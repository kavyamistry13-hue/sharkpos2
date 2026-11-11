// PREDICTION ENGINE — lightweight, transparent statistics. This is NOT a machine-learning model.
//
// For every product we look at the last 28 *complete* store days of unit sales and compute:
//   avgDailySales  mean units/day over 28 days
//   trendPct       last-7-day average vs the 7 days before it
//   forecastDaily  14-day linearly-weighted moving average (recent days count more),
//                  nudged by half of the recent trend (clamped to -15% / +25%)
//   stockoutRisk   P(demand during supplier lead time > current stock), demand ~ Normal(f*L, sigma*sqrt(L))
//   safetyStock    z * sigma * sqrt(lead time + review period)    (z = 1.28, ~90% service level)
//   recommendedQty (forecast demand over lead+review period + safety stock) - stock - already on order,
//                  rounded up to a multiple of 5 and capped at 30 days of forecast demand.
const config = require('../config');
const { query } = require('../db');
const { cached } = require('../utils/cache');

const WINDOW_DAYS = 28;
const PACK = 5;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Standard normal CDF (Abramowitz-Stegun 7.1.26 approximation)
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Pure statistics for one product from its daily unit series (oldest -> newest). */
function forecastFromSeries(series, { stock, leadTimeDays, minimumStock, onOrder = 0 }) {
  const rules = config.rules;
  const last7 = series.slice(-7);
  const prev7 = series.slice(-14, -7);
  const avg28 = mean(series);
  const avg7 = mean(last7);
  const avgPrev7 = mean(prev7);
  const ratio = avgPrev7 > 0 ? avg7 / avgPrev7 : 1;
  const trendPct = avgPrev7 > 0 ? ((avg7 - avgPrev7) / avgPrev7) * 100 : avg7 > 0 ? 100 : 0;

  const last14 = series.slice(-14);
  let wSum = 0;
  let wTotal = 0;
  last14.forEach((v, i) => {
    wSum += v * (i + 1);
    wTotal += i + 1;
  });
  const wma = wTotal ? wSum / wTotal : 0;
  const trendAdj = clamp(1 + 0.5 * (ratio - 1), 0.85, 1.25);
  const forecastDaily = wma * trendAdj;

  const sigma = stdev(series);
  const L = Math.max(leadTimeDays, 1);
  const H = L + rules.reviewPeriodDays;

  // Stockout probability over the lead time
  let risk;
  if (forecastDaily <= 0) risk = stock <= 0 ? 0.05 : 0;
  else if (stock <= 0) risk = 0.99;
  else {
    const mu = forecastDaily * L;
    const sd = sigma * Math.sqrt(L);
    risk = sd === 0 ? (stock < mu ? 0.99 : 0) : 1 - normCdf((stock - mu) / sd);
  }
  risk = clamp(risk, 0, 0.99);

  const safetyStock = Math.ceil(rules.serviceLevelZ * sigma * Math.sqrt(H));
  const demandHorizon = forecastDaily * H;
  const targetStock = Math.max(demandHorizon + safetyStock, minimumStock);
  let rawQty = targetStock - stock - onOrder;
  const cap = Math.ceil(forecastDaily * 30);
  let recommendedQty = 0;
  const daysToStockout = forecastDaily > 0 ? stock / forecastDaily : null;
  const needsAction = rawQty > 0 && (stock <= minimumStock || risk >= 0.25 || (daysToStockout !== null && daysToStockout <= H));
  if (needsAction) {
    rawQty = Math.max(rawQty, 1);
    const capped = cap > 0 ? Math.min(rawQty, Math.max(cap, minimumStock - stock)) : rawQty;
    recommendedQty = Math.ceil(capped / PACK) * PACK;
  }

  const riskLevel = risk >= 0.75 ? 'high' : risk >= 0.4 ? 'medium' : 'low';
  return {
    avgDailySales: round1(avg28),
    avg7: round1(avg7),
    trendPct: Math.round(trendPct),
    forecastDaily: round1(forecastDaily),
    projected7: Math.round(forecastDaily * 7),
    demandLeadTime: Math.round(forecastDaily * L),
    demandHorizon: Math.round(demandHorizon),
    horizonDays: H,
    sigma: round1(sigma),
    daysToStockout: daysToStockout === null ? null : round1(daysToStockout),
    stockoutRisk: Math.round(risk * 100) / 100,
    riskLevel,
    safetyStock,
    targetStock: Math.round(targetStock),
    recommendedQty,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** All active products joined with stock, supplier, onOrder and forecast stats. */
async function getProductStats() {
  return cached('productStats', 15000, loadProductStats);
}

async function loadProductStats() {
  const tz = config.storeTz;
  const [products, daily, onOrder, dismissed] = await Promise.all([
    query(
      `SELECT p.id, p.sku, p.name, p.category_id, c.name AS category, c.tax_rate, p.purchase_price, p.selling_price,
              p.stock, p.minimum_stock, p.supplier_id, s.name AS supplier, p.lead_time_days, p.expiry_date, p.is_active,
              p.created_at, p.unit, p.price_includes_tax, p.max_stock, p.reorder_level, p.track_batches
         FROM products p
         JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.is_active = TRUE
        ORDER BY p.id`,
    ),
    query(
      `SELECT si.product_id, (s.created_at AT TIME ZONE $1)::date AS d, SUM(si.quantity - si.returned_qty) AS qty   -- demand actually kept: returned units are not demand
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.status = 'completed'
          AND (s.created_at AT TIME ZONE $1)::date >= (now() AT TIME ZONE $1)::date - $2::int
          AND (s.created_at AT TIME ZONE $1)::date <  (now() AT TIME ZONE $1)::date
        GROUP BY 1, 2`,
      [tz, WINDOW_DAYS],
    ),
    // Stock already on its way. Counted once: an approved restock order that is linked to a purchase order is covered by that PO's
    // outstanding quantity (ordered - received) once the PO is placed; while the PO is still a draft the restock order keeps counting.
    query(
      `SELECT product_id, SUM(qty) AS qty FROM (
         SELECT r.product_id, r.quantity AS qty
           FROM restock_orders r
           LEFT JOIN purchase_order_items i ON i.id = r.purchase_order_item_id
           LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
          WHERE r.status = 'approved' AND (r.purchase_order_item_id IS NULL OR po.status = 'draft')
         UNION ALL
         SELECT i.product_id, i.ordered_qty - i.received_qty
           FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
          WHERE po.status IN ('ordered','partially_received')
       ) t GROUP BY 1`,
    ),
    query(
      `SELECT DISTINCT product_id FROM restock_orders WHERE status = 'dismissed' AND created_at > now() - interval '24 hours'`,
    ),
  ]);

  const todayStr = (await query(`SELECT ((now() AT TIME ZONE $1)::date)::text AS d`, [tz])).rows[0].d;
  const dayIndex = new Map(); // 'YYYY-MM-DD' -> index in series (0 = oldest)
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const dt = new Date(`${todayStr}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - (WINDOW_DAYS - i));
    dayIndex.set(dt.toISOString().slice(0, 10), i);
  }
  const seriesBy = new Map();
  for (const r of daily.rows) {
    const idx = dayIndex.get(r.d);
    if (idx === undefined) continue;
    if (!seriesBy.has(r.product_id)) seriesBy.set(r.product_id, new Array(WINDOW_DAYS).fill(0));
    seriesBy.get(r.product_id)[idx] = r.qty;
  }
  const onOrderBy = new Map(onOrder.rows.map((r) => [r.product_id, r.qty]));
  const dismissedSet = new Set(dismissed.rows.map((r) => r.product_id));

  const now = new Date(`${todayStr}T00:00:00Z`);
  return products.rows.map((p) => {
    const series = seriesBy.get(p.id) || new Array(WINDOW_DAYS).fill(0);
    const ordered = onOrderBy.get(p.id) || 0;
    const f = forecastFromSeries(series, {
      stock: p.stock,
      leadTimeDays: p.lead_time_days,
      minimumStock: p.minimum_stock,
      onOrder: ordered,
    });
    const daysCover = f.forecastDaily > 0 ? p.stock / f.forecastDaily : null;

    // Stock health
    let stockStatus = 'healthy';
    if (p.stock <= 0 || p.stock <= p.minimum_stock * 0.5 || f.riskLevel === 'high') stockStatus = 'critical';
    else if (p.stock <= p.minimum_stock || f.riskLevel === 'medium') stockStatus = 'warning';
    const lowStock = p.stock <= p.minimum_stock;
    const outOfStock = p.stock <= 0;
    const overstocked = daysCover !== null ? daysCover > 60 && p.stock > p.minimum_stock * 2 : p.stock > p.minimum_stock * 3 && p.stock > 20;

    // Expiry
    let expiryStatus = null;
    let daysToExpiry = null;
    if (p.expiry_date) {
      daysToExpiry = Math.round((new Date(`${p.expiry_date}T00:00:00Z`) - now) / 86400000);
      expiryStatus = daysToExpiry < 0 ? 'expired' : daysToExpiry <= 7 ? 'within7' : daysToExpiry <= 30 ? 'within30' : null;
    }
    const slowMoving = f.avgDailySales <= 1 && p.stock >= 5;

    // Reorder (Phase 9) — a RECOMMENDATION only; nothing is ever ordered automatically.
    // trigger = reorder level when the owner set one, else the minimum stock. Suggested qty tops stock up to max stock (minus what is already on order).
    const maxStock = p.max_stock == null ? null : Number(p.max_stock);
    const reorderLevel = p.reorder_level == null ? null : Number(p.reorder_level);
    const trigger = reorderLevel ?? Number(p.minimum_stock);
    const needsReorder = trigger > 0 && Number(p.stock) <= trigger;
    const suggestedReorderQty = needsReorder ? (maxStock != null ? Math.max(Math.round((maxStock - Number(p.stock) - ordered) * 1000) / 1000, 0) : f.recommendedQty) : 0;

    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      categoryId: p.category_id,
      category: p.category,
      taxRate: p.tax_rate,
      purchasePrice: p.purchase_price,
      sellingPrice: p.selling_price,
      unit: p.unit,
      priceIncludesTax: p.price_includes_tax,
      stock: p.stock,
      minimumStock: p.minimum_stock,
      maxStock,
      reorderLevel,
      reorderTrigger: trigger,
      needsReorder,
      suggestedReorderQty,
      trackBatches: p.track_batches,
      supplierId: p.supplier_id,
      supplier: p.supplier,
      leadTimeDays: p.lead_time_days,
      expiryDate: p.expiry_date,
      daysToExpiry,
      expiryStatus,
      stockValue: Math.round(p.stock * p.purchase_price * 100) / 100,
      onOrder: ordered,
      restockDismissed: dismissedSet.has(p.id),
      daysCover: daysCover === null ? null : round1(daysCover),
      stockStatus,
      lowStock,
      outOfStock,
      overstocked,
      slowMoving,
      ...f,
    };
  });
}

/** Explain a recommendation in plain, deterministic language. */
function restockReasons(p) {
  const reasons = [];
  if (p.avgDailySales > 0) {
    const trend = p.trendPct >= 10 ? ` and demand is up ${p.trendPct}% week-on-week` : p.trendPct <= -10 ? ` although demand is down ${Math.abs(p.trendPct)}% week-on-week` : '';
    reasons.push(`Sells about ${p.avgDailySales} units/day (forecast ${p.forecastDaily}/day)${trend}.`);
  }
  reasons.push(`Supplier lead time is ${p.leadTimeDays} day${p.leadTimeDays === 1 ? '' : 's'}${p.supplier ? ` (${p.supplier})` : ''}.`);
  if (p.daysToStockout !== null) reasons.push(`Current stock of ${p.stock} covers about ${p.daysToStockout} day${p.daysToStockout === 1 ? '' : 's'} of forecast demand.`);
  if (p.stock <= p.minimumStock) reasons.push(`Stock is at or below the minimum threshold of ${p.minimumStock}.`);
  reasons.push(
    `Order = ${p.demandHorizon} units forecast over lead time + review period (${p.horizonDays} days) + ${p.safetyStock} safety stock − ${p.stock} in stock${p.onOrder ? ` − ${p.onOrder} already on order` : ''}, rounded up to packs of ${PACK}.`,
  );
  return reasons;
}

module.exports = { forecastFromSeries, getProductStats, restockReasons, normCdf, WINDOW_DAYS };
