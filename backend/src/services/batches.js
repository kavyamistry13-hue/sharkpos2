// Phase 9: optional batch / expiry tracking with FEFO (first-expiry-first-out).
// Opt-in per product: a product with no batches behaves exactly as before (one stock number). A product that receives a batch is
// flagged track_batches; from then on stock leaves its batches earliest-expiry first, and whatever is not in any batch (older, untracked
// stock) is treated as an "untracked pool" that is consumed last. products.stock stays the single source of truth for the total.
// Every function takes the caller's transaction client — batch quantities and stock must change together or not at all.
const { query } = require('../db');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { round3 } = require('../utils/units');

const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Adds a received quantity to a batch (creating it, or topping up the same batch number). Returns the batch id. */
async function addToBatch(client, { productId, batchNo, manufacturedDate, expiryDate, quantity, unitCost, supplierId, receiptId, userId }) {
  if (manufacturedDate && expiryDate && manufacturedDate > expiryDate) throw badRequest('The expiry date cannot be before the manufacturing date.');
  const no = (batchNo && String(batchNo).trim()) || (expiryDate ? `EXP-${expiryDate}` : null);
  if (!no) throw badRequest('Enter a batch number or an expiry date.');
  const cur = (await client.query('SELECT id, expiry_date FROM stock_batches WHERE product_id = $1 AND batch_no = $2 FOR UPDATE', [productId, no])).rows[0];
  let id;
  if (cur) {
    if (expiryDate && cur.expiry_date && String(cur.expiry_date.toISOString ? cur.expiry_date.toISOString().slice(0, 10) : cur.expiry_date) !== expiryDate) {
      throw conflict(`Batch ${no} already exists with a different expiry date.`, { code: 'BATCH_EXPIRY_MISMATCH' });
    }
    await client.query('UPDATE stock_batches SET quantity_received = quantity_received + $1, quantity_on_hand = quantity_on_hand + $1 WHERE id = $2', [quantity, cur.id]);
    id = cur.id;
  } else {
    id = (await client.query(
      `INSERT INTO stock_batches (product_id, batch_no, manufactured_date, expiry_date, quantity_received, quantity_on_hand, unit_cost, supplier_id, goods_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING id`,
      [productId, no, manufacturedDate || null, expiryDate || null, quantity, unitCost ?? null, supplierId || null, receiptId || null, userId || null],
    )).rows[0].id;
  }
  await client.query('UPDATE products SET track_batches = TRUE WHERE id = $1 AND NOT track_batches', [productId]);
  return { id, batchNo: no, created: !cur };
}

/**
 * Takes `qty` out of a product's batches in FEFO order and returns [{ batchId, quantity }] (the part not found in any batch comes out
 * of the untracked pool and is not listed). Call AFTER products.stock was reduced (stockAfter = the new total).
 * sale (includeExpired = false): expired batches are skipped — expired stock is never sold; if only expired stock is left the sale is refused.
 * write-off (includeExpired = true): expired batches go first, so "expired" adjustments clear exactly the batches that expired.
 */
async function deductFefo(client, productId, qty, { stockAfter, includeExpired = false } = {}) {
  const batches = (await client.query(
    `SELECT id, quantity_on_hand, (expiry_date IS NOT NULL AND expiry_date < ${TODAY}) AS expired FROM stock_batches
      WHERE product_id = $1 AND quantity_on_hand > 0 ORDER BY expiry_date NULLS LAST, id FOR UPDATE`, [productId])).rows;
  if (!batches.length) return [];
  const inBatches = batches.reduce((a, b) => a + Number(b.quantity_on_hand), 0);
  const pool = Math.max(round3(stockAfter + qty - inBatches), 0);            // stock that was never put in a batch
  let left = qty; const out = [];
  for (const b of batches) {
    if (left <= 0) break;
    if (b.expired && !includeExpired) continue;
    const take = Math.min(left, Number(b.quantity_on_hand));
    await client.query('UPDATE stock_batches SET quantity_on_hand = quantity_on_hand - $1 WHERE id = $2', [take, b.id]);
    out.push({ batchId: b.id, quantity: round3(take) });
    left = round3(left - take);
  }
  if (left > pool) throw conflict('Only expired stock is left for this product, so it cannot be sold. Remove it with an "expired" stock adjustment.', { code: 'EXPIRED_STOCK_ONLY' });
  return out;
}

async function listForProduct(productId) {
  if (!(await query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) throw notFound('Product not found.');
  const rows = (await query(
    `SELECT b.id, b.batch_no, b.manufactured_date, b.expiry_date, b.quantity_received, b.quantity_on_hand, b.unit_cost, b.created_at, s.name AS supplier,
            (b.expiry_date - ${TODAY}) AS days_to_expiry
       FROM stock_batches b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.product_id = $1 ORDER BY b.expiry_date NULLS LAST, b.id`, [productId])).rows;
  return rows.map(shape);
}

const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const shape = (r) => ({
  id: r.id, batchNo: r.batch_no, manufacturedDate: iso(r.manufactured_date), expiryDate: iso(r.expiry_date), received: Number(r.quantity_received), onHand: Number(r.quantity_on_hand),
  unitCost: r.unit_cost == null ? null : Number(r.unit_cost), supplier: r.supplier || null, daysToExpiry: r.days_to_expiry == null ? null : Number(r.days_to_expiry), createdAt: r.created_at,
});

/**
 * Expiry report. within: 'expired' | 7 | 30 | 90 | 'all'. Lists batches with stock left and an expiry date, plus products that carry a single
 * product-level expiry date but no batches (older data). Products without any expiry date are never listed — expiry is never forced.
 */
async function expiryReport(within = 'all', limit = 500) {
  const cond = within === 'expired' ? `d < 0` : within === 'all' ? 'TRUE' : `d BETWEEN 0 AND ${Number(within)}`;
  const rows = (await query(
    `SELECT * FROM (
       SELECT 'batch' AS source, b.id AS batch_id, p.id AS product_id, p.name, p.sku, p.unit, b.batch_no, b.expiry_date, b.quantity_on_hand AS qty, p.purchase_price AS cost, (b.expiry_date - ${TODAY}) AS d
         FROM stock_batches b JOIN products p ON p.business_id = b.business_id AND p.id = b.product_id
        WHERE b.quantity_on_hand > 0 AND b.expiry_date IS NOT NULL AND p.is_active
       UNION ALL
       SELECT 'product', NULL, p.id, p.name, p.sku, p.unit, NULL, p.expiry_date, p.stock, p.purchase_price, (p.expiry_date - ${TODAY})
         FROM products p WHERE p.is_active AND p.expiry_date IS NOT NULL AND p.stock > 0 AND NOT EXISTS (SELECT 1 FROM stock_batches b WHERE b.product_id = p.id AND b.quantity_on_hand > 0)
     ) x WHERE ${cond} ORDER BY d, name LIMIT $1`, [limit])).rows;
  const out = rows.map((r) => ({ source: r.source, batchId: r.batch_id, productId: r.product_id, name: r.name, sku: r.sku, unit: r.unit, batchNo: r.batch_no, expiryDate: iso(r.expiry_date), quantity: Number(r.qty), daysToExpiry: Number(r.d), atRiskValue: Math.round(Number(r.qty) * Number(r.cost) * 100) / 100 }));
  const sum = (f) => out.filter(f);
  return { within, rows: out, counts: { expired: sum((r) => r.daysToExpiry < 0).length, within7: sum((r) => r.daysToExpiry >= 0 && r.daysToExpiry <= 7).length, within30: sum((r) => r.daysToExpiry >= 0 && r.daysToExpiry <= 30).length, within90: sum((r) => r.daysToExpiry >= 0 && r.daysToExpiry <= 90).length } };
}

/** Every batch with stock left, paged. `fefoRank` 1 = the batch a sale will take first for that product (earliest non-expired expiry). */
async function listAll({ q, page = 1, limit = 50 } = {}) {
  const params = []; let where = '';
  if (q) { params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where = `AND (p.name ILIKE $1 OR p.sku ILIKE $1 OR b.batch_no ILIKE $1)`; }
  const total = (await query(`SELECT COUNT(*)::int AS n FROM stock_batches b JOIN products p ON p.business_id = b.business_id AND p.id = b.product_id WHERE b.quantity_on_hand > 0 AND p.is_active ${where}`, params)).rows[0].n;
  params.push(limit, (page - 1) * limit);
  const rows = (await query(
    `SELECT * FROM (
       SELECT b.id, b.product_id, p.name, p.sku, p.unit, b.batch_no, b.manufactured_date, b.expiry_date, b.quantity_on_hand, b.quantity_received, (b.expiry_date - ${TODAY}) AS d,
              ROW_NUMBER() OVER (PARTITION BY b.product_id ORDER BY (b.expiry_date IS NOT NULL AND b.expiry_date < ${TODAY}), b.expiry_date NULLS LAST, b.id) AS rank
         FROM stock_batches b JOIN products p ON p.business_id = b.business_id AND p.id = b.product_id WHERE b.quantity_on_hand > 0 AND p.is_active ${where}
     ) x ORDER BY name, rank LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  return {
    total, page, limit,
    rows: rows.map((r) => ({
      id: r.id, productId: r.product_id, name: r.name, sku: r.sku, unit: r.unit, batchNo: r.batch_no, manufacturedDate: iso(r.manufactured_date), expiryDate: iso(r.expiry_date),
      onHand: Number(r.quantity_on_hand), received: Number(r.quantity_received), daysToExpiry: r.d == null ? null : Number(r.d),
      status: r.d == null ? 'no_expiry' : r.d < 0 ? 'expired' : r.d <= 7 ? 'within7' : r.d <= 30 ? 'within30' : r.d <= 90 ? 'within90' : 'ok',
      fefoRank: Number(r.rank), sellsNext: Number(r.rank) === 1 && !(r.d != null && r.d < 0),
    })),
  };
}

module.exports = { listAll, addToBatch, deductFefo, listForProduct, expiryReport };
