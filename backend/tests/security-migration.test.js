// Migration 014 (ledger hardening) on a database that already holds legacy data (schema 001–013), with two tenants.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers');
const { Client } = require('pg');

const dir = path.join(__dirname, '..', '..', 'database', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const apply = (c, list) => list.reduce((p, f) => p.then(() => c.query(fs.readFileSync(path.join(dir, f), 'utf8'))), Promise.resolve());

test('014 repairs 011\'s refunded_at backfill per tenant, keeps every legacy row, and freezes money fields', async () => {
  const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await apply(c, files.filter((f) => f < '014'));
    const made = [];
    for (const n of [1, 2]) {
      const biz = (await c.query(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [`Legacy ${n}`, `legacy-sec-${n}`])).rows[0].id;
      const acc = (await c.query(`INSERT INTO accounts (name, email, password_hash) VALUES ('Old Owner', $1, 'x') RETURNING id`, [`old${n}@example.com`])).rows[0].id;
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [String(biz)]);
      const cat = (await c.query(`INSERT INTO categories (name, tax_rate) VALUES ('c', 12) RETURNING id`)).rows[0].id;
      const prod = (await c.query(`INSERT INTO products (sku, name, category_id, purchase_price, selling_price, stock, minimum_stock) VALUES ('L-1','i',$1,40,50,7,2) RETURNING id`, [cat])).rows[0].id;
      const sale = (await c.query(`INSERT INTO sales (invoice_no, employee_id, subtotal, discount, tax, total, payment_method, status) VALUES ('INV-1',$1,100,10,10.8,100.8,'cash','refunded') RETURNING id`, [acc])).rows[0].id;
      await c.query(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total) VALUES ($1,$2,2,50,100)`, [sale, prod]);
      await c.query('COMMIT');
      made.push({ biz, sale });
    }
    // simulate the 011 defect: legacy refunds with refunded_at left NULL
    for (const m of made) {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.business_id', $1, true)`, [String(m.biz)]);
      await c.query('UPDATE sales SET refunded_at = NULL WHERE id = $1', [m.sale]); await c.query('COMMIT');
    }
    await apply(c, ['014_ledger_hardening.sql']);
    for (const m of made) {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.business_id', $1, true)`, [String(m.biz)]);
      const s = (await c.query('SELECT total, status, refunded_at FROM sales WHERE id = $1', [m.sale])).rows[0];
      assert.equal(Number(s.total), 100.8); assert.equal(s.status, 'refunded'); assert.ok(s.refunded_at, 'refunded_at backfilled for this tenant');
      assert.equal((await c.query('SELECT count(*)::int n FROM sale_items')).rows[0].n, 1, 'legacy lines kept');
      // money fields are frozen even for the owner role
      await c.query('SAVEPOINT a');
      await assert.rejects(c.query('UPDATE sales SET total = 1 WHERE id = $1', [m.sale]), /cannot be changed/);
      await c.query('ROLLBACK TO a');
      await assert.rejects(c.query('UPDATE sales SET refund_amount = -1 WHERE id = $1', [m.sale]));
      await c.query('ROLLBACK');
    }
  } finally { await c.end(); }
});

test('014 is additive: nothing dropped, RLS not weakened, policies only restrict', () => {
  const sql = fs.readFileSync(path.join(dir, '014_ledger_hardening.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|POLICY|SCHEMA)/i);
  assert.doesNotMatch(sql, /DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW|GRANT\s/i);
  for (const m of sql.matchAll(/CREATE POLICY[^;]*?;/gis)) assert.match(m[0], /AS RESTRICTIVE/i, 'a new policy must only restrict');
});
