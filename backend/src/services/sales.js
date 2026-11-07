// POS sale lifecycle. Everything here is deterministic: pricing, discount authorisation, stock updates.
const bcrypt = require('bcryptjs');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { computeBill } = require('./billing');
const { evaluateSales } = require('./risk');
const { toPaise } = require('../utils/money');
const crypto = require('crypto');
const { HttpError, badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertQuantity, round3 } = require('../utils/units');

const { getSettings } = require('./settings');
const credit = require('./credit');

// Highest discount (% of subtotal) each role may give without anyone else's approval.
// The cashier limit is editable in Settings; manager/admin limits are fixed.
async function discountLimits() {
  const s = await getSettings();
  return { cashier: Number(s.cashierMaxDiscountPct), manager: 30, business_owner: 100 };
}

async function loadProductsForCart(client, items, { lock }) {
  const ids = [...new Set(items.map((i) => i.productId))].sort((a, b) => a - b);
  const res = await client.query(
    `SELECT p.id, p.name, p.sku, p.selling_price, p.purchase_price, p.stock, p.is_active, p.expiry_date, p.unit, p.price_includes_tax, c.tax_rate
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = ANY($1::int[]) ${lock ? 'FOR UPDATE OF p' : ''}`,
    [ids],
  );
  return new Map(res.rows.map((r) => [r.id, r]));
}

function mergeItems(items) {
  const merged = new Map();
  for (const it of items) merged.set(it.productId, round3((merged.get(it.productId) || 0) + it.quantity));
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

function buildLines(items, products) {
  const todayIso = new Date().toISOString().slice(0, 10);
  return items.map((it) => {
    const p = products.get(it.productId);
    if (!p || !p.is_active) throw notFound('Product not found.');
    if (p.expiry_date && p.expiry_date < todayIso) throw badRequest(`${p.name} is expired and cannot be sold.`);
    assertQuantity(p.unit, it.quantity, 'Quantity', p.name);
    if (p.stock < it.quantity) {
      throw conflict(`Insufficient stock for ${p.name}. Only ${p.stock} ${p.unit} left.`, { productId: p.id, available: p.stock });
    }
    return {
      productId: p.id, name: p.name, quantity: it.quantity, unitPaise: toPaise(p.selling_price), taxRate: p.tax_rate,
      priceIncludesTax: p.price_includes_tax, unit: p.unit, unitCost: p.purchase_price,
    };
  });
}

/** Price a cart without saving anything (used by the POS screen for the live total). */
async function previewBill({ items, discount }) {
  const merged = mergeItems(items);
  const products = await loadProductsForCart({ query }, merged, { lock: false });
  const lines = buildLines(merged, products);
  return computeBill(lines, discount || null);
}

async function resolveDiscountAuthority(client, user, bill, approval) {
  if (bill.discount <= 0) return { approvedBy: null };
  const LIMITS = await discountLimits();
  const ownLimit = LIMITS[user.role] ?? 0;
  if (bill.discountPct <= ownLimit) return { approvedBy: null };

  if (!approval || !approval.email || !approval.password) {
    const err = forbidden(
      `A ${bill.discountPct}% discount needs manager approval (your limit is ${ownLimit}%).`,
    );
    err.details = { code: 'APPROVAL_REQUIRED', discountPct: bill.discountPct, limit: ownLimit };
    throw err;
  }
  const res = await client.query(
    `SELECT id, password_hash, role, is_active FROM users WHERE lower(email) = lower($1)`,
    [approval.email],
  );
  const approver = res.rows[0];
  const ok = approver && approver.is_active && (await bcrypt.compare(approval.password, approver.password_hash));
  if (!ok) throw forbidden('Approval failed: invalid approver credentials.');
  if (approver.role === 'cashier' || bill.discountPct > (LIMITS[approver.role] ?? 0)) {
    throw forbidden(`This approver cannot authorise a ${bill.discountPct}% discount.`);
  }
  return { approvedBy: approver.id };
}

/** What makes two submissions "the same sale": cashier, items (merged, ordered), discount, customer, payment method. Never secrets. */
function requestHash(user, input, merged) {
  const items = [...merged].map((i) => [i.productId, i.quantity]).sort((a, b) => a[0] - b[0]);
  const d = input.discount ? [input.discount.type, Number(input.discount.value)] : null;
  return crypto.createHash('sha256').update(JSON.stringify({ u: user.id, i: items, d, c: input.customerId || null, p: input.paymentMethod })).digest('hex');
}

/**
 * Creates a sale exactly once per idempotency key.
 * Returns { sale, replayed }. replayed=true means this key was already used with the same payload: the ORIGINAL sale is returned and nothing
 * is processed again (no second sale, no second stock deduction).
 */
async function createSale(user, input, idempotencyKey) {
  const merged = mergeItems(input.items);
  const hash = requestHash(user, input, merged);
  const result = await withTransaction(async (client) => {
    // If another request holds the same key, wait for it (it commits or rolls back) — but never hang a till forever.
    await client.query(`SET LOCAL lock_timeout = ${Math.max(100, Number(config.saleLockTimeoutMs) || 10000)}`);
    let claim;
    try {
      claim = await client.query(
        `INSERT INTO sale_requests (idempotency_key, request_hash, employee_id) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING idempotency_key`,
        [idempotencyKey, hash, user.id],
      );
    } catch (err) {
      if (err.code === '55P03') throw new HttpError(409, 'This sale is still being processed. Please wait a moment and retry.', { code: 'IDEMPOTENCY_IN_PROGRESS' });
      throw err;
    }
    if (!claim.rowCount) {
      const prev = (await client.query('SELECT request_hash, sale_id FROM sale_requests WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
      if (!prev || prev.request_hash !== hash) {
        throw new HttpError(422, 'This idempotency key was already used for a different sale. Start a new sale to get a new key.', { code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      return { saleId: prev.sale_id, replayed: true };
    }

    const products = await loadProductsForCart(client, merged, { lock: true });
    const lines = buildLines(merged, products);
    const bill = computeBill(lines, input.discount || null);
    const { approvedBy } = await resolveDiscountAuthority(client, user, bill, input.approval);

    if (input.paymentMethod === 'credit' && !input.customerId) throw badRequest('Choose a customer for a credit (udhaar) sale.', { code: 'CREDIT_NEEDS_CUSTOMER' });
    if (input.customerId) {
      const c = await client.query('SELECT id FROM customers WHERE id = $1', [input.customerId]);
      if (!c.rowCount) throw notFound('Customer not found.');
    }

    const saleRes = await client.query(
      `INSERT INTO sales (customer_id, employee_id, subtotal, discount, tax, total, payment_method, discount_approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [input.customerId || null, user.id, bill.subtotal, bill.discount, bill.tax, bill.total, input.paymentMethod, approvedBy],
    );
    const saleId = saleRes.rows[0].id;
    const invoiceNo = `INV-${saleRes.rows[0].created_at.toISOString().slice(0, 10).replace(/-/g, '')}-${String(saleId).padStart(5, '0')}`;
    await client.query('UPDATE sales SET invoice_no = $1 WHERE id = $2', [invoiceNo, saleId]);
    // Credit (udhaar) sale: the whole bill goes on the customer's ledger, inside this same transaction (limit is checked under a row lock).
    if (input.paymentMethod === 'credit') await credit.recordCreditSale(client, { customerId: input.customerId, saleId, amount: bill.total, userId: user.id });

    const meta = new Map(lines.map((l) => [l.productId, l]));
    for (const line of bill.items) {
      const m = meta.get(line.productId);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, unit, unit_cost, cost_source, tax_rate, price_includes_tax, discount_share, taxable_value, tax_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'snapshot',$8,$9,$10,$11,$12)`,
        [saleId, line.productId, line.quantity, line.unitPrice, line.lineTotal, m.unit, m.unitCost, line.taxRate, line.priceIncludesTax, line.discountShare, line.taxableValue, line.tax],
      );
      const upd = await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`, [
        line.quantity,
        line.productId,
      ]);
      if (!upd.rowCount) throw conflict(`Insufficient stock for ${line.name}.`);
      await client.query(
        `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type) VALUES ($1,'sale',$2,$3,'sale')`,
        [line.productId, -line.quantity, saleId],
      );
    }
    await client.query('UPDATE sale_requests SET sale_id = $1 WHERE idempotency_key = $2', [saleId, idempotencyKey]);
    return { saleId, replayed: false };
  });

  if (result.replayed) return { sale: await getSale(result.saleId, user), replayed: true };
  invalidateAll();
  // Risk scoring must never break checkout.
  let risk = null;
  try {
    const [r] = await evaluateSales(query, { saleIds: [result.saleId] });
    risk = r;
  } catch (err) {
    console.error('[risk] scoring failed for sale', result.saleId, err.message);
  }
  const sale = await getSale(result.saleId, user);
  return { replayed: false, sale: { ...sale, risk: risk && risk.score >= config.rules.riskAlertThreshold ? { score: risk.score, severity: risk.severity } : null } };
}

async function getSale(id, user) {
  const res = await query(
    `SELECT s.*, u.name AS employee, c.name AS customer_name, c.phone AS customer_phone, a.name AS approved_by_name
       FROM sales s
       JOIN users u ON u.id = s.employee_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users a ON a.id = s.discount_approved_by
      WHERE s.id = $1`,
    [id],
  );
  const s = res.rows[0];
  if (!s || (user && user.role === 'cashier' && s.employee_id !== user.id)) throw notFound('Sale not found.');
  const items = await query(
    `SELECT si.product_id, p.name, p.sku, si.quantity, si.unit, si.unit_price, si.total, si.tax_rate, si.price_includes_tax, si.tax_amount, si.taxable_value, si.discount_share
       FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id`,
    [id],
  );
  const alert =
    user && user.role === 'cashier'
      ? null
      : (await query('SELECT id, risk_score, severity, reason, factors, status FROM anomaly_alerts WHERE sale_id = $1', [id])).rows[0] || null;
  return {
    id: s.id,
    invoiceNo: s.invoice_no,
    createdAt: s.created_at,
    employeeId: s.employee_id,
    employee: s.employee,
    customer: s.customer_id ? { id: s.customer_id, name: s.customer_name, phone: s.customer_phone } : null,
    subtotal: s.subtotal,
    discount: s.discount,
    tax: s.tax,
    total: s.total,
    paymentMethod: s.payment_method,
    status: s.status,
    refundAmount: s.refund_amount,
    discountApprovedBy: s.approved_by_name || null,
    items: items.rows.map((i) => ({
      productId: i.product_id,
      name: i.name,
      sku: i.sku,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unit_price,
      total: i.total,
      taxRate: i.tax_rate,
      priceIncludesTax: i.price_includes_tax,
      taxAmount: i.tax_amount,
      taxableValue: i.taxable_value,
      discountShare: i.discount_share,
    })),
    taxIncluded: Math.round(items.rows.filter((i) => i.price_includes_tax).reduce((a, i) => a + i.tax_amount, 0) * 100) / 100,
    alert: alert && {
      id: alert.id,
      riskScore: alert.risk_score,
      severity: alert.severity,
      reason: alert.reason,
      factors: alert.factors,
      status: alert.status,
    },
  };
}

async function listSales(user, f) {
  const where = [];
  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const tz = config.storeTz;
  if (user.role === 'cashier') where.push(`s.employee_id = ${p(user.id)}`);
  else if (f.employeeId) where.push(`s.employee_id = ${p(f.employeeId)}`);
  if (f.from) where.push(`(s.created_at AT TIME ZONE ${p(tz)})::date >= ${p(f.from)}::date`);
  if (f.to) where.push(`(s.created_at AT TIME ZONE ${p(tz)})::date <= ${p(f.to)}::date`);
  if (f.payment) where.push(`s.payment_method = ${p(f.payment)}`);
  if (f.status) where.push(`s.status = ${p(f.status)}`);
  if (f.q) where.push(`(s.invoice_no ILIKE ${p(`%${f.q}%`)} OR c.name ILIKE ${p(`%${f.q}%`)} OR s.id::text = ${p(f.q)})`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM sales s JOIN users u ON u.id = s.employee_id LEFT JOIN customers c ON c.id = s.customer_id
                LEFT JOIN anomaly_alerts a ON a.sale_id = s.id ${whereSql}`;
  const total = (await query(`SELECT COUNT(*)::int AS n ${base}`, params)).rows[0].n;
  const offset = (f.page - 1) * f.limit;
  const rows = (
    await query(
      `SELECT s.id, s.invoice_no, s.created_at, s.subtotal, s.discount, s.tax, s.total, s.payment_method, s.status,
              s.refund_amount, u.name AS employee, c.name AS customer,
              (SELECT COALESCE(SUM(quantity),0) FROM sale_items WHERE sale_id = s.id) AS items,
              a.risk_score, a.severity
         ${base}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ${p(f.limit)} OFFSET ${p(offset)}`,
      params,
    )
  ).rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_no,
    createdAt: r.created_at,
    subtotal: r.subtotal,
    discount: r.discount,
    tax: r.tax,
    total: r.total,
    paymentMethod: r.payment_method,
    status: r.status,
    refundAmount: r.refund_amount,
    employee: r.employee,
    customer: r.customer,
    items: r.items,
    riskScore: user.role === 'cashier' ? null : r.risk_score,
    riskSeverity: user.role === 'cashier' ? null : r.severity,
  }));
  return { total, page: f.page, limit: f.limit, rows };
}

/** Full refund: marks the sale refunded and puts stock back. */
async function refundSale(id, user) {
  await withTransaction(async (client) => {
    const res = await client.query('SELECT id, status, total, payment_method, customer_id FROM sales WHERE id = $1 FOR UPDATE', [id]);
    const s = res.rows[0];
    if (!s) throw notFound('Sale not found.');
    if (s.status !== 'completed') throw conflict(`This sale is already ${s.status}.`);
    await client.query(`UPDATE sales SET status = 'refunded', refund_amount = total, refunded_at = now(), refunded_by = $2 WHERE id = $1`, [id, user.id]);
    if (s.payment_method === 'credit') await credit.reverseCreditSale(client, { customerId: s.customer_id, saleId: id, amount: s.total, userId: user.id });
    const items = await client.query('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1', [id]);
    for (const it of items.rows) {
      await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [it.quantity, it.product_id]);
      await client.query(
        `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type) VALUES ($1,'refund',$2,$3,'refund')`,
        [it.product_id, it.quantity, id],
      );
    }
  });
  invalidateAll();
  try {
    await evaluateSales(query, { saleIds: [id] });
  } catch (err) {
    console.error('[risk] scoring failed after refund', err.message);
  }
  return getSale(id, user);
}

module.exports = { previewBill, createSale, getSale, listSales, refundSale, discountLimits };
