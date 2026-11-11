// Supplier intelligence from purchase orders, receipts, supplier quotes and price history. Rates are shown with their sample size;
// nothing is scored when there is too little data. All rule-based — no model.
const { query } = require('../../db');
const config = require('../../config');
const { todayLocal, daysBetween, r2 } = require('../../utils/dates');
const { getProductStats } = require('../forecast');

const MIN_SAMPLE = 3;                    // orders needed before a supplier's delivery record is judged
const pct = (a, b) => (b > 0 ? Math.round((a * 1000) / b) / 10 : null);

async function supplierIntelligence({ days = 90 } = {}) {
  const tz = config.storeTz;
  const today = await todayLocal();
  const [perSupplier, receivedPos, overdue, priceRows, quotes, bought, stats, extras, topBought] = await Promise.all([
    query(`SELECT s.id, s.name, COUNT(DISTINCT po.id)::int AS orders,
                  COALESCE(SUM(i.received_qty * i.unit_cost),0) AS spend,
                  COALESCE(SUM(i.ordered_qty) FILTER (WHERE po.status = 'received'),0) AS ordered_done, COALESCE(SUM(i.received_qty) FILTER (WHERE po.status = 'received'),0) AS received_done,
                  COALESCE(SUM(i.rejected_qty) FILTER (WHERE po.status IN ('received','partially_received')),0) AS rejected, COALESCE(SUM(i.received_qty) FILTER (WHERE po.status IN ('received','partially_received')),0) AS received_all
             FROM suppliers s JOIN purchase_orders po ON po.supplier_id = s.id AND po.status IN ('ordered','partially_received','received') AND po.ordered_at >= now() - ($1::int * interval '1 day')
             JOIN purchase_order_items i ON i.purchase_order_id = po.id GROUP BY s.id ORDER BY spend DESC`, [days]),
    query(`SELECT po.supplier_id, COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE po.expected_date IS NOT NULL AND (po.closed_at AT TIME ZONE $2)::date <= po.expected_date)::int AS on_time
             FROM purchase_orders po WHERE po.status = 'received' AND po.closed_at IS NOT NULL AND po.ordered_at >= now() - ($1::int * interval '1 day') GROUP BY po.supplier_id`, [days, tz]),
    query(`SELECT po.id, po.po_number, po.expected_date::text AS expected, s.name AS supplier, s.id AS supplier_id,
                  COALESCE(SUM((i.ordered_qty - i.received_qty) * i.unit_cost),0) AS outstanding_value
             FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN purchase_order_items i ON i.purchase_order_id = po.id
            WHERE po.status IN ('ordered','partially_received') AND po.expected_date < $1::date GROUP BY po.id, s.id, s.name`, [today]),
    query(`WITH r AS (SELECT supplier_id, product_id, unit_cost, recorded_at, id, ROW_NUMBER() OVER (PARTITION BY supplier_id, product_id ORDER BY recorded_at DESC, id DESC) rn FROM supplier_price_history)
           SELECT n.supplier_id, s.name AS supplier, n.product_id, p.name AS product, n.unit_cost AS new_cost, o.unit_cost AS old_cost
             FROM r n
             JOIN LATERAL (SELECT h.unit_cost FROM r h WHERE h.supplier_id = n.supplier_id AND h.product_id = n.product_id AND h.rn > 1 AND h.unit_cost <> n.unit_cost ORDER BY h.rn LIMIT 1) o ON true
             JOIN suppliers s ON s.id = n.supplier_id JOIN products p ON p.id = n.product_id
            WHERE n.rn = 1 AND o.unit_cost > 0 AND n.unit_cost >= o.unit_cost * 1.05 AND p.is_active
              AND EXISTS (SELECT 1 FROM supplier_price_history h2 WHERE h2.supplier_id = n.supplier_id AND h2.product_id = n.product_id AND h2.unit_cost = n.unit_cost AND h2.recorded_at >= now() - ($1::int * interval '1 day'))`, [days]),
    query(`SELECT sp.product_id, p.name AS product, p.unit, p.supplier_id AS main_supplier_id, sp.supplier_id, s.name AS supplier, sp.last_cost, sp.is_preferred
             FROM supplier_products sp JOIN products p ON p.id = sp.product_id JOIN suppliers s ON s.id = sp.supplier_id
            WHERE sp.last_cost IS NOT NULL AND s.is_active AND p.is_active`),
    query(`SELECT gi.product_id, COALESCE(SUM(gi.quantity),0) AS units
             FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.goods_receipt_id WHERE g.received_at >= now() - ($1::int * interval '1 day') GROUP BY 1`, [days]),
    getProductStats(),
    // Phase 9: pending orders, last purchase and average cost per received unit, straight from the same purchase tables.
    query(`SELECT po.supplier_id, COUNT(DISTINCT po.id) FILTER (WHERE po.status IN ('ordered','partially_received'))::int AS pending,
                  MAX(po.ordered_at) FILTER (WHERE po.status IN ('ordered','partially_received','received')) AS last_purchase,
                  COALESCE(SUM(i.received_qty * i.unit_cost) FILTER (WHERE po.status IN ('partially_received','received') AND po.ordered_at >= now() - ($1::int * interval '1 day')), 0) AS value_in,
                  COALESCE(SUM(i.received_qty) FILTER (WHERE po.status IN ('partially_received','received') AND po.ordered_at >= now() - ($1::int * interval '1 day')), 0) AS units_in
             FROM purchase_orders po LEFT JOIN purchase_order_items i ON i.purchase_order_id = po.id GROUP BY po.supplier_id`, [days]),
    query(`SELECT DISTINCT ON (po.supplier_id) po.supplier_id, p.name AS product, SUM(i.received_qty) OVER (PARTITION BY po.supplier_id, i.product_id) AS units
             FROM purchase_orders po JOIN purchase_order_items i ON i.purchase_order_id = po.id JOIN products p ON p.id = i.product_id
            WHERE po.status IN ('partially_received','received') AND po.ordered_at >= now() - ($1::int * interval '1 day') AND i.received_qty > 0
            ORDER BY po.supplier_id, SUM(i.received_qty) OVER (PARTITION BY po.supplier_id, i.product_id) DESC`, [days]),
  ]);
  const extra = new Map(extras.rows.map((r) => [r.supplier_id, r]));
  const top = new Map(topBought.rows.map((r) => [r.supplier_id, r]));

  const onTime = new Map(receivedPos.rows.map((r) => [r.supplier_id, r]));
  const suppliers = perSupplier.rows.map((r) => {
    const t = onTime.get(r.id) || { n: 0, on_time: 0 };
    const enough = t.n >= MIN_SAMPLE;
    const x = extra.get(r.id) || {}; const tp = top.get(r.id);
    return { pendingOrders: x.pending || 0, lastPurchase: x.last_purchase || null, avgUnitCost: Number(x.units_in) > 0 ? r2(Number(x.value_in) / Number(x.units_in)) : null, mostPurchased: tp ? { product: tp.product, units: Number(tp.units) } : null, supplierId: r.id, name: r.name, orders: r.orders, completedOrders: t.n, spend: r2(r.spend), onTimePct: pct(t.on_time, t.n), fillRatePct: pct(r.received_done, r.ordered_done), rejectionPct: pct(r.rejected, r.rejected + r.received_all), enoughData: enough, note: enough ? null : `Only ${t.n} completed order${t.n === 1 ? '' : 's'} so far — not enough to judge delivery (needs ${MIN_SAMPLE}).` };
  });

  const actions = [];
  for (const s of suppliers) {
    if (!s.enoughData) continue;
    if (s.onTimePct !== null && s.onTimePct < 70) actions.push({ type: 'late_supplier', severity: 'medium', supplierId: s.supplierId, title: `${s.name} delivered on time only ${s.onTimePct}% of the time`, detail: `${s.completedOrders} completed orders in ${days} days. Order earlier, or ask for a firm delivery date.`, amount: s.spend, amountBasis: `spend with this supplier in ${days} days`, route: '/purchasing' });
    if (s.fillRatePct !== null && s.fillRatePct < 85) actions.push({ type: 'low_fill_rate', severity: 'medium', supplierId: s.supplierId, title: `${s.name} delivered only ${s.fillRatePct}% of what you ordered`, detail: `Short supply on completed orders in ${days} days. Check whether another supplier can cover the gap.`, amount: s.spend, amountBasis: `spend with this supplier in ${days} days`, route: '/purchasing' });
    if (s.rejectionPct !== null && s.rejectionPct >= 5) actions.push({ type: 'high_rejections', severity: 'medium', supplierId: s.supplierId, title: `${s.rejectionPct}% of goods from ${s.name} were rejected`, detail: 'Raise the quality issue and ask for replacements or a credit note.', amount: s.spend, amountBasis: `spend with this supplier in ${days} days`, route: '/purchasing' });
  }
  for (const o of overdue.rows) {
    const late = daysBetween(o.expected, today);
    actions.push({ type: 'overdue_order', severity: late >= 7 ? 'high' : 'medium', supplierId: o.supplier_id, title: `${o.po_number} from ${o.supplier} is ${late} day${late === 1 ? '' : 's'} late`, detail: `Expected ${o.expected}; ₹${r2(o.outstanding_value)} of goods still to arrive. Call the supplier or close the order.`, amount: r2(o.outstanding_value), amountBasis: 'value still outstanding', purchaseOrderId: o.id, route: '/purchasing' });
  }
  for (const r of priceRows.rows) {
    actions.push({ type: 'price_increase', severity: 'medium', supplierId: r.supplier_id, productId: r.product_id, title: `${r.supplier} raised the price of ${r.product} by ${Math.round(((r.new_cost - r.old_cost) * 1000) / r.old_cost) / 10}%`, detail: `₹${r.old_cost} → ₹${r.new_cost} per unit.`, amount: r2(r.new_cost - r.old_cost), amountBasis: 'extra cost per unit', route: '/purchasing' });
  }
  // Cheaper alternative: another active supplier's last quoted cost is at least 3% below the product's main supplier.
  const boughtBy = new Map(bought.rows.map((r) => [r.product_id, r.units]));
  const byProduct = new Map();
  for (const q of quotes.rows) { if (!byProduct.has(q.product_id)) byProduct.set(q.product_id, []); byProduct.get(q.product_id).push(q); }
  for (const [pid, list] of byProduct) {
    if (list.length < 2) continue;
    const main = list.find((q) => q.supplier_id === list[0].main_supplier_id) || list.find((q) => q.is_preferred);
    if (!main) continue;
    const best = list.filter((q) => q.supplier_id !== main.supplier_id).sort((a, b) => a.last_cost - b.last_cost)[0];
    if (!best || best.last_cost > main.last_cost * 0.97) continue;
    const diff = r2(main.last_cost - best.last_cost);
    const units = boughtBy.get(pid) || 0;
    actions.push({ type: 'cheaper_supplier', severity: 'low', productId: pid, supplierId: best.supplier_id, title: `${best.supplier} quotes ₹${best.last_cost} for ${main.product}; ${main.supplier} charges ₹${main.last_cost}`, detail: `₹${diff} less per ${main.unit}${units > 0 ? `. You received ${units} ${main.unit} in the last ${days} days.` : '.'} Compare quality and delivery before switching.`, amount: r2(diff * units), amountBasis: units > 0 ? `difference × units received in the last ${days} days, if the quote still holds` : 'no purchases in the period', route: '/purchasing' });
  }
  for (const p of stats) {
    if (!p.supplierId && (p.recommendedQty > 0 || p.outOfStock)) actions.push({ type: 'no_supplier', severity: p.outOfStock ? 'high' : 'medium', productId: p.id, title: `${p.name} needs restocking but has no supplier`, detail: 'Set a supplier on the product so a purchase order can be created.', amount: 0, amountBasis: null, route: '/products' });
  }
  const rank = { high: 2, medium: 1, low: 0 };
  actions.sort((a, b) => rank[b.severity] - rank[a.severity] || b.amount - a.amount);
  return { windowDays: days, minSample: MIN_SAMPLE, suppliers, actions };
}

module.exports = { supplierIntelligence, MIN_SAMPLE };
