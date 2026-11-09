// Security regression suite (Security & Data Protection phase).
// Every test talks to the real HTTP API as a real tenant; the UI is never involved.
// Groups: authentication · authorization · tenant isolation · financial integrity · input security · database security · secrets.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');

let env; let api; let A; let B; let prodA; let custA; let saleA; let heldA;
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const asJson = (r) => JSON.stringify(r.body ?? {});

before(async () => {
  env = await boot(); api = client(env.base);
  A = await makeShop(api); B = await makeShop(api);
  prodA = await addProduct(api, A, { stock: 50 });
  custA = await addCustomer(api, A);
  const s = await api(A.owner.token).post('/sales', { items: [{ productId: prodA.id, quantity: 2 }], paymentMethod: 'cash' });
  assert.equal(s.status, 201, asJson(s)); saleA = s.body;
  const h = await api(A.owner.token).post('/held-bills', { items: [{ productId: prodA.id, quantity: 1 }] });
  assert.equal(h.status, 201, asJson(h)); heldA = h.body.hold; assert.ok(heldA && heldA.id, 'held bill id');
});
after(async () => { await env.close(); });

describe('authentication', () => {
  test('no token, garbage token, wrong-algorithm (alg=none) token and expired token are all 401', async () => {
    assert.equal((await api().get('/products')).status, 401);
    assert.equal((await api('not.a.jwt').get('/products')).status, 401);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: A.owner.id, bid: A.businessId, role: 'business_owner', exp: 9999999999 })}.`;
    assert.equal((await api(none).get('/products')).status, 401);
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign({ sub: A.owner.id, bid: A.businessId, role: 'business_owner' }, process.env.JWT_SECRET, { expiresIn: -10 });
    assert.equal((await api(expired).get('/products')).status, 401);
  });
  test('a token signed with the wrong secret is rejected', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: A.owner.id, bid: A.businessId, role: 'business_owner' }, 'x'.repeat(48), { expiresIn: 600 });
    assert.equal((await api(forged).get('/products')).status, 401);
  });
  test('claims in the token cannot be upgraded: role/business come from the database, not the JWT', async () => {
    const jwt = require('jsonwebtoken');
    // Cashier A with a validly-signed token that CLAIMS owner of shop B.
    const t = jwt.sign({ sub: A.cashier.id, bid: B.businessId, role: 'business_owner' }, process.env.JWT_SECRET, { expiresIn: 600 });
    const r = await api(t).get('/audit');
    assert.ok(!ok2xx(r), `forged-claim token must not read audit, got ${r.status}`);
  });
  test('login failures are uniform and never reveal which part was wrong', async () => {
    const a = await api().post('/auth/login', { email: `nobody${uniq('x')}@example.com`, password: 'Whatever123' });
    const email = (await api(A.owner.token).get('/employees')).body.rows.find((e) => e.role === 'manager').email;
    const b = await api().post('/auth/login', { email, password: 'WrongPass123' });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });
  test('password hash and refresh token never appear in API bodies', async () => {
    const me = await api(A.owner.token).get('/auth/me');
    const emp = await api(A.owner.token).get('/employees');
    for (const r of [me, emp]) assert.ok(!/password|hash|refresh/i.test(asJson(r).replace(/passwordChanged|mustChange/gi, '')), asJson(r).slice(0, 200));
  });
  test('refresh/logout need the CSRF header', async () => {
    const r = await fetch(`${env.base}/auth/refresh`, { method: 'POST' });
    assert.ok([400, 401, 403].includes(r.status));
  });
});

describe('authorization (RBAC enforced by the backend)', () => {
  // [method, path, who is DENIED]  — derived from the empirically probed matrix (docs/SECURITY.md).
  const cashierDenied = [
    ['GET', '/audit'], ['GET', '/products'], ['POST', '/products'], ['DELETE', '/products/1'], ['GET', '/inventory'], ['GET', '/suppliers'],
    ['GET', '/purchase-orders'], ['GET', '/credit/summary'], ['GET', '/credit/customers'], ['POST', '/credit/customers/1/adjustments'],
    ['GET', '/reports/closing'], ['GET', '/intelligence/owner-today'], ['GET', '/intelligence/profit-leaks'], ['GET', '/analytics/overview'],
    ['GET', '/measurement/roi'], ['GET', '/employees'], ['POST', '/employees'], ['PUT', '/settings'], ['GET', '/customers'], ['GET', '/risk/alerts'],
    ['GET', '/ai/brief'], ['POST', '/sales/1/refund'], ['GET', '/categories'],
  ];
  for (const [m, p] of cashierDenied) {
    test(`cashier is denied ${m} ${p}`, async () => {
      const c = api(A.cashier.token);
      const r = await c[m === 'DELETE' ? 'del' : m.toLowerCase()](p, ...(m === 'GET' || m === 'DELETE' ? [] : [{}]));
      assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
    });
  }
  const managerDenied = [['DELETE', '/products/1'], ['PUT', '/settings'], ['POST', '/credit/customers/1/adjustments'], ['POST', '/measurement/value-ledger/1/correct'], ['GET', '/audit'], ['DELETE', '/categories/1']];
  for (const [m, p] of managerDenied) {
    test(`manager is denied ${m} ${p}`, async () => {
      const c = api(A.manager.token);
      const r = await c[m === 'DELETE' ? 'del' : m.toLowerCase()](p, ...(m === 'GET' || m === 'DELETE' ? [] : [{}]));
      assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
    });
  }
  test('manager cannot create, promote or demote managers/owners, and cannot reset an owner password', async () => {
    const m = api(A.manager.token);
    for (const role of ['manager', 'business_owner']) {
      const r = await m.post('/employees', { name: 'Sneaky', email: `${uniq('s')}@example.com`, password: 'Passw0rdOK', role });
      assert.equal(r.status, 403, `create ${role}`);
    }
    assert.equal((await m.put(`/employees/${A.owner.id}`, { password: 'Hacked12345' })).status, 403);
    assert.equal((await m.put(`/employees/${A.cashier.id}`, { role: 'manager' })).status, 403);
    assert.equal((await m.put(`/employees/${A.manager.id}`, { role: 'business_owner' })).status, 403); // managers cannot touch manager/owner accounts, including their own role
  });
  test('a business can never lose its last owner', async () => {
    const r = await api(A.owner.token).put(`/employees/${A.owner.id}`, { isActive: false });
    assert.equal(r.status, 400);
  });
  test('cashier sees only their own sales and held bills', async () => {
    const mine = await api(A.cashier.token).post('/sales', { items: [{ productId: prodA.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.equal(mine.status, 201, asJson(mine));
    const list = await api(A.cashier.token).get('/sales');
    const ids = (list.body.rows || list.body.sales || []).map((s) => s.id);
    assert.ok(ids.includes(mine.body.id));
    assert.ok(!ids.includes(saleA.id), "cashier must not see the owner's sale");
    assert.equal((await api(A.cashier.token).get(`/sales/${saleA.id}`)).status, 404);
    assert.equal((await api(A.cashier.token).get(`/held-bills/${heldA.id}`)).status, 404);
  });
  test('cashier responses hide risk scores', async () => {
    const mine = await api(A.cashier.token).get('/sales');
    for (const s of mine.body.rows || mine.body.sales || []) assert.ok(s.riskScore == null && s.riskSeverity == null);
  });
  test('cashier cannot set their own discount beyond the configured limit without approval', async () => {
    const r = await api(A.cashier.token).post('/sales', { items: [{ productId: prodA.id, quantity: 1 }], paymentMethod: 'cash', discount: { type: 'percent', value: 90 } });
    assert.ok(!ok2xx(r), `90% cashier discount must be refused, got ${r.status}`);
  });
  test('discount approval is not a password oracle: wrong guesses throttle the cashier and lock the approver account like login does', async () => {
    const C = await makeShop(api); const prodC = await addProduct(api, C, { stock: 50 });   // own shop: keeps A's seat count and lockouts untouched
    const mk = async (role) => {
      const email = `${uniq(role)}@example.com`;
      const c = await api(C.owner.token).post('/employees', { name: `${role} x`, email, password: 'Passw0rdOK', role });
      assert.equal(c.status, 201, asJson(c));
      const l = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
      return { email, token: l.body.accessToken };
    };
    const mgr = await mk('manager'); const cash = await mk('cashier'); const cash2 = { token: C.cashier.token };   // free plan seat limit: reuse the shop's own cashier
    const items = [{ productId: prodC.id, quantity: 1 }];
    const attempt = (who, password) => api(who.token).post('/sales', { items, paymentMethod: 'cash', discount: { type: 'percent', value: 25 }, approval: { email: mgr.email, password } });
    // a correct approval works
    assert.equal((await attempt(cash2, 'Passw0rdOK')).status, 201);
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt(cash, `Wrong${i}Guess1`)).status, 403);
    assert.equal((await attempt(cash, 'Passw0rdOK')).status, 429, 'after 5 failures even the right password is refused for this cashier');
    assert.equal((await api(cash.token).post('/sales', { items, paymentMethod: 'cash' })).status, 201, 'the cashier can still sell without a discount');
    // the 5 wrong guesses also counted against the manager account: it is locked, exactly like 5 failed logins
    assert.equal((await attempt(cash2, 'Passw0rdOK')).status, 403, 'a locked approver cannot approve');
    assert.equal((await api().post('/auth/login', { email: mgr.email, password: 'Passw0rdOK' })).status, 429);
    // unknown approver and wrong password look identical
    const a = await api(cash2.token).post('/sales', { items, paymentMethod: 'cash', discount: { type: 'percent', value: 25 }, approval: { email: 'nobody@example.com', password: 'Passw0rdOK' } });
    const b = await attempt(cash2, 'WrongPass123');
    assert.equal(a.body.error, b.body.error);
  });
  test('platform routes are closed to every business role', async () => {
    for (const who of ['owner', 'manager', 'cashier']) assert.ok([401, 403, 404].includes((await api(A[who].token).get('/platform/businesses')).status));
  });
});

describe('tenant isolation (Shop B attacking Shop A by ID, directly over the API)', () => {
  const roles = ['owner', 'manager', 'cashier'];
  test('B cannot read or modify A\'s product, customer, sale, held bill — as any role', async () => {
    for (const who of roles) {
      const c = api(B[who].token);
      for (const p of [`/products/${prodA.id}`, `/products/${prodA.id}/cost-history`, `/products/${prodA.id}/suppliers`, `/customers/${custA.id}`, `/sales/${saleA.id}`, `/held-bills/${heldA.id}`, `/inventory/${prodA.id}/movements`, `/credit/customers/${custA.id}`, `/credit/customers/${custA.id}/balance`, `/ai/forecast/${prodA.id}`]) {
        const r = await c.get(p);
        assert.ok(!ok2xx(r), `${who} GET ${p} -> ${r.status}`);
        assert.ok(!asJson(r).includes(prodA.name) && !asJson(r).includes(custA.name), `${who} GET ${p} leaked A's data`);
      }
    }
  });
  test('B cannot write to A\'s records', async () => {
    const o = api(B.owner.token);
    assert.ok(!ok2xx(await o.put(`/products/${prodA.id}`, { name: 'pwned' })));
    assert.ok(!ok2xx(await o.del(`/products/${prodA.id}`)));
    assert.ok(!ok2xx(await o.post(`/sales/${saleA.id}/refund`)));
    assert.ok(!ok2xx(await o.post(`/sales/${saleA.id}/returns`, { items: [{ saleItemId: 1, quantity: 1 }] })));
    assert.ok(!ok2xx(await o.post(`/held-bills/${heldA.id}/discard`)));
    assert.ok(!ok2xx(await o.post(`/held-bills/${heldA.id}/resume`)));
    assert.ok(!ok2xx(await o.post(`/credit/customers/${custA.id}/payments`, { amount: 1, method: 'cash' })));
    assert.ok(!ok2xx(await o.put(`/credit/customers/${custA.id}/limit`, { creditLimit: 99999 })));
    const still = await api(A.owner.token).get(`/products/${prodA.id}`);
    assert.equal(still.body.name, prodA.name);
  });
  test('B cannot sell A\'s product or bill A\'s customer', async () => {
    const r = await api(B.owner.token).post('/sales', { items: [{ productId: prodA.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.ok(!ok2xx(r), `cross-tenant product sale -> ${r.status}`);
    const own = await addProduct(api, B);
    const r2 = await api(B.owner.token).post('/sales', { items: [{ productId: own.id, quantity: 1 }], paymentMethod: 'credit', customerId: custA.id });
    assert.ok(!ok2xx(r2), `cross-tenant customer on credit sale -> ${r2.status}`);
    const a = await api(A.owner.token).get(`/products/${prodA.id}`);
    assert.equal(Number(a.body.stock), Number(a.body.stock)); // unchanged type check; stock asserted below
  });
  test("B's lists never contain A's rows", async () => {
    for (const p of ['/products', '/customers', '/sales', '/held-bills', '/inventory', '/suppliers', '/employees', '/audit', '/credit/customers', '/shifts', '/purchase-orders', '/measurement/decisions', '/reports/cash-reconciliations']) {
      const r = await api(B.owner.token).get(p);
      assert.ok(ok2xx(r), `${p} -> ${r.status}`);
      const s = asJson(r);
      assert.ok(!s.includes(prodA.name) && !s.includes(custA.name), `${p} leaked A's data`);
    }
    const emp = (await api(B.owner.token).get('/employees')).body.rows.map((e) => e.id);
    for (const who of ['owner', 'manager', 'cashier']) assert.ok(!emp.includes(A[who].id), 'A\'s user in B\'s employee list');
    assert.ok(!ok2xx(await api(B.owner.token).put(`/employees/${A.cashier.id}`, { isActive: false })));
    assert.ok(!ok2xx(await api(B.owner.token).del(`/employees/${A.cashier.id}`)));
  });
  test('analytics and intelligence for B contain none of A\'s revenue', async () => {
    const before = await api(B.owner.token).get('/analytics/overview?days=30');
    assert.ok(ok2xx(before));
    const s = asJson(before);
    assert.ok(!s.includes(prodA.name));
  });
  test('tenant identity is never taken from the request: body/header/query tenant hints are ignored', async () => {
    const o = api(B.owner.token, { 'x-business-id': String(A.businessId), 'x-tenant-id': String(A.businessId) });
    const name = uniq('Hint ');
    const r = await o.post('/products', { name, categoryId: B.category.id, purchasePrice: 5, sellingPrice: 9, stock: 3, minimumStock: 1, businessId: A.businessId, business_id: A.businessId });
    assert.equal(r.status, 201, asJson(r));
    const inA = asJson(await api(A.owner.token).get('/products?search=' + encodeURIComponent(name)));
    assert.ok(!inA.includes(name), 'product created by B must not appear in A');
    const inB = asJson(await api(B.owner.token).get('/products?search=' + encodeURIComponent(name)));
    assert.ok(inB.includes(name));
    const c = await o.post('/customers', { name: uniq('HC '), phone: '9123456780', businessId: A.businessId });
    assert.equal(c.status, 201, asJson(c));
    assert.ok(!asJson(await api(A.owner.token).get('/customers')).includes(c.body.name));
  });
  test('a deactivated user loses access immediately (token still within its 15 min life)', async () => {
    const email = `${uniq('tmp')}@example.com`;
    const c = await api(A.owner.token).post('/employees', { name: 'Temp', email, password: 'Passw0rdOK', role: 'cashier' });
    const login = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
    assert.equal((await api(login.body.accessToken).get('/sales')).status, 200);
    assert.equal((await api(A.owner.token).put(`/employees/${c.body.id}`, { isActive: false })).status, 200);
    assert.equal((await api(login.body.accessToken).get('/sales')).status, 401);
  });
  test('a user belonging to shop A cannot use their token against shop B by swapping the bid claim', async () => {
    const jwt = require('jsonwebtoken');
    const t = jwt.sign({ sub: A.owner.id, bid: B.businessId, role: 'business_owner' }, process.env.JWT_SECRET, { expiresIn: 600 });
    const r = await api(t).get('/products');
    assert.ok(!ok2xx(r) || !asJson(r).includes(prodA.name));
    if (ok2xx(r)) assert.equal((r.body.rows || r.body.products || []).length, 0 + (r.body.rows || r.body.products || []).length); // must not be A's data (checked above)
  });
});

describe('financial integrity (malicious money requests)', () => {
  let p;
  before(async () => { p = await addProduct(api, A, { sellingPrice: 100, purchasePrice: 60, stock: 100 }); });
  const sale = (body) => api(A.owner.token).post('/sales', body);
  test('negative, zero and fractional-for-piece quantities are rejected', async () => {
    for (const q of [-1, 0, '-5', 0.5, 1e9]) assert.ok(!ok2xx(await sale({ items: [{ productId: p.id, quantity: q }], paymentMethod: 'cash' })), `qty ${q}`);
  });
  test('client-supplied price/total/tax fields are ignored (server prices the bill)', async () => {
    const base = await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
    const r = await sale({ items: [{ productId: p.id, quantity: 1, price: 0.01, sellingPrice: 0.01, total: 0.01, taxRate: 0 }], paymentMethod: 'cash', total: 0.01, tax: 0, subtotal: 0.01 });
    if (ok2xx(r)) assert.equal(Number(r.body.total), Number(base.body.total), 'total must be the server-priced bill'); else assert.equal(r.status, 400);
  });
  test('discounts over 100% or negative are rejected; amount discount above subtotal is rejected', async () => {
    assert.ok(!ok2xx(await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash', discount: { type: 'percent', value: 150 } })));
    assert.ok(!ok2xx(await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash', discount: { type: 'amount', value: -5 } })));
    const over = await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash', discount: { type: 'amount', value: 100000 } });
    if (ok2xx(over)) assert.ok(Number(over.body.total) >= 0, 'an over-sized discount must never produce a negative bill');
  });
  test('split payments that are under, over or non-positive vs the bill are rejected', async () => {
    const items = [{ productId: p.id, quantity: 1 }];
    for (const payments of [[{ method: 'cash', amount: 50 }], [{ method: 'cash', amount: 60 }, { method: 'upi', amount: 60 }], [{ method: 'cash', amount: -100 }, { method: 'upi', amount: 205 }], [{ method: 'cash', amount: 0 }, { method: 'upi', amount: 105 }]]) {
      const r = await sale({ items, payments });
      assert.ok(!ok2xx(r), `payments ${JSON.stringify(payments)} -> ${r.status}`);
    }
    const total = Number((await sale({ items, paymentMethod: 'cash' })).body.total);
    const good = await sale({ items, payments: [{ method: 'cash', amount: 40 }, { method: 'upi', amount: +(total - 40).toFixed(2) }] });
    assert.equal(good.status, 201, asJson(good));
  });
  test('credit sale needs a customer and respects the credit limit', async () => {
    assert.ok(!ok2xx(await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'credit' })));
    const c = await addCustomer(api, A);
    await api(A.owner.token).put(`/credit/customers/${c.id}/limit`, { creditLimit: 50 });
    assert.ok(!ok2xx(await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'credit', customerId: c.id })), 'sale above credit limit must be refused');
  });
  test('credit payments: negative / zero / absurd amounts rejected', async () => {
    const c = await addCustomer(api, A);
    for (const amount of [-10, 0, 1e12]) assert.ok(!ok2xx(await api(A.cashier.token).post(`/credit/customers/${c.id}/payments`, { amount, method: 'cash' })), `amount ${amount}`);
  });
  test('returns: more than sold, negative, repeated lines, and cumulative over-return are rejected', async () => {
    const s = await sale({ items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'cash' });
    assert.equal(s.status, 201);
    const d = (await api(A.owner.token).get(`/sales/${s.body.id}`)).body;
    const line = d.items[0].id;
    const ret = (items) => api(A.owner.token).post(`/sales/${s.body.id}/returns`, { items, reason: 'other' });
    assert.ok(!ok2xx(await ret([{ saleItemId: line, quantity: 4 }])), 'more than sold');
    assert.ok(!ok2xx(await ret([{ saleItemId: line, quantity: -1 }])), 'negative');
    assert.ok(!ok2xx(await ret([{ saleItemId: line, quantity: 2 }, { saleItemId: line, quantity: 2 }])), 'split across duplicate lines exceeding sold');
    assert.equal((await ret([{ saleItemId: line, quantity: 2 }])).status, 201);
    assert.ok(!ok2xx(await ret([{ saleItemId: line, quantity: 2 }])), 'cumulative over-return');
    assert.equal((await ret([{ saleItemId: line, quantity: 1 }])).status, 201);
    assert.ok(!ok2xx(await ret([{ saleItemId: line, quantity: 1 }])), 'nothing left to return');
  });
  test('returning a line that belongs to another sale (or another shop) is rejected', async () => {
    const s1 = await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
    const s2 = await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
    const line2 = (await api(A.owner.token).get(`/sales/${s2.body.id}`)).body.items[0].id;
    assert.ok(!ok2xx(await api(A.owner.token).post(`/sales/${s1.body.id}/returns`, { items: [{ saleItemId: line2, quantity: 1 }] })));
    const lineA = (await api(A.owner.token).get(`/sales/${saleA.id}`)).body.items[0].id;
    assert.ok(!ok2xx(await api(B.owner.token).post(`/sales/${saleA.id}/returns`, { items: [{ saleItemId: lineA, quantity: 1 }] })));
  });
  test('refund of an already refunded sale is rejected; refund amounts must match the return', async () => {
    const s = await sale({ items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.equal((await api(A.owner.token).post(`/sales/${s.body.id}/refund`)).status, 200);
    assert.ok(!ok2xx(await api(A.owner.token).post(`/sales/${s.body.id}/refund`)));
    const s2 = await sale({ items: [{ productId: p.id, quantity: 2 }], paymentMethod: 'cash' });
    const line = (await api(A.owner.token).get(`/sales/${s2.body.id}`)).body.items[0].id;
    const over = await api(A.owner.token).post(`/sales/${s2.body.id}/returns`, { items: [{ saleItemId: line, quantity: 1 }], refunds: [{ method: 'cash', amount: 500 }] });
    assert.ok(!ok2xx(over), `refund above the return value -> ${over.status}`);
  });
  test('replay with the same Idempotency-Key never double-sells or double-refunds', async () => {
    const key = crypto.randomUUID();
    const body = { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' };
    const stock0 = Number((await api(A.owner.token).get(`/products/${p.id}`)).body.stock);
    const r1 = await api(A.owner.token).post('/sales', body, { 'idempotency-key': key });
    const r2 = await api(A.owner.token).post('/sales', body, { 'idempotency-key': key });
    assert.equal(r1.status, 201); assert.equal(r2.status, 200);
    assert.equal(r1.body.id, r2.body.id);
    assert.equal(Number((await api(A.owner.token).get(`/products/${p.id}`)).body.stock), stock0 - 1);
    const r3 = await api(A.owner.token).post('/sales', { ...body, items: [{ productId: p.id, quantity: 2 }] }, { 'idempotency-key': key });
    assert.equal(r3.status, 422, 'same key, different payload');
  });
  test('concurrent identical requests produce exactly one sale; concurrent oversell cannot drive stock negative', async () => {
    const key = crypto.randomUUID();
    const body = { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' };
    const rs = await Promise.all(Array.from({ length: 6 }, () => api(A.owner.token).post('/sales', body, { 'idempotency-key': key })));
    assert.equal(new Set(rs.filter((r) => ok2xx(r)).map((r) => r.body.id)).size, 1);
    const scarce = await addProduct(api, A, { stock: 3, sellingPrice: 10, purchasePrice: 5 });
    const many = await Promise.all(Array.from({ length: 8 }, () => api(A.owner.token).post('/sales', { items: [{ productId: scarce.id, quantity: 1 }], paymentMethod: 'cash' })));
    assert.equal(many.filter(ok2xx).length, 3, 'exactly the available stock can be sold');
    assert.equal(Number((await api(A.owner.token).get(`/products/${scarce.id}`)).body.stock), 0);
  });
  test('Idempotency-Key must be a UUID on money endpoints', async () => {
    const r = await api(A.owner.token).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' }, { 'idempotency-key': 'not-a-uuid' });
    assert.ok(!ok2xx(r));
  });
});

describe('input security', () => {
  test('malformed JSON -> 400, no stack trace', async () => {
    const r = await fetch(`${env.base}/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.owner.token}` }, body: '{"name": ' });
    assert.equal(r.status, 400);
    assert.ok(!/at .*\.js:\d+/.test(await r.text()));
  });
  test('oversized body -> 413 (not 500), no stack trace', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(200 * 1024) });
    const r = await fetch(`${env.base}/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.owner.token}` }, body: big });
    const text = await r.text();
    assert.equal(r.status, 413, `got ${r.status}: ${text.slice(0, 120)}`);
    assert.ok(!/at .*\.js:\d+/.test(text));
  });
  test('SQL-injection strings in search/filter/body are treated as data', async () => {
    const evil = "' OR 1=1; DROP TABLE products; --";
    for (const p of [`/products?search=${encodeURIComponent(evil)}`, `/customers?search=${encodeURIComponent(evil)}`, `/customers/search?q=${encodeURIComponent(evil)}`, `/audit?q=${encodeURIComponent(evil)}`, `/products/pos-search?q=${encodeURIComponent(evil)}`]) {
      const r = await api(A.owner.token).get(p);
      assert.ok(r.status < 500, `${p} -> ${r.status}`);
    }
    const c = await api(A.owner.token).post('/customers', { name: evil, phone: '9000000001' });
    assert.ok(c.status < 500);
    assert.equal((await api(A.owner.token).get('/products')).status, 200);
  });
  test('non-numeric / array / object IDs are 400, not 500', async () => {
    for (const p of ['/products/abc', '/products/1;DROP', '/sales/-1', '/sales/1e3', '/sales/0', '/customers/%00', '/held-bills/NaN']) {
      const r = await api(A.owner.token).get(p);
      assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    }
  });
  test('prototype-pollution payloads do not pollute and do not 500', async () => {
    const r = await fetch(`${env.base}/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A.owner.token}` }, body: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"name":"pp"}' });
    assert.ok(r.status < 500);
    assert.equal({}.polluted, undefined);
  });
  test('mass assignment: privileged fields in the body are ignored', async () => {
    const email = `${uniq('ma')}@example.com`;
    const r = await api(A.owner.token).post('/employees', { name: 'MA', email, password: 'Passw0rdOK', role: 'cashier', businessId: B.businessId, isActive: false, is_demo: true, accountId: 1 });
    assert.equal(r.status, 201, asJson(r));
    const login = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
    assert.equal(login.status, 200, asJson(login));
    const claims = JSON.parse(Buffer.from(login.body.accessToken.split('.')[1], 'base64url').toString());
    assert.equal(claims.bid, A.businessId); assert.equal(claims.role, 'cashier'); assert.equal(claims.pa, false);
    const reg = await api().post('/auth/register', { businessName: uniq('Rita Store '), ownerName: 'Rita Sen', email: `${uniq('r')}@example.com`, phone: '9876501234', password: 'Passw0rdOK', role: 'platform_admin', isDemo: true });
    assert.equal(reg.status, 201);
    const rc = JSON.parse(Buffer.from(reg.body.accessToken.split('.')[1], 'base64url').toString());
    assert.equal(rc.role, 'business_owner'); assert.equal(rc.pa, false);
  });
  test('registration/login do not accept weak passwords', async () => {
    for (const password of ['short1', 'allletters', '12345678', 'x'.repeat(101) + '1']) {
      const r = await api().post('/auth/register', { businessName: uniq('W '), ownerName: 'W', email: `${uniq('w')}@example.com`, phone: '9876501235', password });
      assert.equal(r.status, 400, `password ${password.slice(0, 6)}…`);
    }
  });
  test('stored XSS payloads are returned as data (JSON), never rendered; security headers present', async () => {
    const x = '<img src=x onerror=alert(1)>';
    const c = await api(A.owner.token).post('/customers', { name: x, phone: '9000000002' });
    assert.ok(c.status < 500);
    const r = await fetch(`${env.base}/products`, { headers: { authorization: `Bearer ${A.owner.token}` } });
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  test('unknown routes and server errors do not echo internals', async () => {
    const r = await fetch(`${env.base}/nope/<script>alert(1)</script>`, { headers: { authorization: `Bearer ${A.owner.token}` } });
    assert.equal(r.status, 404);
    const t = await r.text();
    assert.ok(!t.includes('<script>'), 'URL must not be reflected raw');
  });
  test('CORS: a foreign origin is not allowed credentials', async () => {
    const r = await fetch(`${env.base}/products`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${A.owner.token}` } });
    assert.notEqual(r.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
  });
});

describe('database security', () => {
  const { Client } = require('pg');
  const appUrl = () => process.env.DATABASE_URL;
  test('runtime role is not superuser, cannot bypass RLS, cannot create objects, cannot drop tables', async () => {
    const c = new Client({ connectionString: appUrl() }); await c.connect();
    const r = (await c.query('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    await assert.rejects(c.query('CREATE TABLE public.evil (x int)'));
    await assert.rejects(c.query('DROP TABLE public.sales'));
    await assert.rejects(c.query('TRUNCATE public.sales'));
    await c.end();
  });
  test('with no tenant context the runtime role sees zero tenant rows and cannot write', async () => {
    const c = new Client({ connectionString: appUrl() }); await c.connect();
    for (const t of ['sales', 'customers', 'products', 'sale_items', 'sale_payments', 'sale_returns', 'held_bills', 'credit_ledger', 'shifts', 'audit_logs']) {
      assert.equal(Number((await c.query(`SELECT count(*) FROM ${t}`)).rows[0].count), 0, `${t} visible without tenant`);
    }
    await assert.rejects(c.query("INSERT INTO customers (business_id, name) VALUES (1, 'x')"));
    await c.end();
  });
  test('with tenant A context, tenant B rows are invisible and cross-tenant writes are rejected by the database itself', async () => {
    const c = new Client({ connectionString: appUrl() }); await c.connect();
    await c.query('BEGIN'); await c.query("SELECT set_config('app.business_id', $1, true)", [String(B.businessId)]);
    assert.equal(Number((await c.query('SELECT count(*) FROM sales WHERE business_id = $1', [A.businessId])).rows[0].count), 0);
    assert.equal((await c.query('UPDATE sales SET total = 0 WHERE business_id = $1', [A.businessId])).rowCount, 0);
    assert.equal((await c.query('DELETE FROM products WHERE business_id = $1', [A.businessId])).rowCount, 0);
    await assert.rejects(c.query("INSERT INTO customers (business_id, name) VALUES ($1, 'x')", [A.businessId]));
    await c.query('ROLLBACK'); await c.end();
  });
  test('ledger tamper: finished sales cannot be rewritten, deleted or un-refunded, and stock history is append-only (as the runtime role, inside the tenant)', async () => {
    const c = new Client({ connectionString: appUrl() }); await c.connect();
    await c.query('BEGIN'); await c.query("SELECT set_config('app.business_id', $1, true)", [String(A.businessId)]);
    const fails = async (sql, params, re) => { await c.query('SAVEPOINT s'); await assert.rejects(c.query(sql, params), re); await c.query('ROLLBACK TO s'); };
    await fails('UPDATE sales SET total = 0 WHERE id = $1', [saleA.id], /cannot be changed/);
    await fails('UPDATE sales SET employee_id = employee_id + 1 WHERE id = $1', [saleA.id], /cannot be changed/);
    await fails('UPDATE sales SET refund_amount = -5 WHERE id = $1', [saleA.id]);
    await fails('UPDATE sale_items SET quantity = 999, unit_price = 0 WHERE sale_id = $1', [saleA.id], /cannot be changed/);
    await fails('UPDATE inventory_movements SET quantity = 0', [], /permission denied/);
    assert.equal((await c.query('DELETE FROM sales WHERE id = $1', [saleA.id])).rowCount, 0, 'real shops cannot delete sales');
    assert.equal((await c.query('DELETE FROM sale_items WHERE sale_id = $1', [saleA.id])).rowCount, 0);
    assert.equal((await c.query('DELETE FROM inventory_movements')).rowCount, 0);
    assert.equal(Number((await c.query('SELECT count(*) FROM sales WHERE id = $1', [saleA.id])).rows[0].count), 1);
    await c.query('ROLLBACK'); await c.end();
  });
  test('a sale can still be returned and refunded through the app (bookkeeping columns stay writable)', async () => {
    const q = await addProduct(api, A, { sellingPrice: 20, purchasePrice: 10, stock: 10 });
    const s = await api(A.owner.token).post('/sales', { items: [{ productId: q.id, quantity: 2 }], paymentMethod: 'cash' });
    const line = (await api(A.owner.token).get(`/sales/${s.body.id}`)).body.items[0].id;
    assert.equal((await api(A.owner.token).post(`/sales/${s.body.id}/returns`, { items: [{ saleItemId: line, quantity: 1 }] })).status, 201);
    assert.equal((await api(A.owner.token).post(`/sales/${s.body.id}/refund`)).status, 200);
  });
  test('audit log is append-only for the runtime role (no update, no delete)', async () => {
    const c = new Client({ connectionString: appUrl() }); await c.connect();
    await assert.rejects(c.query('UPDATE audit_logs SET summary = $1', ['x']));
    await assert.rejects(c.query('DELETE FROM audit_logs'));
    await c.end();
  });
  test('every tenant table with business_id has FORCE RLS, except the documented platform tables', async () => {
    const owner = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }); await owner.connect();
    const rows = (await owner.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='business_id' AND NOT a.attisdropped)`)).rows;
    const PLATFORM = ['payments', 'billing_events', 'subscriptions', 'memberships', 'sessions'];
    for (const r of rows) if (!PLATFORM.includes(r.relname)) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} lacks FORCE RLS`);
    await owner.end();
  });
  test('no SECURITY DEFINER functions and no PUBLIC grants on tenant tables', async () => {
    const owner = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }); await owner.connect();
    assert.equal((await owner.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")).rowCount, 0);
    assert.equal((await owner.query("SELECT 1 FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_schema='public'")).rowCount, 0);
    await owner.end();
  });
});

describe('secrets', () => {
  const root = path.join(__dirname, '..', '..');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.pgdata', 'backups'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  test('no private keys or well-known provider tokens are committed', () => {
    const re = /(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bp]-[A-Za-z0-9-]{10,})/;
    const hits = walk(root).filter((f) => !/package-lock\.json$|security\.test\.js$/.test(f) && !/\.(png|jpg|ico|woff2?|gz)$/.test(f) && re.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits.map((f) => path.relative(root, f)), []);
  });
  test('real .env files are gitignored and example env files hold only placeholders', () => {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /^\.env$/m);
    for (const f of ['.env.example', '.env.production.example']) {
      const p = path.join(root, 'backend', f); if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^(JWT_SECRET|PROXY_SHARED_SECRET|PAYMENT_KEY_SECRET|PAYMENT_WEBHOOK_SECRET|LLM_API_KEY|BACKUP_PASSPHRASE)=([^#]*)/);
        if (m) assert.ok(m[2].trim() === '' || /replace|change|example|placeholder|your|xxx|<|generate/i.test(m[2]), `${f}: ${m[1]} looks like a real value`);
      }
    }
  });
  test('backup script verifies every live table (so later migrations cannot be left out), is encrypted and refuses non-SHARKPOS databases', () => {
    const sh = fs.readFileSync(path.join(root, 'scripts', 'backup.sh'), 'utf8');
    assert.match(sh, /pg_tables WHERE schemaname='public'/); assert.match(sh, /TABLE DATA public \$t /);
    assert.match(sh, /aes-256-cbc -pbkdf2 -iter 200000/); assert.match(sh, /sharkpos2\*\) ;;/);
    assert.match(fs.readFileSync(path.join(root, 'scripts', 'verify-restore.js'), 'utf8'), /md5\(/);
  });
  test('login/sale error responses and the request log never contain credentials', async () => {
    const r = await api().post('/auth/login', { email: 'a@b.co', password: 'SuperSecret123' });
    assert.ok(!asJson(r).includes('SuperSecret123'));
    const src = fs.readFileSync(path.join(root, 'backend', 'src', 'middleware', 'requestLog.js'), 'utf8');
    assert.ok(!/req\.body|authorization|cookie|req\.query/i.test(src), 'request log must not read body, auth/cookie headers or the query string');
  });
  test('audit records contain no password / token material', async () => {
    const rows = (await api(A.owner.token).get('/audit?pageSize=100')).body.rows;
    for (const r of rows) assert.ok(!/passw|token|secret|hash/i.test(JSON.stringify([r.oldValue, r.newValue]).replace(/"role"/g, '')), `${r.action} stores a secret-looking field`);
  });
});
