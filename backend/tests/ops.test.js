// SHARKPOS 2 — Phase 3 tests: production safety checks, health, monitoring counters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { boot, client, uniq } = require('./helpers');

let env; let api;
test.before(async () => { env = await boot(); api = client(env.base); });
test.after(async () => { await env.close(); });

const prodStart = (extra) => spawnSync(process.execPath, ['-e', "require('./src/config')"], {
  cwd: require('path').join(__dirname, '..'), encoding: 'utf8',
  env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example.com:5432/sharkpos2', JWT_SECRET: 'x'.repeat(48), CORS_ORIGIN: 'https://app.example.com', PAYMENT_PROVIDER: 'none', ...extra },
});

test('production refuses to start with localhost / http / missing CORS origin, a localhost database, or the mock payment provider', () => {
  assert.equal(prodStart({}).status, 0, 'a valid production config starts');
  assert.match(prodStart({ CORS_ORIGIN: '' }).stderr, /CORS_ORIGIN must be set/);
  assert.match(prodStart({ CORS_ORIGIN: 'http://app.example.com' }).stderr, /https/);
  assert.match(prodStart({ CORS_ORIGIN: 'https://localhost:5174' }).stderr, /localhost/);
  assert.match(prodStart({ DATABASE_URL: 'postgres://u:p@localhost:5432/sharkpos2' }).stderr, /localhost/);
  assert.match(prodStart({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/sharkpos' }).stderr, /sharkpos2/);
  assert.match(prodStart({ PAYMENT_PROVIDER: 'mock' }).stderr, /mock/);
  assert.match(prodStart({ JWT_SECRET: 'short' }).stderr, /JWT_SECRET/);
});

test('health reports database status and leaks no secrets; every response carries a request id', async () => {
  const r = await api().get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.db, 'ok');
  assert.ok(r.headers.get ? r.headers.get('x-request-id') : r.headers['x-request-id']);
  assert.doesNotMatch(JSON.stringify(r.body), /postgres|secret|password/i);
});

test('ops counters: only platform admins can read them, and failed logins are counted', async () => {
  const email = `${uniq('p')}@example.com`;
  await env.db.sysQuery("INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ('Ops Admin', $1, $2, TRUE)", [email, await bcrypt.hash('Passw0rdOK', 4)]);
  const owner = await api().post('/auth/register', { businessName: uniq('Ops Shop '), ownerName: 'Owner', email: `${uniq('o')}@example.com`, password: 'Passw0rdOK' });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.equal((await api(owner.body.accessToken).get('/platform/ops')).status, 403);
  assert.equal((await api().get('/platform/ops')).status, 401);
  const before = (await (async () => { const a = await api().post('/auth/login', { email, password: 'Passw0rdOK' }); return api(a.body.accessToken).get('/platform/ops'); })()).body;
  await api().post('/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
  const a = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
  const after = (await api(a.body.accessToken).get('/platform/ops')).body;
  assert.equal(after.authFailures, before.authFailures + 1);
  assert.ok(after.requests > before.requests);
  assert.ok(after.responseMs.p95 !== null);
});

test('backup role: can read every tenant table, can change nothing; every tenant table has a backup policy', async () => {
  const sys = env.db.sysQuery;
  const missing = (await sys(`SELECT tablename FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'
      AND tablename NOT IN (SELECT tablename FROM pg_policies WHERE policyname='backup_read')`)).rows;
  assert.deepEqual(missing, [], 'add a backup_read policy for new tenant tables (see migration 007)');
  const { Client } = require('pg');
  const url = new URL(process.env.DATABASE_URL); url.username = 'sharkpos2_backup'; url.password = process.env.BACKUP_ROLE_PASSWORD || 'backup_dev_pw';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    await sys("INSERT INTO businesses (name, slug) VALUES ('Bk Shop', $1)", [uniq('bk-')]);
    const bid = (await sys("SELECT id FROM businesses ORDER BY id DESC LIMIT 1")).rows[0].id;
    await env.db.runAsTenant(bid, () => env.db.query("INSERT INTO categories (name) VALUES ('Bk cat')"));
    assert.ok((await c.query('SELECT count(*)::int AS n FROM categories')).rows[0].n >= 1, 'sees tenant rows without a tenant context');
    await assert.rejects(() => c.query("DELETE FROM categories"), /permission denied/);
    await assert.rejects(() => c.query("UPDATE accounts SET name = 'x'"), /permission denied/);
    await assert.rejects(() => c.query("INSERT INTO categories (business_id, name) VALUES (1, 'x')"), /permission denied/);
  } finally { await c.end(); }
});

test('proxy: the real visitor IP is trusted only with the shared secret; liveness probe needs no database', async () => {
  const express = require('express');
  const SECRET = 'p'.repeat(40);
  process.env.PROXY_SHARED_SECRET = SECRET;
  for (const k of Object.keys(require.cache)) if (/src[\\/](config|middleware[\\/]proxyIp)\.js$/.test(k)) delete require.cache[k];
  const proxyIp = require('../src/middleware/proxyIp');
  const app = express(); app.use(proxyIp); app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const get = async (h) => (await (await fetch(`http://127.0.0.1:${srv.address().port}/ip`, { headers: h })).json()).ip;
  assert.equal(await get({ 'x-sp-proxy-secret': SECRET, 'x-sp-client-ip': '203.0.113.7' }), '203.0.113.7');
  assert.notEqual(await get({ 'x-sp-proxy-secret': 'wrong'.padEnd(40, 'x'), 'x-sp-client-ip': '203.0.113.7' }), '203.0.113.7');
  assert.notEqual(await get({ 'x-sp-client-ip': '203.0.113.7' }), '203.0.113.7');
  assert.notEqual(await get({ 'x-sp-proxy-secret': SECRET, 'x-sp-client-ip': 'not-an-ip' }), 'not-an-ip');
  await new Promise((r) => srv.close(r));
  delete process.env.PROXY_SHARED_SECRET;
  const live = await api().get('/health/live');
  assert.equal(live.status, 200);
});
