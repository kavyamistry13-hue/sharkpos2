// Recommendation accuracy, Store Health and the ROI view. All deterministic. A percentage is shown only when there is enough data behind it;
// otherwise the field is null and `insufficientData` explains what is missing. Nothing is estimated.
const { query } = require('../../db');
const { r2 } = require('../../utils/dates');
const { getProductStats } = require('../forecast');
const credit = require('../credit');
const actions = require('../intelligence/actions');
const { inventoryCash } = require('../intelligence/inventory');
const { profitLeaks } = require('../intelligence/profitLeaks');
const { supplierIntelligence } = require('../intelligence/suppliers');
const ledger = require('./ledger');

const MIN_DECISIONS = 5;   // before an acceptance rate is shown
const MIN_RESOLVED = 5;    // before a success rate is shown
const pct1 = (a, b) => Math.round((a / b) * 1000) / 10;

async function accuracy({ days = 90 } = {}) {
  const [gen, latest] = await Promise.all([
    query(`SELECT category, COUNT(*)::int AS n FROM recommendation_log WHERE first_seen_at >= now() - ($1::int * interval '1 day') GROUP BY 1`, [days]),
    query(
      `WITH l AS (SELECT DISTINCT ON (action_key) * FROM action_decisions WHERE decided_at >= now() - ($1::int * interval '1 day') ORDER BY action_key, decided_at DESC, id DESC)
       SELECT l.decision, l.category, o.status, o.acted FROM l LEFT JOIN LATERAL (SELECT status, acted FROM action_outcomes x WHERE x.decision_id = l.id ORDER BY x.id DESC LIMIT 1) o ON true`, [days]),
  ]);
  const generated = gen.rows.reduce((a, r) => a + r.n, 0);
  const rows = latest.rows;
  const count = (f) => rows.filter(f).length;
  const accepted = count((r) => r.decision === 'accepted');
  const rejected = count((r) => r.decision === 'rejected');
  const deferred = count((r) => r.decision === 'deferred');
  const decided = accepted + rejected + deferred;
  const acc = rows.filter((r) => r.decision === 'accepted');
  const st = (s) => acc.filter((r) => (r.status || 'pending') === s).length;
  const o = { verified: st('verified'), neutral: st('neutral'), unsuccessful: st('unsuccessful'), pending: st('pending'), notMeasurable: st('not_measurable') + st('unknown') };
  const resolved = o.verified + o.neutral + o.unsuccessful;
  const actedUpon = acc.filter((r) => r.acted).length;
  const byCategory = ['stock', 'money', 'suppliers', 'profit', 'operations'].map((c) => ({
    category: c, generated: (gen.rows.find((r) => r.category === c) || { n: 0 }).n, accepted: count((r) => r.category === c && r.decision === 'accepted'), rejected: count((r) => r.category === c && r.decision === 'rejected'),
    verified: acc.filter((r) => r.category === c && r.status === 'verified').length,
  }));
  return {
    days, generated, decided, accepted, rejected, deferred, undecided: Math.max(0, generated - decided), actedUpon, outcomes: { ...o, resolved }, byCategory,
    acceptanceRate: accepted + rejected >= MIN_DECISIONS ? pct1(accepted, accepted + rejected) : null,
    acceptanceInsufficient: accepted + rejected < MIN_DECISIONS ? `Needs at least ${MIN_DECISIONS} accepted or rejected recommendations to show a rate (have ${accepted + rejected}).` : null,
    successRate: resolved >= MIN_RESOLVED ? pct1(o.verified, resolved) : null,
    successInsufficient: resolved < MIN_RESOLVED ? `Needs at least ${MIN_RESOLVED} measured outcomes to show how often accepted actions worked (have ${resolved}).` : null,
    basis: 'Generated = distinct recommendations shown (once per calendar month). Latest decision per recommendation is counted. Success = verified ÷ (verified + no change + did not work out); pending and not-measurable outcomes are excluded.',
  };
}

const band = (s) => (s >= 80 ? 'healthy' : s >= 60 ? 'needs_attention' : 'at_risk');
const dim = (key, label, weight, score, factors, note) => ({ key, label, weight, available: true, score: Math.max(0, Math.min(100, Math.round(score))), status: band(Math.max(0, Math.min(100, score))), factors, note: note || null });
const na = (key, label, weight, reason) => ({ key, label, weight, available: false, score: null, status: 'not_available', factors: [], note: reason });

async function storeHealth() {
  const warnings = [];
  const safe = async (key, label, weight, fn) => {
    try { return await fn(); } catch (err) { console.error(`[store-health] ${key} failed:`, err.message); warnings.push(`Could not check ${label.toLowerCase()} right now.`); return na(key, label, weight, 'Could not be calculated right now.'); }
  };
  const dims = await Promise.all([
    safe('inventory', 'Inventory health', 25, async () => {
      const [inv, stats] = await Promise.all([inventoryCash({ deadDays: 60 }), getProductStats()]);
      if (!stats.length) return na('inventory', 'Inventory health', 25, 'No products yet.');
      const out = stats.filter((p) => p.outOfStock).length;
      const trapPen = Math.min(70, Math.round(inv.trappedPct * 2));
      const outPen = Math.min(30, out * 5);
      return dim('inventory', 'Inventory health', 25, 100 - trapPen - outPen, [
        { label: `${inv.trappedPct}% of stock value is dead, expired or excess`, impact: -trapPen, detail: '2 points per 1% trapped, up to 70' },
        { label: `${out} product${out === 1 ? '' : 's'} out of stock`, impact: -outPen, detail: '5 points each, up to 30' },
      ]);
    }),
    safe('credit', 'Overdue credit', 20, async () => {
      const s = await credit.summary({ overdueDays: 30 });
      if (s.debtors === 0) return na('credit', 'Overdue credit', 20, 'No udhaar outstanding, so this is left out of the score.');
      const share = s.outstanding > 0 ? s.overdueAmount / s.outstanding : 0;
      const pen = Math.round(share * 100);
      return dim('credit', 'Overdue credit', 20, 100 - pen, [{ label: `${pen}% of udhaar owed (₹${s.overdueAmount} of ₹${s.outstanding}) is more than 30 days old`, impact: -pen, detail: '1 point per 1% overdue' }]);
    }),
    safe('profit', 'Margin and profit leaks', 20, async () => {
      const [l, stats] = await Promise.all([profitLeaks({ days: 30 }), getProductStats()]);
      if (!stats.length) return na('profit', 'Margin and profit leaks', 20, 'No products yet.');
      const c = (s) => l.leaks.filter((x) => x.severity === s).length;
      const pens = [['critical', 25], ['high', 10], ['medium', 4]].map(([s, w]) => ({ label: `${c(s)} ${s} finding${c(s) === 1 ? '' : 's'}`, impact: -Math.min(100, c(s) * w), detail: `${w} points each` })).filter((f) => f.impact !== 0);
      return dim('profit', 'Margin and profit leaks', 20, 100 + pens.reduce((a, f) => a + f.impact, 0), pens.length ? pens : [{ label: 'No profit leaks found in the last 30 days', impact: 0, detail: '' }]);
    }),
    safe('suppliers', 'Supplier performance', 15, async () => {
      const s = await supplierIntelligence({ days: 90 });
      if (!s.suppliers.length) return na('suppliers', 'Supplier performance', 15, 'No suppliers yet.');
      const n = (t) => s.actions.filter((a) => a.type === t).length;
      const verdicts = n('late_supplier') + n('low_fill_rate') + n('high_rejections');
      const f = [{ label: `${n('overdue_order')} overdue order${n('overdue_order') === 1 ? '' : 's'}`, impact: -n('overdue_order') * 15, detail: '15 points each' }, { label: `${verdicts} supplier problem${verdicts === 1 ? '' : 's'} (late, short or rejected goods)`, impact: -verdicts * 10, detail: '10 points each' }, { label: `${n('price_increase')} price rise${n('price_increase') === 1 ? '' : 's'}`, impact: -n('price_increase') * 3, detail: '3 points each' }].filter((x) => x.impact !== 0);
      return dim('suppliers', 'Supplier performance', 15, 100 + f.reduce((a, x) => a + x.impact, 0), f.length ? f : [{ label: 'No supplier problems found', impact: 0, detail: '' }]);
    }),
    safe('operations', 'Operations', 10, async () => {
      const ac = await actions.actionCenter({ limit: 200 });
      const ops = ac.actions.filter((a) => a.category === 'operations');
      const w = { critical: 40, high: 25, medium: 10, low: 5 };
      const f = ops.map((a) => ({ label: a.title, impact: -w[a.severity], detail: `${a.severity}: ${w[a.severity]} points` }));
      return dim('operations', 'Operations', 10, 100 + f.reduce((a, x) => a + x.impact, 0), f.length ? f : [{ label: 'No uncounted cash, long shifts or open risk alerts', impact: 0, detail: '' }]);
    }),
    safe('followThrough', 'Recommendation follow-through', 10, async () => {
      const a = await accuracy({ days: 90 });
      if (a.decided < MIN_DECISIONS) return na('followThrough', 'Recommendation follow-through', 10, `Needs at least ${MIN_DECISIONS} decisions on recommendations (have ${a.decided}); left out of the score until then.`);
      const rate = Math.round((a.accepted / a.decided) * 100);
      return dim('followThrough', 'Recommendation follow-through', 10, rate, [{ label: `${a.accepted} of ${a.decided} recommendations accepted`, impact: rate - 100, detail: 'Score = share accepted' }]);
    }),
  ]);
  const avail = dims.filter((d) => d.available);
  const wSum = avail.reduce((a, d) => a + d.weight, 0);
  const enough = avail.length >= 3;
  const score = enough ? Math.round(avail.reduce((a, d) => a + d.score * d.weight, 0) / wSum) : null;
  return {
    score, status: enough ? band(score) : 'insufficient_data',
    summary: enough ? `Weighted average of ${avail.length} measured areas.` : 'Not enough data yet: at least 3 areas need data before a score is shown.',
    method: 'Rule-based. Each area starts at 100 and loses the points listed in its factors; the overall score is the weighted average of the areas that have data. Areas without data are left out, never scored as perfect. 80+ healthy, 60–79 needs attention, below 60 at risk.',
    dimensions: dims, excluded: dims.filter((d) => !d.available).map((d) => ({ key: d.key, label: d.label, reason: d.note })), warnings,
  };
}

async function roi({ days = 90 } = {}) {
  const [acc, value, health] = await Promise.all([accuracy({ days }), ledger.valueSummary({ days }), storeHealth().catch(() => null)]);
  let verdict; let text;
  if (acc.accepted === 0) { verdict = 'no_actions_yet'; text = 'No recommendations have been accepted yet, so there is nothing to measure.'; }
  else if (value.verifiedTotal > 0) { verdict = 'value_measured'; text = `₹${value.verifiedTotal} of value is verified from ${acc.outcomes.verified} measured outcome${acc.outcomes.verified === 1 ? '' : 's'}. It counts only money visible in your own records after you accepted an action; it does not prove the action alone caused it.`; }
  else if (acc.outcomes.pending > 0) { verdict = 'pending'; text = `${acc.outcomes.pending} accepted action${acc.outcomes.pending === 1 ? ' is' : 's are'} still being measured. No value is claimed yet.`; }
  else { verdict = 'not_yet_proven'; text = 'Accepted actions have no measurable ₹ value so far. Nothing is claimed.'; }
  return {
    days, answer: { verdict, text },
    funnel: { generated: acc.generated, accepted: acc.accepted, rejected: acc.rejected, deferred: acc.deferred, undecided: acc.undecided, actedUpon: acc.actedUpon, outcomes: acc.outcomes },
    rates: { acceptanceRate: acc.acceptanceRate, acceptanceInsufficient: acc.acceptanceInsufficient, successRate: acc.successRate, successInsufficient: acc.successInsufficient },
    value, byCategory: acc.byCategory, health: health && { score: health.score, status: health.status, summary: health.summary },
    definitions: { recommendation: 'A rule-based suggestion on the Action Center. It is not a saving.', action: 'You accepted, rejected or deferred it. Accepting is not a saving either.', outcome: 'What your records show afterwards: verified, pending, no change, did not work out, or not measurable.', verifiedValue: '₹ that your own records support, written to the value ledger by the system only.' },
  };
}

module.exports = { accuracy, storeHealth, roi, MIN_DECISIONS, MIN_RESOLVED };
