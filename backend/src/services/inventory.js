const { query, withTransaction } = require('../db');
const { getProductStats, restockReasons } = require('./forecast');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertQuantity } = require('../utils/units');

const brief = (p) => ({
  id: p.id, name: p.name, sku: p.sku, unit: p.unit, category: p.category, supplier: p.supplier, stock: p.stock, minimumStock: p.minimumStock,
  avgDailySales: p.avgDailySales, trendPct: p.trendPct, projected7: p.projected7, daysToStockout: p.daysToStockout,
  stockoutRisk: p.stockoutRisk, riskLevel: p.riskLevel, stockStatus: p.stockStatus, stockValue: p.stockValue,
  expiryDate: p.expiryDate, daysToExpiry: p.daysToExpiry, expiryStatus: p.expiryStatus, leadTimeDays: p.leadTimeDays,
  recommendedQty: p.recommendedQty, onOrder: p.onOrder,
});

async function getInventory(filter) {
  const stats = await getProductStats();
  const sum = (arr, k) => Math.round(arr.reduce((a, p) => a + p[k], 0) * 100) / 100;
  const groups = {
    low: stats.filter((p) => p.lowStock && !p.outOfStock),
    out: stats.filter((p) => p.outOfStock),
    over: stats.filter((p) => p.overstocked),
    fast: [...stats].sort((a, b) => b.avgDailySales - a.avgDailySales).slice(0, 15),
    slow: stats.filter((p) => p.slowMoving),
    expiring: stats.filter((p) => p.expiryStatus),
    atrisk: stats.filter((p) => p.riskLevel !== 'low'),
  };
  const expiring = {
    expired: stats.filter((p) => p.expiryStatus === 'expired'),
    within7: stats.filter((p) => p.expiryStatus === 'within7'),
    within30: stats.filter((p) => p.expiryStatus === 'within30'),
  };
  const expSummary = (arr) => ({ products: arr.length, units: arr.reduce((a, p) => a + p.stock, 0), value: sum(arr, 'stockValue') });
  let rows = stats;
  if (filter && groups[filter]) rows = groups[filter];
  rows = [...rows].sort((a, b) => b.stockoutRisk - a.stockoutRisk);
  return {
    summary: {
      totalProducts: stats.length,
      totalUnits: stats.reduce((a, p) => a + p.stock, 0),
      stockValue: sum(stats, 'stockValue'),
      healthy: stats.filter((p) => p.stockStatus === 'healthy').length,
      warning: stats.filter((p) => p.stockStatus === 'warning').length,
      critical: stats.filter((p) => p.stockStatus === 'critical').length,
      low: groups.low.length,
      out: groups.out.length,
      overstocked: groups.over.length,
      slow: groups.slow.length,
      slowValue: sum(groups.slow, 'stockValue'),
      expiring: { expired: expSummary(expiring.expired), within7: expSummary(expiring.within7), within30: expSummary(expiring.within30) },
    },
    filter: filter || 'all',
    rows: rows.map(brief),
  };
}

/** Automatic alerts: critical / warning / info — all derived from data, none hard-coded. */
async function getAlerts() {
  const stats = await getProductStats();
  const out = [];
  const push = (severity, type, p, message) => out.push({ severity, type, productId: p.id, product: p.name, message });
  for (const p of stats) {
    if (p.expiryStatus === 'expired') push('critical', 'expiry', p, `${p.name} expired ${Math.abs(p.daysToExpiry)} day(s) ago — ${p.stock} units (₹${Math.round(p.stockValue).toLocaleString('en-IN')}) must be removed.`);
    else if (p.outOfStock) push('critical', 'stockout', p, `${p.name} is out of stock.`);
    else if (p.daysToStockout !== null && p.daysToStockout <= 2 && p.avgDailySales >= 2) push('critical', 'stockout', p, `${p.name} may run out in ${Math.max(1, Math.ceil(p.daysToStockout))} day${p.daysToStockout > 1 ? 's' : ''}.`);
    else if (p.lowStock) push('warning', 'low_stock', p, `${p.name} stock (${p.stock}) is below the minimum threshold of ${p.minimumStock}.`);
    if (p.expiryStatus === 'within7' && (p.daysCover === null || p.daysCover > p.daysToExpiry)) push('warning', 'expiry', p, `${p.name}: ${p.stock} units expire in ${p.daysToExpiry} day(s).`);
    if (p.trendPct >= 20 && p.avgDailySales >= 3) push('info', 'trend', p, `${p.name} demand increased ${p.trendPct}% this week.`);
    if (p.overstocked && p.stockValue >= 3000) push('info', 'overstock', p, `${p.name} looks overstocked (${p.daysCover ?? '60+'} days of cover, ₹${Math.round(p.stockValue).toLocaleString('en-IN')} tied up).`);
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { counts: { critical: out.filter((a) => a.severity === 'critical').length, warning: out.filter((a) => a.severity === 'warning').length, info: out.filter((a) => a.severity === 'info').length }, alerts: out };
}

/** Restock recommendations from the prediction engine (deterministic). */
async function getRestockRecommendations({ includeDismissed = false } = {}) {
  const stats = await getProductStats();
  const rank = { high: 0, medium: 1, low: 2 };
  return stats
    .filter((p) => p.recommendedQty > 0 && (includeDismissed || !p.restockDismissed))
    .sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel] || b.stockoutRisk - a.stockoutRisk)
    .map((p) => ({
      ...brief(p),
      reasons: restockReasons(p),
      safetyStock: p.safetyStock,
      demandHorizon: p.demandHorizon,
      horizonDays: p.horizonDays,
      forecastDaily: p.forecastDaily,
      estimatedCost: Math.round(p.recommendedQty * p.purchasePrice * 100) / 100,
      summary: `${p.name}: order ${p.recommendedQty} units — ${p.riskLevel} stockout risk, ${p.leadTimeDays}-day lead time${p.trendPct >= 10 ? `, demand +${p.trendPct}%` : ''}.`,
    }));
}

async function approveRestock(productId, quantity, user) {
  const stats = await getProductStats();
  const p = stats.find((x) => x.id === productId);
  if (!p) throw notFound('Product not found.');
  const qty = quantity ?? p.recommendedQty;
  if (!qty || qty <= 0) throw badRequest('There is nothing to restock for this product.');
  assertQuantity(p.unit, qty, 'Quantity', p.name);
  const cap = Math.max(p.recommendedQty * 3, 500);
  if (qty > cap) throw badRequest(`Quantity looks too high. Maximum allowed for this product is ${cap}.`);
  const res = await query(
    `INSERT INTO restock_orders (product_id, quantity, reason, status, created_by) VALUES ($1,$2,$3,'approved',$4) RETURNING id`,
    [productId, qty, restockReasons(p)[0], user.id],
  );
  invalidateAll();
  return { id: res.rows[0].id, productId, product: p.name, quantity: qty, supplier: p.supplier, expectedInDays: p.leadTimeDays, status: 'approved' };
}

async function dismissRestock(productId, user) {
  const p = (await getProductStats()).find((x) => x.id === productId);
  if (!p) throw notFound('Product not found.');
  await query(`INSERT INTO restock_orders (product_id, quantity, reason, status, created_by, resolved_at) VALUES ($1,$2,'Dismissed by manager','dismissed',$3,now())`, [productId, Math.max(p.recommendedQty, 1), user.id]);
  invalidateAll();
  return { productId, status: 'dismissed' };
}

async function listRestockOrders() {
  const res = await query(
    `SELECT r.id, r.product_id, p.name AS product, p.sku, p.unit, p.supplier_id, r.quantity, r.status, r.reason, r.created_at, r.resolved_at, u.name AS created_by, s.name AS supplier, p.lead_time_days,
            po.id AS po_id, po.po_number, po.status AS po_status
       FROM restock_orders r JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN purchase_order_items poi ON poi.id = r.purchase_order_item_id LEFT JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE r.status IN ('approved','received') ORDER BY r.created_at DESC LIMIT 50`,
  );
  return res.rows.map((r) => ({ id: r.id, productId: r.product_id, product: r.product, sku: r.sku, quantity: r.quantity, status: r.status, supplier: r.supplier, leadTimeDays: r.lead_time_days, createdBy: r.created_by, createdAt: r.created_at, resolvedAt: r.resolved_at, unit: r.unit, supplierId: r.supplier_id, purchaseOrder: r.po_id ? { id: r.po_id, poNumber: r.po_number, status: r.po_status } : null }));
}

/** Goods received: adds stock and records an inventory movement. */
async function receiveRestock(orderId) {
  const result = await withTransaction(async (client) => {
    const o = (await client.query('SELECT id, product_id, quantity, status, purchase_order_item_id FROM restock_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('Restock order not found.');
    if (o.status !== 'approved') throw conflict(`This order is already ${o.status}.`);
    // Stock for a restock order that became part of a purchase order is received through that purchase order (ordered vs received is tracked there).
    if (o.purchase_order_item_id) throw conflict('This restock order is part of a purchase order. Receive it from the purchase order instead.', { code: 'RESTOCK_LINKED_TO_PO' });
    await client.query(`UPDATE restock_orders SET status = 'received', resolved_at = now() WHERE id = $1`, [orderId]);
    await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [o.quantity, o.product_id]);
    await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type) VALUES ($1,'restock',$2,$3,'restock_order')`, [o.product_id, o.quantity, orderId]);
    return o;
  });
  invalidateAll();
  return { id: result.id, productId: result.product_id, quantity: result.quantity, status: 'received' };
}

async function getMovements(productId, limit = 30) {
  if (!(await query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) throw notFound('Product not found.');
  const res = await query(
    `SELECT id, movement_type, quantity, reference_id, created_at FROM inventory_movements WHERE product_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [productId, limit],
  );
  return res.rows.map((r) => ({ id: r.id, type: r.movement_type, quantity: r.quantity, referenceId: r.reference_id, createdAt: r.created_at }));
}

module.exports = { getInventory, getAlerts, getRestockRecommendations, approveRestock, dismissRestock, listRestockOrders, receiveRestock, getMovements };
