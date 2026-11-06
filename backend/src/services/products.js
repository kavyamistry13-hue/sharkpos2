const { query, withTransaction } = require('../db');
const { getProductStats } = require('./forecast');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { assertWithinLimit } = require('./billing/subscription');
const { currentBusinessId } = require('../db');

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
    query('SELECT id, name, phone, email, lead_time_days FROM suppliers ORDER BY name'),
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
    const res = await client.query(
      `INSERT INTO products (sku, name, category_id, purchase_price, selling_price, stock, minimum_stock, supplier_id, lead_time_days, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [sku, input.name, input.categoryId, input.purchasePrice, input.sellingPrice, input.stock, input.minimumStock, input.supplierId || null, input.leadTimeDays, input.expiryDate || null],
    );
    if (input.stock > 0) {
      await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id) VALUES ($1,'initial',$2,$3)`, [res.rows[0].id, input.stock, userId]);
    }
    return res.rows[0].id;
  });
  invalidateAll();
  return getProduct(id);
}

async function updateProduct(id, input, userId) {
  await withTransaction(async (client) => {
    const cur = (await client.query('SELECT stock FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Product not found.');
    const map = {
      sku: 'sku', name: 'name', categoryId: 'category_id', purchasePrice: 'purchase_price', sellingPrice: 'selling_price',
      stock: 'stock', minimumStock: 'minimum_stock', supplierId: 'supplier_id', leadTimeDays: 'lead_time_days', expiryDate: 'expiry_date',
    };
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
      await client.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id) VALUES ($1,'adjustment',$2,$3)`, [id, input.stock - cur.stock, userId]);
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
  return rows.map((p) => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, price: p.sellingPrice, stock: p.stock, taxRate: p.taxRate }));
}

module.exports = { listProducts, getLookups, getProduct, createProduct, updateProduct, deleteProduct, searchForPos, statusLabel };
