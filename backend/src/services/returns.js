// Line-level returns. A return is a NEW record (sale_returns + lines + refund lines); the original sale lines and totals are never rewritten.
// Counters kept in the same transaction: sale_items.returned_qty, sales.refund_amount (and status → 'refunded' once every unit is back).
// Money is handled in integer paise. The refund for a line is its payable value (taxable + tax, after the line's share of the bill discount),
// pro-rated by quantity; the LAST unit of a line gets the exact remainder, so the lines of a fully returned sale always add up to the bill.
const crypto = require('crypto');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { toPaise } = require('../utils/money');
const { HttpError, badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertQuantity, round3 } = require('../utils/units');
const { evaluateSales } = require('./risk');
const credit = require('./credit');

const REASONS = ['damaged', 'wrong_item', 'changed_mind', 'quality', 'expired', 'other'];
const NO_RESTOCK_REASONS = ['damaged', 'expired'];           // returned goods that cannot go back on the shelf by default
const CASHIER_RETURN_WINDOW_HOURS = 24;                      // a cashier may return their OWN recent sales; older ones need a manager
const METHODS = ['cash', 'upi', 'card', 'credit'];

const isManager = (u) => u.role === 'business_owner' || u.role === 'manager';

/** Splits `amount` (paise) over methods in proportion to what each still has available, never over capacity. Deterministic. */
function allocateProportionally(amount, caps) {
  const entries = Object.entries(caps).filter(([, c]) => c > 0);
  const capTotal = entries.reduce((a, [, c]) => a + c, 0);
  if (amount > capTotal) return null;
  const out = {};
  let given = 0;
  const frac = [];
  for (const [m, c] of entries) {
    const exact = (amount * c) / capTotal;
    out[m] = Math.floor(exact);
    given += out[m];
    frac.push({ m, rem: exact - out[m] });
  }
  frac.sort((a, b) => b.rem - a.rem || (a.m < b.m ? -1 : 1));
  for (let k = 0; given < amount; k = (k + 1) % frac.length) {
    const m = frac[k].m;
    if (out[m] < caps[m]) { out[m] += 1; given += 1; }
  }
  return out;
}

function requestHash(user, saleId, input) {
  const items = [...input.items].map((i) => [i.saleItemId, Number(i.quantity), i.restock === undefined ? null : Boolean(i.restock)]).sort((a, b) => a[0] - b[0]);
  const refunds = input.refunds && input.refunds.length ? input.refunds.map((r) => [r.method, toPaise(r.amount)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : null;
  return crypto.createHash('sha256').update(JSON.stringify({ u: user.id, s: saleId, i: items, r: input.reason || 'other', n: input.note || null, f: refunds })).digest('hex');
}

const mapReturn = (r, items, refunds) => ({
  id: r.id, saleId: r.sale_id, createdAt: r.created_at, total: r.total_refund, taxable: r.taxable_value, tax: r.tax_amount, reason: r.reason, note: r.note,
  completesSale: r.completes_sale, legacy: r.is_legacy, by: r.by_name || null,
  items: items.map((i) => ({ saleItemId: i.sale_item_id, productId: i.product_id, name: i.name, quantity: i.quantity, refundAmount: i.refund_amount, restocked: i.restocked })),
  refunds: refunds.map((f) => ({ method: f.method, amount: f.amount })),
});

async function loadReturns(q, saleId) {
  const rs = (await q(
    `SELECT r.*, u.name AS by_name FROM sale_returns r LEFT JOIN users u ON u.id = r.processed_by WHERE r.sale_id = $1 ORDER BY r.created_at, r.id`, [saleId],
  )).rows;
  if (!rs.length) return [];
  const ids = rs.map((r) => r.id);
  const [items, refunds] = await Promise.all([
    q(`SELECT ri.*, p.name FROM sale_return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.return_id = ANY($1::int[]) ORDER BY ri.id`, [ids]),
    q(`SELECT * FROM sale_return_refunds WHERE return_id = ANY($1::int[]) ORDER BY id`, [ids]),
  ]);
  return rs.map((r) => mapReturn(r, items.rows.filter((i) => i.return_id === r.id), refunds.rows.filter((f) => f.return_id === r.id)));
}

/**
 * Processes one return. `input.items` = [{ saleItemId, quantity, restock? }]; `input.reason`; optional `input.refunds` = [{ method, amount }].
 * Returns { returnId, replayed }. With an idempotency key, repeating the same request returns the original return and changes nothing.
 */
async function processReturn(user, saleId, input, idempotencyKey = null) {
  const reason = input.reason || 'other';
  if (!REASONS.includes(reason)) throw badRequest('Choose a return reason.');
  const hash = idempotencyKey ? requestHash(user, saleId, input) : null;
  const out = await withTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = ${Math.max(100, Number(config.saleLockTimeoutMs) || 10000)}`);
    let sale;
    try {
      // The sale row is the lock that serialises every return on this sale (two cashiers, a double-click, a retry).
      sale = (await client.query('SELECT id, status, total, refund_amount, payment_method, customer_id, employee_id, created_at FROM sales WHERE id = $1 FOR UPDATE', [saleId])).rows[0];
    } catch (err) {
      if (err.code === '55P03') throw new HttpError(409, 'This sale is being updated. Please wait a moment and retry.', { code: 'SALE_BUSY' });
      throw err;
    }
    if (!sale || (user.role === 'cashier' && sale.employee_id !== user.id)) throw notFound('Sale not found.');

    if (idempotencyKey) {
      const prev = (await client.query('SELECT id, sale_id, request_hash FROM sale_returns WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
      if (prev) {
        if (prev.sale_id !== saleId || prev.request_hash !== hash) throw new HttpError(422, 'This idempotency key was already used for a different return. Start a new return to get a new key.', { code: 'IDEMPOTENCY_KEY_REUSED' });
        return { returnId: prev.id, replayed: true };
      }
    }

    if (sale.status !== 'completed') throw conflict(`This sale is already ${sale.status}.`, { code: 'SALE_NOT_RETURNABLE', status: sale.status });
    if (user.role === 'cashier' && Date.now() - new Date(sale.created_at).getTime() > CASHIER_RETURN_WINDOW_HOURS * 3600 * 1000) {
      throw forbidden(`Returns on bills older than ${CASHIER_RETURN_WINDOW_HOURS} hours need a manager.`);
    }

    const lines = (await client.query(
      `SELECT si.id, si.product_id, si.quantity, si.returned_qty, si.unit, si.unit_cost, si.tax_amount,
              COALESCE(si.taxable_value, si.total - si.discount_share) AS taxable, p.name
         FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id`, [saleId],
    )).rows;
    const byId = new Map(lines.map((l) => [l.id, l]));

    // Merge repeated lines of the request, then validate each against what is still returnable.
    const want = new Map();
    for (const it of input.items) want.set(it.saleItemId, { quantity: round3((want.get(it.saleItemId)?.quantity || 0) + Number(it.quantity)), restock: it.restock });
    if (!want.size) throw badRequest('Choose at least one item to return.');
    const prior = (await client.query(
      `SELECT ri.sale_item_id, COALESCE(SUM(ri.refund_amount),0) AS refunded, COALESCE(SUM(ri.tax_amount),0) AS tax FROM sale_return_items ri
        WHERE ri.sale_item_id = ANY($1::int[]) GROUP BY 1`, [lines.map((l) => l.id)],
    )).rows;
    const priorBy = new Map(prior.map((r) => [r.sale_item_id, r]));

    const plan = [];
    for (const [saleItemId, w] of [...want.entries()].sort((a, b) => a[0] - b[0])) {
      const l = byId.get(saleItemId);
      if (!l) throw badRequest('One of the items is not on this bill.', { code: 'LINE_NOT_IN_SALE', saleItemId });
      if (!(w.quantity > 0)) throw badRequest(`Enter a quantity for ${l.name}.`);
      assertQuantity(l.unit, w.quantity, 'Return quantity', l.name);
      const returnable = round3(l.quantity - l.returned_qty);
      if (w.quantity > returnable) {
        throw conflict(returnable > 0 ? `Only ${returnable} ${l.unit} of ${l.name} can still be returned (sold ${l.quantity}, already returned ${l.returned_qty}).` : `${l.name} has already been fully returned.`,
          { code: 'RETURN_EXCEEDS_SOLD', saleItemId, sold: l.quantity, returned: l.returned_qty, returnable });
      }
      const payable = toPaise(l.taxable) + toPaise(l.tax_amount || 0);
      const tax = toPaise(l.tax_amount || 0);
      const pr = priorBy.get(saleItemId);
      const refundedBefore = pr ? toPaise(pr.refunded) : 0;
      const taxBefore = pr ? toPaise(pr.tax) : 0;
      const last = w.quantity === returnable;                                  // last units of the line: take the exact remainder
      const refund = last ? payable - refundedBefore : Math.min(Math.round((payable * w.quantity) / l.quantity), payable - refundedBefore);
      const lineTax = last ? tax - taxBefore : Math.min(Math.round((tax * w.quantity) / l.quantity), tax - taxBefore);
      plan.push({ line: l, quantity: w.quantity, refund: Math.max(refund, 0), tax: Math.max(lineTax, 0), restock: w.restock === undefined || w.restock === null ? !NO_RESTOCK_REASONS.includes(reason) : Boolean(w.restock), last });
    }

    const completes = lines.every((l) => {
      const p = plan.find((x) => x.line.id === l.id);
      return round3(l.returned_qty + (p ? p.quantity : 0)) === Number(l.quantity);
    });
    let totalPaise = plan.reduce((a, p) => a + p.refund, 0);
    const refundedBeforeSale = toPaise(sale.refund_amount);
    if (completes) {
      // Whole sale is back: the refunds must add up to the bill to the paisa (absorbs rounding on pre-013 lines).
      const delta = toPaise(sale.total) - refundedBeforeSale - totalPaise;
      if (delta !== 0) { plan[plan.length - 1].refund += delta; totalPaise += delta; }
    }
    if (refundedBeforeSale + totalPaise > toPaise(sale.total)) throw conflict('That would refund more than the bill.', { code: 'REFUND_EXCEEDS_BILL' });
    const taxPaise = plan.reduce((a, p) => a + p.tax, 0);

    // How the money goes back: per method, never more than that method paid (cumulative over all returns of this sale).
    const paidRows = (await client.query('SELECT method, amount FROM sale_payments WHERE sale_id = $1', [saleId])).rows;
    const paid = paidRows.length ? Object.fromEntries(paidRows.map((r) => [r.method, toPaise(r.amount)])) : { [sale.payment_method]: toPaise(sale.total) };
    const refundedRows = (await client.query(
      `SELECT rf.method, COALESCE(SUM(rf.amount),0) AS amount FROM sale_return_refunds rf JOIN sale_returns r ON r.id = rf.return_id WHERE r.sale_id = $1 GROUP BY 1`, [saleId],
    )).rows;
    const caps = {};
    for (const m of METHODS) caps[m] = Math.max((paid[m] || 0) - (refundedRows.find((r) => r.method === m) ? toPaise(refundedRows.find((r) => r.method === m).amount) : 0), 0);
    let split;
    if (input.refunds && input.refunds.length) {
      split = {};
      for (const r of input.refunds) {
        const exact = Number(r.amount) * 100;
        if (Math.abs(exact - Math.round(exact)) > 1e-6) throw badRequest('Refund amounts can have at most 2 decimals.');
        if (split[r.method] !== undefined) throw badRequest(`Use ${r.method} only once.`, { code: 'DUPLICATE_REFUND_METHOD' });
        if (Math.round(exact) > caps[r.method]) throw badRequest(`Only ₹${caps[r.method] / 100} is left to refund to ${r.method} on this bill.`, { code: 'REFUND_METHOD_EXCEEDS_PAID', method: r.method, available: caps[r.method] / 100 });
        split[r.method] = Math.round(exact);
      }
      const given = Object.values(split).reduce((a, b) => a + b, 0);
      if (given !== totalPaise) throw badRequest(`The refund lines add up to ₹${given / 100} but the returned items are worth ₹${totalPaise / 100}.`, { code: 'REFUND_SPLIT_MISMATCH', expected: totalPaise / 100, given: given / 100 });
    } else {
      split = allocateProportionally(totalPaise, caps);
      if (!split) throw conflict('The amount paid on this bill cannot cover that refund.', { code: 'REFUND_EXCEEDS_PAID' });
    }

    const ret = (await client.query(
      `INSERT INTO sale_returns (sale_id, idempotency_key, request_hash, total_refund, taxable_value, tax_amount, reason, note, completes_sale, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [saleId, idempotencyKey, hash, totalPaise / 100, (totalPaise - taxPaise) / 100, taxPaise / 100, reason, input.note ? String(input.note).trim().slice(0, 300) || null : null, completes, user.id],
    )).rows[0];

    for (const p of plan) {
      await client.query(
        `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, quantity, refund_amount, taxable_value, tax_amount, unit_cost, restocked) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ret.id, p.line.id, p.line.product_id, p.quantity, p.refund / 100, (p.refund - p.tax) / 100, p.tax / 100, p.line.unit_cost, p.restock],
      );
      await client.query('UPDATE sale_items SET returned_qty = returned_qty + $2 WHERE id = $1', [p.line.id, p.quantity]);
    }
    for (const [method, amount] of Object.entries(split)) {
      if (amount > 0) await client.query('INSERT INTO sale_return_refunds (return_id, method, amount) VALUES ($1,$2,$3)', [ret.id, method, amount / 100]);
    }
    await client.query(
      completes
        ? `UPDATE sales SET refund_amount = refund_amount + $2, status = 'refunded', refunded_at = now(), refunded_by = $3 WHERE id = $1`
        : 'UPDATE sales SET refund_amount = refund_amount + $2 WHERE id = $1',
      completes ? [saleId, totalPaise / 100, user.id] : [saleId, totalPaise / 100],
    );
    if (split.credit > 0) await credit.reverseCreditAmount(client, { customerId: sale.customer_id, saleId, returnId: ret.id, amount: split.credit / 100, userId: user.id });

    // Put units back on the shelf (lock products in id order so two returns can never deadlock).
    for (const p of [...plan].filter((x) => x.restock).sort((a, b) => a.line.product_id - b.line.product_id)) {
      await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [p.quantity, p.line.product_id]);
      await client.query(
        `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type, created_by) VALUES ($1,'refund',$2,$3,'refund',$4)`,
        [p.line.product_id, p.quantity, saleId, user.id],
      );
    }
    return { returnId: ret.id, replayed: false, completes };
  });

  if (!out.replayed) {
    invalidateAll();
    try { await evaluateSales(query, { saleIds: [saleId] }); } catch (err) { console.error('[risk] scoring failed after return', err.message); }
  }
  const ret = (await loadReturns(query, saleId)).find((r) => r.id === out.returnId);
  return { return: ret, replayed: out.replayed };
}

/** Full refund (the original owner/manager action): returns every unit still on the bill. */
async function refundFull(saleId, user) {
  const sale = (await query('SELECT id, status FROM sales WHERE id = $1', [saleId])).rows[0];
  if (!sale) throw notFound('Sale not found.');
  if (sale.status !== 'completed') throw conflict(`This sale is already ${sale.status}.`);
  const remaining = (await query('SELECT id, quantity - returned_qty AS qty FROM sale_items WHERE sale_id = $1 AND quantity > returned_qty ORDER BY id', [saleId])).rows;
  return processReturn(user, saleId, { items: remaining.map((r) => ({ saleItemId: r.id, quantity: Number(r.qty), restock: true })), reason: 'other' }, null);
}

module.exports = { processReturn, refundFull, loadReturns, allocateProportionally, REASONS, CASHIER_RETURN_WINDOW_HOURS };
