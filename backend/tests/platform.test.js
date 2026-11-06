// SHARKPOS 2 — Phase 4 tests: platform admin overview, search, trial extension, configurable plans.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { boot, client, uniq } = require('./helpers');

let env; let api; let admin;
const sql = (q, p) => env.db.sysQuery(q, p);
// audit_logs is FORCE row-level-secured (even the owner only sees its own business), so for assertions we lift it inside a transaction that is rolled back.
const ownerSql = async (q, p) => { const { Client } = require('pg'); const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }); await c.connect(); try { await c.query('BEGIN'); await c.query('ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY'); return await c.query(q, p); } finally { await c.query('ROLLBACK').catch(() => {}); await c.end(); } };

const register = async (extra = {}) => {
  const r = await api().post('/auth/register', { businessName: uniq('P4 Shop '), ownerName: 'Owner', email: `${uniq('o')}@example.com`, password: 'Passw0rdOK', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = api(r.body.accessToken);
  const lk = await o.get('/products/lookups');
  return { o, id: r.body.business.id, name: r.body.business.name, email: r.body.user.email, categoryId: lk.body.categories[0].id };
};
const product = (t) => t.o.post('/products', { name: uniq('Item '), categoryId: t.categoryId, purchasePrice: 5, sellingPrice: 10, stock: 5 });

test.before(async () => {
  env = await boot(); api = client(env.base);
  const email = `${uniq('adm')}@example.com`;
  await sql("INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ('Admin', $1, $2, TRUE)", [email, await bcrypt.hash('Passw0rdOK', 4)]);
  const a = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  admin = api(a.body.accessToken);
});
test.after(async () => { await env.close(); });

const validFeatures = { maxUsers: 3, maxProducts: 100, maxStores: 1, aiInsights: false, advancedReports: false, advancedAi: false };
const planBody = (o = {}) => ({ name: 'Test Plan', pricePaise: 5900, intervalDays: 30, features: validFeatures, highlights: ['One', 'Two'], sortOrder: 9, isActive: true, ...o });

test('every new platform endpoint is closed to business users and anonymous callers', async () => {
  const t = await register();
  const calls = [['get', '/platform/overview'], ['get', '/platform/plans'], ['get', '/platform/businesses?q=x'], ['post', `/platform/businesses/${t.id}/extend-trial`, { days: 5 }], ['post', '/platform/plans', { code: 'zz', ...planBody() }]];
  for (const [m, p, b] of calls) {
    assert.equal((await t.o[m](p, b)).status, 403, `${m} ${p} as business owner`);
    assert.equal((await api()[m](p, b)).status, 401, `${m} ${p} anonymous`);
  }
});

test('overview counts businesses by effective subscription state and estimates monthly revenue from the plan table', async () => {
  const before = (await admin.get('/platform/overview')).body;
  const a = await register(); const b = await register({ plan: 'pro' });
  await sql("UPDATE subscriptions SET status='active', trial_end=NULL, end_date = now() + interval '20 days' WHERE business_id = $1", [b.id]);
  await sql("UPDATE subscriptions SET trial_end = now() - interval '1 day', end_date = now() - interval '1 day' WHERE business_id = $1", [a.id]);
  const after = (await admin.get('/platform/overview')).body;
  assert.equal(after.businesses.total, before.businesses.total + 2);
  assert.equal(after.businesses.new7, before.businesses.new7 + 2);
  assert.equal(after.subscriptions.expired, before.subscriptions.expired + 1);
  assert.equal(after.subscriptions.active, before.subscriptions.active + 1);
  const proPrice = (await sql("SELECT price_paise FROM plans WHERE code='pro'")).rows[0].price_paise;
  assert.equal(after.revenue.mrrPaise, before.revenue.mrrPaise + proPrice);
  // no personal or secret data in the summary
  assert.doesNotMatch(JSON.stringify(after), /@|password|hash/i);
});

test('business search matches name, owner name or email, shows plan and subscription, and treats % and _ literally', async () => {
  const t = await register();
  const byName = (await admin.get(`/platform/businesses?q=${encodeURIComponent(t.name.slice(0, 12))}`)).body;
  assert.ok(byName.rows.some((r) => r.id === t.id));
  const row = (await admin.get(`/platform/businesses?q=${encodeURIComponent(t.email)}`)).body.rows[0];
  assert.equal(row.id, t.id);
  assert.equal(row.subscription, 'trialing');
  assert.equal(row.plan, 'Business');
  assert.equal(row.ownerEmail, t.email);
  const wild = (await admin.get('/platform/businesses?q=%25')).body;
  assert.equal(wild.total, 0, 'a lone % must not match everything');
  assert.equal((await admin.get('/platform/businesses?q=' + 'x'.repeat(200))).status, 400);
  const all = (await admin.get('/platform/businesses')).body;
  assert.ok(all.total >= 1 && all.rows.length >= 1);
});

test('extend trial: revives a lapsed business, refuses a paying one, validates days, and is audited', async () => {
  const t = await register();
  await sql("UPDATE subscriptions SET trial_end = now() - interval '2 day', end_date = now() - interval '2 day' WHERE business_id = $1", [t.id]);
  assert.equal((await product(t)).status, 402, 'lapsed trial is read-only');
  assert.equal((await admin.post(`/platform/businesses/${t.id}/extend-trial`, { days: 0 })).status, 400);
  assert.equal((await admin.post(`/platform/businesses/${t.id}/extend-trial`, { days: 61 })).status, 400);
  assert.equal((await admin.post(`/platform/businesses/${t.id}/extend-trial`, { days: 1.5 })).status, 400);
  const r = await admin.post(`/platform/businesses/${t.id}/extend-trial`, { days: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const days = (new Date(r.body.trialEnd) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `trial ends in ~7 days (got ${days})`);
  assert.equal((await product(t)).status, 201, 'writes work again');
  const log = (await ownerSql("SELECT * FROM audit_logs WHERE business_id = $1 AND action = 'platform.trial_extended'", [t.id])).rows;
  assert.equal(log.length, 1);
  // a still-running trial gets the days added on top
  const again = await admin.post(`/platform/businesses/${t.id}/extend-trial`, { days: 3 });
  assert.ok((new Date(again.body.trialEnd) - new Date(r.body.trialEnd)) / 86400000 > 2.9);
  // a paying business is refused
  const p = await register();
  await sql("UPDATE subscriptions SET status='active', trial_end=NULL, end_date = now() + interval '10 days' WHERE business_id = $1", [p.id]);
  assert.equal((await admin.post(`/platform/businesses/${p.id}/extend-trial`, { days: 5 })).status, 409);
  assert.equal((await admin.post('/platform/businesses/999999/extend-trial', { days: 5 })).status, 404);
});

test('plans are fully configurable: price, limits and visibility change without code, and the change is audited', async () => {
  const plans = (await admin.get('/platform/plans')).body.plans;
  const starter = plans.find((p) => p.code === 'starter');
  assert.ok(starter && typeof starter.subscribers === 'number');
  try {
    const put = await admin.put(`/platform/plans/${starter.id}`, planBody({ name: 'Starter', pricePaise: 12900, features: { ...starter.features, maxProducts: 2 }, highlights: starter.highlights, sortOrder: starter.sortOrder }));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    // public pricing reflects it immediately
    const pub = (await api().get('/plans')).body.plans.find((p) => p.code === 'starter');
    assert.equal(pub.pricePaise, 12900);
    // a new limit is enforced on the very next request
    const t = await register({ plan: 'starter' });
    assert.equal((await product(t)).status, 201);
    assert.equal((await product(t)).status, 201);
    const third = await product(t);
    assert.equal(third.status, 403);
    assert.equal(third.body.details.code, 'PLAN_LIMIT');
    // checkout charges the new price (server-side, from the plan table)
    const co = await t.o.post('/billing/checkout', { planCode: 'starter' });
    assert.equal(co.status, 201, JSON.stringify(co.body));
    assert.equal(co.body.amount, 12900);
    const log = (await ownerSql("SELECT * FROM audit_logs WHERE action = 'platform.plan_updated' AND entity_id = $1", [String(starter.id)])).rows;
    assert.ok(log.length >= 1 && log[0].business_id === null);
  } finally {
    await admin.put(`/platform/plans/${starter.id}`, planBody({ name: 'Starter', pricePaise: starter.pricePaise, features: starter.features, highlights: starter.highlights, sortOrder: starter.sortOrder }));
  }
});

test('plan validation: unknown/missing feature keys, negative price, and switching off the default plan are rejected', async () => {
  const biz = (await admin.get('/platform/plans')).body.plans.find((p) => p.code === 'business');
  const put = (b) => admin.put(`/platform/plans/${biz.id}`, b);
  assert.equal((await put(planBody({ features: { ...validFeatures, superPower: true } }))).status, 400);
  const { maxUsers, ...missing } = validFeatures;
  assert.equal((await put(planBody({ features: missing }))).status, 400);
  assert.equal((await put(planBody({ pricePaise: -1 }))).status, 400);
  assert.equal((await put(planBody({ pricePaise: 1.5 }))).status, 400);
  assert.equal((await put(planBody({ features: { ...validFeatures, maxUsers: -3 } }))).status, 400);
  const off = await put(planBody({ isActive: false }));
  assert.equal(off.status, 400);
  assert.match(off.body.error || off.body.message || JSON.stringify(off.body), /default plan/i);
  assert.equal((await admin.put('/platform/plans/999999', planBody())).status, 404);
  assert.ok((await api().get('/plans')).body.plans.some((p) => p.code === 'business'), 'default plan is still offered');
});

test('new plans can be created, hidden, and existing subscribers keep working on a hidden plan', async () => {
  const code = `promo_${Date.now().toString(36)}`;
  const c = await admin.post('/platform/plans', { code, ...planBody({ name: 'Promo', pricePaise: 0 }) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await admin.post('/platform/plans', { code, ...planBody() })).status, 409);
  assert.equal((await admin.post('/platform/plans', { code: 'Bad Code', ...planBody() })).status, 400);
  assert.ok((await api().get('/plans')).body.plans.some((p) => p.code === code));
  const t = await register({ plan: code });
  assert.equal((await t.o.get('/billing/subscription')).body.plan?.code ?? code, code);
  await admin.put(`/platform/plans/${c.body.id}`, planBody({ name: 'Promo', pricePaise: 0, isActive: false }));
  assert.ok(!(await api().get('/plans')).body.plans.some((p) => p.code === code), 'hidden from public pricing');
  assert.equal((await product(t)).status, 201, 'existing subscriber unaffected');
  const listed = (await admin.get('/platform/plans')).body.plans.find((p) => p.code === code);
  assert.equal(listed.isActive, false);
  assert.equal(listed.subscribers, 1);
});
