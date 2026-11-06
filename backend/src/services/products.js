const { query, withTransaction } = require('../db');
const { getProductStats } = require('./forecast');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertWithinLimit } = require('./billing/subscription');
const { currentBusinessId } = require('../db');
const { assertQuantity, isDecimalUnit } = require('../utils/units');

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
  let rows = await getProductStats();
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }
  if (f.categoryId) rows = rows.filter((p) => p.categoryId === f.categoryId);
  if (f.supplierId) rows = rows.filter((p) => p.supplierId === f.supplierId);
  if (f.status) rows = rows.filter((p) => statusLabel(p) === f.status);
  const sorted = [...rows].sort(SORTS[f.sort] || SORTS.name);
  if (f.dir === 'desc') sorted.reverse();
  const total = sorted.length;
  const page = sorted.slice((f.page - 1) * f.limit, f.page * f.limit).map((p) => ({ ...p, status: statusLabel(p) }));
  return { total, page: f.page, limit: f.limit, rows: page };
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
  return { ...p, status: statusLabel(p) };
}

async function createProduct(input, userId) {
  await assertWithinLimit(currentBusinessId(), 'products');
  const id = await withTransaction(async (client) => {
    const sku = input.sku || `SKU-${Date.now().toString(36).toUpperCase()}`;
    const unit = input.unit || 'pcs';
    assertQuantity(unit, input.stock, 'Stock', input.name);
    assertQuantity(unit, input.minimumStock, 'Minimum stock', input.name);
    const res = await client.query(
      `INSERT INTO products (sku, name, category_id, purchase_price, selling_price, stock, minimum_stock, supplier_id, lead_time_days, expiry_date, unit, price_includes_tax)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [sku, input.name, input.categoryId, input.purchasePrice, input.sellingPrice, input.stock, input.minimumStock, input.supplierId || null, input.leadTimeDays, input.expiryDate || null, unit, Boolean(input.priceIncludesTax)],
    );
    await client.query(`INSERT INTO product_cost_history (product_id, cost, source, created_by) VALUES ($1,$2,'initial',$3)`, [res.rows[0].id, input.purchasePrice, userId]);
    if (input.stock > 0) {
      await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, reference_type) VALUES ($1,'initial',$2,$3,NULL)`, [res.rows[0].id, input.stock, userId]);
    }
    return res.rows[0].id;
  });
  invalidateAll();
  return getProduct(id);
}

async function updateProduct(id, input, userId) {
  await withTransaction(async (client) => {
    const cur = (await client.query('SELECT name, stock, minimum_stock, unit, purchase_price FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Product not found.');
    const map = {
      sku: 'sku', name: 'name', categoryId: 'category_id', purchasePrice: 'purchase_price', sellingPrice: 'selling_price',
      stock: 'stock', minimumStock: 'minimum_stock', supplierId: 'supplier_id', leadTimeDays: 'lead_time_days', expiryDate: 'expiry_date',
      unit: 'unit', priceIncludesTax: 'price_includes_tax',
    };
    // The unit decides whether fractions are allowed; check the values the product will have AFTER this update.
    const nextUnit = input.unit !== undefined ? input.unit : cur.unit;
    assertQuantity(nextUnit, input.stock !== undefined ? input.stock : cur.stock, 'Stock', cur.name);
    assertQuantity(nextUnit, input.minimumStock !== undefined ? input.minimumStock : cur.minimum_stock, 'Minimum stock', cur.name);
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

/** Soft delete: sold products must stay referenced by historical sale_items. */
async function deleteProduct(id) {
  const res = await query('UPDATE products SET is_active = FALSE WHERE id = $1 AND is_active = TRUE RETURNING id', [id]);
  if (!res.rowCount) throw notFound('Product not found.');
  invalidateAll();
}

/** POS product search: name / SKU, active, sellable. */
async function searchForPos(q, limit = 24) {
  const all = await getProductStats();
  const needle = (q || '').toLowerCase().trim();
  const rows = all
    .filter((p) => !p.outOfStock && p.expiryStatus !== 'expired')
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase() === needle || p.sku.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle))
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

module.exports = { getCostHistory, getProductSuppliers, listProducts, getLookups, getProduct, createProduct, updateProduct, deleteProduct, searchForPos, statusLabel };
