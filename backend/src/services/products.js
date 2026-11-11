const { query, withTransaction } = require('../db');
const { getProductStats } = require('./forecast');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertWithinLimit } = require('./billing/subscription');
const { currentBusinessId } = require('../db');
const { assertQuantity, isDecimalUnit } = require('../utils/units');
const barcodes = require('./barcodes');
const batches = require('./batches');
const crypto = require('crypto');

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  price: (a, b) => a.sellingPrice - b.sellingPrice,
  stock: (a, b) => a.stock - b.stock,
  category: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  sku: (a, b) => a.sku.localeCompare(b.sku),
  risk: (a, b) => b.stockoutRisk - a.stockoutRisk,
  margin: (a, b) => b.sellingPrice - b.purchasePrice - (a.sellingPrice - a.purchasePrice),
};

const statusLabel = (p) => (p.outOfStock ? 'out_of_stock' : p.lowStock ? 'low_stock' : p.expiryStatus === 'expired' ? 'expired' : 'in_stock');

async function listProducts(f) {
  // Inactive (archived) products are not part of the live stats: a separate, simple, paginated query.
  if (f.active === 'inactive') return listInactive(f);
  let rows = await getProductStats();
  if (f.q) {
    const q = f.q.toLowerCase();
    // a typed/scanned barcode finds its product too (substring, so a partial code works)
    const byCode = new Set((await query('SELECT DISTINCT product_id FROM product_barcodes WHERE barcode ILIKE $1', [`%${f.q.replace(/[\\%_]/g, '\\$&')}%`])).rows.map((r) => r.product_id));
    rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || byCode.has(p.id));
  }
  if (f.categoryId) rows = rows.filter((p) => p.categoryId === f.categoryId);
  if (f.supplierId) rows = rows.filter((p) => p.supplierId === f.supplierId);
  if (f.status) rows = rows.filter((p) => statusLabel(p) === f.status);
  if (f.reorder) rows = rows.filter((p) => p.needsReorder);
  if (f.batch === 'yes') rows = rows.filter((p) => p.trackBatches);
  if (f.batch === 'no') rows = rows.filter((p) => !p.trackBatches);
  if (f.expiry) {                       // batch expiries + legacy product-level dates, from the same report the Expiry screen uses
    const ids = new Set((await batches.expiryReport(f.expiry)).rows.map((r) => r.productId));
    rows = rows.filter((p) => ids.has(p.id));
  }
  const sorted = [...rows].sort(SORTS[f.sort] || SORTS.name);
  if (f.dir === 'desc') sorted.reverse();
  const total = sorted.length;
  const slice = sorted.slice((f.page - 1) * f.limit, f.page * f.limit);
  const codes = await barcodes.mapForProducts(slice.map((p) => p.id));
  const page = slice.map((p) => ({ ...p, status: statusLabel(p), barcodes: codes.get(p.id) || [] }));
  return { total, page: f.page, limit: f.limit, rows: page };
}

async function listInactive(f) {
  const params = []; const where = ['p.is_active = FALSE'];
  if (f.q) { params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
  if (f.categoryId) { params.push(f.categoryId); where.push(`p.category_id = $${params.length}`); }
  if (f.supplierId) { params.push(f.supplierId); where.push(`p.supplier_id = $${params.length}`); }
  const total = (await query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where.join(' AND ')}`, params)).rows[0].n;
  params.push(f.limit, (f.page - 1) * f.limit);
  const rows = (await query(
    `SELECT p.id, p.sku, p.name, p.unit, p.stock, p.purchase_price, p.selling_price, c.name AS category, s.name AS supplier
       FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  return { total, page: f.page, limit: f.limit, rows: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, unit: r.unit, stock: Number(r.stock), purchasePrice: r.purchase_price, sellingPrice: r.selling_price, category: r.category, supplier: r.supplier, isActive: false, status: 'inactive', barcodes: [] })) };
}

async function getLookups() {
  const [categories, suppliers] = await Promise.all([
    query('SELECT id, name, tax_rate FROM categories ORDER BY name'),
    query('SELECT id, name, phone, email, lead_time_days FROM suppliers WHERE is_active ORDER BY name'),
  ]);
  return {
    categories: categories.rows.map((c) => ({ id: c.id, name: c.name, taxRate: c.tax_rate })),
    suppliers: suppliers.rows.map((s) => ({ id: s.id, name: s.name, phone: s.phone, email: s.email, leadTimeDays: s.lead_time_days })),
  };
}

async function getProduct(id) {
  const all = await getProductStats();
  const p = all.find((x) => x.id === id);
  if (!p) throw notFound('Product not found.');
  return { ...p, status: statusLabel(p), barcodes: (await barcodes.mapForProducts([id])).get(id) || [] };
}

/** Optional stock targets: whole numbers for counted units, and max stock can never be below the minimum. */
function assertStockLevels(unit, name, min, max, reorder) {
  if (max != null) { assertQuantity(unit, max, 'Maximum stock', name); if (max < (min || 0)) throw badRequest('Maximum stock cannot be lower than the minimum stock.'); }
  if (reorder != null) { assertQuantity(unit, reorder, 'Reorder level', name); if (max != null && reorder > max) throw badRequest('Reorder level cannot be higher than the maximum stock.'); }
}

/** Creates ONE product inside the caller's transaction (also used by the CSV import, so imported and hand-made products follow identical rules). */
async function createProductTx(client, input, userId) {
  const sku = input.sku || `SKU-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const unit = input.unit || 'pcs';
  assertQuantity(unit, input.stock, 'Stock', input.name);
  assertQuantity(unit, input.minimumStock, 'Minimum stock', input.name);
  assertStockLevels(unit, input.name, input.minimumStock, input.maxStock, input.reorderLevel);
  const res = await client.query(
    `INSERT INTO products (sku, name, category_id, purchase_price, selling_price, stock, minimum_stock, supplier_id, lead_time_days, expiry_date, unit, price_includes_tax, max_stock, reorder_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [sku, input.name, input.categoryId, input.purchasePrice, input.sellingPrice, input.stock, input.minimumStock, input.supplierId || null, input.leadTimeDays, input.expiryDate || null, unit, Boolean(input.priceIncludesTax), input.maxStock ?? null, input.reorderLevel ?? null],
  );
  await client.query(`INSERT INTO product_cost_history (product_id, cost, source, created_by) VALUES ($1,$2,'initial',$3)`, [res.rows[0].id, input.purchasePrice, userId]);
  if (input.stock > 0) {
    await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type) VALUES ($1,'initial',$2,$3,NULL)`, [res.rows[0].id, input.stock, userId]);
  }
  // optional manufacturer barcode, saved atomically with the product (a duplicate rolls the whole creation back)
  if (input.barcode) await barcodes.insertBarcode(client, res.rows[0].id, input.barcode, userId, { primary: true });
  return res.rows[0].id;
}

async function createProduct(input, userId) {
  await assertWithinLimit(currentBusinessId(), 'products');
  const id = await withTransaction((client) => createProductTx(client, input, userId));
  invalidateAll();
  return getProduct(id);
}

/**
 * First-time registration of a manufacturer barcode from the Counter: a product with only what the cashier knows (name, price, unit, stock),
 * plus its barcode, in ONE transaction. Category defaults to "General" (or the shop's first category); cost stays 0 until the owner fills it in.
 */
async function quickCreate(input, userId) {
  let categoryId = input.categoryId;
  if (!categoryId) {
    const c = (await query(`SELECT id FROM categories ORDER BY (lower(name) = 'general') DESC, name LIMIT 1`)).rows[0];
    if (!c) throw badRequest('Add a category first (Products → Categories), then register this barcode.');
    categoryId = c.id;
  }
  const p = await createProduct({
    name: input.name, categoryId, purchasePrice: input.purchasePrice ?? 0, sellingPrice: input.sellingPrice, stock: input.stock ?? 0, minimumStock: 0,
    unit: input.unit || 'pcs', priceIncludesTax: input.priceIncludesTax ?? true, leadTimeDays: 3, barcode: input.barcode,
  }, userId);
  const hit = await barcodes.lookup(input.barcode);
  return { product: p, scan: hit };
}

async function updateProduct(id, input, userId) {
  await withTransaction(async (client) => {
    const cur = (await client.query('SELECT name, stock, minimum_stock, unit, purchase_price, max_stock, reorder_level FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Product not found.');
    const map = {
      sku: 'sku', name: 'name', categoryId: 'category_id', purchasePrice: 'purchase_price', sellingPrice: 'selling_price',
      stock: 'stock', minimumStock: 'minimum_stock', supplierId: 'supplier_id', leadTimeDays: 'lead_time_days', expiryDate: 'expiry_date',
      unit: 'unit', priceIncludesTax: 'price_includes_tax', maxStock: 'max_stock', reorderLevel: 'reorder_level',
    };
    // The unit decides whether fractions are allowed; check the values the product will have AFTER this update.
    const nextUnit = input.unit !== undefined ? input.unit : cur.unit;
    assertQuantity(nextUnit, input.stock !== undefined ? input.stock : cur.stock, 'Stock', cur.name);
    assertQuantity(nextUnit, input.minimumStock !== undefined ? input.minimumStock : cur.minimum_stock, 'Minimum stock', cur.name);
    const nextMin = input.minimumStock !== undefined ? input.minimumStock : Number(cur.minimum_stock);
    assertStockLevels(nextUnit, cur.name, nextMin, input.maxStock !== undefined ? input.maxStock : (cur.max_stock == null ? null : Number(cur.max_stock)), input.reorderLevel !== undefined ? input.reorderLevel : (cur.reorder_level == null ? null : Number(cur.reorder_level)));
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (input[k] !== undefined) {
        params.push(input[k] === '' ? null : input[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('Nothing to update.');
    params.push(id);
    await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (input.stock !== undefined && input.stock !== cur.stock) {
      await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id) VALUES ($1,'adjustment',$2,$3)`, [id, Math.round((input.stock - cur.stock) * 1000) / 1000, userId]);
    }
    if (input.purchasePrice !== undefined && Number(input.purchasePrice) !== Number(cur.purchase_price)) {
      await client.query(`INSERT INTO product_cost_history (product_id, cost, source, created_by) VALUES ($1,$2,'manual',$3)`, [id, input.purchasePrice, userId]);
    }
  });
  invalidateAll();
  return getProduct(id);
}

/**
 * Adds received/found stock to a product ATOMICALLY (stock = stock + qty under a row lock), so a sale happening at the same moment is never
 * overwritten the way "set stock to X" could. Recorded as a normal 'adjustment' movement, exactly like a manual stock edit.
 */
async function addStock(id, qty, userId) {
  const out = await withTransaction(async (client) => {
    const cur = (await client.query('SELECT name, unit, stock FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Product not found.');
    assertQuantity(cur.unit, qty, 'Quantity', cur.name);
    const after = (await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING stock', [qty, id])).rows[0].stock;
    await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id) VALUES ($1,'adjustment',$2,$3)`, [id, qty, userId]);
    return { name: cur.name, unit: cur.unit, before: Number(cur.stock), after: Number(after) };
  });
  invalidateAll();
  return out;
}

/** Soft delete: sold products must stay referenced by historical sale_items. */
async function deleteProduct(id) {
  const res = await query('UPDATE products SET is_active = FALSE WHERE id = $1 AND is_active = TRUE RETURNING id', [id]);
  if (!res.rowCount) throw notFound('Product not found.');
  await query('DELETE FROM product_barcodes WHERE product_id = $1', [id]);   // the archived product must not keep a barcode a live product may need
  invalidateAll();
}

/** POS product search: name / SKU, active, sellable. */
async function searchForPos(q, limit = 24) {
  const all = await getProductStats();
  const needle = (q || '').toLowerCase().trim();
  let byCode = new Set();
  if (needle.length >= 4) byCode = new Set((await query('SELECT product_id FROM product_barcodes WHERE barcode = ANY($1::text[])', [barcodes.equivalents((q || '').trim())])).rows.map((r) => r.product_id));
  const rows = all
    .filter((p) => !p.outOfStock && p.expiryStatus !== 'expired')
    .filter((p) => !needle || byCode.has(p.id) || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase() === needle || p.sku.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle))
    .sort((a, b) => b.avgDailySales - a.avgDailySales)
    .slice(0, limit);
  return rows.map((p) => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, price: p.sellingPrice, stock: p.stock, taxRate: p.taxRate, unit: p.unit, allowDecimal: isDecimalUnit(p.unit), priceIncludesTax: p.priceIncludesTax }));
}

async function getCostHistory(productId, limit = 100) {
  if (!(await query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) throw notFound('Product not found.');
  const res = await query(
    `SELECT h.id, h.cost, h.effective_at, h.source, h.ref_type, h.ref_id, a.name AS created_by
       FROM product_cost_history h LEFT JOIN users a ON a.id = h.created_by
      WHERE h.product_id = $1 ORDER BY h.effective_at DESC, h.id DESC LIMIT $2`,
    [productId, limit],
  );
  return res.rows.map((r) => ({ id: r.id, cost: r.cost, effectiveAt: r.effective_at, source: r.source, refType: r.ref_type, refId: r.ref_id, createdBy: r.created_by }));
}

async function getProductSuppliers(productId) {
  if (!(await query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) throw notFound('Product not found.');
  const res = await query(
    `SELECT sp.supplier_id, s.name AS supplier, s.is_active, sp.supplier_sku, sp.pack_size, sp.min_order_qty, COALESCE(sp.lead_time_days, s.lead_time_days) AS lead_time_days,
            sp.last_cost, sp.is_preferred
       FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.product_id = $1 ORDER BY sp.is_preferred DESC, sp.last_cost NULLS LAST, s.name`,
    [productId],
  );
  return res.rows.map((r) => ({ supplierId: r.supplier_id, supplier: r.supplier, isActive: r.is_active, supplierSku: r.supplier_sku, packSize: r.pack_size, minOrderQty: r.min_order_qty, leadTimeDays: r.lead_time_days, lastCost: r.last_cost, isPreferred: r.is_preferred }));
}

module.exports = { createProductTx, assertStockLevels,
  quickCreate, addStock, getCostHistory, getProductSuppliers, listProducts, getLookups, getProduct, createProduct, updateProduct, deleteProduct, searchForPos, statusLabel };
