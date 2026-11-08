// Sprint 6–7: Owner Today (composes the Action Center, Store Health, closing maths) and the whole counter journey at API level:
// LOGIN → OWNER TODAY → CASHIER (shift) → CREATE SALE → HOLD → RESUME → SPLIT PAYMENT → COMPLETE → PARTIAL RETURN → INVENTORY / SHIFT / REPORT UPDATE.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');

let env; let api;
test.before(async () => { env = await boot(); api = client(env.base); });
test.after(async () => { await env.close(); });
const as = (s, who = 'owner') => api(s[who].token);
const stockOf = async (s, p) => (await as(s).get(`/products/${p.id}`)).body.stock;

test('owner today: owner/manager only; shape, honest labels, and it reuses the Action Center instead of making its own', async () => {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Plain', taxRate: 0 })).body;
  const out = await addProduct(api, s, { name: 'Almost gone', categoryId: cat.id, purchasePrice: 10, sellingPrice: 20, stock: 0, minimumStock: 5 });
  assert.equal((await api().get('/intelligence/owner-today')).status, 401);
  assert.equal((await as(s, 'cashier').get('/intelligence/owner-today')).status, 403, 'owner-only functions are not available to a cashier');
  assert.equal((await as(s, 'manager').get('/intelligence/owner-today')).status, 200);
  const r = (await as(s).get('/intelligence/owner-today')).body;
  assert.deepEqual(Object.keys(r.kinds).sort(), ['actual', 'estimated', 'forecast', 'recommendation']);
  assert.deepEqual(r.needsAttention.map((x) => x.key), ['critical_stock', 'expiring', 'credit', 'unusual', 'suppliers', 'cash']);
  assert.equal(r.business.grossProfit.kind, 'estimated');
  assert.equal(r.business.sales.kind, 'actual');
  assert.equal(r.forecast.kind, 'forecast');
  assert.equal(r.recommendations.kind, 'recommendation');
  const ac = (await as(s).get('/intelligence/today?top=5')).body;
  assert.deepEqual(r.recommendations.actions.map((a) => a.id), ac.actions.map((a) => a.id), 'the SAME ranked Action Center list, not a second engine');
  const crit = r.needsAttention.find((x) => x.key === 'critical_stock');
  assert.ok(crit.count >= 1, 'out-of-stock product is surfaced');
  assert.ok(r.recommendations.actions.every((a) => a.title && a.severity && a.route !== undefined));
  assert.ok(out.id);
  // asking Owner Today records the recommendations as "seen" like the Action Center does (measurement), once per item
  const seen = await env.db.runAsTenant(s.businessId, async () => (await env.db.query(`SELECT COUNT(*)::int AS n FROM recommendation_log`)).rows[0].n);
  assert.ok(seen >= 1);
});

test('owner today: tenant isolation, and the figures equal the closing report', async () => {
  const s = await makeShop(api); const t = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Plain', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, purchasePrice: 40, sellingPrice: 100, stock: 50 });
  const c = await addCustomer(api, s);
  await as(s).post('/sales', { items: [{ productId: p.id, quantity: 2 }], paymentMethod: 'upi', customerId: c.id });
  await as(s).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
  const r = (await as(s).get('/intelligence/owner-today')).body;
  const rep = (await as(s).get('/reports/closing')).body;
  assert.equal(r.business.sales.value, rep.sales.netSales);
  assert.equal(r.business.bills.value, 2);
  assert.equal(r.business.grossProfit.value, rep.sales.grossProfit);
  assert.equal(r.business.customers.known, 1); assert.equal(r.business.customers.walkIn, 1);
  assert.deepEqual(Object.fromEntries(r.business.payments.map((x) => [x.method, x.amount])), { upi: 200, cash: 100 });
  const other = (await as(t).get('/intelligence/owner-today')).body;
  assert.equal(other.business.bills.value, 0, 'another business sees none of it');
  assert.equal(other.business.payments.length, 0);
});

test('owner today: unusual cash counts and udhaar show up under "needs attention"', async () => {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Plain', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, purchasePrice: 40, sellingPrice: 100, stock: 50 });
  const c = await addCustomer(api, s); await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: 1000 });
  await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'credit', customerId: c.id });
  await as(s, 'cashier').post('/shifts/open', { openingCash: 100 });
  await as(s, 'cashier').post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
  const close = await as(s, 'cashier').post('/shifts/close', { countedCash: 150, notes: 'short by 50' });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  const r = (await as(s).get('/intelligence/owner-today')).body;
  const credit = r.needsAttention.find((x) => x.key === 'credit');
  assert.equal(credit.amount, 300); assert.equal(credit.count, 1);
  const cash = r.needsAttention.find((x) => x.key === 'cash');
  assert.equal(cash.count, 1); assert.match(cash.detail, /short ₹50/);
});

test('JOURNEY: login → owner today → cashier → sale → hold → resume → split → complete → partial return → inventory, shift, closing and Owner Today agree', async () => {
  // LOGIN
  const reg = await api().post('/auth/register', { businessName: 'Journey Mart', ownerName: 'Owner J', email: `journey${Date.now()}@example.com`, phone: '9876500001', password: 'Passw0rdOK' });
  assert.equal(reg.status, 201);
  const s = { owner: { token: reg.body.accessToken, id: reg.body.user.id }, businessId: reg.body.business.id };
  const cEmail = `jc${Date.now()}@example.com`;
  const emp = await as(s).post('/employees', { name: 'Counter Cashier', email: cEmail, password: 'Passw0rdOK', role: 'cashier' });
  assert.equal(emp.status, 201);
  const cl = await api().post('/auth/login', { email: cEmail, password: 'Passw0rdOK' });
  assert.equal(cl.status, 200); s.cashier = { token: cl.body.accessToken, id: emp.body.id };
  const cat = (await as(s).post('/categories', { name: 'Grocery', taxRate: 5 })).body;
  s.category = cat;
  const rice = await addProduct(api, s, { name: 'Rice 5kg', categoryId: cat.id, purchasePrice: 200, sellingPrice: 300, stock: 40 });      // ₹315 incl 5%
  const dal = await addProduct(api, s, { name: 'Dal 1kg', categoryId: cat.id, purchasePrice: 80, sellingPrice: 100, stock: 40 });         // ₹105

  // OWNER TODAY (morning): nothing sold yet
  const morning = (await as(s).get('/intelligence/owner-today')).body;
  assert.equal(morning.business.bills.value, 0);

  // CASHIER MODE: open shift, create a normal sale first
  assert.equal((await as(s, 'cashier').post('/shifts/open', { openingCash: 500 })).status, 201);
  const s1 = await as(s, 'cashier').post('/sales', { items: [{ productId: dal.id, quantity: 1 }], paymentMethod: 'cash' });
  assert.equal(s1.status, 201); assert.equal(s1.body.total, 105);

  // HOLD a second customer's cart; stock and money are untouched
  const hold = (await as(s, 'cashier').post('/held-bills', { items: [{ productId: rice.id, quantity: 2 }, { productId: dal.id, quantity: 1 }], label: 'Sharma ji' })).body.hold;
  assert.equal(await stockOf(s, rice), 40);
  assert.equal((await as(s).get('/reports/closing')).body.sales.count, 1, 'a held bill is not a bill yet');

  // RESUME (pretend the screen was refreshed): still there, priced ₹735
  const resumed = (await as(s, 'cashier').post(`/held-bills/${hold.id}/resume`)).body;
  assert.equal(resumed.bill.total, 735); assert.equal(resumed.canComplete, true);

  // SPLIT PAYMENT and COMPLETE: cash 235 + UPI 500
  const done = await as(s, 'cashier').post(`/held-bills/${hold.id}/complete`, { payments: [{ method: 'cash', amount: 235 }, { method: 'upi', amount: 500 }] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.total, 735);
  assert.equal(await stockOf(s, rice), 38); assert.equal(await stockOf(s, dal), 38);

  // PARTIAL RETURN: one rice (₹315) goes back, refunded in proportion to what was paid
  const sale = done.body;
  const riceLine = sale.items.find((i) => i.productId === rice.id);
  const ret = await as(s, 'cashier').post(`/sales/${sale.id}/returns`, { items: [{ saleItemId: riceLine.id, quantity: 1 }], reason: 'changed_mind' });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal(ret.body.return.total, 315);
  const refunds = Object.fromEntries(ret.body.return.refunds.map((x) => [x.method, x.amount]));
  assert.equal(refunds.cash + refunds.upi, 315);
  assert.ok(refunds.cash > 0 && refunds.upi > 0);

  // INVENTORY
  assert.equal(await stockOf(s, rice), 39); assert.equal(await stockOf(s, dal), 38);
  // SHIFT: opening 500 + cash sales (105 + 235) − cash refund
  const live = (await as(s, 'cashier').get('/shifts/current')).body.shift;
  assert.equal(live.expectedCash, Math.round((500 + 105 + 235 - refunds.cash) * 100) / 100);
  // CLOSING REPORT
  const rep = (await as(s).get('/reports/closing')).body;
  assert.equal(rep.sales.count, 2);
  assert.equal(rep.sales.billedTotal, 840);
  assert.equal(rep.sales.refunds, 315);
  assert.equal(rep.sales.netSales, 525);
  assert.equal(rep.sales.unitsSold, 3, 'dal ×2, rice ×1');
  const methods = Object.fromEntries(rep.payments.map((p) => [p.method, p.amount]));
  assert.equal(methods.cash, 340); assert.equal(methods.upi, 500);
  // OWNER TODAY (evening) tells the same story
  const evening = (await as(s).get('/intelligence/owner-today')).body;
  assert.equal(evening.business.sales.value, 525);
  assert.equal(evening.business.bills.value, 2);
  assert.equal(evening.business.refunds.value, 315);
  // reports agree with analytics
  const an = (await as(s).get('/analytics/sales?range=today')).body;
  assert.equal(Object.values(an.payments).length, 2);
  // audit trail
  const actions = await env.db.runAsTenant(s.businessId, async () => (await env.db.query(`SELECT action FROM audit_logs WHERE action IN ('hold.created','hold.resumed','sale.created','sale.returned') ORDER BY id`)).rows.map((r) => r.action));
  assert.deepEqual(actions, ['sale.created', 'hold.created', 'hold.resumed', 'sale.created', 'sale.returned']);
  // end of day: cashier closes the shift with the right cash
  const closed = await as(s, 'cashier').post('/shifts/close', { countedCash: live.expectedCash });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.variance, 0);
});
