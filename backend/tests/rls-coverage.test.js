// Every tenant table — including the Sprint 1–2 ones — must have forced RLS and a tenant policy. Catches a forgotten table in future migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let env;
test.before(async () => { env = await boot(); });
test.after(async () => { await env.close(); });

// Pre-existing platform/identity/billing tables (migrations 001–008, untouched by Sprint 1–2). They carry a business_id but are accessed
// through the system (sysQuery) role by design; they are listed explicitly so any NEW table that forgets RLS fails this test.
const PLATFORM_TABLES = ['payments', 'billing_events', 'subscriptions', 'memberships', 'sessions'];
const NEW_TABLES = ['product_cost_history', 'supplier_products', 'purchase_orders', 'purchase_order_items', 'goods_receipts', 'goods_receipt_items', 'supplier_price_history'];

test('every table with a business_id column has RLS enabled and forced, with at least one policy', async () => {
  const rows = (await env.db.sysQuery(
    `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN information_schema.columns col ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'business_id'
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  )).rows;
  assert.ok(rows.length >= 15, 'expected the tenant tables to be found');
  for (const t of NEW_TABLES) assert.ok(rows.some((r) => r.relname === t), `${t} has a business_id column`);
  const bad = rows.filter((r) => !PLATFORM_TABLES.includes(r.relname)).filter((r) => !r.rls || !r.forced || r.policies < 1).map((r) => r.relname);
  assert.ok(!NEW_TABLES.some((t) => PLATFORM_TABLES.includes(t)), 'Sprint 1–2 tables must never be exempted');
  assert.deepEqual(bad, [], `tables without enforced RLS: ${bad.join(', ')}`);
});

test('new tables are readable by the backup role and the app role cannot UPDATE append-only ledgers', async () => {
  const pol = (await env.db.sysQuery(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`, [NEW_TABLES])).rows;
  for (const t of NEW_TABLES) {
    assert.ok(pol.some((p) => p.tablename === t && /backup_read/.test(p.policyname)), `${t} lacks backup_read`);
  }
  const grants = (await env.db.sysQuery(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = current_user AND table_name = ANY($1)`,
    [['product_cost_history', 'goods_receipts', 'goods_receipt_items', 'supplier_price_history']],
  )).rows;
  assert.ok(!grants.some((g) => g.privilege_type === 'UPDATE' || g.privilege_type === 'TRUNCATE'), 'ledgers are not updatable by the app role');
});
