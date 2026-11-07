// Profit-leak detection: deterministic checks on cost, price, discounts and the per-line snapshots saved at sale time (Sprint 1).
// Every finding shows the numbers behind it. Nothing here is a prediction.
const { query } = require('../../db');
const config = require('../../config');
const { r2 } = require('../../utils/dates');

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const NET_PRICE = `(CASE WHEN p.price_includes_tax THEN p.selling_price * 100.0 / (100 + c.tax_rate) ELSE p.selling_price END)`;

async function profitLeaks({ days = 30, thinMarginPct = 8 } = {}) {
  const tz = config.storeTz;
  const win = `(s.created_at AT TIME ZONE $1)::date >= (now() AT TIME ZONE $1)::date - $2::int`;
  const [below, thin, realized, creep, disc, cashiers, estimated] = await Promise.all([
    // 1. Priced below cost right now (price excluding GST vs purchase price)
    query(`SELECT p.id, p.name, p.purchase_price, p.selling_price, ${NET_PRICE} AS net_price, p.stock
             FROM products p JOIN categories c ON c.id = p.category_id WHERE p.is_active AND ${NET_PRICE} < p.purchase_price ORDER BY (${NET_PRICE} - p.purchase_price)`),
    // 2. Thin but positive margin on things that actually sell
    query(`SELECT p.id, p.name, p.purchase_price, ${NET_PRICE} AS net_price, COALESCE(SUM(si.quantity),0) AS units, COALESCE(SUM(COALESCE(si.taxable_value, si.total)),0) AS revenue
             FROM products p JOIN categories c ON c.id = p.category_id
             JOIN sale_items si ON si.product_id = p.id JOIN sales s ON s.id = si.sale_id AND s.status = 'completed' AND ${win}
            WHERE p.is_active AND ${NET_PRICE} >= p.purchase_price AND p.purchase_price > 0 AND (${NET_PRICE} - p.purchase_price) * 100.0 / ${NET_PRICE} < $3
            GROUP BY p.id, c.tax_rate`, [tz, days, thinMarginPct]),
    // 3. Lines that were actually sold at a loss (snapshot cost; lines with an estimated cost are left out)
    query(`SELECT p.id, p.name, COUNT(*)::int AS lines, SUM(si.quantity) AS units,
                  SUM(si.unit_cost * si.quantity - COALESCE(si.taxable_value, si.total - si.discount_share)) AS loss, SUM(si.discount_share) AS discount
             FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.status = 'completed' AND ${win} JOIN products p ON p.id = si.product_id
            WHERE si.cost_source = 'snapshot' AND si.unit_cost * si.quantity > COALESCE(si.taxable_value, si.total - si.discount_share) + 0.005
            GROUP BY p.id ORDER BY loss DESC`, [tz, days]),
    // 4. Cost went up and the margin has not been repaired: latest vs previous cost
    query(`WITH ranked AS (SELECT product_id, cost, effective_at, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY effective_at DESC, id DESC) rn FROM product_cost_history)
           SELECT p.id, p.name, n.cost AS new_cost, o.cost AS old_cost, n.effective_at, ${NET_PRICE} AS net_price
             FROM ranked n JOIN ranked o ON o.product_id = n.product_id AND o.rn = 2 JOIN products p ON p.id = n.product_id JOIN categories c ON c.id = p.category_id
            WHERE n.rn = 1 AND p.is_active AND o.cost > 0 AND n.cost >= o.cost * 1.03 AND n.effective_at >= now() - ($1::int * interval '1 day')`, [Math.max(days, 30)]),
    // 5. Discount totals in the window
    query(`SELECT COALESCE(SUM(s.discount),0) AS discount, COALESCE(SUM(s.subtotal),0) AS gross, COUNT(*) FILTER (WHERE s.discount > 0)::int AS discounted, COUNT(*)::int AS n
             FROM sales s WHERE s.status = 'completed' AND ${win}`, [tz, days]),
    query(`SELECT u.id, u.name, COUNT(*)::int AS n, COALESCE(SUM(s.discount),0) AS discount, COALESCE(SUM(s.subtotal),0) AS gross
             FROM sales s JOIN users u ON u.id = s.employee_id WHERE s.status = 'completed' AND ${win} GROUP BY u.id, u.name`, [tz, days]),
    query(`SELECT COUNT(*)::int AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.status = 'completed' AND ${win} WHERE si.cost_source <> 'snapshot'`, [tz, days]),
  ]);

  const leaks = [];
  for (const r of below.rows) {
    const perUnit = r2(r.purchase_price - r.net_price);
    leaks.push({ type: 'below_cost', severity: 'critical', productId: r.id, name: r.name, title: `${r.name} is priced below its cost`, detail: `Sells for ₹${r2(r.net_price)} (excluding GST) but costs ₹${r.purchase_price}: a loss of ₹${perUnit} on every unit.`, amount: r2(perUnit * Math.max(r.stock, 0)), amountBasis: 'loss if the current stock sells at today\'s price', evidence: { sellingPrice: r.selling_price, netPrice: r2(r.net_price), cost: r.purchase_price, stock: r.stock }, action: 'Raise the selling price or correct the cost.', route: '/products' });
  }
  const belowIds = new Set(below.rows.map((r) => r.id));
  for (const r of realized.rows) {
    leaks.push({ type: 'sold_at_a_loss', severity: r.loss >= 500 ? 'high' : 'medium', productId: r.id, name: r.name, title: `${r.name} was sold below cost ${r.lines} time${r.lines === 1 ? '' : 's'}`, detail: `In the last ${days} days ${r.units} units went out below cost${r.discount > 0 ? ' (discounts were applied)' : ''}: ₹${r2(r.loss)} lost.`, amount: r2(r.loss), amountBasis: `realised loss in the last ${days} days, from the cost saved on each sale`, evidence: { lines: r.lines, units: r.units, discountGiven: r2(r.discount) }, action: 'Limit discounts on this item or fix its price.', route: '/sales' });
  }
  for (const r of thin.rows) {
    if (belowIds.has(r.id)) continue;
    const pct = Math.round(((r.net_price - r.purchase_price) * 1000) / r.net_price) / 10;
    leaks.push({ type: 'thin_margin', severity: 'medium', productId: r.id, name: r.name, title: `${r.name} earns only ${pct}% margin`, detail: `₹${r2(r.net_price - r.purchase_price)} per unit on ₹${r2(r.net_price)}. It sold ${r.units} units in ${days} days, so a small cost rise would wipe the profit out.`, amount: r2(r.revenue), amountBasis: `revenue (excl. GST) at this thin margin in the last ${days} days`, evidence: { marginPct: pct, unitsSold: r.units }, action: 'Check whether the price can go up a little, or negotiate the cost.', route: '/products' });
  }
  for (const r of creep.rows) {
    if (belowIds.has(r.id) || r.net_price <= 0) continue;
    const oldPct = ((r.net_price - r.old_cost) * 100) / r.net_price;
    const newPct = ((r.net_price - r.new_cost) * 100) / r.net_price;
    if (oldPct - newPct < 3) continue;
    leaks.push({ type: 'cost_increase', severity: newPct < 0 ? 'high' : 'medium', productId: r.id, name: r.name, title: `${r.name}: cost rose ${Math.round(((r.new_cost - r.old_cost) * 1000) / r.old_cost) / 10}% and the price did not follow`, detail: `Cost ₹${r.old_cost} → ₹${r.new_cost}. Margin at today's selling price fell from ${Math.round(oldPct * 10) / 10}% to ${Math.round(newPct * 10) / 10}%.`, amount: r2(r.new_cost - r.old_cost), amountBasis: 'extra cost per unit', evidence: { oldCost: r.old_cost, newCost: r.new_cost, oldMarginPct: Math.round(oldPct * 10) / 10, newMarginPct: Math.round(newPct * 10) / 10 }, action: 'Review the selling price or ask another supplier for a quote.', route: '/products' });
  }
  const d = disc.rows[0];
  const shopRate = d.gross > 0 ? d.discount / d.gross : 0;
  for (const c of cashiers.rows) {
    const rate = c.gross > 0 ? c.discount / c.gross : 0;
    if (c.n >= 10 && c.discount >= 200 && shopRate > 0 && rate >= shopRate * 2 && rate >= 0.03) {
      leaks.push({ type: 'discount_outlier', severity: 'medium', name: c.name, title: `${c.name} gives discounts at ${Math.round(rate * 1000) / 10}% of sales — ${Math.round((rate / shopRate) * 10) / 10}× the shop average`, detail: `₹${r2(c.discount)} discounted over ${c.n} bills in ${days} days (shop average ${Math.round(shopRate * 1000) / 10}%).`, amount: r2(c.discount), amountBasis: `discounts given in the last ${days} days`, evidence: { cashierRatePct: Math.round(rate * 1000) / 10, shopRatePct: Math.round(shopRate * 1000) / 10, bills: c.n }, action: 'Review this cashier\'s discounts in the audit trail. This is a pattern to look at, not proof of wrongdoing.', route: '/audit' });
    }
  }
  leaks.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.amount - a.amount);
  return {
    windowDays: days, thinMarginPct,
    summary: { findings: leaks.length, realizedLoss: r2(realized.rows.reduce((a, r) => a + r.loss, 0)), discountsGiven: r2(d.discount), discountPct: d.gross > 0 ? Math.round(shopRate * 1000) / 10 : 0, discountedBills: d.discounted, bills: d.n },
    leaks,
    notes: [`Realised losses use the cost saved on each sale line. ${estimated.rows[0].n} line${estimated.rows[0].n === 1 ? '' : 's'} in this window use an estimated cost (from before cost snapshots existed) and are left out of loss counts.`],
  };
}

module.exports = { profitLeaks };
