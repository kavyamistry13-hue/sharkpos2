// Test harness: wipes and migrates the throw-away TEST database, then boots the real Express app on a random port.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

process.env.NODE_ENV = 'test';
const testUrl = process.env.TEST_DATABASE_URL;
const testOwnerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (!testUrl || !testOwnerUrl) throw new Error('Set TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL in backend/.env');
const dbOf = (u) => decodeURIComponent(new URL(u).pathname.slice(1));
if (!/^sharkpos2_test/.test(dbOf(testUrl)) || !/^sharkpos2_test/.test(dbOf(testOwnerUrl))) throw new Error('Tests may only run against a database named sharkpos2_test*');
process.env.DATABASE_URL = testUrl;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.PAYMENT_KEY_SECRET = 'test-payment-secret';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

async function migrateFresh() {
  const c = new Client({ connectionString: testOwnerUrl });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dir = path.join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  await c.end();
}

async function boot() {
  await migrateFresh();
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const db = require('../src/db');
  return { base, db, close: async () => { await new Promise((r) => server.close(r)); await db.pool.end(); } };
}

/** Tiny HTTP client: api(token).get('/products') → { status, body, headers } */
function client(base) {
  return (token, extraHeaders = {}) => {
    const call = async (method, p, body, headers = {}) => {
      // Every POST /sales needs an Idempotency-Key; ordinary tests get a fresh one, idempotency tests pass their own.
      if (method === 'POST' && (p === '/sales' || /^\/held-bills\/\d+\/complete$/.test(p) || /^\/sales\/\d+\/returns$/.test(p)) && !Object.keys(headers).some((k) => k.toLowerCase() === 'idempotency-key')) headers = { ...headers, 'idempotency-key': require('crypto').randomUUID() };
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: json, headers: res.headers };
    };
    return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
  };
}

/** TEST FIXTURE ONLY: rewrites a finished sale's date (to build history). Migration 014 freezes sales money/date fields
 *  against the app role, so fixtures go through the OWNER role with that one trigger switched off inside a single transaction. */
async function backdateSaleFixture(businessId, saleId, interval) {
  const c = new Client({ connectionString: testOwnerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.business_id', String(businessId)]);
    await c.query('ALTER TABLE sales DISABLE TRIGGER trg_sales_money_frozen');
    await c.query('UPDATE sales SET created_at = created_at - $2::interval WHERE id = $1', [saleId, interval]);
    await c.query('ALTER TABLE sales ENABLE TRIGGER trg_sales_money_frozen');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
}

let n = 0;
const uniq = (s) => `${s}${Date.now().toString(36)}${(n += 1)}`;

module.exports = { boot, client, uniq, backdateSaleFixture };
