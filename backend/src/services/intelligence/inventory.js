// Capital tied up in stock, and dead-stock detection. Pure arithmetic on existing stock, cost and sales rows — no model, no guessing.
// Values use the purchase (cost) price: that is the money that was spent. They describe capital at rest, NOT money that can be recovered.
const { query } = require('../../db');
const config = require('../../config');
const { todayLocal, daysBetween, r2 } = require('../../utils/dates');
const { getProductStats } = require('../forecast');

const COVER_DAYS = 45;          // stock beyond this many days of forecast demand (plus the minimum) is counted as excess

/** Last completed sale and age of every active, stocked product. */
async function loadMovement() {
  const tz = config.storeTz;
  const [last, today] = await Promise.all([
    query(
      `SELECT p.id, (p.created_at AT TIME ZONE $1)::date::text AS created_day,
              (MAX(s.created_at) AT TIME ZONE $1)::date::text AS last_sold_day
         FROM products p
         LEFT JOIN sale_items si ON si.product_id = p.id AND si.quantity > si.returned_qty   -- a line that was entirely returned is not a sale
         LEFT JOIN sales s ON s.id = si.sale_id AND s.status = 'completed'
        WHERE p.is_active GROUP BY p.id`, [tz]),
    todayLocal(),
  ]);
  return { today, by: new Map(last.rows.map((r) => [r.id, r])) };
}

/** Pure: classify one product. Returns null when there is nothing in stock. */
function classify(p, mv, today, deadDays) {
  if (!(p.stock > 0)) return null;
  const value = r2(p.stock * p.avgCost);
  const sinceSale = mv.last_sold_day ? daysBetween(mv.last_sold_day, today) : null;
  const age = daysBetween(mv.created_day, today);
  const noRecentSale = sinceSale === null ? age >= deadDays : sinceSale >= deadDays;
  if (p.expiryStatus === 'expired') return { bucket: 'expired', value, trapped: value, units: p.stock, sinceSale, age };
  if (noRecentSale) return { bucket: 'dead', value, trapped: value, units: p.stock, sinceSale, age };
  if (p.overstocked) {
    const keep = Math.ceil(p.forecastDaily * COVER_DAYS) + p.minimumStock;
    const excessUnits = Math.max(0, Math.round((p.stock - keep) * 1000) / 1000);
    return { bucket: 'overstock', value, trapped: r2(excessUnits * p.avgCost), units: excessUnits, sinceSale, age };
  }
  return { bucket: 'healthy', value, trapped: 0, units: 0, sinceSale, age };
}

const ACTION = {
  expired: 'Remove from sale and ask the supplier about a return or credit note.',
  dead: 'No sale for a long time: discount or bundle it, or return it to the supplier, and stop reordering.',
  overstock: 'More than needed for the coming weeks: pause reordering until sales catch up.',
};

async function inventoryCash({ deadDays = 60, top = 10 } = {}) {
  const [stats, mvData] = await Promise.all([getProductStats(), loadMovement()]);
  const buckets = { healthy: { products: 0, value: 0 }, overstock: { products: 0, value: 0, trapped: 0 }, dead: { products: 0, value: 0 }, expired: { products: 0, value: 0 } };
  const cats = new Map();
  const rows = [];
  let total = 0; let retail = 0; let stocked = 0;
  for (const p of stats) {
    const c = classify(p, mvData.by.get(p.id) || { created_day: mvData.today, last_sold_day: null }, mvData.today, deadDays);
    if (!c) continue;
    stocked += 1; total += c.value; retail += p.stock * p.sellingPrice;
    const b = buckets[c.bucket]; b.products += 1; b.value += c.value; if (c.bucket === 'overstock') b.trapped += c.trapped;
    cats.set(p.category, (cats.get(p.category) || 0) + c.value);
    if (c.trapped > 0) rows.push({ productId: p.id, name: p.name, category: p.category, unit: p.unit, stock: p.stock, bucket: c.bucket, stockValue: c.value, trappedValue: c.trapped, daysSinceLastSale: c.sinceSale, action: ACTION[c.bucket] });
  }
  const trapped = r2(buckets.dead.value + buckets.expired.value + buckets.overstock.trapped);
  rows.sort((a, b) => b.trappedValue - a.trappedValue);
  const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    deadDays, coverDays: COVER_DAYS, stockedProducts: stocked, totalValue: r2(total), potentialRetailValue: r2(retail),
    trappedCash: trapped, trappedPct: pct(trapped),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { products: v.products, value: r2(v.value), ...(k === 'overstock' ? { trappedExcess: r2(v.trapped) } : {}) }])),
    byCategory: [...cats.entries()].map(([category, value]) => ({ category, value: r2(value), pct: pct(value) })).sort((a, b) => b.value - a.value),
    topTrapped: rows.slice(0, top),
    basis: `Value = stock × purchase price (cost). Dead = no completed sale for ${deadDays}+ days. Excess = stock beyond ${COVER_DAYS} days of forecast demand plus the minimum stock. This is capital at rest, not recoverable money.`,
  };
}

async function deadStock({ days = 60, limit = 100 } = {}) {
  const [stats, mvData] = await Promise.all([getProductStats(), loadMovement()]);
  const rows = [];
  for (const p of stats) {
    const mv = mvData.by.get(p.id) || { created_day: mvData.today, last_sold_day: null };
    const c = classify(p, mv, mvData.today, days);
    if (!c || (c.bucket !== 'dead' && c.bucket !== 'expired')) continue;
    rows.push({
      productId: p.id, name: p.name, sku: p.sku, category: p.category, unit: p.unit, stock: p.stock, stockValue: c.value, retailValue: r2(p.stock * p.sellingPrice),
      lastSoldOn: mv.last_sold_day, daysSinceLastSale: c.sinceSale, daysSinceAdded: c.age, expired: c.bucket === 'expired', daysToExpiry: p.daysToExpiry,
      supplier: p.supplier, action: ACTION[c.bucket],
    });
  }
  rows.sort((a, b) => b.stockValue - a.stockValue);
  return { days, count: rows.length, totalValue: r2(rows.reduce((a, r) => a + r.stockValue, 0)), rows: rows.slice(0, limit), basis: `Products with stock that have had no completed sale for ${days}+ days (or never sold and added ${days}+ days ago), plus expired stock. New products are not flagged.` };
}

module.exports = { inventoryCash, deadStock, classify, COVER_DAYS };
