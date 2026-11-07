// Outcome measurement. Deterministic: each recommendation type has ONE fixed rule that compares the numbers captured when the action was accepted
// (the baseline) with what the shop's own records show now. A ₹ figure is produced only when a real record supports it; otherwise the outcome is
// pending / neutral / not_measurable. Nothing here estimates, forecasts or "assumes the owner saved money".
const { query } = require('../../db');
const { r2 } = require('../../utils/dates');
const { getProductStats } = require('../forecast');

const DAY = 86400000;
const WINDOW = { udhaar: 30, dead_stock: 30, reorder: 14, margin: 30, supplier_cost: 30, overdue_order: 14, recon: 7 };
const expired = (d, days) => Date.now() - new Date(d.decided_at).getTime() > days * DAY;

const out = (status, outcomeType, headline, explanation, o = {}) => ({ status, outcomeType, headline, explanation, amount: o.amount ?? null, valueType: o.valueType || null, acted: !!o.acted, metrics: o.metrics || {}, ref: o.ref || null });

const NOT_MEASURABLE = {
  expiry: 'Whether clearing expiring stock avoided a loss cannot be proven from the sales and stock records, so no value is claimed.',
  default: 'SHARKPOS has no defensible way to measure the result of this kind of action from your records, so no value is claimed.',
};

const netPrice = (p) => (p.priceIncludesTax ? p.sellingPrice / (1 + (p.taxRate || 0) / 100) : p.sellingPrice);
const marginOf = (p) => r2(netPrice(p) - p.purchasePrice);

/** What to compare against later. Captured server-side at decision time from live data (never taken from the client). */
async function captureBaseline(action) {
  const [kind, ...rest] = String(action.id).split(':');
  const num = (s) => (/^\d+$/.test(s || '') ? Number(s) : null);
  const stats = async () => new Map((await getProductStats()).map((p) => [p.id, p]));
  if (kind === 'udhaar' && num(rest[0])) {
    const bal = (await query(`SELECT COALESCE(SUM(l.amount * l.effect),0) AS b, MAX(c.name) AS name FROM customers c LEFT JOIN credit_ledger l ON l.customer_id = c.id WHERE c.id = $1`, [num(rest[0])])).rows[0];
    return { kind: 'udhaar', customerId: num(rest[0]), name: bal.name, balance: r2(bal.b) };
  }
  if (kind === 'reorder' && num(rest[0])) {
    const p = (await stats()).get(num(rest[0]));
    return p ? { kind: 'reorder', productId: p.id, name: p.name, stock: p.stock, minimumStock: p.minimumStock, purchasePrice: p.purchasePrice } : { kind: 'none' };
  }
  if (action.id === 'dead-stock') {
    const dead = await require('../intelligence/inventory').deadStock({ days: 60, limit: 200 });
    return { kind: 'dead_stock', products: dead.rows.filter((r) => r.stock > 0).map((r) => ({ productId: r.productId, name: r.name, stock: r.stock, cost: r2(r.stockValue / r.stock) })) };
  }
  if (kind === 'leak' && ['below_cost', 'thin_margin', 'sold_at_a_loss', 'cost_increase'].includes(rest[0]) && num(rest[1])) {
    const p = (await stats()).get(num(rest[1]));
    return p ? { kind: 'margin', productId: p.id, name: p.name, marginPerUnit: marginOf(p), netPrice: r2(netPrice(p)), cost: p.purchasePrice } : { kind: 'none' };
  }
  if (kind === 'supplier' && ['price_increase', 'cheaper_supplier'].includes(rest[0]) && num(rest[1])) {
    const p = (await stats()).get(num(rest[1]));
    return p ? { kind: 'supplier_cost', productId: p.id, name: p.name, cost: p.purchasePrice } : { kind: 'none' };
  }
  if (kind === 'supplier' && rest[0] === 'overdue_order' && num(rest[1])) return { kind: 'overdue_order', purchaseOrderId: num(rest[1]) };
  if (kind === 'recon' && /^\d{4}-\d{2}-\d{2}$/.test(rest[0] || '')) return { kind: 'recon', date: rest[0] };
  return { kind: 'none', note: action.type === 'expiry' ? NOT_MEASURABLE.expiry : NOT_MEASURABLE.default };
}

async function udhaar(d, b) {
  const pay = (await query(`SELECT COALESCE(SUM(amount),0) AS total, MAX(id) AS last_id FROM credit_ledger WHERE customer_id = $1 AND entry_type = 'payment' AND created_at > $2`, [b.customerId, d.decided_at])).rows[0];
  const collected = Math.min(r2(pay.total), b.balance);
  if (collected > 0) return out('verified', 'overdue_credit_collected', `₹${collected} collected from ${b.name} after you accepted`, 'Payments recorded in the udhaar ledger after you accepted, capped at what was owed at that time. The ledger proves the money arrived; it does not prove the reminder alone caused it.', { amount: collected, valueType: 'recovered_credit', acted: true, metrics: { owedAtDecision: b.balance, collected }, ref: { type: 'credit_ledger', id: pay.last_id } });
  if (expired(d, WINDOW.udhaar)) return out('neutral', 'overdue_credit_collected', `No payment from ${b.name} in ${WINDOW.udhaar} days`, 'No udhaar payment was recorded in the 30 days after you accepted.', { metrics: { owedAtDecision: b.balance } });
  return out('pending', 'overdue_credit_collected', 'Waiting for a payment', `Measured from udhaar payments recorded after you accepted; checked for ${WINDOW.udhaar} days.`, { metrics: { owedAtDecision: b.balance } });
}

async function deadStock(d, b) {
  if (!b.products.length) return out('not_measurable', 'dead_stock_sold', 'No product list was captured', 'No dead stock could be listed when you accepted, so there is nothing to compare against.');
  const sold = (await query(
    `SELECT si.product_id, SUM(si.quantity) AS units FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'completed' AND s.created_at > $1 AND si.product_id = ANY($2::int[]) GROUP BY 1`, [d.decided_at, b.products.map((p) => p.productId)],
  )).rows;
  const by = new Map(sold.map((r) => [r.product_id, Number(r.units)]));
  let units = 0; let value = 0; let n = 0;
  for (const p of b.products) { const u = Math.min(by.get(p.productId) || 0, p.stock); if (u > 0) { n += 1; units += u; value += u * p.cost; } }
  value = r2(value);
  if (value > 0) return out('verified', 'dead_stock_sold', `${n} dead-stock product${n === 1 ? '' : 's'} sold after you accepted (₹${value} at cost)`, 'Completed sales of products that were dead stock when you accepted, capped at the stock held then, valued at purchase cost. This is stock turned back into sales, not profit.', { amount: value, valueType: 'inventory_released', acted: true, metrics: { products: n, units } });
  if (expired(d, WINDOW.dead_stock)) return out('neutral', 'dead_stock_sold', 'None of the dead stock sold', 'No completed sale of the listed products in the 30 days after you accepted.', { amount: 0, valueType: 'inventory_released', metrics: { listed: b.products.length } });
  return out('pending', 'dead_stock_sold', 'Waiting for dead stock to sell', 'Measured from completed sales of the listed products after you accepted.', { amount: 0, valueType: 'inventory_released', metrics: { listed: b.products.length } });
}

async function reorder(d, b) {
  const cur = (await query('SELECT stock, minimum_stock FROM products WHERE id = $1', [b.productId])).rows[0];
  if (!cur) return out('not_measurable', 'stockout_avoided', `${b.name} no longer exists`, 'The product was removed, so nothing can be compared.');
  const rec = (await query(`SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_movements WHERE product_id = $1 AND movement_type = 'restock' AND quantity > 0 AND created_at > $2`, [b.productId, d.decided_at])).rows[0].q;
  const m = { stockAtDecision: b.stock, stockNow: cur.stock, received: Number(rec) };
  if (rec > 0 && cur.stock > cur.minimum_stock) return out('verified', 'stockout_avoided', b.stock > 0 ? `Stockout avoided: ${b.name} restocked (${rec} received)` : `${b.name} is back in stock (${rec} received)`, 'Stock was received after you accepted and the product is now above its minimum. This is a verified stock outcome; no ₹ value is claimed because lost sales cannot be measured.', { acted: true, metrics: m });
  if (rec > 0) return out('pending', 'stockout_avoided', `${b.name}: ${rec} received, still at or below minimum`, 'Some stock arrived but not enough to clear the minimum yet.', { acted: true, metrics: m });
  if (expired(d, WINDOW.reorder)) return out('unsuccessful', 'stockout_avoided', `${b.name} was not restocked in ${WINDOW.reorder} days`, `No stock was received; ${cur.stock} on hand now.`, { metrics: m });
  return out('pending', 'stockout_avoided', 'Waiting for stock to arrive', `Checked against stock received after you accepted, for ${WINDOW.reorder} days.`, { metrics: m });
}

async function margin(d, b) {
  const p = (await getProductStats()).find((x) => x.id === b.productId);
  if (!p) return out('not_measurable', 'margin_improved', `${b.name} no longer exists`, 'The product was removed, so nothing can be compared.');
  const now = marginOf(p);
  const m = { marginAtDecision: b.marginPerUnit, marginNow: now };
  if (now <= b.marginPerUnit + 0.004) {
    return expired(d, WINDOW.margin) ? out('unsuccessful', 'margin_improved', `${b.name}: margin unchanged`, `Margin per unit is still ₹${now} (was ₹${b.marginPerUnit}).`, { metrics: m }) : out('pending', 'margin_improved', 'Waiting for a price or cost change', `Margin per unit is ₹${now}, the same as when you accepted.`, { metrics: m });
  }
  const sold = (await query(
    `SELECT COALESCE(SUM(si.quantity),0) AS units, COALESCE(SUM(si.taxable_value - si.unit_cost * si.quantity),0) AS profit
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'completed' AND s.created_at > $1 AND si.product_id = $2 AND si.unit_cost IS NOT NULL AND si.taxable_value IS NOT NULL`, [d.decided_at, b.productId],
  )).rows[0];
  const units = Number(sold.units);
  if (units <= 0) return out('pending', 'margin_improved', `${b.name}: margin per unit improved, no sales yet`, `Margin per unit rose from ₹${b.marginPerUnit} to ₹${now}. Value is counted only from units actually sold afterwards.`, { acted: true, metrics: m });
  const gain = r2(Number(sold.profit) - b.marginPerUnit * units);
  if (gain > 0) return out('verified', 'margin_improved', `${b.name}: ₹${gain} extra profit on ${units} units sold`, 'Realised profit on completed sales since you accepted (price excluding tax minus the cost saved on each sale), minus what the old margin would have earned on the same units.', { amount: gain, valueType: 'margin_improvement', acted: true, metrics: { ...m, unitsSold: units } });
  return out('neutral', 'margin_improved', `${b.name}: no extra profit realised`, 'Margin per unit rose, but realised profit on the units sold since did not beat the old margin (discounts may have absorbed it).', { acted: true, metrics: { ...m, unitsSold: units } });
}

async function supplierCost(d, b) {
  const r = (await query(
    `SELECT COALESCE(SUM(gi.quantity),0) AS qty, COALESCE(SUM(gi.quantity * GREATEST(0, $2 - gi.unit_cost)),0) AS saving, MIN(gi.unit_cost) AS lowest, MAX(gi.id) AS last_id
       FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.goods_receipt_id WHERE gi.product_id = $1 AND g.received_at > $3 AND gi.quantity > 0`, [b.productId, b.cost, d.decided_at],
  )).rows[0];
  const saving = r2(r.saving);
  if (saving > 0) return out('verified', 'supplier_cost_reduced', `${b.name} bought for less: ₹${saving} saved on delivered stock`, `Deliveries after you accepted were invoiced below the ₹${b.cost} cost at that time; saving = units delivered × the difference. Only actual deliveries count.`, { amount: saving, valueType: 'cost_saving', acted: true, metrics: { baselineCost: b.cost, lowestCost: r.lowest, unitsDelivered: Number(r.qty) }, ref: { type: 'goods_receipt_item', id: r.last_id } });
  if (Number(r.qty) > 0) return out('neutral', 'supplier_cost_reduced', `${b.name} delivered at the same or a higher cost`, `Deliveries after you accepted were not invoiced below ₹${b.cost}.`, { acted: true, metrics: { baselineCost: b.cost, lowestCost: r.lowest } });
  if (expired(d, WINDOW.supplier_cost)) return out('neutral', 'supplier_cost_reduced', `No delivery of ${b.name} in ${WINDOW.supplier_cost} days`, 'Without a delivery there is no invoiced cost to compare.', { metrics: { baselineCost: b.cost } });
  return out('pending', 'supplier_cost_reduced', 'Waiting for the next delivery', 'Measured from the invoiced cost on deliveries received after you accepted.', { metrics: { baselineCost: b.cost } });
}

async function overdueOrder(d, b) {
  const r = (await query(`SELECT COUNT(*)::int AS n, MAX(id) AS last_id FROM goods_receipts WHERE purchase_order_id = $1 AND received_at > $2`, [b.purchaseOrderId, d.decided_at])).rows[0];
  if (r.n > 0) return out('verified', 'delivery_received', 'The late delivery arrived', 'A goods receipt was recorded against this purchase order after you accepted. No ₹ value is claimed.', { acted: true, ref: { type: 'goods_receipt', id: r.last_id } });
  const po = (await query('SELECT status FROM purchase_orders WHERE id = $1', [b.purchaseOrderId])).rows[0];
  if (po && ['cancelled', 'closed'].includes(po.status)) return out('neutral', 'delivery_received', `The order was ${po.status}`, 'The order was closed or cancelled without a delivery being recorded.', { acted: true });
  if (expired(d, WINDOW.overdue_order)) return out('unsuccessful', 'delivery_received', 'Still not delivered', 'No delivery was recorded in the 14 days after you accepted.');
  return out('pending', 'delivery_received', 'Waiting for the delivery', 'Checked against goods receipts recorded after you accepted.');
}

async function recon(d, b) {
  const r = (await query(`SELECT id FROM cash_reconciliations WHERE business_date = $1::date AND created_at > $2 ORDER BY id DESC LIMIT 1`, [b.date, d.decided_at])).rows[0];
  if (r) return out('verified', 'cash_counted', `Cash for ${b.date} was counted`, 'A cash count was recorded for that day after you accepted. No ₹ value is claimed.', { acted: true, ref: { type: 'cash_reconciliation', id: r.id } });
  return expired(d, WINDOW.recon) ? out('unsuccessful', 'cash_counted', `Cash for ${b.date} was never counted`, 'No cash count was recorded within 7 days.') : out('pending', 'cash_counted', 'Waiting for the cash count', 'Checked against cash counts recorded after you accepted.');
}

const RULES = { udhaar, dead_stock: deadStock, reorder, margin, supplier_cost: supplierCost, overdue_order: overdueOrder, recon };

/** Evaluates one accepted decision from its frozen baseline. Pure reads. */
async function evaluate(decision) {
  const b = decision.baseline || {};
  const rule = RULES[b.kind];
  if (!rule) return out('not_measurable', 'not_measurable', 'Cannot be measured from SHARKPOS data', b.note || NOT_MEASURABLE.default);
  return rule(decision, b);
}

module.exports = { captureBaseline, evaluate, WINDOW };
