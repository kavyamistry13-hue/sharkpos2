// Category management. The tax rate here is the GST rate applied to NEW sales; sale lines store the rate they were sold at,
// so changing a rate never rewrites history.
const { query } = require('../db');
const { conflict, notFound } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');

const map = (r) => ({ id: r.id, name: r.name, taxRate: r.tax_rate, products: r.products ?? 0 });

async function listCategories() {
  const res = await query(
    `SELECT c.id, c.name, c.tax_rate, COUNT(p.id) FILTER (WHERE p.is_active)::int AS products
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id ORDER BY lower(c.name)`,
  );
  return res.rows.map(map);
}

async function createCategory({ name, taxRate }) {
  const dup = await query('SELECT 1 FROM categories WHERE lower(name) = lower($1)', [name]);
  if (dup.rowCount) throw conflict('A category with this name already exists.');
  const res = await query('INSERT INTO categories (name, tax_rate) VALUES ($1,$2) RETURNING id, name, tax_rate', [name, taxRate]);
  invalidateAll();
  return map(res.rows[0]);
}

async function updateCategory(id, { name, taxRate }) {
  const cur = (await query('SELECT id, name, tax_rate FROM categories WHERE id = $1', [id])).rows[0];
  if (!cur) throw notFound('Category not found.');
  if (name !== undefined && name.toLowerCase() !== cur.name.toLowerCase()) {
    if ((await query('SELECT 1 FROM categories WHERE lower(name) = lower($1) AND id <> $2', [name, id])).rowCount) throw conflict('A category with this name already exists.');
  }
  const res = await query('UPDATE categories SET name = COALESCE($1, name), tax_rate = COALESCE($2, tax_rate) WHERE id = $3 RETURNING id, name, tax_rate', [name ?? null, taxRate ?? null, id]);
  invalidateAll();
  return { before: map(cur), after: map(res.rows[0]) };
}

/** A category that any product (even a deleted one, which keeps its history) still uses cannot be removed. */
async function deleteCategory(id) {
  const cur = (await query('SELECT id, name FROM categories WHERE id = $1', [id])).rows[0];
  if (!cur) throw notFound('Category not found.');
  const used = (await query('SELECT COUNT(*)::int AS n FROM products WHERE category_id = $1', [id])).rows[0].n;
  if (used > 0) throw conflict(`${cur.name} is used by ${used} product${used === 1 ? '' : 's'}. Move them to another category first.`, { code: 'CATEGORY_IN_USE', products: used });
  await query('DELETE FROM categories WHERE id = $1', [id]);
  invalidateAll();
  return cur;
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory };
