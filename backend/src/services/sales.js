// POS sale lifecycle. Everything here is deterministic: pricing, discount authorisation, stock updates.
const bcrypt = require('bcryptjs');
const batches = require('./batches');
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
const approvalGuard = require('./approvalGuard');

// Highest discount (% of subtotal) each role may give without anyone else's approval.
// The cashier limit is editable in Settings; manager/admin limits are fixed.
async function discountLimits() {
  const s = await getSettings();
  return { cashier: Number(s.cashierMaxDiscountPct), manager: 30, business_owner: 100 };
}

async function loadProductsForCart(client, items, { lock }) {
  const ids = [...new Set(items.map((i) => i.productId))].sort((a, b) => a - b);
  const res = await client.query(
    `SELECT p.id, p.name, p.sku, p.selling_price, p.purchase_price, p.avg_cost, p.stock, p.is_active, p.expiry_date, p.unit, p.price_includes_tax, c.tax_rate
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
      priceIncludesTax: p.price_includes_tax, unit: p.unit, unitCost: p.avg_cost,
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

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

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
  approvalGuard.assertRequesterAllowed(user.id);
  const res = await client.query(
    `SELECT id, password_hash, role, is_active FROM users WHERE lower(email) = lower($1)`,
    [approval.email],
  );
  const approver = res.rows[0];
  const locked = approver ? await approvalGuard.accountLocked(approver.id) : false;
  // Always run bcrypt (against a dummy hash if the approver is unknown) so timing does not reveal which emails exist.
  const matches = await bcrypt.compare(approval.password, approver ? approver.password_hash : DUMMY_HASH);
  const ok = !!approver && approver.is_active && !locked && matches;
  if (!ok) {
    await approvalGuard.recordFailure(user.id, approver && !locked ? approver.id : null, approver ? 'bad_credentials' : 'unknown_account', null);
    throw forbidden('Approval failed: invalid approver credentials.');
  }
  approvalGuard.recordSuccess(user.id);
  if (approver.role === 'cashier' || bill.discountPct > (LIMITS[approver.role] ?? 0)) {
    throw forbidden(`This approver cannot authorise a ${bill.discountPct}% discount.`);
  }
  return { approvedBy: approver.id };
}

/**
 * Turns the payment part of a request into tender lines that add up to the bill EXACTLY (integer paise — no rounding slack).
 *   paymentMethod only      → one line for the whole bill (the original behaviour)
 *   payments: [{method, amount}] → split payment; each method at most once; lines must sum to the total (no over- or under-payment).
 * Credit (udhaar) is just another line: the part the customer will pay later. A zero-value bill (100% discount) has no tender lines.
 */
function resolvePayments(input, totalPaise) {
  const given = input.payments && input.payments.length ? input.payments : null;
  if (totalPaise === 0) {
    if (given && given.some((p) => toPaise(p.amount) > 0)) throw badRequest('This bill is ₹0, so there is nothing to pay.', { code: 'PAYMENT_EXCEEDS_BILL', total: 0, paid: given.reduce((a, p) => a + toPaise(p.amount), 0) / 100 });
    return { lines: [], primary: input.paymentMethod || (given && given[0].method) || 'cash' };
  }
  let lines;
  if (given) {
    const seen = new Set();
    lines = given.map((p) => {
      const exact = Number(p.amount) * 100;
      if (Math.abs(exact - Math.round(exact)) > 1e-6) throw badRequest('Payment amounts can have at most 2 decimals.', { code: 'PAYMENT_PRECISION' });
      if (seen.has(p.method)) throw badRequest(`Use ${p.method} only once. Add the amounts together.`, { code: 'DUPLICATE_PAYMENT_METHOD' });
      seen.add(p.method);
      return { method: p.method, paise: Math.round(exact) };
    });
    const paid = lines.reduce((a, l) => a + l.paise, 0);
    if (paid !== totalPaise) {
      const short = paid < totalPaise;
      throw badRequest(short ? `Payments add up to ₹${paid / 100} but the bill is ₹${totalPaise / 100}. ₹${(totalPaise - paid) / 100} is still unpaid.` : `Payments add up to ₹${paid / 100}, ₹${(paid - totalPaise) / 100} more than the bill of ₹${totalPaise / 100}.`,
        { code: short ? 'PAYMENT_SHORT' : 'PAYMENT_EXCEEDS_BILL', total: totalPaise / 100, paid: paid / 100, difference: Math.abs(totalPaise - paid) / 100 });
    }
  } else {
    if (!input.paymentMethod) throw badRequest('Choose a payment method.', { code: 'PAYMENT_REQUIRED' });
    lines = [{ method: input.paymentMethod, paise: totalPaise }];
  }
  return { lines, primary: lines.length === 1 ? lines[0].method : 'split' };
}

/** What makes two submissions "the same sale": cashier, items (merged, ordered), discount, customer, payment lines, held bill. Never secrets. */
function requestHash(user, input, merged) {
  const items = [...merged].map((i) => [i.productId, i.quantity]).sort((a, b) => a[0] - b[0]);
  const d = input.discount ? [input.discount.type, Number(input.discount.value)] : null;
  const pl = input.payments && input.payments.length ? input.payments.map((p) => [p.method, toPaise(p.amount)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : null;
  return crypto.createHash('sha256').update(JSON.stringify({ u: user.id, i: items, d, c: input.customerId || null, p: input.paymentMethod || null, pl, h: input.heldBillId || null })).digest('hex');
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

    const pay = resolvePayments(input, toPaise(bill.total));
    const creditLine = pay.lines.find((l) => l.method === 'credit');
    if (creditLine && !input.customerId) throw badRequest('Choose a customer for a credit (udhaar) sale.', { code: 'CREDIT_NEEDS_CUSTOMER' });

    // A held bill is completed exactly once: lock it, check it is still open and the caller may complete it, then mark it in THIS transaction.
    let held = null;
    if (input.heldBillId) {
      held = (await client.query('SELECT id, status, created_by FROM held_bills WHERE id = $1 FOR UPDATE', [input.heldBillId])).rows[0];
      if (!held) throw notFound('Held bill not found.');
      if (user.role === 'cashier' && held.created_by !== user.id) throw notFound('Held bill not found.');
      if (held.status !== 'held') throw conflict(`This held bill is already ${held.status}.`, { code: 'HELD_BILL_NOT_OPEN', status: held.status });
    }
    if (input.customerId) {
      const c = await client.query('SELECT id FROM customers WHERE id = $1', [input.customerId]);
      if (!c.rowCount) throw notFound('Customer not found.');
    }

    const saleRes = await client.query(
      `INSERT INTO sales (customer_id, employee_id, subtotal, discount, tax, total, payment_method, discount_approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [input.customerId || null, user.id, bill.subtotal, bill.discount, bill.tax, bill.total, pay.primary, approvedBy],
    );
    const saleId = saleRes.rows[0].id;
    const invoiceNo = `INV-${saleRes.rows[0].created_at.toISOString().slice(0, 10).replace(/-/g, '')}-${String(saleId).padStart(5, '0')}`;
    await client.query('UPDATE sales SET invoice_no = $1 WHERE id = $2', [invoiceNo, saleId]);
    // Credit (udhaar) sale: the whole bill goes on the customer's ledger, inside this same transaction (limit is checked under a row lock).
    for (const l of pay.lines) await client.query('INSERT INTO sale_payments (sale_id, method, amount) VALUES ($1,$2,$3)', [saleId, l.method, l.paise / 100]);
    if (creditLine) await credit.recordCreditSale(client, { customerId: input.customerId, saleId, amount: creditLine.paise / 100, userId: user.id });

    const meta = new Map(lines.map((l) => [l.productId, l]));
    for (const line of bill.items) {
      const m = meta.get(line.productId);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, unit, unit_cost, cost_source, tax_rate, price_includes_tax, discount_share, taxable_value, tax_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'snapshot',$8,$9,$10,$11,$12)`,
        [saleId, line.productId, line.quantity, line.unitPrice, line.lineTotal, m.unit, m.unitCost, line.taxRate, line.priceIncludesTax, line.discountShare, line.taxableValue, line.tax],
      );
      const upd = await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock, track_batches`, [
        line.quantity,
        line.productId,
      ]);
      if (!upd.rowCount) throw conflict(`Insufficient stock for ${line.name}.`);
      // Batch-tracked products (Phase 9) sell earliest-expiry first and the movement records which batch; others are untouched.
      const parts = upd.rows[0].track_batches ? await batches.deductFefo(client, line.productId, line.quantity, { stockAfter: Number(upd.rows[0].stock) }) : [];
      const moves = parts.length ? parts.map((x) => ({ qty: x.quantity, batchId: x.batchId })) : [{ qty: line.quantity, batchId: null }];
      for (const mv of moves) {
        await client.query(
          `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type, batch_id) VALUES ($1,'sale',$2,$3,'sale',$4)`,
          [line.productId, -mv.qty, saleId, mv.batchId],
        );
      }
    }
    await client.query('UPDATE sale_requests SET sale_id = $1 WHERE idempotency_key = $2', [saleId, idempotencyKey]);
    if (held) await client.query(`UPDATE held_bills SET status = 'completed', completed_sale_id = $2, completed_at = now(), version = version + 1 WHERE id = $1`, [held.id, saleId]);
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
    `SELECT si.id, si.product_id, p.name, p.sku, si.quantity, si.returned_qty, si.unit, si.unit_price, si.total, si.tax_rate, si.price_includes_tax, si.tax_amount, si.taxable_value, si.discount_share
       FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id`,
    [id],
  );
  const payRows = (await query('SELECT method, amount FROM sale_payments WHERE sale_id = $1 ORDER BY id', [id])).rows;
  const payments = payRows.length ? payRows.map((r) => ({ method: r.method, amount: r.amount })) : s.total > 0 ? [{ method: s.payment_method, amount: s.total }] : [];
  const returns = await require('./returns').loadReturns(query, id);
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
    payments,
    returns,
    discountApprovedBy: s.approved_by_name || null,
    items: items.rows.map((i) => ({
      id: i.id,
      returnedQty: i.returned_qty,
      returnableQty: Math.round((i.quantity - i.returned_qty) * 1000) / 1000,
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
  if (f.payment) where.push(f.payment === 'split' ? `s.payment_method = 'split'` : `EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = ${p(f.payment)})`);
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

/** Full refund (owner/manager): a return of every unit still on the bill. Implemented by the return engine (services/returns.js). */
async function refundSale(id, user) {
  await require('./returns').refundFull(id, user);
  return getSale(id, user);
}

module.exports = { resolvePayments, previewBill, createSale, getSale, listSales, refundSale, discountLimits, loadProductsForCart, mergeItems };
