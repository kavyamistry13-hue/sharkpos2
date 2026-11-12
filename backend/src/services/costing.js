// Weighted-average costing (roadmap Phase 9.1). ONE place computes the average, and it does so in PostgreSQL NUMERIC (never in JS floats):
//
//   new_avg = (qty_before * old_avg + qty_in * unit_cost) / (qty_before + qty_in)        rounded to 4 decimals
//
// A receipt that leaves the average unchanged writes no history row.
// The caller holds nothing: this function locks the product row itself (FOR UPDATE), so two receipts / returns of the same product are
// serialised and each one sees the previous one's result. Call it BEFORE the stock increment of the same transaction (it records the
// quantity before/after). Quantity-only changes (adjustments, damage, loss, counts, sales) never change the average: units simply leave or
// enter at the current average, which is the standard weighted-average rule.
const { badRequest, notFound } = require('../utils/errors');

/**
 * Bring `quantity` units that cost `unitCost` each into the product's average.
 * source: 'purchase' (goods receipt) | 'return' (restocked sale return, valued at the original sale cost) | 'batch' (batch opening stock with a cost).
 * Returns { productId, prevAvg, newAvg, qtyBefore, qtyAfter } (numbers parsed from exact text).
 */
async function receive(client, { productId, quantity, unitCost, source = 'purchase', refType = null, refId = null, userId = null }) {
  if (!(Number(quantity) > 0)) throw badRequest('Quantity must be more than zero.');
  if (!(Number(unitCost) >= 0)) throw badRequest('Unit cost must be zero or more.');
  const p = (await client.query('SELECT stock::text AS stock, avg_cost::text AS avg_cost FROM products WHERE id = $1 FOR UPDATE', [productId])).rows[0];
  if (!p) throw notFound('Product not found.');
  const r = (await client.query(
    `WITH i AS (SELECT GREATEST($1::numeric, 0) AS q0, $2::numeric AS a0, $3::numeric AS qin, $4::numeric AS c)
     SELECT CASE WHEN q0 = 0 THEN round(c, 4) ELSE round((q0 * a0 + qin * c) / (q0 + qin), 4) END AS new_avg, (q0 + qin)::text AS qty_after FROM i`,
    [p.stock, p.avg_cost, String(quantity), String(unitCost)],
  )).rows[0];
  if (Number(r.new_avg) === Number(p.avg_cost)) {
    // The average did not move (same cost as before): nothing to value differently, so no cost event. The receipt itself is still audited
    // by its goods-receipt line and stock movement.
    return { productId, prevAvg: Number(p.avg_cost), newAvg: Number(r.new_avg), qtyBefore: Number(p.stock), qtyAfter: Number(r.qty_after) };
  }
  await client.query('UPDATE products SET avg_cost = $1 WHERE id = $2', [r.new_avg, productId]);
  await client.query(
    `INSERT INTO product_cost_history (product_id, cost, source, ref_type, ref_id, created_by, prev_avg_cost, new_avg_cost, qty_before, qty_received, qty_after, effective_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, clock_timestamp())   -- clock_timestamp(): the moment the product lock was held, so concurrent receipts sort in the order they were applied`,
    [productId, String(unitCost), source, refType, refId, userId, p.avg_cost, r.new_avg, p.stock, String(quantity), r.qty_after],
  );
  return { productId, prevAvg: Number(p.avg_cost), newAvg: Number(r.new_avg), qtyBefore: Number(p.stock), qtyAfter: Number(r.qty_after) };
}

module.exports = { receive };
