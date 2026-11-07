// The value ledger. Append-only: balance = Σ(amount × effect). 'verified' value is written only by outcome measurement; a person can add
// 'reported' value (kept separate, never added to verified totals) and the owner can reverse an entry with a reason. Nothing is ever edited.
const { query, withTransaction } = require('../../db');
const { badRequest, notFound, conflict } = require('../../utils/errors');
const { todayLocal, r2 } = require('../../utils/dates');
const config = require('../../config');

const TYPE_LABEL = { recovered_credit: 'Overdue udhaar collected', inventory_released: 'Dead stock sold (at cost)', margin_improvement: 'Margin improvement', cost_saving: 'Supplier cost saving', avoided_loss: 'Avoided loss', recovered_cash: 'Recovered cash', stockout_impact: 'Stockout impact' };
const mapEntry = (r) => ({
  id: r.id, date: r.entry_date, type: r.entry_type, verification: r.verification, effect: r.effect, amount: r.amount, valueType: r.value_type, valueLabel: TYPE_LABEL[r.value_type],
  decisionId: r.decision_id, outcomeId: r.outcome_id, reversesId: r.reverses_id, reference: r.ref_type ? { type: r.ref_type, id: r.ref_id } : null,
  explanation: r.explanation, evidence: r.evidence, by: r.by_name || null, createdAt: r.created_at, category: r.category || null,
});
const SQL = `SELECT v.*, v.entry_date::text AS entry_date, u.name AS by_name, d.category FROM value_ledger v LEFT JOIN users u ON u.id = v.created_by LEFT JOIN action_decisions d ON d.id = v.decision_id`;

async function listEntries({ verification, valueType, from, to, page = 1, limit = 50 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (verification) where.push(`v.verification = ${p(verification)}`);
  if (valueType) where.push(`v.value_type = ${p(valueType)}`);
  if (from) where.push(`v.entry_date >= ${p(from)}::date`);
  if (to) where.push(`v.entry_date <= ${p(to)}::date`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query(`SELECT COUNT(*)::int AS n FROM value_ledger v ${w}`, params)).rows[0].n;
  const rows = (await query(`${SQL} ${w} ORDER BY v.id DESC LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`, params)).rows;
  return { total, page, limit, rows: rows.map(mapEntry) };
}

/** Totals over a window. Verified and user-reported value are never added together. */
async function valueSummary({ days = 90 } = {}) {
  const tz = config.storeTz;
  const since = `(now() AT TIME ZONE $2)::date - $1::int`;
  const base = `FROM value_ledger v LEFT JOIN action_decisions d ON d.id = v.decision_id WHERE v.entry_date >= ${since}`;
  const [totals, byType, byCategory, byMonth] = await Promise.all([
    query(`SELECT v.verification, COALESCE(SUM(v.amount * v.effect),0) AS total, COUNT(*)::int AS entries ${base} GROUP BY 1`, [days, tz]),
    query(`SELECT v.value_type, COALESCE(SUM(v.amount * v.effect),0) AS total ${base} AND v.verification = 'verified' GROUP BY 1 HAVING SUM(v.amount * v.effect) <> 0 ORDER BY 2 DESC`, [days, tz]),
    query(`SELECT COALESCE(d.category, 'uncategorised') AS category, COALESCE(SUM(v.amount * v.effect),0) AS total ${base} AND v.verification = 'verified' GROUP BY 1 HAVING SUM(v.amount * v.effect) <> 0 ORDER BY 2 DESC`, [days, tz]),
    query(`SELECT to_char(date_trunc('month', v.entry_date), 'YYYY-MM') AS month, COALESCE(SUM(v.amount * v.effect) FILTER (WHERE v.verification = 'verified'),0) AS verified,
                  COALESCE(SUM(v.amount * v.effect) FILTER (WHERE v.verification = 'reported'),0) AS reported ${base} GROUP BY 1 ORDER BY 1`, [days, tz]),
  ]);
  const t = (k) => totals.rows.find((r) => r.verification === k);
  let run = 0;
  return {
    days,
    verifiedTotal: r2(t('verified') ? t('verified').total : 0), verifiedEntries: t('verified') ? t('verified').entries : 0,
    reportedTotal: r2(t('reported') ? t('reported').total : 0), reportedEntries: t('reported') ? t('reported').entries : 0,
    byType: byType.rows.map((r) => ({ valueType: r.value_type, label: TYPE_LABEL[r.value_type], total: r2(r.total) })),
    byCategory: byCategory.rows.map((r) => ({ category: r.category, total: r2(r.total) })),
    byMonth: byMonth.rows.map((r) => { run += Number(r.verified); return { month: r.month, verified: r2(r.verified), reported: r2(r.reported), cumulativeVerified: r2(run) }; }),
    note: 'Verified = measured from your own records after an accepted action. Reported = typed in by a person, never counted as verified.',
  };
}

async function recordReported(user, { valueType, amount, explanation, decisionId }) {
  const amt = r2(amount);
  if (!(amt > 0)) throw badRequest('Enter an amount greater than zero.');
  if (decisionId) {
    const d = (await query('SELECT id FROM action_decisions WHERE id = $1', [decisionId])).rows[0];
    if (!d) throw notFound('Decision not found.');
  }
  const date = await todayLocal();
  const id = (await query(
    `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, decision_id, explanation, created_by) VALUES ($1::date,'reported','reported',1,$2,$3,$4,$5,$6) RETURNING id`,
    [date, amt, valueType, decisionId || null, explanation.trim(), user.id],
  )).rows[0].id;
  return mapEntry((await query(`${SQL} WHERE v.id = $1`, [id])).rows[0]);
}

/** Reverses one entry in full with a new row. The original stays. One reversal per entry. */
async function correct(user, entryId, { note }) {
  return withTransaction(async (client) => {
    const q = client.query.bind(client);
    const e = (await q('SELECT * FROM value_ledger WHERE id = $1', [entryId])).rows[0];
    if (!e) throw notFound('Ledger entry not found.');
    if (e.entry_type === 'correction') throw badRequest('A correction cannot itself be corrected. Add a new reported entry if needed.', { code: 'CANNOT_CORRECT_CORRECTION' });
    const dup = (await q('SELECT 1 FROM value_ledger WHERE reverses_id = $1', [entryId])).rows[0];
    if (dup) throw conflict('This entry has already been corrected.', { code: 'ALREADY_CORRECTED' });
    const date = await todayLocal(q);
    const id = (await q(
      `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, decision_id, outcome_id, reverses_id, ref_type, ref_id, explanation, created_by)
       VALUES ($1::date,'correction',$2,-1,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [date, e.verification, e.amount, e.value_type, e.decision_id, e.outcome_id, e.id, e.ref_type, e.ref_id, note.trim(), user.id],
    )).rows[0].id;
    return mapEntry((await q(`${SQL} WHERE v.id = $1`, [id])).rows[0]);
  });
}

module.exports = { listEntries, valueSummary, recordReported, correct, TYPE_LABEL };
