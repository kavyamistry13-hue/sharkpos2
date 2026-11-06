// SHARKPOS 2 — Phase 1 integration tests: auth, roles, tenant isolation, POS, inventory, audit, errors.
// Runs against the real app and a throw-away PostgreSQL database (sharkpos2_test), wiped at the start of the run.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { boot, client, uniq } = require('./helpers');

let env; let api;
const A = {}; const B = {};

const register = (over = {}) => {
  const email = `${uniq('owner')}@example.com`;
  return api().post('/auth/register', { businessName: uniq('TEST Mart '), ownerName: 'Owner One', email, phone: '9876543210', password: 'Passw0rdOK', ...over });
};
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

async function makeTenant(t) {
  const reg = await register();
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  t.owner = { token: reg.body.accessToken, email: reg.body.user.email, id: reg.body.user.id };
  t.businessId = reg.body.business.id;
  t.refreshCookie = cookieOf(reg);
  const o = api(t.owner.token);
  for (const role of ['manager', 'cashier']) {
    const email = `${uniq(role)}@example.com`;
    const c = await o.post('/employees', { name: `${role} person`, email, password: 'Passw0rdOK', role });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const login = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
    t[role] = { token: login.body.accessToken, email, id: c.body.id };
  }
  const lk = await o.get('/products/lookups');
  t.categoryId = lk.body.categories[0].id;
  const p = await o.post('/products', { name: uniq('Milk '), categoryId: t.categoryId, purchasePrice: 40, sellingPrice: 50, stock: 20, minimumStock: 5 });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  t.product = p.body;
  const cu = await o.post('/customers', { name: 'Asha', phone: String(9000000000 + Math.floor(Math.random() * 99999999)) });
  assert.equal(cu.status, 201, JSON.stringify(cu.body));
  t.customer = cu.body;
  const s = await api(t.cashier.token).post('/sales', { items: [{ productId: t.product.id, quantity: 2 }], paymentMethod: 'cash' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  t.sale = s.body;
}

test.before(async () => {
  env = await boot();
  api = client(env.base);
  await makeTenant(A);
  await makeTenant(B);
});
test.after(async () => { await env.close(); });

// ---------------------------------------------------------------- authentication
test('registration creates business + owner and signs in', async () => {
  assert.ok(A.businessId && A.owner.token);
  const me = await api(A.owner.token).get('/auth/me');
  assert.equal(me.body.user.role, 'business_owner');
  assert.equal(me.body.user.businessId, A.businessId);
});

test('registration validates input and rejects duplicate emails', async () => {
  const bad = await register({ password: 'short' });
  assert.equal(bad.status, 400);
  const weak = await register({ password: 'onlyletters' });
  assert.equal(weak.status, 400);
  const first = await register({ email: 'dup@example.com' });
  assert.equal(first.status, 201);
  const second = await register({ email: 'DUP@example.com' });
  assert.equal(second.status, 409);
});

test('login: wrong password and unknown email give the same 401', async () => {
  const w = await api().post('/auth/login', { email: A.owner.email, password: 'wrong-password' });
  const u = await api().post('/auth/login', { email: 'nobody@example.com', password: 'wrong-password' });
  assert.equal(w.status, 401);
  assert.equal(u.status, 401);
  assert.equal(w.body.error, u.body.error);
});

test('account locks after repeated failures', async () => {
  const r = await register();
  for (let i = 0; i < 5; i += 1) await api().post('/auth/login', { email: r.body.user.email, password: 'nope-nope' });
  const locked = await api().post('/auth/login', { email: r.body.user.email, password: 'Passw0rdOK' });
  assert.equal(locked.status, 429);
});

test('requests without / with bad / expired token are 401', async () => {
  assert.equal((await api().get('/products')).status, 401);
  assert.equal((await api('garbage').get('/products')).status, 401);
  const expired = jwt.sign({ sub: A.owner.id, bid: A.businessId, role: 'business_owner', name: 'x' }, process.env.JWT_SECRET, { expiresIn: -10 });
  assert.equal((await api(expired).get('/products')).status, 401);
  const forged = jwt.sign({ sub: A.owner.id, bid: B.businessId, role: 'business_owner', name: 'x' }, 'some-other-secret');
  assert.equal((await api(forged).get('/products')).status, 401);
});

test('a valid token cannot be pointed at another business (membership is checked in the database)', async () => {
  const mine = jwt.sign({ sub: A.owner.id, bid: B.businessId, role: 'business_owner', name: 'x' }, process.env.JWT_SECRET, { expiresIn: 60 });
  const r = await api(mine).get('/products');
  assert.equal(r.status, 401);
});

test('a token claiming a higher role than the database gives is ignored', async () => {
  const sneaky = jwt.sign({ sub: A.cashier.id, bid: A.businessId, role: 'business_owner', name: 'x' }, process.env.JWT_SECRET, { expiresIn: 60 });
  const r = await api(sneaky).get('/employees');
  assert.equal(r.status, 403);
});

test('refresh rotates the token, logout revokes it, reuse revokes everything', async () => {
  const r = await register();
  const c1 = cookieOf(r);
  const noHeader = await api(null, { cookie: c1 }).post('/auth/refresh');
  assert.equal(noHeader.status, 403); // CSRF header required
  const rf = await api(null, { cookie: c1, 'x-requested-with': 'sharkpos' }).post('/auth/refresh');
  assert.equal(rf.status, 200);
  const c2 = cookieOf(rf);
  assert.notEqual(c1, c2);
  assert.ok((await api(rf.body.accessToken).get('/auth/me')).status === 200);
  // reusing the OLD (already rotated) token is treated as theft
  const reuse = await api(null, { cookie: c1, 'x-requested-with': 'sharkpos' }).post('/auth/refresh');
  assert.equal(reuse.status, 401);
  const after = await api(null, { cookie: c2, 'x-requested-with': 'sharkpos' }).post('/auth/refresh');
  assert.equal(after.status, 401); // the newer session was revoked too
});

test('logout invalidates the refresh session', async () => {
  const r = await register();
  const cookie = cookieOf(r);
  const out = await api(null, { cookie, 'x-requested-with': 'sharkpos' }).post('/auth/logout');
  assert.equal(out.status, 200);
  const again = await api(null, { cookie, 'x-requested-with': 'sharkpos' }).post('/auth/refresh');
  assert.equal(again.status, 401);
});

test('deactivating an employee blocks their existing token immediately', async () => {
  const email = `${uniq('temp')}@example.com`;
  const c = await api(A.owner.token).post('/employees', { name: 'Temp', email, password: 'Passw0rdOK', role: 'cashier' });
  const login = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
  assert.equal((await api(login.body.accessToken).get('/settings')).status, 200);
  assert.equal((await api(A.owner.token).put(`/employees/${c.body.id}`, { isActive: false })).status, 200);
  assert.equal((await api(login.body.accessToken).get('/settings')).status, 401);
  assert.equal((await api().post('/auth/login', { email, password: 'Passw0rdOK' })).status, 403);
});

test('suspended business is locked out; platform admin can reactivate', async () => {
  const r = await register();
  const { sysQuery } = env.db;
  await sysQuery("INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ('Plat', 'plat@example.com', (SELECT password_hash FROM accounts LIMIT 1), TRUE) ON CONFLICT DO NOTHING");
  await sysQuery("UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE id = $1) WHERE email = 'plat@example.com'", [r.body.user.id]);
  const plat = await api().post('/auth/login', { email: 'plat@example.com', password: 'Passw0rdOK' });
  assert.equal(plat.status, 200);
  assert.equal(plat.body.user.role, 'platform_admin');
  const s = await api(plat.body.accessToken).post(`/platform/businesses/${r.body.business.id}/status`, { status: 'suspended' });
  assert.equal(s.status, 200);
  assert.equal((await api(r.body.accessToken).get('/products')).status, 403);
  await api(plat.body.accessToken).post(`/platform/businesses/${r.body.business.id}/status`, { status: 'active' });
  assert.equal((await api(r.body.accessToken).get('/products')).status, 200);
});

// ---------------------------------------------------------------- role permissions
test('platform area is closed to business users, business area closed to platform admin', async () => {
  for (const who of [A.owner, A.manager, A.cashier]) {
    assert.equal((await api(who.token).get('/platform/businesses')).status, 403);
  }
});

test('cashier permissions', async () => {
  const c = api(A.cashier.token);
  assert.equal((await c.get('/products/pos-search?q=milk')).status, 200);
  assert.equal((await c.post('/sales/preview', { items: [{ productId: A.product.id, quantity: 1 }] })).status, 200);
  for (const [m, p, b] of [['get', '/employees'], ['get', '/analytics/overview'], ['get', '/audit'], ['get', '/inventory'], ['get', '/risk/alerts'], ['get', '/customers'], ['get', '/ai/brief'], ['post', '/products', { name: 'x', categoryId: A.categoryId, purchasePrice: 1, sellingPrice: 2 }], ['put', '/settings', { storeName: 'hack' }], ['post', `/sales/${A.sale.id}/refund`], ['del', `/products/${A.product.id}`], ['post', '/employees', { name: 'n', email: 'n@example.com', password: 'Passw0rdOK', role: 'cashier' }]]) {
    const r = await c[m](p, b);
    assert.equal(r.status, 403, `${m} ${p} should be 403 for cashier, got ${r.status}`);
  }
});

test('manager permissions: can run the shop, cannot touch owner-only areas', async () => {
  const m = api(A.manager.token);
  assert.equal((await m.get('/analytics/overview')).status, 200);
  assert.equal((await m.get('/inventory')).status, 200);
  assert.equal((await m.get('/risk/alerts')).status, 200);
  assert.equal((await m.post('/products', { name: uniq('Tea '), categoryId: A.categoryId, purchasePrice: 5, sellingPrice: 9, stock: 3 })).status, 201);
  assert.equal((await m.get('/audit')).status, 403);
  assert.equal((await m.put('/settings', { storeName: 'x' })).status, 403);
  assert.equal((await m.del(`/products/${A.product.id}`)).status, 403);
  assert.equal((await m.post('/demo/load', { confirm: true })).status, 403);
  // managers may add cashiers but never managers/owners
  assert.equal((await m.post('/employees', { name: 'c', email: `${uniq('c')}@example.com`, password: 'Passw0rdOK', role: 'cashier' })).status, 201);
  assert.equal((await m.post('/employees', { name: 'm', email: `${uniq('m')}@example.com`, password: 'Passw0rdOK', role: 'manager' })).status, 403);
  assert.equal((await m.put(`/employees/${A.owner.id}`, { name: 'Pwned' })).status, 403);
});

test('owner permissions and last-owner protection', async () => {
  const o = api(A.owner.token);
  assert.equal((await o.get('/audit')).status, 200);
  assert.equal((await o.put('/settings', { storeName: 'Renamed Store' })).status, 200);
  assert.equal((await o.put(`/employees/${A.owner.id}`, { role: 'manager' })).status, 400);
  assert.equal((await o.del(`/employees/${A.owner.id}`)).status, 400);
});

// ---------------------------------------------------------------- TENANT ISOLATION
test('ISOLATION: lists never contain the other business', async () => {
  const a = api(A.owner.token);
  const prods = await a.get('/products');
  assert.ok(prods.body.rows.length >= 1);
  assert.ok(!prods.body.rows.some((p) => p.id === B.product.id));
  const custs = await a.get('/customers');
  assert.ok(!JSON.stringify(custs.body).includes(B.customer.phone));
  const sales = await a.get('/sales');
  assert.ok(!sales.body.rows.some((s) => s.id === B.sale.id));
  const emps = await a.get('/employees');
  assert.ok(!emps.body.rows.some((e) => e.id === B.manager.id || e.id === B.cashier.id));
  const pos = await a.get('/products/pos-search?q=');
  assert.ok(!pos.body.rows.some((p) => p.id === B.product.id));
});

test('ISOLATION: another business\'s ids are 404 on every read, write and delete', async () => {
  const a = api(A.owner.token);
  const probes = [
    ['get', `/products/${B.product.id}`], ['put', `/products/${B.product.id}`, { name: 'hijacked' }], ['del', `/products/${B.product.id}`],
    ['get', `/sales/${B.sale.id}`], ['post', `/sales/${B.sale.id}/refund`],
    ['get', `/customers/${B.customer.id}`],
    ['get', `/inventory/${B.product.id}/movements`], ['get', `/ai/forecast/${B.product.id}`],
    ['post', `/ai/restock/${B.product.id}/approve`, {}], ['post', `/ai/restock/${B.product.id}/dismiss`],
    ['put', `/employees/${B.cashier.id}`, { isActive: false }], ['del', `/employees/${B.cashier.id}`],
    ['post', '/inventory/restock-orders/999999/receive'],
  ];
  for (const [m, p, body] of probes) {
    const r = await a[m](p, body);
    assert.equal(r.status, 404, `${m.toUpperCase()} ${p} leaked: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  // …and B's data is untouched
  const bProd = await api(B.owner.token).get(`/products/${B.product.id}`);
  assert.equal(bProd.status, 200);
  assert.notEqual(bProd.body.name, 'hijacked');
  const bEmp = await api(B.owner.token).get('/employees');
  assert.ok(bEmp.body.rows.find((e) => e.id === B.cashier.id).isActive);
});

test('ISOLATION: cannot sell, attach or restock another business\'s records', async () => {
  const a = api(A.owner.token);
  const sellB = await a.post('/sales', { items: [{ productId: B.product.id, quantity: 1 }], paymentMethod: 'cash' });
  assert.ok([400, 404].includes(sellB.status), `selling B's product returned ${sellB.status}`);
  const mixed = await a.post('/sales', { items: [{ productId: A.product.id, quantity: 1 }, { productId: B.product.id, quantity: 1 }], paymentMethod: 'cash' });
  assert.ok([400, 404].includes(mixed.status));
  const custB = await a.post('/sales', { items: [{ productId: A.product.id, quantity: 1 }], paymentMethod: 'cash', customerId: B.customer.id });
  assert.equal(custB.status, 404);
  const prodCat = await a.post('/products', { name: uniq('X'), categoryId: 999999, purchasePrice: 1, sellingPrice: 2 });
  assert.ok(prodCat.status >= 400 && prodCat.status < 500);
  // B's stock is unchanged by all of the above
  const stock = (await api(B.owner.token).get(`/products/${B.product.id}`)).body.stock;
  assert.equal(stock, 18);
});

test('ISOLATION: a category from another business cannot be used (composite foreign key)', async () => {
  const bCategory = (await api(B.owner.token).get('/products/lookups')).body.categories[0].id;
  const r = await api(A.owner.token).post('/products', { name: uniq('X'), categoryId: bCategory, purchasePrice: 1, sellingPrice: 2 });
  assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
});

test('ISOLATION: audit logs, alerts and analytics are per business', async () => {
  const a = await api(A.owner.token).get('/audit?pageSize=100');
  assert.ok(a.body.rows.length > 0);
  assert.ok(!a.body.rows.some((r) => r.entityType === 'product' && String(r.entityId) === String(B.product.id)));
  const ov = await api(B.owner.token).get('/analytics/overview');
  assert.equal(ov.body.kpis.products, 1);
  assert.equal(ov.body.kpis.orders, 1);
});

test('ISOLATION (database level): row-level security hides and rejects cross-tenant rows even for raw SQL', async () => {
  const { runAsTenant, query, sysQuery } = env.db;
  await runAsTenant(A.businessId, async () => {
    assert.equal((await query('SELECT * FROM products WHERE id = $1', [B.product.id])).rowCount, 0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM products WHERE business_id = $1', [B.businessId])).rows[0].n, 0);
    assert.equal((await query('UPDATE products SET name = $1 WHERE id = $2', ['x', B.product.id])).rowCount, 0);
    assert.equal((await query('DELETE FROM sales WHERE id = $1', [B.sale.id])).rowCount, 0);
    await assert.rejects(query('INSERT INTO categories (business_id, name) VALUES ($1, $2)', [B.businessId, 'sneaky']), /row-level security/);
    await assert.rejects(query('UPDATE products SET business_id = $1 WHERE id = $2', [B.businessId, A.product.id]), /row-level security/);
  });
  // with no tenant context at all the tenant tables are empty
  assert.equal((await sysQuery('SELECT COUNT(*)::int AS n FROM products')).rows[0].n, 0);
  assert.equal((await sysQuery('SELECT COUNT(*)::int AS n FROM sales')).rows[0].n, 0);
});

test('ISOLATION: the app role cannot bypass RLS or rewrite the audit trail', async () => {
  const { sysQuery } = env.db;
  const role = (await sysQuery("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  await assert.rejects(sysQuery('UPDATE audit_logs SET summary = $1', ['tampered']), /permission denied/);
  await assert.rejects(sysQuery('DELETE FROM audit_logs'), /permission denied/);
});

test('ISOLATION: two tenants can use the same SKU / phone / invoice numbers without clashing', async () => {
  const sku = uniq('SAME-');
  const r1 = await api(A.owner.token).post('/products', { sku, name: 'One', categoryId: A.categoryId, purchasePrice: 1, sellingPrice: 2 });
  const bCat = (await api(B.owner.token).get('/products/lookups')).body.categories[0].id;
  const r2 = await api(B.owner.token).post('/products', { sku, name: 'Two', categoryId: bCat, purchasePrice: 1, sellingPrice: 2 });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const dup = await api(A.owner.token).post('/products', { sku, name: 'Three', categoryId: A.categoryId, purchasePrice: 1, sellingPrice: 2 });
  assert.equal(dup.status, 409);
});

// ---------------------------------------------------------------- POS / inventory
test('POS: totals are computed by the server and stock decreases with a ledger entry', async () => {
  const o = api(A.owner.token);
  const before = (await o.get(`/products/${A.product.id}`)).body.stock;
  const prev = await o.post('/sales/preview', { items: [{ productId: A.product.id, quantity: 3 }] });
  assert.equal(prev.body.subtotal, 150);
  const sale = await o.post('/sales', { items: [{ productId: A.product.id, quantity: 3 }], paymentMethod: 'upi' });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.total, prev.body.total);
  assert.equal((await o.get(`/products/${A.product.id}`)).body.stock, before - 3);
  const moves = await o.get(`/inventory/${A.product.id}/movements`);
  assert.ok(moves.body.rows.some((m) => m.quantity === -3));
});

test('POS: cannot oversell, and client-sent prices are ignored', async () => {
  const o = api(A.owner.token);
  const over = await o.post('/sales', { items: [{ productId: A.product.id, quantity: 900 }], paymentMethod: 'cash' });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Insufficient stock/);
  const cheat = await o.post('/sales', { items: [{ productId: A.product.id, quantity: 1, unitPrice: 0.01, price: 0.01 }], total: 0.01, paymentMethod: 'cash' });
  assert.equal(cheat.status, 201);
  assert.equal(cheat.body.subtotal, 50);
});

test('POS: cashier discount above limit needs manager approval from the same business only', async () => {
  const c = api(A.cashier.token);
  const items = [{ productId: A.product.id, quantity: 1 }];
  const no = await c.post('/sales', { items, paymentMethod: 'cash', discount: { type: 'percent', value: 25 } });
  assert.equal(no.status, 403);
  assert.equal(no.body.details.code, 'APPROVAL_REQUIRED');
  const foreign = await c.post('/sales', { items, paymentMethod: 'cash', discount: { type: 'percent', value: 25 }, approval: { email: B.manager.email, password: 'Passw0rdOK' } });
  assert.equal(foreign.status, 403, 'a manager from another business must not be able to approve');
  const ok = await c.post('/sales', { items, paymentMethod: 'cash', discount: { type: 'percent', value: 25 }, approval: { email: A.manager.email, password: 'Passw0rdOK' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('refund restores stock and is audited', async () => {
  const o = api(A.owner.token);
  const sale = await o.post('/sales', { items: [{ productId: A.product.id, quantity: 2 }], paymentMethod: 'cash' });
  const mid = (await o.get(`/products/${A.product.id}`)).body.stock;
  assert.equal((await o.post(`/sales/${sale.body.id}/refund`)).status, 200);
  assert.equal((await o.get(`/products/${A.product.id}`)).body.stock, mid + 2);
  const log = await o.get('/audit?action=sale.refunded');
  assert.ok(log.body.rows.length >= 1);
});

test('inventory: low stock and AI restock approve flow', async () => {
  const o = api(A.owner.token);
  const p = (await o.post('/products', { name: uniq('Rice '), categoryId: A.categoryId, purchasePrice: 30, sellingPrice: 45, stock: 2, minimumStock: 10 })).body;
  const inv = await o.get('/inventory?filter=low');
  assert.ok(inv.body.rows.some((r) => r.id === p.id));
  const ord = await o.post(`/ai/restock/${p.id}/approve`, { quantity: 25 });
  assert.equal(ord.status, 201);
  const orders = await o.get('/inventory/restock-orders');
  const mine = orders.body.rows.find((r) => r.id === ord.body.id);
  assert.ok(mine);
  assert.equal((await o.post(`/inventory/restock-orders/${ord.body.id}/receive`)).status, 200);
  assert.equal((await o.get(`/products/${p.id}`)).body.stock, 27);
});

test('customers: create, search, duplicate phone handled', async () => {
  const phone = String(8000000000 + Math.floor(Math.random() * 99999999));
  const a = api(A.owner.token);
  assert.equal((await a.post('/customers', { name: 'Ravi', phone })).status, 201);
  assert.equal((await a.post('/customers', { name: 'Ravi 2', phone })).status, 409);
  assert.ok((await a.get(`/customers/search?q=${phone.slice(0, 6)}`)).body.rows.length >= 1);
});

// ---------------------------------------------------------------- AI + audit + errors
test('AI works without any LLM key and falls back to data-driven answers', async () => {
  const o = api(A.owner.token);
  const brief = await o.get('/ai/brief');
  assert.equal(brief.status, 200);
  const q = await o.post('/ai/copilot', { question: 'What should I restock tomorrow?' });
  assert.equal(q.status, 200);
  assert.ok(q.body.answer && q.body.answer.length > 10);
});

test('AI, analytics and risk work for a brand-new empty business', async () => {
  const r = await register();
  const o = api(r.body.accessToken);
  for (const p of ['/ai/brief', '/analytics/overview', '/analytics/sales?range=7d', '/inventory', '/risk/alerts', '/customers', '/ai/restock', '/employees']) {
    const x = await o.get(p);
    assert.equal(x.status, 200, `${p} → ${x.status} ${JSON.stringify(x.body).slice(0, 150)}`);
  }
});

test('audit log records the important actions with old and new values', async () => {
  const o = api(A.owner.token);
  const p = (await o.post('/products', { name: uniq('Audited '), categoryId: A.categoryId, purchasePrice: 40, sellingPrice: 50, stock: 5 })).body;
  await o.put(`/products/${p.id}`, { sellingPrice: 55 });
  const emp = await o.post('/employees', { name: 'Gone Soon', email: `${uniq('g')}@example.com`, password: 'Passw0rdOK', role: 'cashier' });
  await o.del(`/employees/${emp.body.id}`);
  await o.put('/settings', { invoiceFooter: 'Visit again!' });
  await o.del(`/products/${p.id}`);
  const rows = (await o.get('/audit?pageSize=100')).body.rows;
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['auth.login', 'product.created', 'product.price_changed', 'product.deleted', 'sale.created', 'employee.created', 'employee.removed', 'settings.changed', 'business.registered']) assert.ok(actions.has(a), `missing audit action ${a}`);
  const price = rows.find((r) => r.action === 'product.price_changed' && String(r.entityId) === String(p.id));
  assert.equal(price.oldValue.sellingPrice, 50);
  assert.equal(price.newValue.sellingPrice, 55);
  assert.match(price.summary, /₹50 to ₹55/);
});

test('changing a password signs out other sessions', async () => {
  const r = await register();
  const cookie = cookieOf(r);
  const ch = await api(r.body.accessToken).post('/auth/change-password', { currentPassword: 'Passw0rdOK', newPassword: 'NewPassw0rd1' });
  assert.equal(ch.status, 200);
  assert.equal((await api(null, { cookie, 'x-requested-with': 'sharkpos' }).post('/auth/refresh')).status, 401);
  assert.equal((await api().post('/auth/login', { email: r.body.user.email, password: 'NewPassw0rd1' })).status, 200);
});

test('errors are consistent JSON and never leak internals', async () => {
  const o = api(A.owner.token);
  const notFound = await o.get('/nope');
  assert.equal(notFound.status, 404);
  assert.ok(notFound.body.error);
  const bad = await o.get('/products/not-a-number');
  assert.equal(bad.status, 400);
  const raw = await fetch(`${env.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(raw.status, 400);
  const text = JSON.stringify(await raw.json());
  assert.ok(!/at .*\.js|node_modules|SELECT |stack/i.test(text));
  const sqlish = await o.get("/customers/search?q=' OR 1=1; DROP TABLE products;--");
  assert.equal(sqlish.status, 200);
  assert.equal((await o.get('/products')).status, 200);
  const h = await fetch(`${env.base}/health`);
  assert.equal(h.headers.get('x-powered-by'), null);
  assert.ok(h.headers.get('x-content-type-options'));
});
