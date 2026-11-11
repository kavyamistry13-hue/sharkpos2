// PURCHASING — purchase orders, partial receiving, purchase history. Deterministic; no AI.
// Lifecycle:  draft → ordered → partially_received → received      (or cancelled; or closed short from partially_received)
//   ordered_qty   what you asked the supplier for
//   received_qty  what was accepted into stock (never more than ordered)
//   rejected_qty  what arrived but was refused: NOT added to stock, and still counts as outstanding
// Receiving adds stock, writes inventory movements, records the actual invoiced cost in product cost history and supplier price history.
const config = require('../config');
const batches = require('./batches');
const { query, withTransaction } = require('../db');
const { HttpError, badRequest, conflict, notFound } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertQuantity, round3 } = require('../utils/units');

const OPEN = ['draft', 'ordered', 'partially_received'];
const pad = (n) => String(n).padStart(5, '0');
const r2 = (n) => Math.round(n * 100) / 100;
const isMultiple = (q, size) => Math.abs(q / size - Math.round(q / size)) < 1e-6;

async function todayLocal(q = query) {
  return (await q('SELECT ((now() AT TIME ZONE $1)::date)::text AS d', [config.storeTz])).rows[0].d;
}

async function lockPo(client, id) {
  const po = (await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!po) throw notFound('Purchase order not found.');
  return po;
}

/** Validates and prices the lines of a draft: unique active products, quantities that fit the unit, cost = given → supplier's last cost → product cost. */
async function resolveLines(client, supplierId, items) {
  if (!items || !items.length) throw badRequest('Add at least one product.');
  const ids = items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each product can appear only once on a purchase order.');
  const prods = (await client.query(
    `SELECT p.id, p.name, p.unit, p.purchase_price, sp.last_cost
       FROM products p LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.supplier_id = $2
      WHERE p.id = ANY($1::int[]) AND p.is_active`, [ids, supplierId],
  )).rows;
  const byId = new Map(prods.map((p) => [p.id, p]));
  return items.map((i) => {
    const p = byId.get(i.productId);
    if (!p) throw notFound('Product not found.');
    assertQuantity(p.unit, i.quantity, 'Quantity', p.name);
    const cost = i.unitCost ?? p.last_cost ?? p.purchase_price;
    return { productId: p.id, quantity: round3(i.quantity), unitCost: Number(cost) };
  });
}

// ---------------------------------------------------------------- reads

async function getPo(id) {
  const head = (await query(
    `SELECT po.*, s.name AS supplier, s.lead_time_days AS supplier_lead, s.min_order_value, u.name AS created_by_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN users u ON u.id = po.created_by WHERE po.id = $1`, [id],
  )).rows[0];
  if (!head) throw notFound('Purchase order not found.');
  const [items, receipts, today] = await Promise.all([
    query(
      `SELECT i.id, i.product_id, p.name, p.sku, p.unit, i.ordered_qty, i.received_qty, i.rejected_qty, i.unit_cost,
              sp.pack_size, sp.min_order_qty,
              (SELECT r.id FROM restock_orders r WHERE r.purchase_order_item_id = i.id ORDER BY r.id LIMIT 1) AS restock_order_id
         FROM purchase_order_items i JOIN products p ON p.id = i.product_id
         LEFT JOIN supplier_products sp ON sp.product_id = i.product_id AND sp.supplier_id = $2
        WHERE i.purchase_order_id = $1 ORDER BY i.id`, [id, head.supplier_id],
    ),
    query(
      `SELECT g.id, g.received_at, g.invoice_no, g.notes, u.name AS received_by,
              gi.purchase_order_item_id, gi.product_id, p.name AS product, gi.quantity, gi.rejected_quantity, gi.unit_cost
         FROM goods_receipts g LEFT JOIN users u ON u.id = g.received_by
         JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id JOIN products p ON p.id = gi.product_id
        WHERE g.purchase_order_id = $1 ORDER BY g.received_at, g.id, gi.id`, [id],
    ),
    todayLocal(),
  ]);
  const lines = items.rows.map((i) => ({
    id: i.id, productId: i.product_id, name: i.name, sku: i.sku, unit: i.unit,
    orderedQty: i.ordered_qty, receivedQty: i.received_qty, rejectedQty: i.rejected_qty, outstandingQty: round3(i.ordered_qty - i.received_qty),
    unitCost: i.unit_cost, lineTotal: r2(i.ordered_qty * i.unit_cost), packSize: i.pack_size, minOrderQty: i.min_order_qty, restockOrderId: i.restock_order_id,
  }));
  const rec = new Map();
  for (const r of receipts.rows) {
    if (!rec.has(r.id)) rec.set(r.id, { id: r.id, receivedAt: r.received_at, invoiceNo: r.invoice_no, notes: r.notes, receivedBy: r.received_by, items: [] });
    rec.get(r.id).items.push({ itemId: r.purchase_order_item_id, productId: r.product_id, product: r.product, quantity: r.quantity, rejectedQuantity: r.rejected_quantity, unitCost: r.unit_cost });
  }
  const orderedValue = r2(lines.reduce((a, l) => a + l.lineTotal, 0));
  const receivedValue = r2(receipts.rows.reduce((a, r) => a + r.quantity * r.unit_cost, 0));

  // Advisory only (never blocks an order): supplier terms the order does not meet.
  const warnings = [];
  for (const l of lines) {
    if (l.minOrderQty && l.orderedQty < l.minOrderQty) warnings.push(`${l.name}: ${l.orderedQty} is below this supplier's minimum order of ${l.minOrderQty}.`);
    if (l.packSize && l.packSize > 1 && !isMultiple(l.orderedQty, l.packSize)) warnings.push(`${l.name}: ${l.orderedQty} is not a multiple of the pack size ${l.packSize}.`);
  }
  if (head.min_order_value > 0 && orderedValue < head.min_order_value) warnings.push(`Order value ₹${orderedValue} is below this supplier's minimum of ₹${head.min_order_value}.`);

  return {
    id: head.id, poNumber: head.po_number, supplierId: head.supplier_id, supplier: head.supplier, status: head.status,
    orderDate: head.order_date, expectedDate: head.expected_date, orderedAt: head.ordered_at, closedAt: head.closed_at, closedShort: head.closed_short,
    notes: head.notes, createdBy: head.created_by_name, createdAt: head.created_at,
    isOverdue: Boolean(head.expected_date && head.expected_date < today && ['ordered', 'partially_received'].includes(head.status)),
    items: lines, receipts: [...rec.values()], orderedValue, receivedValue, warnings,
  };
}

async function listPos({ status, supplierId, overdue, page = 1, limit = 25 } = {}) {
  const today = await todayLocal();
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (status === 'open') where.push(`po.status IN ('draft','ordered','partially_received')`);
  else if (status) where.push(`po.status = ${p(status)}`);
  if (supplierId) where.push(`po.supplier_id = ${p(supplierId)}`);
  if (overdue) where.push(`po.status IN ('ordered','partially_received') AND po.expected_date < ${p(today)}::date`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query(`SELECT COUNT(*)::int AS n FROM purchase_orders po ${whereSql}`, params)).rows[0].n;
  const rows = (await query(
    `SELECT po.id, po.po_number, po.supplier_id, s.name AS supplier, po.status, po.order_date, po.expected_date, po.created_at, po.closed_short,
            (SELECT COUNT(*)::int FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS lines,
            (SELECT COALESCE(SUM(i.ordered_qty * i.unit_cost), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS ordered_value,
            (SELECT COALESCE(SUM(gi.quantity * gi.unit_cost), 0) FROM goods_receipts g JOIN goods_receipt_items gi ON gi.goods_receipt_id = g.id WHERE g.purchase_order_id = po.id) AS received_value,
            (SELECT COALESCE(SUM(i.ordered_qty), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS ordered_qty,
            (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS received_qty
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${whereSql}
      ORDER BY po.created_at DESC, po.id DESC LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`, params,
  )).rows.map((r) => ({
    id: r.id, poNumber: r.po_number, supplierId: r.supplier_id, supplier: r.supplier, status: r.status, orderDate: r.order_date, expectedDate: r.expected_date,
    createdAt: r.created_at, closedShort: r.closed_short, lines: r.lines, orderedValue: r2(r.ordered_value), receivedValue: r2(r.received_value),
    orderedQty: r.ordered_qty, receivedQty: r.received_qty,
    isOverdue: Boolean(r.expected_date && r.expected_date < today && ['ordered', 'partially_received'].includes(r.status)),
  }));
  return { total, page, limit, rows };
}

/** Every delivery line ever received: what, from whom, how much, at what price. */
async function purchaseHistory({ productId, supplierId, limit = 100 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (productId) where.push(`gi.product_id = ${p(productId)}`);
  if (supplierId) where.push(`po.supplier_id = ${p(supplierId)}`);
  const res = await query(
    `SELECT g.id AS receipt_id, g.received_at, g.invoice_no, po.id AS po_id, po.po_number, s.id AS supplier_id, s.name AS supplier,
            gi.product_id, p.name AS product, p.unit, gi.quantity, gi.rejected_quantity, gi.unit_cost
       FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.goods_receipt_id JOIN purchase_orders po ON po.id = g.purchase_order_id
       JOIN suppliers s ON s.id = po.supplier_id JOIN products p ON p.id = gi.product_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.received_at DESC, gi.id DESC LIMIT ${p(limit)}`, params,
  );
  return res.rows.map((r) => ({
    receiptId: r.receipt_id, receivedAt: r.received_at, invoiceNo: r.invoice_no, purchaseOrderId: r.po_id, poNumber: r.po_number, supplierId: r.supplier_id, supplier: r.supplier,
    productId: r.product_id, product: r.product, unit: r.unit, quantity: r.quantity, rejectedQuantity: r.rejected_quantity, unitCost: r.unit_cost, lineTotal: r2(r.quantity * r.unit_cost),
  }));
}

// ---------------------------------------------------------------- writes

async function createPo(user, input) {
  const id = await withTransaction(async (client) => {
    const sup = (await client.query('SELECT id, is_active FROM suppliers WHERE id = $1', [input.supplierId])).rows[0];
    if (!sup) throw notFound('Supplier not found.');
    if (!sup.is_active) throw badRequest('This supplier is inactive.');
    const lines = await resolveLines(client, input.supplierId, input.items);
    const ins = await client.query(
      `INSERT INTO purchase_orders (supplier_id, expected_date, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [input.supplierId, input.expectedDate || null, input.notes || null, user.id],
    );
    const poId = ins.rows[0].id;
    await client.query('UPDATE purchase_orders SET po_number = $1 WHERE id = $2', [`PO-${ins.rows[0].created_at.toISOString().slice(0, 10).replace(/-/g, '')}-${pad(poId)}`, poId]);
    for (const l of lines) {
      await client.query('INSERT INTO purchase_order_items (purchase_order_id, product_id, ordered_qty, unit_cost) VALUES ($1,$2,$3,$4)', [poId, l.productId, l.quantity, l.unitCost]);
    }
    return poId;
  });
  invalidateAll();
  return getPo(id);
}

/** Edit a DRAFT: dates, notes, and (optionally) the full list of lines. Lines linked to restock orders are unlinked before removal. */
async function updateDraft(id, input) {
  await withTransaction(async (client) => {
    const po = await lockPo(client, id);
    if (po.status !== 'draft') throw conflict('Only a draft purchase order can be edited.', { code: 'PO_NOT_DRAFT' });
    if (input.expectedDate !== undefined || input.notes !== undefined) {
      await client.query('UPDATE purchase_orders SET expected_date = $1, notes = $2 WHERE id = $3', [input.expectedDate !== undefined ? input.expectedDate : po.expected_date, input.notes !== undefined ? input.notes : po.notes, id]);
    }
    if (input.items) {
      const lines = await resolveLines(client, po.supplier_id, input.items);
      const existing = (await client.query('SELECT id, product_id FROM purchase_order_items WHERE purchase_order_id = $1 FOR UPDATE', [id])).rows;
      const keep = new Set(lines.map((l) => l.productId));
      for (const e of existing.filter((x) => !keep.has(x.product_id))) {
        await client.query('UPDATE restock_orders SET purchase_order_item_id = NULL WHERE purchase_order_item_id = $1', [e.id]);
        await client.query('DELETE FROM purchase_order_items WHERE id = $1', [e.id]);
      }
      const have = new Map(existing.map((x) => [x.product_id, x.id]));
      for (const l of lines) {
        if (have.has(l.productId)) await client.query('UPDATE purchase_order_items SET ordered_qty = $1, unit_cost = $2 WHERE id = $3', [l.quantity, l.unitCost, have.get(l.productId)]);
        else await client.query('INSERT INTO purchase_order_items (purchase_order_id, product_id, ordered_qty, unit_cost) VALUES ($1,$2,$3,$4)', [id, l.productId, l.quantity, l.unitCost]);
      }
    }
  });
  invalidateAll();
  return getPo(id);
}

/** draft → ordered. Fixes the order date and the expected delivery (default: today + the supplier's lead time). */
async function placeOrder(id, { expectedDate } = {}) {
  await withTransaction(async (client) => {
    const po = await lockPo(client, id);
    if (po.status !== 'draft') throw conflict(`This purchase order is already ${po.status.replace('_', ' ')}.`, { code: 'PO_NOT_DRAFT' });
    const n = (await client.query('SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE purchase_order_id = $1', [id])).rows[0].n;
    if (!n) throw badRequest('Add at least one product before placing the order.');
    const sup = (await client.query('SELECT is_active, lead_time_days FROM suppliers WHERE id = $1', [po.supplier_id])).rows[0];
    if (!sup.is_active) throw badRequest('This supplier is inactive.');
    const today = await todayLocal(client.query.bind(client));
    const expected = expectedDate || po.expected_date || (await client.query(`SELECT (($1::date) + $2::int)::text AS d`, [today, sup.lead_time_days])).rows[0].d;
    if (expected < today) throw badRequest('The expected delivery date cannot be in the past.');
    await client.query(`UPDATE purchase_orders SET status = 'ordered', order_date = $1::date, ordered_at = now(), expected_date = $2::date WHERE id = $3`, [today, expected, id]);
  });
  invalidateAll();
  return getPo(id);
}

/**
 * Record a delivery (full or partial). Validates everything first, then writes in one transaction:
 * receipt + lines, ordered-vs-received counters, stock, inventory movements, cost history, supplier price history, PO status.
 * An optional Idempotency-Key makes a repeated submit return the first receipt instead of receiving twice.
 */
async function receive(id, user, input, idempotencyKey) {
  const result = await withTransaction(async (client) => {
    const po = await lockPo(client, id);
    if (idempotencyKey) {
      const prev = (await client.query('SELECT id, purchase_order_id FROM goods_receipts WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
      if (prev) {
        if (prev.purchase_order_id !== id) throw new HttpError(422, 'This idempotency key was already used for a different purchase order.', { code: 'IDEMPOTENCY_KEY_REUSED' });
        return { receiptId: prev.id, replayed: true, priceChanges: [] };
      }
    }
    if (po.status === 'draft') throw conflict('Place the order before receiving goods.', { code: 'PO_NOT_ORDERED' });
    if (!['ordered', 'partially_received'].includes(po.status)) throw conflict(`This purchase order is ${po.status.replace('_', ' ')}.`, { code: 'PO_CLOSED' });

    const ids = input.items.map((i) => i.itemId);
    if (new Set(ids).size !== ids.length) throw badRequest('Each item can appear only once per delivery.');
    const items = (await client.query(
      `SELECT i.id, i.product_id, i.ordered_qty, i.received_qty, i.unit_cost, p.name, p.unit
         FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_order_id = $1 ORDER BY i.product_id FOR UPDATE OF i`, [id],
    )).rows;
    const byId = new Map(items.map((i) => [i.id, i]));

    const lines = [];
    for (const l of input.items) {
      const it = byId.get(l.itemId);
      if (!it) throw badRequest('One of the items is not on this purchase order.');
      const q = round3(l.quantity || 0);
      const rej = round3(l.rejectedQuantity || 0);
      if (q === 0 && rej === 0) continue;
      assertQuantity(it.unit, q, 'Received quantity', it.name);
      assertQuantity(it.unit, rej, 'Rejected quantity', it.name);
      const outstanding = round3(it.ordered_qty - it.received_qty);
      if (q > outstanding) throw conflict(`Only ${outstanding} ${it.unit} of ${it.name} are still to be received (you entered ${q}).`, { code: 'OVER_RECEIPT', itemId: it.id, outstanding });
      lines.push({ it, q, rej, cost: l.unitCost !== undefined ? Number(l.unitCost) : Number(it.unit_cost), batchNo: l.batchNo || null, manufacturedDate: l.manufacturedDate || null, expiryDate: l.expiryDate || null });
    }
    if (!lines.length) throw badRequest('Enter a received or rejected quantity for at least one item.');

    const rc = await client.query(
      `INSERT INTO goods_receipts (purchase_order_id, received_by, invoice_no, notes, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, user.id, input.invoiceNo || null, input.notes || null, idempotencyKey || null],
    );
    const receiptId = rc.rows[0].id;
    const priceChanges = [];
    for (const { it, q, rej, cost, batchNo, manufacturedDate, expiryDate } of lines) {
      await client.query('UPDATE purchase_order_items SET received_qty = received_qty + $1, rejected_qty = rejected_qty + $2 WHERE id = $3', [q, rej, it.id]);
      await client.query('INSERT INTO goods_receipt_items (goods_receipt_id, purchase_order_item_id, product_id, quantity, rejected_quantity, unit_cost, batch_no, manufactured_date, expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [receiptId, it.id, it.product_id, q, rej, cost, batchNo, manufacturedDate, expiryDate]);
      if (q <= 0) continue;
      const p = (await client.query(
        `SELECT p.purchase_price, p.selling_price, p.price_includes_tax, c.tax_rate FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = $1 FOR UPDATE OF p`, [it.product_id],
      )).rows[0];
      await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [q, it.product_id]);
      // Optional batch / expiry captured at receiving (Phase 9). Without them nothing changes for the product.
      const batch = batchNo || expiryDate ? await batches.addToBatch(client, { productId: it.product_id, batchNo, manufacturedDate, expiryDate, quantity: q, unitCost: cost, supplierId: po.supplier_id, receiptId, userId: user.id }) : null;
      await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type, created_by, batch_id) VALUES ($1,'restock',$2,$3,'goods_receipt',$4,$5)`, [it.product_id, q, receiptId, user.id, batch ? batch.id : null]);
      if (Number(p.purchase_price) !== cost) {
        await client.query('UPDATE products SET purchase_price = $1 WHERE id = $2', [cost, it.product_id]);
        await client.query(`INSERT INTO product_cost_history (product_id, cost, source, ref_type, ref_id, created_by) VALUES ($1,$2,'purchase','goods_receipt',$3,$4)`, [it.product_id, cost, receiptId, user.id]);
        // Informational only: the selling price is NEVER changed automatically.
        const net = p.price_includes_tax ? p.selling_price / (1 + p.tax_rate / 100) : p.selling_price;
        const margin = (c) => (net > 0 ? Math.round(((net - c) / net) * 1000) / 10 : null);
        priceChanges.push({ productId: it.product_id, product: it.name, oldCost: Number(p.purchase_price), newCost: cost, sellingPrice: p.selling_price, oldMarginPct: margin(Number(p.purchase_price)), newMarginPct: margin(cost) });
      }
      await client.query(`INSERT INTO supplier_price_history (supplier_id, product_id, unit_cost, source, purchase_order_id, goods_receipt_id, created_by) VALUES ($1,$2,$3,'purchase_order',$4,$5,$6)`, [po.supplier_id, it.product_id, cost, id, receiptId, user.id]);
      await client.query(
        `INSERT INTO supplier_products (supplier_id, product_id, last_cost) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, supplier_id, product_id) DO UPDATE SET last_cost = EXCLUDED.last_cost`, [po.supplier_id, it.product_id, cost],
      );
    }

    const done = (await client.query('SELECT bool_and(received_qty >= ordered_qty) AS all_in FROM purchase_order_items WHERE purchase_order_id = $1', [id])).rows[0].all_in;
    await client.query(`UPDATE purchase_orders SET status = $1::text, closed_at = CASE WHEN $1::text = 'received' THEN now() ELSE closed_at END WHERE id = $2`, [done ? 'received' : 'partially_received', id]);
    await client.query(
      `UPDATE restock_orders SET status = 'received', resolved_at = now()
        WHERE status = 'approved' AND purchase_order_item_id IN (SELECT id FROM purchase_order_items WHERE purchase_order_id = $1 AND received_qty >= ordered_qty)`, [id],
    );
    return { receiptId, replayed: false, priceChanges };
  });
  invalidateAll();
  return { ...result, purchaseOrder: await getPo(id) };
}

/** Finish a partially received order without waiting for the rest: the missing quantity stops counting as "on order". */
async function closeShort(id) {
  await withTransaction(async (client) => {
    const po = await lockPo(client, id);
    if (po.status !== 'partially_received') throw conflict('Only a partially received order can be closed short.', { code: 'PO_NOT_PARTIAL' });
    await client.query(`UPDATE purchase_orders SET status = 'received', closed_short = TRUE, closed_at = now() WHERE id = $1`, [id]);
    await client.query(
      `UPDATE restock_orders r SET status = CASE WHEN i.received_qty >= i.ordered_qty THEN 'received' ELSE 'dismissed' END, resolved_at = now()
         FROM purchase_order_items i WHERE r.purchase_order_item_id = i.id AND i.purchase_order_id = $1 AND r.status = 'approved'`, [id],
    );
  });
  invalidateAll();
  return getPo(id);
}

async function cancel(id) {
  await withTransaction(async (client) => {
    const po = await lockPo(client, id);
    if (!['draft', 'ordered'].includes(po.status)) throw conflict(po.status === 'partially_received' ? 'Goods were already received. Close the order short instead.' : `This purchase order is already ${po.status.replace('_', ' ')}.`, { code: 'PO_CANNOT_CANCEL' });
    if ((await client.query('SELECT 1 FROM goods_receipts WHERE purchase_order_id = $1 LIMIT 1', [id])).rowCount) throw conflict('Goods were already received. Close the order short instead.', { code: 'PO_CANNOT_CANCEL' });
    await client.query(`UPDATE purchase_orders SET status = 'cancelled', closed_at = now() WHERE id = $1`, [id]);
    await client.query(
      `UPDATE restock_orders SET status = 'dismissed', resolved_at = now()
        WHERE status = 'approved' AND purchase_order_item_id IN (SELECT id FROM purchase_order_items WHERE purchase_order_id = $1)`, [id],
    );
  });
  invalidateAll();
  return getPo(id);
}

/**
 * Turn approved, not-yet-ordered restock orders into DRAFT purchase orders, one per supplier (the product's main supplier).
 * Nothing is ordered until the owner places the draft. The restock quantity keeps counting as "on order" while the draft exists.
 */
async function fromRestock(user, restockOrderIds) {
  const poIds = await withTransaction(async (client) => {
    const ids = [...new Set(restockOrderIds)];
    const rows = (await client.query(
      `SELECT r.id, r.product_id, r.quantity, r.status, r.purchase_order_item_id, p.name, p.unit, p.supplier_id, p.purchase_price, s.is_active AS supplier_active, sp.last_cost
         FROM restock_orders r JOIN products p ON p.id = r.product_id LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.supplier_id = p.supplier_id
        WHERE r.id = ANY($1::int[]) ORDER BY r.id FOR UPDATE OF r`, [ids],
    )).rows;
    if (rows.length !== ids.length) throw notFound('Restock order not found.');
    for (const r of rows) {
      if (r.status !== 'approved') throw conflict(`The restock order for ${r.name} is already ${r.status}.`);
      if (r.purchase_order_item_id) throw conflict(`The restock order for ${r.name} is already on a purchase order.`, { code: 'RESTOCK_ALREADY_LINKED' });
      if (!r.supplier_id) throw badRequest(`${r.name} has no supplier. Assign a supplier to the product first.`, { code: 'PRODUCT_HAS_NO_SUPPLIER' });
      if (!r.supplier_active) throw badRequest(`The supplier of ${r.name} is inactive.`);
    }
    const bySupplier = new Map();
    for (const r of rows) {
      if (!bySupplier.has(r.supplier_id)) bySupplier.set(r.supplier_id, new Map());
      const prods = bySupplier.get(r.supplier_id);
      if (!prods.has(r.product_id)) prods.set(r.product_id, { qty: 0, cost: Number(r.last_cost ?? r.purchase_price), restockIds: [] });
      const e = prods.get(r.product_id);
      e.qty = round3(e.qty + r.quantity);
      e.restockIds.push(r.id);
    }
    const created = [];
    for (const [supplierId, prods] of bySupplier) {
      const ins = await client.query('INSERT INTO purchase_orders (supplier_id, created_by, notes) VALUES ($1,$2,$3) RETURNING id, created_at', [supplierId, user.id, 'Created from approved restock orders']);
      const poId = ins.rows[0].id;
      await client.query('UPDATE purchase_orders SET po_number = $1 WHERE id = $2', [`PO-${ins.rows[0].created_at.toISOString().slice(0, 10).replace(/-/g, '')}-${pad(poId)}`, poId]);
      for (const [productId, e] of prods) {
        const item = await client.query('INSERT INTO purchase_order_items (purchase_order_id, product_id, ordered_qty, unit_cost) VALUES ($1,$2,$3,$4) RETURNING id', [poId, productId, e.qty, e.cost]);
        await client.query('UPDATE restock_orders SET purchase_order_item_id = $1 WHERE id = ANY($2::int[])', [item.rows[0].id, e.restockIds]);
      }
      created.push(poId);
    }
    return created;
  });
  invalidateAll();
  return Promise.all(poIds.map(getPo));
}

module.exports = { OPEN, getPo, listPos, purchaseHistory, createPo, updateDraft, placeOrder, receive, closeShort, cancel, fromRestock };
