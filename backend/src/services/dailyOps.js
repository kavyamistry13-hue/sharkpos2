// Daily operations: the closing report, cash reconciliation, and the activity maths shared with cashier shifts.
// Everything is derived from existing rows (sales, sale lines, refunds, the credit ledger, goods receipts). Cash expected is NEVER taken from the client.
const { query } = require('../db');
const config = require('../config');
const { badRequest } = require('../utils/errors');
const { todayLocal, isValidDate, r2 } = require('../utils/dates');
const { getProductStats } = require('./forecast');

const METHODS = ['cash', 'upi', 'card', 'credit'];
const PAY_METHODS = ['cash', 'upi', 'card'];

/**
 * Money movements inside one window. The window is described by three SQL predicates sharing one parameter list:
 *   salesW   → rows of `sales s` created in the window
 *   refundW  → rows of `sales s` whose refund was processed in the window
 *   payW     → rows of `credit_ledger l` created in the window
 * Sales are counted when rung up (including ones refunded later); a refund is counted when it is processed. Cash expected follows the same rule.
 */
async function activity(q, { salesW, refundW, payW, params }) {
  const [sales, byMethod, refunds, pays, credit, items, profit] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(s.subtotal),0) AS gross, COALESCE(SUM(s.discount),0) AS discount, COALESCE(SUM(s.tax),0) AS tax, COALESCE(SUM(s.total),0) AS total
         FROM sales s WHERE s.status IN ('completed','refunded') AND ${salesW}`, params),
    q(`SELECT s.payment_method AS method, COUNT(*)::int AS n, COALESCE(SUM(s.total),0) AS amount
         FROM sales s WHERE s.status IN ('completed','refunded') AND ${salesW} GROUP BY 1`, params),
    q(`SELECT s.payment_method AS method, COUNT(*)::int AS n, COALESCE(SUM(s.refund_amount),0) AS amount
         FROM sales s WHERE s.status = 'refunded' AND ${refundW} GROUP BY 1`, params),
    q(`SELECT l.payment_method AS method, COUNT(*)::int AS n, COALESCE(SUM(l.amount),0) AS amount
         FROM credit_ledger l WHERE l.entry_type = 'payment' AND ${payW} GROUP BY 1`, params),
    q(`SELECT COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'sale'),0) AS given
         FROM credit_ledger l WHERE ${payW}`, params),
    q(`SELECT COALESCE(SUM(si.quantity),0) AS units, COUNT(DISTINCT si.product_id)::int AS products
         FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed' AND ${salesW}`, params),
    q(`SELECT COALESCE(SUM(COALESCE(si.taxable_value, si.total - si.discount_share) - COALESCE(si.unit_cost, p.purchase_price) * si.quantity),0) AS profit
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id WHERE s.status = 'completed' AND ${salesW}`, params),
  ]);
  const pick = (rows, m) => rows.find((r) => r.method === m) || { n: 0, amount: 0 };
  const t = sales.rows[0];
  const refundTotal = r2(refunds.rows.reduce((a, r) => a + r.amount, 0));
  const cashSales = r2(pick(byMethod.rows, 'cash').amount);
  const cashRefunds = r2(pick(refunds.rows, 'cash').amount);
  const cashPayments = r2(pick(pays.rows, 'cash').amount);
  return {
    sales: { count: t.n, grossSales: r2(t.gross), discounts: r2(t.discount), tax: r2(t.tax), billedTotal: r2(t.total), refunds: refundTotal, refundCount: refunds.rows.reduce((a, r) => a + r.n, 0), netSales: r2(t.total - refundTotal), avgBill: t.n ? r2(t.total / t.n) : 0, unitsSold: items.rows[0].units, productsSold: items.rows[0].products, grossProfit: r2(profit.rows[0].profit) },
    payments: METHODS.map((m) => ({ method: m, count: pick(byMethod.rows, m).n, amount: r2(pick(byMethod.rows, m).amount) })),
    refundsByMethod: METHODS.map((m) => ({ method: m, count: pick(refunds.rows, m).n, amount: r2(pick(refunds.rows, m).amount) })).filter((x) => x.count > 0),
    creditCollected: { total: r2(pays.rows.reduce((a, r) => a + r.amount, 0)), methods: PAY_METHODS.map((m) => ({ method: m, count: pick(pays.rows, m).n, amount: r2(pick(pays.rows, m).amount) })) },
    creditGiven: r2(credit.rows[0].given),
    cash: { cashSales, cashCreditPayments: cashPayments, cashRefunds, netCashMovement: r2(cashSales + cashPayments - cashRefunds) },
  };
}

const dayPredicates = { salesW: `(s.created_at AT TIME ZONE $1)::date = $2::date`, refundW: `(COALESCE(s.refunded_at, s.updated_at) AT TIME ZONE $1)::date = $2::date`, payW: `(l.created_at AT TIME ZONE $1)::date = $2::date` };

async function resolveDate(date) {
  const today = await todayLocal();
  const d = date || today;
  if (!isValidDate(d)) throw badRequest('Use a date like 2026-11-30.');
  if (d > today) throw badRequest('That date is in the future.');
  return { date: d, today };
}

/** Opening cash we suggest for a day: what was counted at the end of the latest earlier day. The owner can overwrite it. */
async function suggestedOpening(date) {
  const r = (await query(
    `SELECT actual_cash FROM cash_reconciliations WHERE business_date < $1::date AND shift_id IS NULL ORDER BY business_date DESC, created_at DESC, id DESC LIMIT 1`, [date],
  )).rows[0];
  return r ? r.actual_cash : 0;
}

const mapRecon = (r) => ({ id: r.id, date: r.business_date, shiftId: r.shift_id, openingCash: r.opening_cash, expectedCash: r.expected_cash, actualCash: r.actual_cash, variance: r.variance, breakdown: r.breakdown, notes: r.notes, reconciledBy: r.by_name || null, createdAt: r.created_at });
const RECON_SQL = `SELECT r.*, to_char(r.business_date, 'YYYY-MM-DD') AS business_date, u.name AS by_name FROM cash_reconciliations r LEFT JOIN users u ON u.id = r.reconciled_by`;

async function dayRecon(date) {
  const rows = (await query(`${RECON_SQL} WHERE r.business_date = $1::date AND r.shift_id IS NULL ORDER BY r.created_at DESC, r.id DESC`, [date])).rows;
  return { latest: rows[0] ? mapRecon(rows[0]) : null, history: rows.map(mapRecon) };
}

async function closingReport(dateInput) {
  const { date, today } = await resolveDate(dateInput);
  const tz = config.storeTz;
  const a = await activity(query, { ...dayPredicates, params: [tz, date] });
  const [opening, recon, shifts, cashiers, top, received, restock, stats, outstanding] = await Promise.all([
    suggestedOpening(date),
    dayRecon(date),
    query(`SELECT sh.id, sh.status, sh.opened_at, sh.closed_at, sh.opening_cash, sh.expected_cash, sh.counted_cash, sh.variance, u.name AS cashier
             FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE (sh.opened_at AT TIME ZONE $1)::date = $2::date ORDER BY sh.opened_at`, [tz, date]),
    query(`SELECT u.name AS cashier, COUNT(*)::int AS bills, COALESCE(SUM(s.total),0) AS total, COALESCE(SUM(s.total) FILTER (WHERE s.payment_method = 'cash'),0) AS cash
             FROM sales s JOIN users u ON u.id = s.employee_id WHERE s.status IN ('completed','refunded') AND (s.created_at AT TIME ZONE $1)::date = $2::date GROUP BY u.name ORDER BY total DESC`, [tz, date]),
    query(`SELECT p.name, SUM(si.quantity) AS units, SUM(si.total) AS revenue FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
            WHERE s.status = 'completed' AND (s.created_at AT TIME ZONE $1)::date = $2::date GROUP BY p.name ORDER BY revenue DESC LIMIT 5`, [tz, date]),
    query(`SELECT COALESCE(SUM(gi.quantity),0) AS units, COALESCE(SUM(gi.quantity * gi.unit_cost),0) AS value, COUNT(DISTINCT g.id)::int AS deliveries
             FROM goods_receipts g JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id WHERE (g.received_at AT TIME ZONE $1)::date = $2::date`, [tz, date]),
    query(`SELECT COUNT(*)::int AS n FROM restock_orders WHERE status IN ('approved','received') AND (created_at AT TIME ZONE $1)::date = $2::date`, [tz, date]),
    getProductStats(),
    query(`SELECT COALESCE(SUM(amount * effect),0) AS b FROM credit_ledger`),
  ]);
  const opening_ = recon.latest ? recon.latest.openingCash : opening;
  const expectedCash = r2(opening_ + a.cash.netCashMovement);
  return {
    date, isToday: date === today, timezone: tz, generatedAt: new Date().toISOString(),
    basis: 'Sales count on the day they were rung up; refunds count on the day they were processed.',
    sales: a.sales, payments: a.payments, refunds: { count: a.sales.refundCount, amount: a.sales.refunds, byMethod: a.refundsByMethod },
    credit: { given: a.creditGiven, collected: a.creditCollected.total, collectedByMethod: a.creditCollected.methods, outstandingTotal: r2(outstanding.rows[0].b) },
    cash: { openingCash: opening_, openingIsSuggested: !recon.latest, ...a.cash, expectedCash, reconciliation: recon.latest },
    inventory: {
      unitsSold: a.sales.unitsSold, productsSold: a.sales.productsSold, stockReceivedUnits: received.rows[0].units, stockReceivedValue: r2(received.rows[0].value), deliveriesReceived: received.rows[0].deliveries,
      restockOrdersApproved: restock.rows[0].n, lowStockNow: stats.filter((p) => p.lowStock && !p.outOfStock).length, outOfStockNow: stats.filter((p) => p.outOfStock).length,
      stockValueNow: r2(stats.reduce((x, p) => x + p.stock * p.purchasePrice, 0)),
    },
    topProducts: top.rows.map((r) => ({ name: r.name, units: r.units, revenue: r2(r.revenue) })),
    cashiers: cashiers.rows.map((r) => ({ name: r.cashier, bills: r.bills, total: r2(r.total), cash: r2(r.cash) })),
    shifts: shifts.rows.map((r) => ({ id: r.id, cashier: r.cashier, status: r.status, openedAt: r.opened_at, closedAt: r.closed_at, openingCash: r.opening_cash, expectedCash: r.expected_cash, countedCash: r.counted_cash, variance: r.variance })),
  };
}

/** Records the count of the till for a day. Expected cash is recomputed here from the books. */
async function recordReconciliation(user, { date: dateInput, openingCash, actualCash, notes }) {
  const { date } = await resolveDate(dateInput);
  const a = await activity(query, { ...dayPredicates, params: [config.storeTz, date] });
  const opening = openingCash ?? (await dayRecon(date)).latest?.openingCash ?? (await suggestedOpening(date));
  const expected = r2(opening + a.cash.netCashMovement);
  const variance = r2(actualCash - expected);
  if (variance !== 0 && !(notes && notes.trim())) throw badRequest(`The count is ₹${Math.abs(variance)} ${variance < 0 ? 'short' : 'over'}. Add a note explaining the difference.`, { code: 'VARIANCE_NEEDS_NOTE', variance, expectedCash: expected });
  const breakdown = { cashSales: a.cash.cashSales, cashCreditPayments: a.cash.cashCreditPayments, cashRefunds: a.cash.cashRefunds };
  const row = (await query(
    `INSERT INTO cash_reconciliations (business_date, opening_cash, expected_cash, actual_cash, variance, breakdown, notes, reconciled_by) VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [date, opening, expected, actualCash, variance, JSON.stringify(breakdown), notes ? notes.trim() : null, user.id],
  )).rows[0];
  const rec = (await query(`${RECON_SQL} WHERE r.id = $1`, [row.id])).rows[0];
  return mapRecon(rec);
}

async function listReconciliations({ from, to, limit = 60 } = {}) {
  const where = [];
  const params = [];
  if (from) { params.push(from); where.push(`r.business_date >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`r.business_date <= $${params.length}::date`); }
  params.push(limit);
  const rows = (await query(`${RECON_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.business_date DESC, r.created_at DESC, r.id DESC LIMIT $${params.length}`, params)).rows;
  return rows.map(mapRecon);
}

module.exports = { activity, closingReport, recordReconciliation, listReconciliations, suggestedOpening, METHODS };
