// Action Center: turns the numbers the system already has into a short, ranked to-do list. Rule-based and deterministic — no AI/ML.
// Priority score = severity weight (critical 100 · high 70 · medium 40 · low 10) + up to 25 points for the rupee amount involved (5 × log10(1 + ₹)).
// Every action says WHY it is on the list and what the rupee figure means, so the owner can check it.
const { query } = require('../../db');
const config = require('../../config');
const { todayLocal, addDays, r2 } = require('../../utils/dates');
const { getProductStats } = require('../forecast');
const credit = require('../credit');
const { inventoryCash } = require('./inventory');
const { profitLeaks } = require('./profitLeaks');
const { supplierIntelligence } = require('./suppliers');

const WEIGHT = { critical: 100, high: 70, medium: 40, low: 10 };
const score = (severity, amount) => Math.round((WEIGHT[severity] + Math.min(25, Math.log10(1 + Math.max(0, amount || 0)) * 5)) * 10) / 10;
const CATEGORIES = ['stock', 'money', 'suppliers', 'profit', 'operations'];

function make(a) {
  return { why: [], amount: 0, amountLabel: null, evidence: {}, ...a, score: score(a.severity, a.amount) };
}

async function stockActions() {
  const out = [];
  for (const p of await getProductStats()) {
    if (p.expiryStatus && p.stock > 0 && (p.expiryStatus === 'expired' || p.expiryStatus === 'within7')) {
      const value = r2(p.stock * p.purchasePrice);
      out.push(make({ id: `expiry:${p.id}`, type: 'expiry', category: 'stock', severity: p.expiryStatus === 'expired' ? 'high' : 'medium', title: p.expiryStatus === 'expired' ? `${p.name} has expired — take it off the shelf` : `${p.name} expires in ${p.daysToExpiry} day${p.daysToExpiry === 1 ? '' : 's'}`, detail: `${p.stock} ${p.unit} in stock (₹${value} at cost). ${p.expiryStatus === 'expired' ? 'Remove it and ask the supplier about a credit note.' : 'Discount it or return it before it expires.'}`, why: [`Expiry date is ${p.expiryStatus === 'expired' ? 'in the past' : `${p.daysToExpiry} days away`}.`], amount: value, amountLabel: 'stock value at cost', route: '/products', cta: 'Open products', evidence: { productId: p.id, stock: p.stock, daysToExpiry: p.daysToExpiry } }));
    }
    if (p.recommendedQty > 0 && (p.outOfStock || p.riskLevel === 'high' || p.lowStock)) {
      const spend = r2(p.recommendedQty * p.purchasePrice);
      out.push(make({ id: `reorder:${p.id}`, type: 'reorder', category: 'stock', severity: p.outOfStock ? 'critical' : p.riskLevel === 'high' ? 'high' : 'medium', title: p.outOfStock ? `${p.name} is out of stock — reorder ${p.recommendedQty}` : `Reorder ${p.name}: ${p.recommendedQty} ${p.unit}`, detail: p.outOfStock ? 'Sales are being lost while it is out of stock.' : `About ${p.daysToStockout ?? '—'} day${p.daysToStockout === 1 ? '' : 's'} of stock left at the forecast sales rate; the supplier needs ${p.leadTimeDays} days.`, why: [`Stock ${p.stock} vs minimum ${p.minimumStock}.`, `Forecast ${p.forecastDaily}/day (moving average — a statistical estimate, not a guarantee).`, ...(p.onOrder ? [`${p.onOrder} already on order is counted.`] : [])], amount: spend, amountLabel: 'cost of the suggested order', route: '/inventory', cta: 'Review restock', evidence: { productId: p.id, stock: p.stock, recommendedQty: p.recommendedQty, supplier: p.supplier } }));
    }
  }
  return out;
}

async function moneyActions() {
  const out = [];
  const debtors = await credit.listDebtors({ overdueDays: 30 });
  for (const d of debtors.slice(0, 5)) {
    out.push(make({ id: `udhaar:${d.customerId}`, type: 'overdue_credit', category: 'money', severity: d.oldestDays > 90 ? 'high' : 'medium', title: `${d.name} owes ₹${d.balance} — oldest ${d.oldestDays} days`, detail: 'Send a friendly WhatsApp reminder (you press send yourself — nothing is sent automatically).', why: [`Oldest unpaid credit bill is ${d.oldestDays} days old (limit for “overdue” is 30 days).`], amount: d.balance, amountLabel: 'amount outstanding', route: '/udhaar', cta: 'Open udhaar', evidence: { customerId: d.customerId, oldestDays: d.oldestDays } }));
  }
  if (debtors.length > 5) {
    const rest = debtors.slice(5);
    const sum = r2(rest.reduce((a, r) => a + r.balance, 0));
    out.push(make({ id: 'udhaar:more', type: 'overdue_credit', category: 'money', severity: 'low', title: `${rest.length} more customers are overdue on credit`, detail: `₹${sum} in total.`, amount: sum, amountLabel: 'amount outstanding', route: '/udhaar', cta: 'Open udhaar' }));
  }
  return out;
}

async function supplierActions() {
  const s = await supplierIntelligence({ days: 90 });
  const out = s.actions.slice(0, 8).map((a, i) => make({ id: `supplier:${a.type}:${a.purchaseOrderId || a.productId || a.supplierId || i}`, type: a.type, category: 'suppliers', severity: a.severity, title: a.title, detail: a.detail, why: [a.amountBasis ? `₹ figure = ${a.amountBasis}.` : 'Based on your purchase and price history.'], amount: a.amount, amountLabel: a.amountBasis, route: a.route, cta: 'Open purchasing', evidence: { supplierId: a.supplierId, productId: a.productId } }));
  const approved = (await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(r.quantity * p.purchase_price),0) AS v FROM restock_orders r JOIN products p ON p.id = r.product_id WHERE r.status = 'approved' AND r.purchase_order_item_id IS NULL`)).rows[0];
  if (approved.n > 0) out.push(make({ id: 'restock:unlinked', type: 'restock_to_po', category: 'suppliers', severity: 'medium', title: `${approved.n} approved restock order${approved.n === 1 ? ' is' : 's are'} not on a purchase order yet`, detail: 'Turn them into supplier purchase orders so the delivery can be tracked.', why: ['Approved but not ordered from a supplier.'], amount: r2(approved.v), amountLabel: 'cost of these restock orders', route: '/purchasing', cta: 'Create purchase orders' }));
  const drafts = (await query(`SELECT COUNT(*)::int AS n FROM purchase_orders WHERE status = 'draft' AND created_at < now() - interval '2 days'`)).rows[0].n;
  if (drafts > 0) out.push(make({ id: 'po:stale-drafts', type: 'stale_draft_po', category: 'suppliers', severity: 'low', title: `${drafts} draft purchase order${drafts === 1 ? ' has' : 's have'} been waiting over 2 days`, detail: 'Place them or cancel them so stock does not run out unnoticed.', why: ['Draft orders do not count as stock on the way once placed late.'], route: '/purchasing', cta: 'Open purchasing' }));
  return out;
}

async function profitActions() {
  const out = [];
  const [leaks, inv] = await Promise.all([profitLeaks({ days: 30 }), inventoryCash({ deadDays: 60 })]);
  for (const l of leaks.leaks.filter((x) => x.severity === 'critical' || x.severity === 'high').slice(0, 5)) {
    out.push(make({ id: `leak:${l.type}:${l.productId || l.name}`, type: l.type, category: 'profit', severity: l.severity, title: l.title, detail: `${l.detail} ${l.action}`, why: [`₹ figure = ${l.amountBasis}.`], amount: l.amount, amountLabel: l.amountBasis, route: l.route, cta: 'Fix now', evidence: l.evidence }));
  }
  const mediums = leaks.leaks.filter((x) => x.severity === 'medium');
  if (mediums.length) out.push(make({ id: 'leak:medium', type: 'profit_review', category: 'profit', severity: 'medium', title: `${mediums.length} margin or discount issue${mediums.length === 1 ? '' : 's'} to review`, detail: mediums.slice(0, 3).map((m) => m.title).join(' · '), why: ['Thin margins, cost increases or unusual discounting found in the last 30 days.'], amount: r2(mediums.reduce((a, m) => a + Math.max(0, m.amount), 0)), amountLabel: 'combined figures above (mixed bases)', route: '/intelligence', cta: 'See profit leaks' }));
  const dead = inv.buckets.dead.value + inv.buckets.expired.value;
  if (dead > 0) {
    out.push(make({ id: 'dead-stock', type: 'dead_stock', category: 'stock', severity: inv.totalValue > 0 && dead / inv.totalValue >= 0.1 ? 'medium' : 'low', title: `₹${r2(dead)} is sitting in ${inv.buckets.dead.products + inv.buckets.expired.products} product${inv.buckets.dead.products + inv.buckets.expired.products === 1 ? '' : 's'} that are not selling`, detail: 'Discount, bundle or return them, and stop reordering.', why: [`${inv.trappedPct}% of your inventory value (at cost) is trapped in dead, expired or excess stock.`], amount: r2(dead), amountLabel: 'stock value at cost (capital at rest, not recoverable money)', route: '/intelligence', cta: 'See dead stock' }));
  }
  return out;
}

async function operationsActions() {
  const out = [];
  const tz = config.storeTz;
  const today = await todayLocal();
  const yesterday = addDays(today, -1);
  const y = (await query(
    `SELECT COUNT(*) FILTER (WHERE s.payment_method = 'cash')::int AS cash_sales,
            EXISTS (SELECT 1 FROM cash_reconciliations r WHERE r.business_date = $2::date AND r.shift_id IS NULL) AS reconciled
       FROM sales s WHERE s.status IN ('completed','refunded') AND (s.created_at AT TIME ZONE $1)::date = $2::date`, [tz, yesterday])).rows[0];
  if (y.cash_sales > 0 && !y.reconciled) out.push(make({ id: `recon:${yesterday}`, type: 'unreconciled_day', category: 'operations', severity: 'medium', title: `Yesterday's cash (${yesterday}) was never counted`, detail: 'Count the drawer and record it so any shortage is caught while it can still be traced.', why: [`${y.cash_sales} cash sales yesterday and no cash reconciliation recorded.`], route: '/closing', cta: 'Reconcile cash' }));
  const open = (await query(`SELECT sh.id, u.name, EXTRACT(EPOCH FROM (now() - sh.opened_at))/3600 AS hours FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.status = 'open' AND sh.opened_at < now() - interval '14 hours'`)).rows;
  for (const s of open) out.push(make({ id: `shift:${s.id}`, type: 'long_shift', category: 'operations', severity: 'medium', title: `${s.name}'s shift has been open for ${Math.floor(s.hours)} hours`, detail: 'Close it with a cash count so the handover is on record.', why: ['A shift left open mixes two days of cash together.'], route: '/shifts', cta: 'Open shifts' }));
  const alerts = (await query(`SELECT COUNT(*)::int AS n FROM anomaly_alerts WHERE status = 'open' AND severity IN ('high','critical')`)).rows[0].n;
  if (alerts > 0) out.push(make({ id: 'risk:open', type: 'risk_alerts', category: 'operations', severity: 'high', title: `${alerts} high-risk sale alert${alerts === 1 ? '' : 's'} need a decision`, detail: 'Review and mark each one as genuine or a problem.', why: ['Open alerts raised by the rule-based sale risk checks.'], route: '/alerts', cta: 'Review alerts', amount: 0 }));
  return out;
}

const SOURCES = [['stock', stockActions], ['money', moneyActions], ['suppliers', supplierActions], ['profit', profitActions], ['operations', operationsActions]];

async function actionCenter({ category = null, limit = 50 } = {}) {
  const warnings = [];
  const parts = await Promise.all(SOURCES.map(async ([name, fn]) => {
    if (category && category !== name && !(category === 'stock' && name === 'profit')) { /* still computed: dead stock lives in the profit source */ }
    try { return await fn(); } catch (err) { console.error(`[action-center] ${name} failed:`, err.message); warnings.push(`Could not check ${name} right now.`); return []; }
  }));
  const seen = new Set();
  let all = parts.flat().filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  all.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, all.filter((a) => a.category === c).length]));
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of all) bySeverity[a.severity] += 1;
  if (category) all = all.filter((a) => a.category === category);
  return { generatedAt: new Date().toISOString(), method: 'Rule-based: fixed thresholds on your own data. Not AI or machine learning.', scoring: 'severity weight (critical 100, high 70, medium 40, low 10) + up to 25 for the rupee amount', total: all.length, counts, bySeverity, warnings, actions: all.slice(0, limit) };
}

/** "What should I do today?" — the top of the Action Center, with a one-line headline. */
async function todayList({ top = 7 } = {}) {
  const ac = await actionCenter({ limit: 200 });
  const list = ac.actions.slice(0, top).map((a, i) => ({ rank: i + 1, ...a }));
  const urgent = ac.bySeverity.critical + ac.bySeverity.high;
  return {
    generatedAt: ac.generatedAt, method: ac.method, scoring: ac.scoring, warnings: ac.warnings, totalActions: ac.total, allClear: ac.total === 0,
    headline: ac.total === 0 ? 'Nothing needs your attention right now.' : `${urgent} urgent and ${ac.total - urgent} other thing${ac.total - urgent === 1 ? '' : 's'} to look at — start with #1.`,
    actions: list,
  };
}

module.exports = { actionCenter, todayList, score, WEIGHT };
