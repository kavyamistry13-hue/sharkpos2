// Migrations 009/010 are additive: legacy data (created under schema 001–008) must survive and be backfilled correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers'); // loads .env + safety checks for the throw-away test database
const { Client } = require('pg');

const dir = path.join(__dirname, '..', '..', 'database', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const apply = (c, list) => list.reduce((p, f) => p.then(() => c.query(fs.readFileSync(path.join(dir, f), 'utf8'))), Promise.resolve());

test('009/010 on a database that already holds legacy sales: nothing lost, history backfilled and flagged', async () => {
  const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await apply(c, files.filter((f) => f < '009'));

    // legacy data, written the way the old code wrote it (as the owner, inside the tenant context)
    const biz = (await c.query(`INSERT INTO businesses (name, slug) VALUES ('Legacy Mart', 'legacy-mart') RETURNING id`)).rows[0].id;
    const acc = (await c.query(`INSERT INTO accounts (name, email, password_hash) VALUES ('Old Owner', 'old@example.com', 'x') RETURNING id`)).rows[0].id;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [String(biz)]);
    const cat = (await c.query(`INSERT INTO categories (name, tax_rate) VALUES ('Legacy cat', 12) RETURNING id`)).rows[0].id;
    const prod = (await c.query(`INSERT INTO products (sku, name, category_id, purchase_price, selling_price, stock, minimum_stock) VALUES ('L-1','Legacy item',$1,40,50,7,2) RETURNING id`, [cat])).rows[0].id;
    const sale = (await c.query(`INSERT INTO sales (invoice_no, employee_id, subtotal, discount, tax, total, payment_method) VALUES ('INV-1',$1,100,10,10.8,100.8,'cash') RETURNING id`, [acc])).rows[0].id;
    await c.query(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total) VALUES ($1,$2,2,50,100)`, [sale, prod]);
    await c.query(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id) VALUES ($1,'sale',-2,$2)`, [prod, sale]);
    await c.query('COMMIT');

    await apply(c, files.filter((f) => f >= '009'));

    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [String(biz)]);
    const p = (await c.query('SELECT unit, price_includes_tax, stock, minimum_stock, purchase_price, selling_price FROM products WHERE id = $1', [prod])).rows[0];
    assert.deepEqual([p.unit, p.price_includes_tax, p.stock, p.minimum_stock, p.purchase_price, p.selling_price].map(Number).map((x) => (Number.isNaN(x) ? 'n/a' : x)), ['n/a', 0, 7, 2, 40, 50]);
    assert.equal(p.unit, 'pcs'); assert.equal(p.price_includes_tax, false, 'legacy products keep tax-on-top');
    const li = (await c.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale])).rows[0];
    assert.deepEqual(
      [Number(li.quantity), Number(li.unit_cost), li.cost_source, Number(li.tax_rate), li.price_includes_tax, Number(li.discount_share), Number(li.taxable_value), Number(li.tax_amount), li.snapshot_backfilled],
      [2, 40, 'estimated', 12, false, 10, 90, 10.8, true],
    );
    const sl = (await c.query('SELECT subtotal, discount, tax, total FROM sales WHERE id = $1', [sale])).rows[0];
    assert.deepEqual([sl.subtotal, sl.discount, sl.tax, sl.total].map(Number), [100, 10, 10.8, 100.8], 'sale header untouched');
    const hist = (await c.query('SELECT cost, source FROM product_cost_history WHERE product_id = $1', [prod])).rows;
    assert.equal(hist.length, 1); assert.equal(Number(hist[0].cost), 40);
    const mv = (await c.query('SELECT quantity, movement_type FROM inventory_movements WHERE product_id = $1', [prod])).rows[0];
    assert.deepEqual([Number(mv.quantity), mv.movement_type], [-2, 'sale']);
    // new schema is usable on top of the legacy rows, and constraints are live
    await c.query('SAVEPOINT s1');
    await assert.rejects(c.query('UPDATE products SET stock = 1.5 WHERE id = $1', [prod]), /products_whole_units_chk/);
    await c.query('ROLLBACK TO SAVEPOINT s1');
    await c.query(`UPDATE products SET unit = 'kg', stock = 1.5 WHERE id = $1`, [prod]);
    await c.query('ROLLBACK');
  } finally { await c.end(); }
});

test('every migration is additive: no DROP TABLE/COLUMN, no RLS disabling, in 009 and 010', () => {
  for (const f of files.filter((x) => x >= '009')) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|POLICY|SCHEMA)/i, `${f} drops something`);
    assert.doesNotMatch(sql, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW/i, `${f} weakens RLS`);
    assert.doesNotMatch(sql, /RENAME\s+(TO|COLUMN)/i, `${f} renames something`);
  }
});
