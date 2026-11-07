// Turns an accepted decision's measurement into rows: a new outcome row when the observation changes, and value-ledger entries only for the
// increase (or decrease) in what the records prove. Running it twice in a row writes nothing. A user can never type a verified figure.
const { query, withTransaction } = require('../../db');
const { todayLocal, r2 } = require('../../utils/dates');
const evaluators = require('./evaluators');

/** Re-measures one decision. Safe to call repeatedly. Returns { outcome, ledgerEntries, changed }. */
async function evaluateDecision(user, decisionId) {
  const d = (await query('SELECT * FROM action_decisions WHERE id = $1', [decisionId])).rows[0];
  if (!d || d.decision !== 'accepted') return null;
  const r = await evaluators.evaluate(d);
  return withTransaction(async (client) => {
    const q = client.query.bind(client);
    await q('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [`outcome:${d.business_id}:${d.id}`]);
    const last = (await q('SELECT * FROM action_outcomes WHERE decision_id = $1 ORDER BY id DESC LIMIT 1', [d.id])).rows[0];
    const same = last && last.status === r.status && last.outcome_type === r.outcomeType && last.headline === r.headline && Number(last.measured_amount ?? -1) === Number(r.amount ?? -1);
    let outcomeId = last && last.id;
    if (!same) {
      outcomeId = (await q(
        `INSERT INTO action_outcomes (decision_id, status, outcome_type, headline, explanation, measured_amount, acted, metrics) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [d.id, r.status, r.outcomeType, r.headline.slice(0, 200), r.explanation.slice(0, 600), r.amount, r.acted, JSON.stringify(r.metrics)],
      )).rows[0].id;
    }
    let ledgerEntries = 0;
    if (r.valueType && r.amount !== null) {
      const cur = (await q(
        `SELECT COALESCE(SUM(amount * effect),0) AS net, COUNT(*) FILTER (WHERE reverses_id IS NOT NULL)::int AS disputed
           FROM value_ledger WHERE decision_id = $1 AND value_type = $2 AND verification = 'verified'`, [d.id, r.valueType],
      )).rows[0];
      const net = r2(cur.net);
      if (cur.disputed === 0) {                       // an owner who reversed this value has the last word: it is not re-added
        const date = await todayLocal(q);
        const diff = r2(r.amount - net);
        if (diff > 0) {
          await q(
            `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, decision_id, outcome_id, ref_type, ref_id, explanation, evidence, created_by)
             VALUES ($1::date,'measured','verified',1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [date, diff, r.valueType, d.id, outcomeId, r.ref && r.ref.type, r.ref && r.ref.id, `${r.headline}. ${r.explanation}`.slice(0, 500), JSON.stringify({ ...r.metrics, measuredTotal: r.amount, previouslyCounted: net }), user ? user.id : null],
          );
          ledgerEntries = 1;
        } else if (diff < 0) {
          await q(
            `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, decision_id, outcome_id, explanation, evidence, created_by)
             VALUES ($1::date,'correction','verified',-1,$2,$3,$4,$5,$6,$7,$8)`,
            [date, -diff, r.valueType, d.id, outcomeId, 'Re-measured from the records: the supported amount is now lower than previously counted.', JSON.stringify({ measuredTotal: r.amount, previouslyCounted: net }), user ? user.id : null],
          );
          ledgerEntries = 1;
        }
      }
    }
    const row = (await q('SELECT * FROM action_outcomes WHERE id = $1', [outcomeId])).rows[0];
    return { outcome: row, ledgerEntries, changed: !same };
  });
}

/** Re-measures every accepted decision that is still current: the latest decision for its recommendation, made within 120 days or still pending. */
async function evaluateAll(user) {
  const rows = (await query(
    `WITH latest AS (SELECT DISTINCT ON (action_key) id, decision, decided_at FROM action_decisions ORDER BY action_key, decided_at DESC, id DESC)
     SELECT l.id FROM latest l LEFT JOIN LATERAL (SELECT status FROM action_outcomes o WHERE o.decision_id = l.id ORDER BY o.id DESC LIMIT 1) o ON true
      WHERE l.decision = 'accepted' AND (l.decided_at > now() - interval '120 days' OR o.status IS NULL OR o.status = 'pending')
      ORDER BY l.id LIMIT 500`,
  )).rows;
  const res = { evaluated: 0, newOutcomes: 0, newLedgerEntries: 0, failed: [] };
  for (const { id } of rows) {
    try {
      const e = await evaluateDecision(user, id);
      if (!e) continue;
      res.evaluated += 1; if (e.changed) res.newOutcomes += 1; res.newLedgerEntries += e.ledgerEntries;
    } catch (err) {
      console.error(`[measurement] decision ${id} could not be measured:`, err.message);
      res.failed.push({ decisionId: id, message: 'Could not be measured right now.' });
    }
  }
  return res;
}

module.exports = { evaluateDecision, evaluateAll };
