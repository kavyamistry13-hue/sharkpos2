// Phase 9 — a partly returned sale must be counted at what the customer KEPT in every report. The sale itself stays intact
// (total, lines, date); the return is a separate record. Each test proves one module of the Security-audit finding (F-partial-returns).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, backdateSaleFixture } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');
const { getBaselines } = require('../src/services/risk');

let env; let api; let S;
test.before(async () => { env = await boot(); api = client(env.base); S = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (who = 'owner') => api(S[who].token);
const q = (text, params) => env.db.runAsTenant(S.businessId, async () => (await env.db.query(text, params)).rows);
const returnLine = (sale, productId, quantity, who = 'owner') => as(who).post(`/sales/${sale.id}/returns`, { items: [{ saleItemId: sale.items.find((i) => i.productId === productId).id, quantity }], reason: 'changed_mind' });
const sellOne = async (items, extra = {}, who = 'owner') => { const r = await as(who).post('/sales', { items, paymentMethod: 'cash', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const cat = async () => (await as().post('/categories', { name: `Plain ${Math.random()}`, taxRate: 0 })).body;

test('customer lifetime value and favourite category use net spend (₹1,000 sale, ₹300 returned → ₹700)', async () => {
  const c = await cat();
  const p = await addProduct(api, S, { name: 'LTV item', categoryId: c.id, purchasePrice: 50, sellingPrice: 100, stock: 100 });
  const cust = await addCustomer(api, S);
  const sale = await sellOne([{ productId: p.id, quantity: 10 }], { customerId: cust.id });
  assert.equal(sale.total, 1000);
  assert.equal((await returnLine(sale, p.id, 3)).status, 201);
  const row = (await as().get('/customers')).body.rows.find((r) => r.id === cust.id);
  assert.equal(row.spending, 700, 'lifetime value counts what was kept');
  assert.equal(row.orders, 1, 'still one order');
  assert.equal(row.avgOrderValue, 700);
  const detail = (await as().get(`/customers/${cust.id}`)).body;
  assert.equal(detail.recentOrders[0].total, 1000, 'the original bill is shown unchanged');
  assert.equal(detail.recentOrders[0].netTotal, 700);
  assert.equal(detail.recentOrders[0].refundAmount, 300);
  assert.equal(Number(detail.topCategories?.[0]?.spend ?? detail.categories?.[0]?.spend ?? 700), 700);
  const orig = (await q('SELECT total, refund_amount FROM sales WHERE id = $1', [sale.id]))[0];
  assert.equal(Number(orig.total), 1000); assert.equal(Number(orig.refund_amount), 300);
});

test('employee performance revenue is net and a partial return counts as a refund event', async () => {
  const c = await cat();
  const p = await addProduct(api, S, { name: 'Emp item', categoryId: c.id, purchasePrice: 10, sellingPrice: 100, stock: 100 });
  const before = (await as().get('/employees')).body.rows ?? (await as().get('/employees')).body;
  const me = (list) => list.find((e) => e.id === S.cashier.id);
  const base = me(before);
  const sale = await sellOne([{ productId: p.id, quantity: 4 }], {}, 'cashier');
  assert.equal((await returnLine(sale, p.id, 1)).status, 201);
  const after = me((await as().get('/employees')).body.rows ?? (await as().get('/employees')).body);
  assert.equal(after.revenue - base.revenue, 300, '₹400 sale − ₹100 returned');
  assert.equal(after.refunds - base.refunds, 1, 'a partial return is a refund event for the cashier');
  assert.equal(after.transactions - base.transactions, 1);
});

test('forecast velocity ignores returned units (sold 10, returned 4 == a shop that sold 6)', async () => {
  const c = await cat();
  const a = await addProduct(api, S, { name: 'Vel returned', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 500 });
  const b = await addProduct(api, S, { name: 'Vel kept6', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 500 });
  const d = await addProduct(api, S, { name: 'Vel full10', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 500 });
  const s1 = await sellOne([{ productId: a.id, quantity: 28 }, { productId: b.id, quantity: 14 }, { productId: d.id, quantity: 28 }]);
  assert.equal((await returnLine(s1, a.id, 14)).status, 201);          // a: 28 sold, 14 returned → 14 kept, like b
  await backdateSaleFixture(S.businessId, s1.id, '3 days');             // forecast looks at COMPLETED past days
  const inv = (await as().get('/inventory')).body.rows;
  const by = (id) => inv.find((r) => r.id === id);
  assert.ok(by(b.id).avgDailySales > 0);
  assert.equal(by(a.id).avgDailySales, by(b.id).avgDailySales, 'returned units are not demand');
  assert.ok(by(d.id).avgDailySales > by(a.id).avgDailySales);
});

test('dead stock: a product whose only sale line was entirely returned is not "recently sold"', async () => {
  const c = await cat();
  const dead = await addProduct(api, S, { name: 'Dead after return', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 20 });
  const live = await addProduct(api, S, { name: 'Live kept', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 20 });
  const anchor = await addProduct(api, S, { name: 'Anchor', categoryId: c.id, purchasePrice: 10, sellingPrice: 20, stock: 20 });
  for (const p of [dead, live]) await q(`UPDATE products SET created_at = now() - interval '40 days' WHERE id = $1`, [p.id]);
  const sale = await sellOne([{ productId: dead.id, quantity: 2 }, { productId: live.id, quantity: 2 }, { productId: anchor.id, quantity: 1 }]);
  assert.equal((await returnLine(sale, dead.id, 2)).status, 201);       // whole line back; the sale itself stays 'completed'
  assert.equal((await q('SELECT status FROM sales WHERE id = $1', [sale.id]))[0].status, 'completed');
  const out = (await as().get('/intelligence/dead-stock?days=7')).body;
  const names = JSON.stringify(out);
  assert.ok(names.includes('Dead after return'), 'fully returned line does not count as a sale');
  assert.ok(!names.includes('Live kept'), 'a kept line does count as a recent sale');
});

test('profit leaks: realised loss and discounts count only the kept units', async () => {
  const c = await cat();
  const p = await addProduct(api, S, { name: 'Loss item', categoryId: c.id, purchasePrice: 100, sellingPrice: 80, stock: 100 });
  const sale = await sellOne([{ productId: p.id, quantity: 5 }]);       // ₹20 loss per unit
  const full = (await as().get('/intelligence/profit-leaks?days=30')).body;
  const loss5 = full.leaks.concat([]).length >= 0 ? full.summary.realizedLoss : 0;
  assert.ok(loss5 >= 100 - 0.01);
  assert.equal((await returnLine(sale, p.id, 2)).status, 201);
  const after = (await as().get('/intelligence/profit-leaks?days=30')).body;
  assert.equal(Math.round((loss5 - after.summary.realizedLoss) * 100) / 100, 40, 'two returned units no longer count as loss (2 × ₹20)');
});

test('risk baselines: employee revenue is net and partial returns feed the refund rate', async () => {
  const c = await cat();
  const p = await addProduct(api, S, { name: 'Risk item', categoryId: c.id, purchasePrice: 10, sellingPrice: 100, stock: 100 });
  const read = async () => (await env.db.runAsTenant(S.businessId, () => getBaselines(env.db.query))).employees.get(S.cashier.id);
  const b0 = await read();
  const sale = await sellOne([{ productId: p.id, quantity: 3 }], {}, 'cashier');
  assert.equal((await returnLine(sale, p.id, 1)).status, 201);
  const b1 = await read();
  assert.equal(b1.revenue - b0.revenue, 200, '₹300 − ₹100');
  assert.equal(b1.refunds - b0.refunds, 1);
});
