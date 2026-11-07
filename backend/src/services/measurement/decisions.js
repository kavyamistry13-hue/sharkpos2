// Accept / reject / defer a recommendation. The recommendation is looked up from the live Action Center on the server and frozen in `snapshot`
// (a client can never supply its own recommendation), and every decision is a new row: changing your mind adds a row, it never edits the old one.
const { query, withTransaction, currentBusinessId } = require('../../db');
const config = require('../../config');
const { notFound, HttpError } = require('../../utils/errors');
const actions = require('../intelligence/actions');
const { captureBaseline } = require('./evaluators');

const OUTCOME_LABEL = { verified: 'Verified outcome', pending: 'Pending measurement', neutral: 'No measurable change', unsuccessful: 'Did not work out', not_measurable: 'Not measurable', unknown: 'Unknown' };

const mapOutcome = (r) => (r && r.o_id ? { id: r.o_id, status: r.o_status, label: OUTCOME_LABEL[r.o_status], type: r.o_type, headline: r.o_headline, explanation: r.o_explanation, measuredAmount: r.o_amount, acted: r.o_acted, metrics: r.o_metrics, evaluatedAt: r.o_at } : null);
const mapDecision = (r) => ({
  id: r.id, actionKey: r.action_key, type: r.action_type, category: r.category, severity: r.severity, decision: r.decision, reason: r.reason,
  decidedBy: r.decided_by ? { id: r.decided_by, name: r.by_name || null } : null, decidedAt: r.decided_at, recommendation: r.snapshot, baseline: r.baseline, outcome: r.decision === 'accepted' ? mapOutcome(r) : null,
});
const SQL = `SELECT d.*, u.name AS by_name, o.id AS o_id, o.status AS o_status, o.outcome_type AS o_type, o.headline AS o_headline, o.explanation AS o_explanation, o.measured_amount AS o_amount, o.acted AS o_acted, o.metrics AS o_metrics, o.evaluated_at AS o_at
               FROM action_decisions d LEFT JOIN users u ON u.id = d.decided_by
               LEFT JOIN LATERAL (SELECT * FROM action_outcomes x WHERE x.decision_id = d.id ORDER BY x.id DESC LIMIT 1) o ON true`;

/** Best-effort: remember that these recommendations were shown, so "generated" can be counted. Never fails the caller. */
async function recordSeen(list) {
  if (!list || !list.length) return;
  try {
    for (const a of list) {
      await query(
        `INSERT INTO recommendation_log (action_key, action_type, category, severity, amount, snapshot, seen_month)
         VALUES ($1,$2,$3,$4,$5,$6, date_trunc('month', now() AT TIME ZONE $7)::date) ON CONFLICT (business_id, action_key, seen_month) DO NOTHING`,
        [a.id, a.type, a.category, a.severity, a.amount || 0, JSON.stringify(a), config.storeTz],
      );
    }
  } catch (err) { console.error('[measurement] recordSeen failed:', err.message); }
}

async function getDecision(id) {
  const r = (await query(`${SQL} WHERE d.id = $1`, [id])).rows[0];
  if (!r) throw notFound('Decision not found.');
  const history = (await query('SELECT id, status, outcome_type, headline, measured_amount, evaluated_at FROM action_outcomes WHERE decision_id = $1 ORDER BY id', [id])).rows;
  const ledger = (await query('SELECT id, entry_date::text AS entry_date, entry_type, verification, effect, amount, value_type, explanation FROM value_ledger WHERE decision_id = $1 ORDER BY id', [id])).rows;
  return { ...mapDecision(r), outcomeHistory: history.map((h) => ({ id: h.id, status: h.status, type: h.outcome_type, headline: h.headline, measuredAmount: h.measured_amount, evaluatedAt: h.evaluated_at })), valueEntries: ledger.map((l) => ({ id: l.id, date: l.entry_date, type: l.entry_type, verification: l.verification, effect: l.effect, amount: l.amount, valueType: l.value_type, explanation: l.explanation })) };
}

/** Returns { decision, duplicate }. The same decision on the same recommendation in the same calendar month is a duplicate and returns the existing row. */
async function recordDecision(user, { actionId, decision, reason }) {
  const note = reason && reason.trim() ? reason.trim() : null;
  const ac = await actions.actionCenter({ limit: 200 });
  const live = ac.actions.find((a) => a.id === actionId);
  const baseline = live ? await captureBaseline(live) : null;
  const out = await withTransaction(async (client) => {
    const q = client.query.bind(client);
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${currentBusinessId()}:${actionId}`]);
    const last = (await q(
      `SELECT id, decision, reason, (decided_at AT TIME ZONE $2)::date >= date_trunc('month', now() AT TIME ZONE $2)::date AS this_month
         FROM action_decisions WHERE action_key = $1 ORDER BY decided_at DESC, id DESC LIMIT 1`, [actionId, config.storeTz],
    )).rows[0];
    if (last && last.this_month && last.decision === decision && (last.reason || null) === note) return { id: last.id, duplicate: true };
    if (!live) throw new HttpError(404, 'This recommendation is no longer on the Action Center, so it cannot be recorded. Refresh the list.', { code: 'ACTION_NOT_FOUND' });
    const ins = (await q(
      `INSERT INTO action_decisions (action_key, action_type, category, severity, decision, reason, snapshot, baseline, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [actionId, live.type, live.category, live.severity, decision, note, JSON.stringify(live), JSON.stringify(baseline), user.id],
    )).rows[0];
    await q(
      `INSERT INTO recommendation_log (action_key, action_type, category, severity, amount, snapshot, seen_month) VALUES ($1,$2,$3,$4,$5,$6, date_trunc('month', now() AT TIME ZONE $7)::date) ON CONFLICT (business_id, action_key, seen_month) DO NOTHING`,
      [actionId, live.type, live.category, live.severity, live.amount || 0, JSON.stringify(live), config.storeTz],
    );
    return { id: ins.id, duplicate: false };
  });
  if (!out.duplicate && decision === 'accepted') {
    try { await require('./outcomes').evaluateDecision(user, out.id); } catch (err) { console.error('[measurement] first evaluation failed:', err.message); }
  }
  return { duplicate: out.duplicate, decision: await getDecision(out.id) };
}

async function listDecisions({ latest = false, decision, category, page = 1, limit = 25 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (latest) where.push('d.id = (SELECT x.id FROM action_decisions x WHERE x.action_key = d.action_key ORDER BY x.decided_at DESC, x.id DESC LIMIT 1)');
  if (decision) where.push(`d.decision = ${p(decision)}`);
  if (category) where.push(`d.category = ${p(category)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query(`SELECT COUNT(*)::int AS n FROM action_decisions d ${w}`, params)).rows[0].n;
  const rows = (await query(`${SQL} ${w} ORDER BY d.decided_at DESC, d.id DESC LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`, params)).rows;
  return { total, page, limit, rows: rows.map(mapDecision) };
}

module.exports = { recordDecision, recordSeen, listDecisions, getDecision, mapDecision, OUTCOME_LABEL };
