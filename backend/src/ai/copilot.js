// AI BUSINESS COPILOT
//   question -> intent detection -> database query -> structured facts -> deterministic answer
//            -> (optional) LLM rewrites the answer using ONLY those facts -> grounding check -> response
// If the LLM is unconfigured, slow, errors, or writes a number that is not in the facts, the
// deterministic answer is returned instead, so the copilot never invents figures and never goes down.
const config = require('../config');
const { query } = require('../db');
const { complete, isConfigured, AiUnavailableError } = require('./llm');
const { isGrounded } = require('./grounding');
const { getProductStats } = require('../services/forecast');
const { getRestockRecommendations, getInventory, getAlerts } = require('../services/inventory');
const { getSalesAnalytics, getProductAnalytics, getOverview } = require('../services/analytics');
const { listAlerts } = require('../services/risk');
const { listEmployees } = require('../services/employees');
const { listCustomers } = require('../services/customers');

const TZ = config.storeTz;
const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const INTENTS = [
  ['suspicious', /suspicious|fraud|anomal|unusual|flagged|risky transaction|risk center|abnormal/],
  ['improve_inventory', /improve.*(inventory|stock)|inventory (management|tips|advice)|optimi[sz]e.*(inventory|stock)|reduce waste/],
  ['sales_decline', /(why|reason).*(sales|revenue).*(decreas|drop|down|fell|declin|lower|dip|slow)|(sales|revenue).*(decreas|drop|fell|declin|dip)|why.*(sales|revenue)/],
  ['restock', /restock|re-?order|replenish|what (should|do) i (buy|order|purchase)|purchase.*tomorrow|order.*tomorrow/],
  ['stockout', /stock-?out|run(ning)? out|out of stock|low stock|shortage|at risk/],
  ['top_employee', /employee|cashier|staff|who (processed|sold)/],
  ['top_category', /categor/],
  ['slow', /slow|dead stock|not selling|least (sold|selling)|stagnant/],
  ['expiry', /expir|shelf life|spoil/],
  ['customers', /customer|vip|loyal/],
  ['fastest', /fast|best.?sell|top.?sell|highest.?demand|most (sold|popular)|selling the|trending/],
  ['revenue', /revenue|sales today|today|how (are|am) (we|i) doing|summary|overview|brief/],
];

function detectIntent(question) {
  const q = question.toLowerCase();
  for (const [name, re] of INTENTS) if (re.test(q)) return name;
  return 'help';
}

const riskWord = (lvl) => cap(lvl);

// ---------- intent handlers: each returns { facts, answer, why, table?, alerts? } ----------

async function hRestock() {
  const recs = (await getRestockRecommendations()).slice(0, 5);
  if (!recs.length) {
    return { facts: { count: 0 }, answer: 'Nothing needs restocking right now. Every product has enough stock to cover forecast demand over its supplier lead time.', why: ['Stock levels are above forecast demand plus safety stock for all products.'] };
  }
  const items = recs.map((r) => ({ name: r.name, quantity: r.recommendedQty, risk: r.riskLevel, stock: r.stock, leadTimeDays: r.leadTimeDays, avgDailySales: r.avgDailySales, trendPct: r.trendPct, supplier: r.supplier }));
  const lines = items.map((r, i) => `${i + 1}. ${r.name} — ${r.quantity} units\n   Stockout risk: ${riskWord(r.risk)}`);
  return {
    facts: { count: recs.length, items },
    answer: `Based on recent sales (last 28 days, weighted towards the latest 14) and current inventory, I recommend restocking ${recs.length} product${recs.length > 1 ? 's' : ''}:\n\n${lines.join('\n\n')}`,
    why: ['The recommendations are mainly driven by recent demand and supplier lead time.', ...recs.slice(0, 3).map((r) => r.reasons[0] + ' ' + r.reasons[1])],
    table: { columns: ['Product', 'Order qty', 'Stock', 'Lead time', 'Risk'], rows: recs.map((r) => [r.name, r.recommendedQty, r.stock, `${r.leadTimeDays}d`, riskWord(r.riskLevel)]) },
    action: { label: 'Open AI Restock', to: '/inventory?view=restock' },
  };
}

async function hStockout() {
  const stats = (await getProductStats()).filter((p) => p.riskLevel !== 'low').sort((a, b) => b.stockoutRisk - a.stockoutRisk).slice(0, 6);
  if (!stats.length) return { facts: { count: 0 }, answer: 'No products are currently at meaningful risk of running out within their supplier lead time.', why: ['Stockout risk compares current stock with forecast demand during the lead time.'] };
  const items = stats.map((p) => ({ name: p.name, stock: p.stock, daysToStockout: p.daysToStockout, riskPct: Math.round(p.stockoutRisk * 100), level: p.riskLevel, leadTimeDays: p.leadTimeDays }));
  return {
    facts: { count: stats.length, items },
    answer: `${stats.length} product${stats.length > 1 ? 's are' : ' is'} at risk of stocking out before a new order could arrive:\n\n${items.map((p, i) => `${i + 1}. ${p.name} — ${p.stock} in stock, about ${p.daysToStockout ?? '—'} days left\n   Stockout risk: ${p.riskPct}% (${riskWord(p.level)})`).join('\n\n')}`,
    why: ['Risk is the probability that demand during the supplier lead time exceeds current stock, based on recent daily sales and their variability.'],
    table: { columns: ['Product', 'Stock', 'Days left', 'Lead time', 'Risk'], rows: items.map((p) => [p.name, p.stock, p.daysToStockout ?? '—', `${p.leadTimeDays}d`, `${p.riskPct}%`]) },
  };
}

async function hFastest() {
  const stats = [...(await getProductStats())].sort((a, b) => b.avg7 - a.avg7).slice(0, 5);
  const items = stats.map((p) => ({ name: p.name, unitsPerDay: p.avg7, trendPct: p.trendPct, stock: p.stock }));
  return {
    facts: { items },
    answer: `Your fastest-selling products over the last 7 days:\n\n${items.map((p, i) => `${i + 1}. ${p.name} — ${p.unitsPerDay} units/day${p.trendPct >= 10 ? ` (up ${p.trendPct}% on the week before)` : p.trendPct <= -10 ? ` (down ${Math.abs(p.trendPct)}% on the week before)` : ''}`).join('\n')}`,
    why: ['Ranked by average daily units sold over the last 7 complete days.'],
    table: { columns: ['Product', 'Units/day', 'Trend', 'Stock'], rows: items.map((p) => [p.name, p.unitsPerDay, `${p.trendPct > 0 ? '+' : ''}${p.trendPct}%`, p.stock]) },
  };
}

async function hSlow() {
  const a = await getProductAnalytics('30d');
  const items = a.slowMoving.slice(0, 6).map((p) => ({ name: p.name, stock: p.stock, avgDailySales: p.avgDailySales, stockValue: p.stockValue }));
  if (!items.length) return { facts: { count: 0 }, answer: 'No products qualify as slow-moving right now.', why: ['Slow-moving = selling about one unit a day or less while 5 or more units sit in stock.'] };
  const tied = Math.round(a.slowMoving.reduce((s, p) => s + p.stockValue, 0));
  return {
    facts: { items, tiedUpValue: tied },
    answer: `These products are moving slowly while capital is tied up in stock (${inr(tied)} across the top ${a.slowMoving.length}):\n\n${items.map((p, i) => `${i + 1}. ${p.name} — ${p.stock} units, ${p.avgDailySales}/day, ${inr(p.stockValue)} at cost`).join('\n')}\n\nConsider a promotion, bundling, or pausing reorders for these.`,
    why: ['Slow-moving = selling about one unit a day or less while 5 or more units sit in stock.'],
    table: { columns: ['Product', 'Stock', 'Units/day', 'Value at cost'], rows: items.map((p) => [p.name, p.stock, p.avgDailySales, inr(p.stockValue)]) },
  };
}

async function hTopCategory() {
  const s = await getSalesAnalytics('30d');
  const total = s.categories.reduce((a, c) => a + c.revenue, 0);
  const top = s.categories.slice(0, 5).map((c) => ({ name: c.name, revenue: c.revenue, sharePct: total ? Math.round((c.revenue / total) * 100) : 0 }));
  return {
    facts: { windowDays: 30, totalRevenueFromItems: Math.round(total), items: top },
    answer: `${top[0].name} generated the most revenue in the last 30 days: ${inr(top[0].revenue)} (${top[0].sharePct}% of item sales).\n\n${top.map((c, i) => `${i + 1}. ${c.name} — ${inr(c.revenue)} (${c.sharePct}%)`).join('\n')}`,
    why: ['Item sales value (before bill-level discounts and tax) over the last 30 days.'],
    table: { columns: ['Category', 'Revenue', 'Share'], rows: top.map((c) => [c.name, inr(c.revenue), `${c.sharePct}%`]) },
  };
}

async function hTopEmployee() {
  const emps = (await listEmployees(30)).filter((e) => e.transactions > 0).slice(0, 5);
  const items = emps.map((e) => ({ name: e.name, transactions: e.transactions, revenue: e.revenue, avgTransaction: e.avgTransaction, discounts: e.discounts, risk: e.risk }));
  return {
    facts: { windowDays: 30, items },
    answer: `${items[0].name} processed the most sales in the last 30 days: ${inr(items[0].revenue)} across ${items[0].transactions} transactions.\n\n${items.map((e, i) => `${i + 1}. ${e.name} — ${inr(e.revenue)}, ${e.transactions} transactions, avg ${inr(e.avgTransaction)}`).join('\n')}`,
    why: ['Ranked by completed-sale revenue over the last 30 days. Discount usage and risk level are on the Employees page.'],
    table: { columns: ['Employee', 'Revenue', 'Transactions', 'Avg bill', 'Discounts', 'Risk'], rows: items.map((e) => [e.name, inr(e.revenue), e.transactions, inr(e.avgTransaction), inr(e.discounts), cap(e.risk)]) },
  };
}

async function hSuspicious() {
  const alerts = (await listAlerts({ status: 'open', limit: 5 }));
  if (!alerts.length) return { facts: { count: 0 }, answer: 'No open transactions need review. Nothing has been flagged by the risk rules.', why: ['Transactions are scored on discount deviation, bill size, refunds, cancellations and speed.'] };
  const items = alerts.map((a) => ({ saleId: a.saleId, employee: a.employee, bill: a.bill, discount: a.discount, normalRange: a.normalDiscountRange ? `${inr(a.normalDiscountRange[0])}–${inr(a.normalDiscountRange[1])}` : null, riskScore: a.riskScore, severity: a.severity, reason: a.reason }));
  const top = items[0];
  return {
    facts: { openAlerts: alerts.length, items },
    answer: `${alerts.length} transaction${alerts.length > 1 ? 's need' : ' needs'} review. Highest risk:\n\nTransaction #${top.saleId} — ${top.employee}\nBill: ${inr(top.bill)}${top.discount ? `, discount ${inr(top.discount)}${top.normalRange ? ` (normal range ${top.normalRange})` : ''}` : ''}\nRisk: ${top.riskScore}% (${cap(top.severity)})\nReason: ${top.reason}\n\nRecommended action: review the transaction with the cashier.`,
    why: ['Risk scores come from transparent rules (discount vs the cashier’s own history, bill size, refunds, cancellations, speed) — not a machine-learning model.'],
    alerts: alerts.map((a) => ({ id: a.id, saleId: a.saleId, employee: a.employee, riskScore: a.riskScore, severity: a.severity, reason: a.reason, bill: a.bill, discount: a.discount })),
    action: { label: 'Open Risk Center', to: '/risk' },
  };
}

async function hSalesDecline() {
  const dayExpr = `(s.created_at AT TIME ZONE $1)::date`;
  const today = `(now() AT TIME ZONE $1)::date`;
  const cur = `${dayExpr} >= ${today} - 7 AND ${dayExpr} < ${today}`;
  const prev = `${dayExpr} >= ${today} - 14 AND ${dayExpr} < ${today} - 7`;
  const [tot, cats, prods, days] = await Promise.all([
    query(`SELECT COALESCE(SUM(s.total) FILTER (WHERE ${cur}),0) AS cur_rev, COALESCE(SUM(s.total) FILTER (WHERE ${prev}),0) AS prev_rev,
                  COUNT(*) FILTER (WHERE ${cur})::int AS cur_orders, COUNT(*) FILTER (WHERE ${prev})::int AS prev_orders
             FROM sales s WHERE s.status = 'completed' AND ${dayExpr} >= ${today} - 14 AND ${dayExpr} < ${today}`, [TZ]),
    query(`SELECT c.name, COALESCE(SUM(si.total) FILTER (WHERE ${cur}),0) AS cur_rev, COALESCE(SUM(si.total) FILTER (WHERE ${prev}),0) AS prev_rev
             FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id JOIN categories c ON c.id = p.category_id
            WHERE s.status = 'completed' AND ${dayExpr} >= ${today} - 14 AND ${dayExpr} < ${today} GROUP BY c.name`, [TZ]),
    query(`SELECT p.name, p.stock, COALESCE(SUM(si.quantity) FILTER (WHERE ${cur}),0)::numeric AS cur_units, COALESCE(SUM(si.quantity) FILTER (WHERE ${prev}),0)::numeric AS prev_units
             FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
            WHERE s.status = 'completed' AND ${dayExpr} >= ${today} - 14 AND ${dayExpr} < ${today} GROUP BY p.name, p.stock`, [TZ]),
    query(`SELECT ${dayExpr}::text AS d, SUM(s.total) AS rev FROM sales s WHERE s.status = 'completed' AND ${cur} GROUP BY 1 ORDER BY rev ASC LIMIT 1`, [TZ]),
  ]);
  const t = tot.rows[0];
  const change = t.prev_rev > 0 ? Math.round(((t.cur_rev - t.prev_rev) / t.prev_rev) * 1000) / 10 : null;
  const aovCur = t.cur_orders ? t.cur_rev / t.cur_orders : 0;
  const aovPrev = t.prev_orders ? t.prev_rev / t.prev_orders : 0;
  const catDrops = cats.rows.map((c) => ({ name: c.name, change: Math.round(c.cur_rev - c.prev_rev) })).filter((c) => c.change < 0).sort((a, b) => a.change - b.change).slice(0, 3);
  const prodDrops = prods.rows.map((p) => ({ name: p.name, change: p.cur_units - p.prev_units, stock: p.stock })).filter((p) => p.change < 0).sort((a, b) => a.change - b.change).slice(0, 3);
  const facts = {
    last7Revenue: Math.round(t.cur_rev), previous7Revenue: Math.round(t.prev_rev), revenueChangePct: change,
    last7Orders: t.cur_orders, previous7Orders: t.prev_orders, avgOrderValueNow: Math.round(aovCur), avgOrderValuePrev: Math.round(aovPrev),
    categoryDrops: catDrops, productDrops: prodDrops, weakestDay: days.rows[0] ? { date: days.rows[0].d, revenue: Math.round(days.rows[0].rev) } : null,
  };
  if (change === null) return { facts, answer: 'There is not enough history yet to compare this week with the previous week.', why: ['Needs at least 14 days of sales.'] };
  if (change >= 0) {
    return { facts, answer: `Sales did not decrease: revenue over the last 7 complete days was ${inr(t.cur_rev)}, up ${change}% from ${inr(t.prev_rev)} the week before (${t.cur_orders} vs ${t.prev_orders} orders).`, why: ['Compared the last 7 complete days with the 7 days before them; today is excluded because it is incomplete.'] };
  }
  const drivers = [];
  if (t.cur_orders < t.prev_orders) drivers.push(`Fewer orders: ${t.cur_orders} vs ${t.prev_orders} the week before.`);
  if (aovCur < aovPrev * 0.97) drivers.push(`Smaller baskets: average bill ${inr(aovCur)} vs ${inr(aovPrev)}.`);
  catDrops.forEach((c) => drivers.push(`${c.name} revenue fell by ${inr(Math.abs(c.change))}.`));
  prodDrops.forEach((p) => drivers.push(`${p.name} sold ${Math.abs(p.change)} fewer units${p.stock <= 0 ? ' (currently out of stock)' : ''}.`));
  return {
    facts,
    answer: `Revenue over the last 7 complete days was ${inr(t.cur_rev)}, down ${Math.abs(change)}% from ${inr(t.prev_rev)} the week before.\n\nMain drivers:\n${drivers.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
    why: ['Compared the last 7 complete days with the 7 days before them (today excluded). Drivers are the largest measured drops by order count, basket size, category and product.'],
  };
}

async function hImproveInventory() {
  const inv = await getInventory();
  const alerts = await getAlerts();
  const s = inv.summary;
  const recs = (await getRestockRecommendations()).length;
  const facts = { lowStock: s.low, outOfStock: s.out, overstocked: s.overstocked, slowMoving: s.slow, slowValue: Math.round(s.slowValue), restockRecommendations: recs, expiredProducts: s.expiring.expired.products, expiringWithin7: s.expiring.within7.products, expiringWithin7Value: Math.round(s.expiring.within7.value), criticalAlerts: alerts.counts.critical };
  const tips = [];
  if (recs) tips.push(`Approve the ${recs} pending restock recommendation${recs > 1 ? 's' : ''} so fast sellers don’t run out.`);
  if (s.out + s.low) tips.push(`${s.low + s.out} product${s.low + s.out > 1 ? 's are' : ' is'} at or below minimum stock — review reorder points and supplier lead times.`);
  if (s.slow) tips.push(`${s.slow} slow-moving product${s.slow > 1 ? 's hold' : ' holds'} ${inr(s.slowValue)} of stock — run promotions or pause reorders.`);
  if (s.overstocked) tips.push(`${s.overstocked} product${s.overstocked > 1 ? 's are' : ' is'} overstocked (more than 60 days of cover).`);
  if (s.expiring.within7.products || s.expiring.expired.products) tips.push(`${s.expiring.within7.products} product(s) expire within 7 days (${inr(s.expiring.within7.value)}) and ${s.expiring.expired.products} already expired — discount or remove them.`);
  if (!tips.length) tips.push('Inventory looks healthy. Keep reviewing the weekly restock recommendations.');
  return { facts, answer: `Here is where inventory can improve right now:\n\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`, why: ['Based on current stock, minimum thresholds, forecast demand, and expiry dates.'], action: { label: 'Open Inventory', to: '/inventory' } };
}

async function hExpiry() {
  const inv = await getInventory('expiring');
  const e = inv.summary.expiring;
  const items = inv.rows.filter((r) => r.expiryStatus).sort((a, b) => a.daysToExpiry - b.daysToExpiry).slice(0, 6).map((r) => ({ name: r.name, units: r.stock, daysToExpiry: r.daysToExpiry, value: r.stockValue }));
  const facts = { expired: e.expired, within7: e.within7, within30: e.within30, items };
  if (!items.length) return { facts, answer: 'No products are expired or expiring within 30 days.', why: ['Checked expiry dates of all active products.'] };
  return {
    facts,
    answer: `Expiry status: ${e.expired.products} expired, ${e.within7.products} expiring within 7 days (${e.within7.units} units, ${inr(e.within7.value)}), ${e.within30.products} within 30 days.\n\nClosest to expiry:\n${items.map((p, i) => `${i + 1}. ${p.name} — ${p.units} units, ${p.daysToExpiry < 0 ? `expired ${Math.abs(p.daysToExpiry)} day(s) ago` : `${p.daysToExpiry} day(s) left`}`).join('\n')}`,
    why: ['Values are stock at purchase cost.'],
    table: { columns: ['Product', 'Units', 'Days to expiry', 'Value'], rows: items.map((p) => [p.name, p.units, p.daysToExpiry, inr(p.value)]) },
  };
}

async function hCustomers() {
  const c = await listCustomers({ sort: 'spending', limit: 5 });
  const items = c.rows.map((r) => ({ name: r.name, spending: r.spending, orders: r.orders, favoriteCategory: r.favoriteCategory, segment: r.segment }));
  return {
    facts: { segments: c.counts, items },
    answer: `Your most valuable customers by total spending:\n\n${items.map((r, i) => `${i + 1}. ${r.name} — ${inr(r.spending)} over ${r.orders} orders${r.favoriteCategory ? `, favourite: ${r.favoriteCategory}` : ''}`).join('\n')}\n\nSegments: ${c.counts.vip} VIP, ${c.counts.regular} regular, ${c.counts.new} new, ${c.counts.inactive} inactive.`,
    why: ['Segments use only purchase history: spend, order count, recency.'],
    table: { columns: ['Customer', 'Spending', 'Orders', 'Favourite', 'Segment'], rows: items.map((r) => [r.name, inr(r.spending), r.orders, r.favoriteCategory || '—', cap(r.segment)]) },
  };
}

async function hRevenue() {
  const o = await getOverview();
  const k = o.kpis;
  const cmp = o.comparison;
  const facts = { revenueToday: k.revenue, orders: k.orders, avgOrderValue: k.aov, estimatedProfit: k.estimatedProfit, lowStock: k.lowStock, riskAlerts: k.riskAlerts, comparison: cmp, topToday: o.topToday.slice(0, 3) };
  return {
    facts,
    answer: `Today so far: ${inr(k.revenue)} revenue from ${k.orders} orders (average bill ${inr(k.aov)}), estimated profit ${inr(k.estimatedProfit)}.${cmp.revenueChangePct === null ? '' : `\nRevenue is ${cmp.revenueChangePct >= 0 ? 'up' : 'down'} ${Math.abs(cmp.revenueChangePct)}% vs ${cmp.basis}.`}\nTop sellers today: ${o.topToday.slice(0, 3).map((p) => `${p.name} (${p.units})`).join(', ') || '—'}.\n${k.lowStock} products are below minimum stock and ${k.riskAlerts} transactions need review.`,
    why: ['Revenue counts completed sales only. Profit is estimated before tax using current purchase prices.'],
  };
}

function hHelp() {
  return {
    facts: {},
    answer: 'I answer questions about your store’s data. Try one of these:\n\n1. What should I restock tomorrow?\n2. Which products are at risk of stockout?\n3. Which products are selling the fastest?\n4. Why did sales decrease this week?\n5. Show me suspicious transactions.\n6. Which category generated the most revenue?',
    why: ['I look up numbers in your database first, then explain them.'],
  };
}

const HANDLERS = {
  restock: hRestock, stockout: hStockout, fastest: hFastest, slow: hSlow, top_category: hTopCategory, top_employee: hTopEmployee,
  suspicious: hSuspicious, sales_decline: hSalesDecline, improve_inventory: hImproveInventory, expiry: hExpiry, customers: hCustomers, revenue: hRevenue, help: hHelp,
};

const SYSTEM_PROMPT = `You are the business copilot inside SHARKPOS AI, a retail POS. You explain store data to a shop owner.
Rules:
- Use ONLY the facts in the FACTS JSON. Never invent, estimate, or recompute numbers; copy figures exactly as given.
- Be concise and business-oriented (under 130 words). Use plain text, numbered lists where helpful, and the rupee sign for money.
- Do not claim to use machine learning: forecasts are statistical, risk scores are rule-based.
- If the facts are empty or insufficient, say so.
- Do not add a "Why this recommendation?" section; it is added separately.`;

async function ask(question) {
  const intent = detectIntent(question);
  const base = await HANDLERS[intent]();
  const response = {
    question, intent, answer: base.answer, why: base.why || [], table: base.table || null, alerts: base.alerts || null, action: base.action || null,
    source: 'data', notice: null, aiUsed: false,
  };
  if (intent === 'help') return response;

  if (!isConfigured()) {
    response.notice = 'AI language model not configured. Showing data-driven answers.';
    return response;
  }
  try {
    const text = await complete({
      system: SYSTEM_PROMPT,
      user: `QUESTION: ${question}\n\nFACTS (JSON, from the database):\n${JSON.stringify(base.facts)}\n\nBASELINE ANSWER (already correct, you may rephrase and tighten):\n${base.answer}`,
    });
    if (!isGrounded(text, { facts: base.facts, answer: base.answer })) {
      response.notice = 'AI service temporarily unavailable. Showing data-driven recommendations.';
      return response;
    }
    response.answer = text;
    response.source = 'llm';
    response.aiUsed = true;
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) console.error('[copilot] unexpected AI error', err);
    response.notice = 'AI service temporarily unavailable. Showing data-driven recommendations.';
  }
  return response;
}

module.exports = { ask, detectIntent };
