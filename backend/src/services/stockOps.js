// Phase 9: stock adjustments, the per-product movement timeline and physical stock counts.
// Rules that hold for everything in this file:
//   • stock only ever changes inside a transaction, under a row lock (FOR UPDATE), as `stock = stock + delta`, never "set to X",
//     so a sale happening at the same moment is never overwritten;
//   • every change writes an append-only inventory_movements row (reason, note, who, resulting stock) — history is never edited;
//   • stock can never go below zero (the DB also enforces it);
//   • tenant scope comes from the request context + forced RLS, so another shop's product is simply "not found".
const { query, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertQuantity, round3 } = require('../utils/units');
const batches = require('./batches');
const costing = require('./costing');

const REASONS = ['damaged', 'expired', 'lost', 'theft', 'counting_error', 'found_stock', 'manual_correction', 'other'];
const LOSS_REASONS = new Set(['damaged', 'expired', 'lost', 'theft']);   // can only take stock away
const GAIN_REASONS = new Set(['found_stock']);                           // can only add stock

/**
 * Core of every manual stock change. Must run inside a transaction. Locks the product, validates, updates and records the movement.
 * Returns { name, unit, before, after, delta, movementId }.
 */
async function applyAdjustment(client, { productId, delta, reason, note, userId, referenceType = 'adjustment', referenceId = null, batchId = null }) {
  const cur = (await client.query('SELECT name, unit, stock, track_batches FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [productId])).rows[0];
  if (!cur) throw notFound('Product not found.');
  if (!(delta !== 0 && Number.isFinite(delta))) throw badRequest('The change in stock cannot be zero.');
  assertQuantity(cur.unit, Math.abs(delta), 'Quantity', cur.name);
  const before = Number(cur.stock);
  const after = round3(before + delta);
  if (after < 0) throw conflict(`Only ${before} ${cur.unit} of "${cur.name}" in stock — that change would make stock negative.`, { code: 'NEGATIVE_STOCK' });
  await client.query('UPDATE products SET stock = $1 WHERE id = $2', [after, productId]);
  // Removing stock from a batch-tracked product takes it from the batches (expired first, then FEFO); one movement per batch touched.
  const parts = delta < 0 && cur.track_batches ? await batches.deductFefo(client, productId, -delta, { stockAfter: after, includeExpired: true }) : [];
  const split = parts.length ? parts.map((x) => ({ qty: -x.quantity, batchId: x.batchId })) : [{ qty: delta, batchId: batchId || null }];
  let movementId;
  for (const x of split) {
    movementId = (await client.query(
      `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type, created_by, reason, note, stock_after, batch_id)
       VALUES ($1,'adjustment',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [productId, x.qty, referenceId, referenceType, userId, reason, note || null, after, x.batchId],
    )).rows[0].id;
  }
  return { name: cur.name, unit: cur.unit, before, after, delta, movementId };
}

/** Owner/manager stock adjustment with a mandatory reason. `delta` is signed (+ adds stock, − removes it). */
async function adjustStock(productId, { delta, reason, note }, userId) {
  if (!REASONS.includes(reason)) throw badRequest('Choose a valid reason for the adjustment.');
  if (LOSS_REASONS.has(reason) && delta > 0) throw badRequest(`A "${reason}" adjustment can only remove stock.`);
  if (GAIN_REASONS.has(reason) && delta < 0) throw badRequest('"Found stock" can only add stock.');
  if (reason === 'other' && !(note && note.trim())) throw badRequest('Please add a short note when the reason is "other".');
  const out = await withTransaction((client) => applyAdjustment(client, { productId, delta, reason, note, userId }));
  invalidateAll();
  return out;
}

/** Adds stock that arrives with a batch / expiry (opening stock, a gift, a purchase without a PO). Owner/manager; atomic like any adjustment. */
async function addBatchStock(productId, { quantity, batchNo, manufacturedDate, expiryDate, unitCost }, userId) {
  const out = await withTransaction(async (client) => {
    const p = (await client.query('SELECT unit FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [productId])).rows[0];
    if (!p) throw notFound('Product not found.');
    assertQuantity(p.unit, quantity, 'Quantity');
    const b = await batches.addToBatch(client, { productId, batchNo, manufacturedDate, expiryDate, quantity, unitCost, userId });
    // Opening stock that comes with a cost is a purchase-like inflow: it joins the weighted average. Without a cost it enters at the current average.
    if (unitCost != null) await costing.receive(client, { productId, quantity, unitCost, source: 'batch', refType: 'stock_batch', refId: b.id, userId });
    const r = await applyAdjustment(client, { productId, delta: quantity, reason: 'manual_correction', note: `Batch ${b.batchNo}`, userId, batchId: b.id });
    return { ...r, batchId: b.id, batchNo: b.batchNo };
  });
  invalidateAll();
  return out;
}

/** Movement timeline for ONE product, newest first. `before` is the id of the last row of the previous page (keyset paging). */
async function getTimeline(productId, { limit = 50, before } = {}) {
  const p = (await query('SELECT id, name, unit, stock FROM products WHERE id = $1', [productId])).rows[0];
  if (!p) throw notFound('Product not found.');
  const params = [productId, limit + 1];
  let cursor = '';
  if (before) { params.push(before); cursor = `AND m.id < $${params.length}`; }
  const rows = (await query(
    `SELECT m.id, m.business_id, m.movement_type, m.quantity, m.stock_after, m.reason, m.note, m.reference_id, m.reference_type, m.batch_id, m.created_at,
            a.name AS user_name
       FROM inventory_movements m LEFT JOIN accounts a ON a.id = m.created_by
      WHERE m.product_id = $1 ${cursor} ORDER BY m.id DESC LIMIT $2`,
    params,
  )).rows;
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => ({
    id: r.id, tenantId: r.business_id, type: r.movement_type, quantity: Number(r.quantity),
    stockAfter: r.stock_after == null ? null : Number(r.stock_after),
    stockBefore: r.stock_after == null ? null : round3(Number(r.stock_after) - Number(r.quantity)),
    reason: r.reason, note: r.note, referenceType: r.reference_type, referenceId: r.reference_id, batchId: r.batch_id,
    user: r.user_name, createdAt: r.created_at,
  }));
  return { product: { id: p.id, name: p.name, unit: p.unit, stock: Number(p.stock) }, rows: page, nextBefore: more ? page[page.length - 1].id : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Physical stock count. States: counting → review → approved (or cancelled). Counting and review change NOTHING in stock;
// approving applies each variance as an auditable 'stock_count' adjustment, under the same row locks as any other adjustment.
// ---------------------------------------------------------------------------------------------------------------------------------

const money = (n) => Math.round(n * 100) / 100;

function summarise(items) {
  const s = { counted: items.length, matched: 0, short: 0, over: 0, shortUnits: 0, overUnits: 0, varianceValue: 0 };
  for (const i of items) {
    const v = i.variance;
    if (v === 0) s.matched++;
    else if (v < 0) { s.short++; s.shortUnits = round3(s.shortUnits + v); } else { s.over++; s.overUnits = round3(s.overUnits + v); }
    s.varianceValue = money(s.varianceValue + i.varianceValue);
  }
  return s;
}

const shapeItem = (r) => {
  const expected = Number(r.expected_qty); const counted = Number(r.counted_qty); const variance = round3(counted - expected);
  return { id: r.id, productId: r.product_id, name: r.name, sku: r.sku, unit: r.unit, expected, counted, variance, unitCost: Number(r.unit_cost), varianceValue: money(variance * Number(r.unit_cost)), currentStock: Number(r.current_stock) };
};

async function loadCount(client, id, lock = false) {
  const c = (await client.query(`SELECT c.*, s.name AS started_by_name, ap.name AS approved_by_name FROM stock_counts c LEFT JOIN accounts s ON s.id = c.started_by LEFT JOIN accounts ap ON ap.id = c.approved_by WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [id])).rows[0];
  if (!c) throw notFound('Stock count not found.');
  return c;
}

async function countDetail(client, id) {
  const c = await loadCount(client, id);
  const items = (await client.query(
    `SELECT i.id, i.product_id, i.expected_qty, i.counted_qty, i.unit_cost, p.name, p.sku, p.unit, p.stock AS current_stock
       FROM stock_count_items i JOIN products p ON p.business_id = i.business_id AND p.id = i.product_id
      WHERE i.stock_count_id = $1 ORDER BY p.name`, [id])).rows.map(shapeItem);
  return {
    id: c.id, title: c.title, status: c.status, note: c.note, startedBy: c.started_by_name, startedAt: c.started_at, submittedAt: c.submitted_at,
    approvedBy: c.approved_by_name, approvedAt: c.approved_at, items, summary: summarise(items),
  };
}

async function startCount({ title, note }, userId) {
  const open = (await query(`SELECT id FROM stock_counts WHERE status IN ('counting','review') LIMIT 1`)).rows[0];
  if (open) throw conflict('A stock count is already open. Finish or cancel it before starting another.', { code: 'COUNT_ALREADY_OPEN', countId: open.id });
  const r = await query(`INSERT INTO stock_counts (title, note, started_by) VALUES ($1,$2,$3) RETURNING id`, [title || 'Stock count', note || null, userId]);
  return { id: r.rows[0].id };
}

async function listCounts() {
  const rows = (await query(
    `SELECT c.id, c.title, c.status, c.started_at, c.approved_at, u.name AS started_by, (SELECT COUNT(*)::int FROM stock_count_items i WHERE i.stock_count_id = c.id) AS items
       FROM stock_counts c LEFT JOIN accounts u ON u.id = c.started_by ORDER BY c.started_at DESC, c.id DESC LIMIT 50`)).rows;
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, startedAt: r.started_at, approvedAt: r.approved_at, startedBy: r.started_by, items: r.items }));
}

const getCount = (id) => withTransaction((client) => countDetail(client, id));

/** Record (or re-record) the physical quantity for one product. The expected quantity is frozen the FIRST time the product is counted. */
async function recordItem(countId, productId, countedQty, userId) {
  await withTransaction(async (client) => {
    const c = await loadCount(client, countId, true);
    if (c.status !== 'counting') throw conflict(`This count is ${c.status} — items can no longer be changed.`, { code: 'COUNT_NOT_OPEN' });
    const p = (await client.query('SELECT name, unit, stock, avg_cost FROM products WHERE id = $1 AND is_active = TRUE', [productId])).rows[0];
    if (!p) throw notFound('Product not found.');
    assertQuantity(p.unit, countedQty, 'Counted quantity', p.name);
    await client.query(
      `INSERT INTO stock_count_items (stock_count_id, product_id, expected_qty, counted_qty, unit_cost, counted_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (business_id, stock_count_id, product_id) DO UPDATE SET counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by`,
      [countId, productId, p.stock, countedQty, p.avg_cost, userId],
    );
  });
  return getCount(countId);
}

async function removeItem(countId, productId) {
  await withTransaction(async (client) => {
    const c = await loadCount(client, countId, true);
    if (c.status !== 'counting') throw conflict(`This count is ${c.status} — items can no longer be changed.`, { code: 'COUNT_NOT_OPEN' });
    await client.query('DELETE FROM stock_count_items WHERE stock_count_id = $1 AND product_id = $2', [countId, productId]);
  });
  return getCount(countId);
}

/** counting → review. Still no stock change; the variance summary is what the approver looks at. */
async function submitCount(countId, userId) {
  return withTransaction(async (client) => {
    const c = await loadCount(client, countId, true);
    if (c.status !== 'counting') throw conflict(`This count is already ${c.status}.`, { code: 'COUNT_NOT_OPEN' });
    const n = (await client.query('SELECT COUNT(*)::int AS n FROM stock_count_items WHERE stock_count_id = $1', [countId])).rows[0].n;
    if (!n) throw badRequest('Count at least one product before sending the count for review.');
    await client.query(`UPDATE stock_counts SET status = 'review', submitted_by = $2, submitted_at = now() WHERE id = $1`, [countId, userId]);
    return countDetail(client, countId);
  });
}

async function cancelCount(countId) {
  return withTransaction(async (client) => {
    const c = await loadCount(client, countId, true);
    if (!['counting', 'review'].includes(c.status)) throw conflict(`This count is already ${c.status}.`, { code: 'COUNT_NOT_OPEN' });
    await client.query(`UPDATE stock_counts SET status = 'cancelled' WHERE id = $1`, [countId]);
    return countDetail(client, countId);
  });
}

/**
 * review → approved. The ONLY step that changes stock. All-or-nothing: if any product changed since it was counted (a sale or a receipt
 * moved its stock), the whole approval is refused with the list, so the approver never overwrites live movement with a stale count.
 * Each variance becomes one 'stock_count' adjustment movement referencing the count.
 */
async function approveCount(countId, userId) {
  const out = await withTransaction(async (client) => {
    const c = await loadCount(client, countId, true);
    if (c.status !== 'review') throw conflict(c.status === 'approved' ? 'This count was already approved.' : 'Send the count for review before approving it.', { code: 'COUNT_NOT_IN_REVIEW' });
    const items = (await client.query(
      `SELECT i.product_id, i.expected_qty, i.counted_qty FROM stock_count_items i WHERE i.stock_count_id = $1 ORDER BY i.product_id`, [countId])).rows;
    const stale = []; const applied = [];
    for (const i of items) {
      const p = (await client.query('SELECT name, unit, stock FROM products WHERE id = $1 FOR UPDATE', [i.product_id])).rows[0];
      if (Number(p.stock) !== Number(i.expected_qty)) stale.push({ productId: i.product_id, name: p.name, expected: Number(i.expected_qty), currentStock: Number(p.stock) });
    }
    if (stale.length) throw conflict('Stock changed after these products were counted. Re-count them, then approve again.', { code: 'COUNT_STALE', stale });
    for (const i of items) {
      const delta = round3(Number(i.counted_qty) - Number(i.expected_qty));
      if (delta === 0) continue;
      const r = await applyAdjustment(client, { productId: i.product_id, delta, reason: 'stock_count', note: `Stock count #${countId}`, userId, referenceType: 'stock_count', referenceId: countId });
      applied.push({ productId: i.product_id, name: r.name, before: r.before, after: r.after, delta });
    }
    await client.query(`UPDATE stock_counts SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [countId, userId]);
    return { detail: await countDetail(client, countId), applied };
  });
  invalidateAll();
  return out;
}

module.exports = { REASONS, applyAdjustment, adjustStock, addBatchStock, getTimeline, startCount, listCounts, getCount, recordItem, removeItem, submitCount, cancelCount, approveCount };
