// Cashier shifts: open with a float, work, close with a counted drawer. The summary is frozen at close so the record never changes afterwards.
const { query, withTransaction } = require('../db');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { r2 } = require('../utils/dates');
const { activity } = require('./dailyOps');

const isManager = (u) => u.role === 'business_owner' || u.role === 'manager';
const windowPreds = { salesW: 's.employee_id = $1 AND s.created_at >= $2 AND s.created_at < $3', refundW: 'r.processed_by = $1 AND r.created_at >= $2 AND r.created_at < $3', payW: 'l.created_by = $1 AND l.created_at >= $2 AND l.created_at < $3' };

/** Live numbers for a shift: what this cashier rang up, refunded and collected between opening and now (or closing). */
async function shiftSummary(q, shift, until = new Date()) {
  const a = await activity(q, { ...windowPreds, params: [shift.user_id, shift.opened_at, until] });
  const expectedCash = r2(shift.opening_cash + a.cash.netCashMovement);
  return {
    openingCash: shift.opening_cash, ...a.cash, expectedCash,
    sales: { count: a.sales.count, billedTotal: a.sales.billedTotal, discounts: a.sales.discounts, tax: a.sales.tax, refunds: a.sales.refunds, netSales: a.sales.netSales, unitsSold: a.sales.unitsSold },
    payments: a.payments, creditGiven: a.creditGiven, creditCollected: a.creditCollected.total,
  };
}

const map = (r, live) => ({
  id: r.id, cashierId: r.user_id, cashier: r.cashier, status: r.status, openedAt: r.opened_at, closedAt: r.closed_at, openingCash: r.opening_cash,
  expectedCash: r.status === 'closed' ? r.expected_cash : (live ? live.expectedCash : null), countedCash: r.counted_cash, variance: r.variance,
  notes: r.notes, handoverTo: r.handover_to ? { id: r.handover_to, name: r.handover_name } : null, handoverNote: r.handover_note, closedBy: r.closed_by_name || null,
  summary: r.status === 'closed' ? r.summary : live,
});
const SQL = `SELECT sh.*, u.name AS cashier, h.name AS handover_name, cb.name AS closed_by_name
               FROM shifts sh JOIN users u ON u.id = sh.user_id LEFT JOIN users h ON h.id = sh.handover_to LEFT JOIN users cb ON cb.id = sh.closed_by`;

async function getShift(id, user) {
  const r = (await query(`${SQL} WHERE sh.id = $1`, [id])).rows[0];
  if (!r || (!isManager(user) && r.user_id !== user.id)) throw notFound('Shift not found.');
  return map(r, r.status === 'open' ? await shiftSummary(query, r) : null);
}

/** The signed-in person's open shift (or null), plus a suggested float: what the last closed shift left in the drawer. */
async function currentShift(user) {
  const r = (await query(`${SQL} WHERE sh.user_id = $1 AND sh.status = 'open'`, [user.id])).rows[0];
  const last = (await query(`SELECT counted_cash FROM shifts WHERE status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT 1`)).rows[0];
  return { shift: r ? map(r, await shiftSummary(query, r)) : null, suggestedOpeningCash: last ? last.counted_cash : 0 };
}

async function openShift(user, { openingCash }) {
  try {
    const r = (await query('INSERT INTO shifts (user_id, opening_cash) VALUES ($1,$2) RETURNING id', [user.id, openingCash])).rows[0];
    return getShift(r.id, user);
  } catch (err) {
    if (err.code === '23505') throw conflict('You already have an open shift. Close it before starting another.', { code: 'SHIFT_ALREADY_OPEN' });
    throw err;
  }
}

/** Closes a shift: the cashier closes their own; a manager or owner may close anyone's (the record shows who). */
async function closeShift(user, id, { countedCash, notes, handoverTo, handoverNote }) {
  const out = await withTransaction(async (client) => {
    const q = client.query.bind(client);
    const sh = (await q('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!sh || (!isManager(user) && sh.user_id !== user.id)) throw notFound('Shift not found.');
    if (sh.status === 'closed') throw conflict('This shift is already closed.', { code: 'SHIFT_CLOSED' });
    if (handoverTo) {
      if (handoverTo === sh.user_id) throw badRequest('Hand over to a different person.');
      const to = (await q('SELECT id FROM users WHERE id = $1 AND is_active', [handoverTo])).rows[0];
      if (!to) throw badRequest('The person you are handing over to is not an active member of this business.');
    }
    const until = new Date();
    const summary = await shiftSummary(q, sh, until);
    const variance = r2(countedCash - summary.expectedCash);
    if (variance !== 0 && !(notes && notes.trim())) throw badRequest(`The drawer is ₹${Math.abs(variance)} ${variance < 0 ? 'short' : 'over'}. Add a note explaining the difference.`, { code: 'VARIANCE_NEEDS_NOTE', variance, expectedCash: summary.expectedCash });
    await q(
      `UPDATE shifts SET status = 'closed', closed_at = $2, closed_by = $3, expected_cash = $4, counted_cash = $5, variance = $6, summary = $7, notes = $8, handover_to = $9, handover_note = $10 WHERE id = $1`,
      [id, until, user.id, summary.expectedCash, countedCash, variance, JSON.stringify(summary), notes ? notes.trim() : null, handoverTo || null, handoverNote ? handoverNote.trim() : null],
    );
    const bd = { cashSales: summary.cashSales, cashCreditPayments: summary.cashCreditPayments, cashRefunds: summary.cashRefunds };
    await q(
      `INSERT INTO cash_reconciliations (business_date, shift_id, opening_cash, expected_cash, actual_cash, variance, breakdown, notes, reconciled_by)
       VALUES (($1::timestamptz AT TIME ZONE $2)::date, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [until, require('../config').storeTz, id, sh.opening_cash, summary.expectedCash, countedCash, variance, JSON.stringify(bd), notes ? notes.trim() : null, user.id],
    );
    return { id, variance };
  });
  return getShift(out.id, user);
}

async function listShifts(user, { status, userId, from, to, page = 1, limit = 25 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (!isManager(user)) where.push(`sh.user_id = ${p(user.id)}`);
  else if (userId) where.push(`sh.user_id = ${p(userId)}`);
  if (status) where.push(`sh.status = ${p(status)}`);
  if (from) where.push(`sh.opened_at >= ${p(from)}::date`);
  if (to) where.push(`sh.opened_at < (${p(to)}::date + 1)`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query(`SELECT COUNT(*)::int AS n FROM shifts sh ${w}`, params)).rows[0].n;
  const rows = (await query(`${SQL} ${w} ORDER BY sh.opened_at DESC, sh.id DESC LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`, params)).rows;
  const out = [];
  for (const r of rows) {
    const m = map(r, r.status === 'open' ? await shiftSummary(query, r) : null);
    out.push({ ...m, summary: undefined, salesCount: m.summary ? m.summary.sales.count : 0, netSales: m.summary ? m.summary.sales.netSales : 0 });
  }
  return { total, page, limit, rows: out };
}

module.exports = { openShift, closeShift, currentShift, getShift, listShifts, shiftSummary, forbidden };
