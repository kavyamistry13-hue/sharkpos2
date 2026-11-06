// SHARKPOS 2 — Phase 4 tests: getting-started checklist for new businesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');

let env; let api;
test.before(async () => { env = await boot(); api = client(env.base); });
test.after(async () => { await env.close(); });

const register = async (address) => {
  const r = await api().post('/auth/register', { businessName: uniq('OB Shop '), ownerName: 'Owner', email: `${uniq('o')}@example.com`, password: 'Passw0rdOK', ...(address ? { address } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = api(r.body.accessToken);
  const lk = await o.get('/products/lookups');
  return { o, token: r.body.accessToken, categoryId: lk.body.categories[0].id };
};
const step = (b, id) => b.steps.find((s) => s.id === id);

test('a brand-new business starts with an unfinished checklist, and each step ticks off from real data', async () => {
  const t = await register();
  let c = (await t.o.get('/onboarding')).body;
  assert.equal(c.complete, false); assert.equal(c.dismissed, false);
  assert.deepEqual(c.steps.map((s) => s.id), ['shop', 'product', 'sale', 'team', 'plan']);
  assert.ok(c.steps.every((s) => s.done === false), 'nothing done yet');
  assert.ok(c.steps.every((s) => s.to.startsWith('/')), 'every step links to an app page');

  assert.equal((await t.o.put('/settings', { storeAddress: '12 MG Road, Pune' })).status, 200);
  const p = await t.o.post('/products', { name: uniq('Item '), categoryId: t.categoryId, purchasePrice: 5, sellingPrice: 10, stock: 20 });
  assert.equal(p.status, 201);
  c = (await t.o.get('/onboarding')).body;
  assert.equal(step(c, 'shop').done, true); assert.equal(step(c, 'product').done, true);
  assert.equal(step(c, 'sale').done, false); assert.equal(c.complete, false);

  const sale = await t.o.post('/sales', { items: [{ productId: p.body.id, quantity: 1 }], paymentMethod: 'cash' });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal((await t.o.post('/employees', { name: 'Cash', email: `${uniq('c')}@example.com`, password: 'Passw0rdOK', role: 'cashier' })).status, 201);
  c = (await t.o.get('/onboarding')).body;
  assert.equal(step(c, 'sale').done, true); assert.equal(step(c, 'team').done, true);
  assert.equal(c.complete, true, 'all required steps done (team and plan are optional)');
  assert.equal(step(c, 'plan').done, false);
  assert.equal(c.doneCount, 4); assert.equal(c.total, 5);
});

test('a registration address counts as the shop step already done', async () => {
  const t = await register('5 Lake Road, Kochi');
  assert.equal(step((await t.o.get('/onboarding')).body, 'shop').done, true);
});

test('only the owner can dismiss; dismissal is remembered per business and nothing leaks across businesses', async () => {
  const a = await register(); const b = await register();
  const cashierEmail = `${uniq('c')}@example.com`;
  await a.o.post('/employees', { name: 'Cash', email: cashierEmail, password: 'Passw0rdOK', role: 'cashier' });
  const login = await api().post('/auth/login', { email: cashierEmail, password: 'Passw0rdOK' });
  const cashier = api(login.body.accessToken);
  assert.equal((await cashier.get('/onboarding')).status, 403, 'cashiers never see setup');
  assert.equal((await cashier.post('/onboarding/dismiss')).status, 403);
  assert.equal((await api().get('/onboarding')).status, 401);

  assert.equal((await a.o.post('/onboarding/dismiss')).status, 200);
  assert.equal((await a.o.get('/onboarding')).body.dismissed, true);
  assert.equal((await b.o.get('/onboarding')).body.dismissed, false);
  assert.equal(step((await b.o.get('/onboarding')).body, 'team').done, false, "A's cashier does not count for B");
  assert.equal((await a.o.post('/onboarding/dismiss')).status, 200, 'dismissing twice is harmless');
});

test('an expired business can still read its checklist but cannot change anything', async () => {
  const t = await register();
  await env.db.sysQuery("UPDATE subscriptions SET trial_end = now() - interval '1 day', end_date = now() - interval '1 day' WHERE business_id = (SELECT business_id FROM memberships m JOIN accounts a ON a.id = m.account_id ORDER BY m.id DESC LIMIT 1)");
  assert.equal((await t.o.get('/onboarding')).status, 200);
  assert.equal((await t.o.post('/onboarding/dismiss')).status, 402);
});
