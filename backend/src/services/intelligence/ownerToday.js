// Owner Today: ONE page that answers "what should I pay attention to today?". It COMPOSES existing systems — it computes no recommendation of its own:
//   business        → the same activity maths as the closing report (dailyOps.activity)
//   needsAttention  → the Action Center list, grouped; plus facts read straight from the books (credit, cash counts)
//   recommendations → actions.todayList (the Action Center), exactly what /intelligence/today returns
//   health / value → measurement metrics (Store Health, verified value)
// Every figure carries a `kind` so the owner can tell what is a fact and what is a guess:
//   actual (counted from your records) · estimated (uses a cost/price assumption) · forecast (a projection) · recommendation (a rule-based suggestion, not a saving).
const config = require('../../config');
const { query } = require('../../db');
const { todayLocal, addDays, r2 } = require('../../utils/dates');
const { activity, dayPredicates } = require('../dailyOps');
const actions = require('./actions');
const credit = require('../credit');
const metrics = require('../measurement/metrics');
const ledger = require('../measurement/ledger');
const { getProductStats } = require('../forecast');
const batches = require('../batches');

const KINDS = {
  actual: 'Counted from your own records.',
  estimated: 'Uses an assumption (e.g. the cost price recorded at sale time).',
  forecast: 'A projection from recent sales. It can be wrong.',
  recommendation: 'A rule-based suggestion. It is not a saving until you act and it is measured.',
};

async function ownerToday({ top = 5 } = {}) {
  const tz = config.storeTz;
  const today = await todayLocal();
  const yesterday = addDays(today, -1);
  const safe = async (label, fn, fallback) => { try { return await fn(); } catch (err) { console.error(`[owner-today] ${label} failed:`, err.message); return fallback; } };
  const warnings = [];
  const [a, y, cust, ac, list, cr, recon, shiftVar, stats, health, value, expiredRep, pendingPo] = await Promise.all([
    activity(query, { ...dayPredicates, params: [tz, today] }),
    activity(query, { ...dayPredicates, params: [tz, yesterday] }),
    query(`SELECT COUNT(DISTINCT s.customer_id)::int AS known, COUNT(*) FILTER (WHERE s.customer_id IS NULL)::int AS walkin
             FROM sales s WHERE s.status IN ('completed','refunded') AND (s.created_at AT TIME ZONE $1)::date = $2::date`, [tz, today]),
    actions.actionCenter({ limit: 200 }),
    actions.todayList({ top }),
    safe('credit', () => credit.summary({ overdueDays: 30 }), null),
    query(`SELECT business_date::text AS date, variance FROM cash_reconciliations WHERE shift_id IS NULL AND variance <> 0 AND business_date >= $1::date - 7 ORDER BY business_date DESC LIMIT 5`, [today]),
    query(`SELECT sh.id, u.name AS cashier, sh.variance, (sh.closed_at AT TIME ZONE $1)::date::text AS date FROM shifts sh JOIN users u ON u.id = sh.user_id
            WHERE sh.status = 'closed' AND sh.variance <> 0 AND sh.closed_at >= now() - interval '7 days' ORDER BY sh.closed_at DESC LIMIT 5`, [tz]),
    safe('stats', () => getProductStats(), []),
    safe('health', () => metrics.storeHealth(), null),
    safe('value', () => ledger.valueSummary({ days: 90 }), null),
    safe('expired', () => batches.expiryReport('expired', 200), { rows: [], counts: { expired: 0 } }),
    safe('purchases', async () => (await query(`SELECT po.po_number, po.status, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
                                                  WHERE po.status IN ('ordered','partially_received') ORDER BY po.id LIMIT 50`)).rows, []),
  ]);
  if (!cr) warnings.push('Could not read udhaar right now.');
  if (!health) warnings.push('Could not compute Store Health right now.');

  const byType = (t) => ac.actions.filter((x) => x.type === t);
  const sum = (arr) => r2(arr.reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const worst = (arr) => ['critical', 'high', 'medium', 'low'].find((s) => arr.some((x) => x.severity === s)) || null;
  const reorder = byType('reorder');
  const critical = reorder.filter((x) => x.severity === 'critical' || x.severity === 'high');
  const expiring = byType('expiry');
  const risk = byType('risk_alerts');
  const suppliers = ac.actions.filter((x) => x.category === 'suppliers');
  const cashDiffs = [
    ...recon.rows.map((r) => ({ when: r.date, who: 'Day count', variance: r.variance })),
    ...shiftVar.rows.map((r) => ({ when: r.date, who: `${r.cashier}'s shift`, variance: r.variance, shiftId: r.id })),
  ];
  // Phase 9: counts straight from the stock rules (reorder level / batches / open purchase orders). Recommendations only — nothing is ordered here.
  const needRestock = stats.filter((p) => p.needsReorder);
  const expiredRows = expiredRep.rows;
  const attn = [
    { key: 'restock', label: 'Products to restock', kind: 'actual', count: needRestock.length, severity: needRestock.length ? 'medium' : null, detail: needRestock.length ? `${needRestock.length} product${needRestock.length === 1 ? '' : 's'} need restocking (at or below the reorder level).` : 'Nothing is below its reorder level.', items: needRestock.slice(0, 3).map((p) => `${p.name}: ${p.stock} left, suggested order ${p.suggestedReorderQty}`), to: '/inventory?view=reorder' },
    { key: 'expired', label: 'Expired stock', kind: 'actual', count: expiredRows.length, severity: expiredRows.length ? 'high' : null, detail: expiredRows.length ? `${expiredRows.length} expired batch/product line${expiredRows.length === 1 ? '' : 's'} (₹${sum(expiredRows.map((r) => ({ amount: r.atRiskValue })))} at cost). Remove with an "expired" stock adjustment.` : 'Nothing has expired.', items: expiredRows.slice(0, 3).map((r) => `${r.name}${r.batchNo ? ` · batch ${r.batchNo}` : ''}: ${r.quantity} ${r.unit}`), to: '/inventory?view=expiry' },
    { key: 'purchases', label: 'Purchases awaiting receiving', kind: 'actual', count: pendingPo.length, severity: pendingPo.length ? 'low' : null, detail: pendingPo.length ? `${pendingPo.length} order${pendingPo.length === 1 ? '' : 's'} not fully received${pendingPo[0].po_number ? ` — ${pendingPo[0].po_number} (${pendingPo[0].supplier}) is the oldest` : ''}.` : 'No orders are waiting to be received.', to: '/purchasing' },
    { key: 'critical_stock', label: 'Critical stock', kind: 'actual', count: critical.length, severity: worst(critical), detail: critical.length ? `${critical.filter((x) => x.severity === 'critical').length} out of stock, ${critical.filter((x) => x.severity === 'high').length} about to run out.` : 'Nothing is out of stock or about to run out.', items: critical.slice(0, 3).map((x) => x.title), to: '/inventory' },
    { key: 'expiring', label: 'Expiring items', kind: 'actual', count: expiring.length, severity: worst(expiring), detail: expiring.length ? `₹${sum(expiring)} of stock expired or expiring within 7 days.` : 'Nothing is expiring this week.', items: expiring.slice(0, 3).map((x) => x.title), to: '/inventory' },
    { key: 'credit', label: 'Outstanding credit (udhaar)', kind: 'actual', count: cr ? cr.debtors : 0, severity: cr && cr.overdueCustomers ? 'medium' : null, detail: cr ? (cr.outstanding > 0 ? `₹${cr.outstanding} owed by ${cr.debtors} customer(s); ₹${cr.overdueAmount} is more than ${cr.overdueDays} days old.` : 'Nobody owes you anything.') : 'Unavailable.', items: cr ? cr.top.slice(0, 3).map((t) => `${t.name} · ₹${t.balance}`) : [], amount: cr ? cr.outstanding : 0, to: '/udhaar' },
    { key: 'unusual', label: 'Unusual activity', kind: 'actual', count: risk.length ? Number((risk[0].evidence && risk[0].evidence.open) || risk.length) : 0, severity: worst(risk), detail: risk.length ? risk[0].title : 'No open risk alerts.', items: [], to: '/risk' },
    { key: 'suppliers', label: 'Supplier issues', kind: 'actual', count: suppliers.length, severity: worst(suppliers), detail: suppliers.length ? suppliers[0].title : 'No supplier problems found.', items: suppliers.slice(0, 3).map((x) => x.title), to: '/purchasing' },
    { key: 'cash', label: 'Cash differences (last 7 days)', kind: 'actual', count: cashDiffs.length, severity: cashDiffs.length ? 'medium' : null, detail: cashDiffs.length ? `${cashDiffs.length} count(s) did not match. Latest: ${cashDiffs[0].who} on ${cashDiffs[0].when}, ${cashDiffs[0].variance < 0 ? 'short' : 'over'} ₹${Math.abs(cashDiffs[0].variance)}.` : 'Every counted drawer matched.', items: cashDiffs.slice(0, 3).map((d) => `${d.who} · ${d.when} · ₹${d.variance}`), to: '/closing' },
  ].map((x) => ({ ...x, needsAction: x.count > 0 && x.severity !== null || (x.key === 'credit' && x.count > 0) }));
  const ORDER = ['critical_stock', 'restock', 'expiring', 'expired', 'credit', 'unusual', 'suppliers', 'purchases', 'cash'];
  attn.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

  const atRisk = stats.filter((p) => p.riskLevel === 'high' && !p.outOfStock);
  const t = a.sales;
  return {
    date: today, timezone: tz, generatedAt: new Date().toISOString(), kinds: KINDS,
    business: {
      kind: 'actual',
      sales: { value: t.netSales, kind: 'actual', note: 'Net of refunds and returns processed today.' },
      grossProfit: { value: t.grossProfit, kind: 'estimated', note: 'Before tax, using the cost recorded on each sale line; returns are taken out.' },
      bills: { value: t.count, kind: 'actual' },
      avgBill: { value: t.avgBill, kind: 'actual' },
      refunds: { value: t.refunds, count: t.refundCount, kind: 'actual' },
      customers: { known: cust.rows[0].known, walkIn: cust.rows[0].walkin, kind: 'actual' },
      payments: a.payments.filter((p) => p.count > 0), kindPayments: 'actual',
      vsYesterday: { netSales: y.sales.netSales, bills: y.sales.count, changePct: y.sales.netSales > 0 ? Math.round(((t.netSales - y.sales.netSales) / y.sales.netSales) * 1000) / 10 : null, kind: 'actual', note: 'Yesterday full day.' },
    },
    needsAttention: attn,
    forecast: { kind: 'forecast', stockoutRiskProducts: atRisk.length, items: atRisk.slice(0, 3).map((p) => ({ id: p.id, name: p.name, stock: p.stock, daysLeft: p.daysToStockout ?? null })), note: 'Products the sales trend says will run out soon.' },
    recommendations: { kind: 'recommendation', ...list },
    health: health && { score: health.score, status: health.status, summary: health.summary },
    value: value && { kind: 'actual', verifiedTotal: value.verifiedTotal, reportedTotal: value.reportedTotal, days: value.days, note: 'Verified = measured from your records after an accepted action.' },
    warnings: [...warnings, ...(ac.warnings || [])],
  };
}

module.exports = { ownerToday, KINDS };
