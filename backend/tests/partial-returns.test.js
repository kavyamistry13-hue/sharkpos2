// Sprint 7 — line-level partial returns: caps, tax, refund methods, restock, credit, reports, idempotency, roles, tenant isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot, client } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');
const { allocateProportionally } = require('../src/services/returns');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const stockOf = async (s, p) => (await as(s).get(`/products/${p.id}`)).body.stock;
const key = () => crypto.randomUUID();

async function shop(taxRate = 0, price = 100) {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Cat', taxRate })).body;
  s.cat = cat;
  s.p = await addProduct(api, s, { name: 'Widget', categoryId: cat.id, purchasePrice: 40, sellingPrice: price, stock: 100 });
  s.q = await addProduct(api, s, { name: 'Gadget', categoryId: cat.id, purchasePrice: 10, sellingPrice: 50, stock: 100 });
  return s;
}
const lineOf = (sale, p) => sale.items.find((i) => i.productId === p.id);
const ret = (s, sale, items, extra = {}, who = 'owner') => as(s, who).post(`/sales/${sale.id}/returns`, { items, reason: 'changed_mind', ...extra });

test('allocateProportionally: exact, deterministic, never over a method\'s capacity', () => {
  assert.deepEqual(allocateProportionally(500, { cash: 400, upi: 600 }), { cash: 200, upi: 300 });
  assert.deepEqual(allocateProportionally(1, { cash: 1, upi: 1 }).cash + allocateProportionally(1, { cash: 1, upi: 1 }).upi, 1);
  assert.deepEqual(allocateProportionally(100, { cash: 0, upi: 100 }), { upi: 100 });
  assert.equal(allocateProportionally(101, { cash: 50, upi: 50 }), null, 'cannot refund more than was paid');
  const x = allocateProportionally(1001, { cash: 333, upi: 333, card: 335 });
  assert.equal(Object.values(x).reduce((a, b) => a + b, 0), 1001);
  assert.ok(x.cash <= 333 && x.upi <= 333 && x.card <= 335);
});

test('partial return: 1 of 3 units — exact refund incl. tax, stock back, sale stays completed, original lines untouched', async () => {
  const s = await shop(5, 100);                               // ₹100 + 5% = ₹105 per unit
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 3 }], paymentMethod: 'cash' })).body;
  assert.equal(sale.total, 315);
  const r = await ret(s, sale, [{ saleItemId: lineOf(sale, s.p).id, quantity: 1 }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.return.total, 105);
  assert.equal(r.body.return.tax, 5);
  assert.equal(r.body.return.taxable, 100);
  assert.deepEqual(r.body.return.refunds, [{ method: 'cash', amount: 105 }]);
  assert.equal(await stockOf(s, s.p), 98, "100 − 3 sold + 1 returned");
  const after = r.body.sale;
  assert.equal(after.status, 'completed');
  assert.equal(after.total, 315, 'the sale total is never rewritten');
  assert.equal(after.refundAmount, 105);
  assert.equal(lineOf(after, s.p).quantity, 3);
  assert.equal(lineOf(after, s.p).returnedQty, 1);
  assert.equal(lineOf(after, s.p).returnableQty, 2);
  assert.equal(after.returns.length, 1);
  const mv = await sql(s, `SELECT quantity FROM inventory_movements WHERE movement_type = 'refund' AND product_id = $1`, [s.p.id]);
  assert.deepEqual(mv.map((m) => m.quantity), [1]);
});

test('partial return: cannot exceed what was sold; returning the rest completes the sale and the refunds add up to the bill exactly', async () => {
  const s = await shop(18, 33.33);                             // awkward numbers on purpose
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 3 }, { productId: s.q.id, quantity: 2 }], discount: { type: 'amount', value: 7 }, paymentMethod: 'upi' })).body;
  const L = lineOf(sale, s.p); const M = lineOf(sale, s.q);
  const tooMany = await ret(s, sale, [{ saleItemId: L.id, quantity: 4 }]);
  assert.equal(tooMany.status, 409); assert.equal(tooMany.body.details.code, 'RETURN_EXCEEDS_SOLD'); assert.equal(tooMany.body.details.returnable, 3);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 2 }])).status, 201);
  const over = await ret(s, sale, [{ saleItemId: L.id, quantity: 2 }]);
  assert.equal(over.status, 409, 'only 1 left on that line');
  assert.equal(over.body.details.returnable, 1);
  const rest = await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }, { saleItemId: M.id, quantity: 2 }]);
  assert.equal(rest.status, 201, JSON.stringify(rest.body));
  assert.equal(rest.body.return.completesSale, true);
  assert.equal(rest.body.sale.status, 'refunded');
  assert.equal(rest.body.sale.refundAmount, sale.total, 'cumulative refunds == bill to the paisa');
  const sum = rest.body.sale.returns.reduce((a, x) => a + Math.round(x.total * 100), 0);
  assert.equal(sum, Math.round(sale.total * 100));
  assert.equal(await stockOf(s, s.p), 100); assert.equal(await stockOf(s, s.q), 100);
  const again = await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }]);
  assert.equal(again.status, 409); assert.equal(again.body.details.code, 'SALE_NOT_RETURNABLE');
});

test('partial return: tax-inclusive price — the tax part of the refund is pro-rated and sums back to the line tax', async () => {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Inc', taxRate: 12 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, purchasePrice: 50, sellingPrice: 112, stock: 20, priceIncludesTax: true });
  const sale = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'cash' })).body;
  assert.equal(sale.total, 336);
  const L = lineOf(sale, p);
  const r1 = (await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }])).body.return;
  const r2 = (await ret(s, sale, [{ saleItemId: L.id, quantity: 2 }])).body.return;
  assert.equal(r1.total, 112); assert.equal(r2.total, 224);
  assert.equal(Math.round((r1.tax + r2.tax) * 100), Math.round(sale.tax * 100), 'returned tax == tax charged');
  assert.equal(Math.round((r1.taxable + r2.taxable) * 100), Math.round((sale.total - sale.tax) * 100));
});

test('partial return: refund goes back by the methods that paid (split bill) — proportional by default, explicit lines allowed within what each paid', async () => {
  const s = await shop(0, 500);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] })).body;
  const L = lineOf(sale, s.p);
  const a = (await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }])).body.return;      // ₹500 → 200 cash + 300 upi
  assert.deepEqual(Object.fromEntries(a.refunds.map((x) => [x.method, x.amount])), { cash: 200, upi: 300 });
  // explicit: the rest (₹500) all to UPI is NOT allowed — upi only paid 600, 300 already went back → 300 left
  const bad = await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { refunds: [{ method: 'upi', amount: 500 }] });
  assert.equal(bad.status, 400); assert.equal(bad.body.details.code, 'REFUND_METHOD_EXCEEDS_PAID'); assert.equal(bad.body.details.available, 300);
  const mismatch = await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { refunds: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 300 }] });
  assert.equal(mismatch.status, 400); assert.equal(mismatch.body.details.code, 'REFUND_SPLIT_MISMATCH');
  const ok = await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { refunds: [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 300 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.sale.status, 'refunded');
  const byMethod = await sql(s, `SELECT method, SUM(amount)::float AS amount FROM sale_return_refunds GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(byMethod, [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }], 'in total each method gets back exactly what it paid');
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { refunds: [{ method: 'cash', amount: 500.001 }] })).status, 409, 'refunded already');
});

test('partial return on a credit (udhaar) bill reduces what the customer owes by the credit share', async () => {
  const s = await shop(0, 500);
  const c = await addCustomer(api, s);
  await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: 5000 });
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], customerId: c.id, payments: [{ method: 'cash', amount: 600 }, { method: 'credit', amount: 400 }] })).body;
  assert.equal((await as(s).get(`/credit/customers/${c.id}/balance`)).body.balance, 400);
  const L = lineOf(sale, s.p);
  const r1 = (await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }])).body.return;      // 500 → 300 cash + 200 credit
  assert.deepEqual(Object.fromEntries(r1.refunds.map((x) => [x.method, x.amount])), { cash: 300, credit: 200 });
  assert.equal((await as(s).get(`/credit/customers/${c.id}/balance`)).body.balance, 200);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }])).status, 201);
  assert.equal((await as(s).get(`/credit/customers/${c.id}/balance`)).body.balance, 0, 'never negative, never double-reversed');
  // single credit sale returned in two steps
  const s2 = await shop(0, 100);
  const c2 = await addCustomer(api, s2); await as(s2, 'manager').put(`/credit/customers/${c2.id}/limit`, { creditLimit: 5000 });
  const sale2 = (await as(s2).post('/sales', { items: [{ productId: s2.p.id, quantity: 4 }], customerId: c2.id, paymentMethod: 'credit' })).body;
  await ret(s2, sale2, [{ saleItemId: lineOf(sale2, s2.p).id, quantity: 1 }]);
  assert.equal((await as(s2).get(`/credit/customers/${c2.id}/balance`)).body.balance, 300);
});

test('partial return: restock rules — damaged/expired are not put back by default; an explicit restock flag overrides', async () => {
  const s = await shop(0, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 4 }], paymentMethod: 'cash' })).body;
  const L = lineOf(sale, s.p);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { reason: 'damaged' })).status, 201);
  assert.equal(await stockOf(s, s.p), 96, 'damaged goods do not go back on the shelf');
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1, restock: true }], { reason: 'damaged' })).status, 201);
  assert.equal(await stockOf(s, s.p), 97);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1, restock: false }], { reason: 'changed_mind' })).status, 201);
  assert.equal(await stockOf(s, s.p), 97);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 1 }], { reason: 'wrong_item' })).status, 201);
  assert.equal(await stockOf(s, s.p), 98);
  const flags = await sql(s, `SELECT restocked FROM sale_return_items ORDER BY id`);
  assert.deepEqual(flags.map((f) => f.restocked), [false, true, false, true]);
});

test('partial return feeds closing, shift cash, analytics and profit consistently (and the original sale day is not rewritten)', async () => {
  const s = await shop(0, 100);                            // cost 40, margin 60 per unit
  await as(s, 'cashier').post('/shifts/open', { openingCash: 200 });
  const sale = (await as(s, 'cashier').post('/sales', { items: [{ productId: s.p.id, quantity: 5 }], paymentMethod: 'cash' })).body;   // 500
  const before = (await as(s).get('/reports/closing')).body;
  assert.equal(before.sales.billedTotal, 500); assert.equal(before.sales.grossProfit, 300);
  const L = lineOf(sale, s.p);
  assert.equal((await ret(s, sale, [{ saleItemId: L.id, quantity: 2 }], {}, 'cashier')).status, 201);   // cashier returns own bill: ₹200 cash out
  const rep = (await as(s).get('/reports/closing')).body;
  assert.equal(rep.sales.billedTotal, 500, 'billed is what was rung up');
  assert.equal(rep.sales.refunds, 200);
  assert.equal(rep.sales.refundCount, 1);
  assert.equal(rep.sales.netSales, 300);
  assert.equal(rep.sales.grossProfit, 180, '3 units kept × ₹60');
  assert.equal(rep.sales.unitsSold, 3);
  const live = (await as(s, 'cashier').get('/shifts/current')).body.shift;
  assert.equal(live.expectedCash, 200 + 500 - 200, 'opening + cash sales − cash refunds');
  const ov = (await as(s).get('/analytics/overview')).body;
  const rev = JSON.stringify(ov);
  assert.ok(rev.includes('300'), 'overview revenue is net of the returned goods');
  const rows = await sql(s, `SELECT status, total::float AS total, refund_amount::float AS refund FROM sales`);
  assert.deepEqual(rows, [{ status: 'completed', total: 500, refund: 200 }]);
});

test('partial return is idempotent: same key replays, different body with the same key is refused, key is required', async () => {
  const s = await shop(0, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 4 }], paymentMethod: 'cash' })).body;
  const L = lineOf(sale, s.p);
  const k = key();
  const body = { items: [{ saleItemId: L.id, quantity: 2 }], reason: 'changed_mind' };
  const a = await as(s).post(`/sales/${sale.id}/returns`, body, { 'idempotency-key': k });
  const b = await as(s).post(`/sales/${sale.id}/returns`, body, { 'idempotency-key': k });
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(b.body.return.id, a.body.return.id);
  assert.equal(await stockOf(s, s.p), 98, 'restocked once');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sale_returns`))[0].n, 1);
  const other = await as(s).post(`/sales/${sale.id}/returns`, { ...body, items: [{ saleItemId: L.id, quantity: 1 }] }, { 'idempotency-key': k });
  assert.equal(other.status, 422);
  // missing / malformed key
  const raw = await fetch(`${env.base}/sales/${sale.id}/returns`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.owner.token}` }, body: JSON.stringify(body) });
  assert.equal(raw.status, 400);
  const bad = await as(s).post(`/sales/${sale.id}/returns`, body, { 'idempotency-key': 'nope' });
  assert.equal(bad.status, 400);
});

test('partial return: concurrent returns on the same line cannot exceed the sold quantity', async () => {
  const s = await shop(0, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 3 }], paymentMethod: 'cash' })).body;
  const L = lineOf(sale, s.p);
  const res = await Promise.all([1, 2, 3].map(() => ret(s, sale, [{ saleItemId: L.id, quantity: 2 }])));
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(await stockOf(s, s.p), 99);
  assert.equal((await sql(s, `SELECT returned_qty::float AS q FROM sale_items`))[0].q, 2);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sale_returns`))[0].n, 1);
});

test('partial return: roles — cashier only on their own recent bills; manager/owner any; old bills need a manager', async () => {
  const s = await shop(0, 100);
  const mine = (await as(s, 'cashier').post('/sales', { items: [{ productId: s.p.id, quantity: 4 }], paymentMethod: 'cash' })).body;
  const owners = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 4 }], paymentMethod: 'cash' })).body;
  assert.equal((await ret(s, mine, [{ saleItemId: lineOf(mine, s.p).id, quantity: 1 }], {}, 'cashier')).status, 201);
  assert.equal((await ret(s, owners, [{ saleItemId: lineOf(owners, s.p).id, quantity: 1 }], {}, 'cashier')).status, 404, "a cashier cannot see or return someone else's bill");
  await sql(s, `UPDATE sales SET created_at = now() - interval '30 hours' WHERE id = $1`, [mine.id]);
  const old = await ret(s, mine, [{ saleItemId: lineOf(mine, s.p).id, quantity: 1 }], {}, 'cashier');
  assert.equal(old.status, 403);
  assert.equal((await ret(s, mine, [{ saleItemId: lineOf(mine, s.p).id, quantity: 1 }], {}, 'manager')).status, 201);
  assert.equal((await ret(s, owners, [{ saleItemId: lineOf(owners, s.p).id, quantity: 1 }], {}, 'owner')).status, 201);
  assert.equal((await api().post(`/sales/${mine.id}/returns`, { items: [{ saleItemId: 1, quantity: 1 }] })).status, 401);
  // the legacy "refund whole bill" button stays owner/manager only
  assert.equal((await as(s, 'cashier').post(`/sales/${mine.id}/refund`)).status, 403);
  const audits = await sql(s, `SELECT action FROM audit_logs WHERE action = 'sale.returned'`);
  assert.equal(audits.length, 3, 'every successful return is audited');
});

test('partial return: tenant isolation and line ownership', async () => {
  const s = await shop(0, 100); const t = await shop(0, 100);
  const a = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], paymentMethod: 'cash' })).body;
  const b = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], paymentMethod: 'cash' })).body;
  assert.equal((await ret(t, a, [{ saleItemId: lineOf(a, s.p).id, quantity: 1 }])).status, 404, "another business cannot return this business's sale");
  const cross = await ret(s, a, [{ saleItemId: lineOf(b, s.p).id, quantity: 1 }]);
  assert.equal(cross.status, 400); assert.equal(cross.body.details.code, 'LINE_NOT_IN_SALE');
  assert.equal((await sql(t, `SELECT COUNT(*)::int AS n FROM sale_returns`))[0].n, 0);
  assert.equal(await stockOf(s, s.p), 96, 'nothing moved');
});

test('partial return: validation', async () => {
  const s = await shop(0, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], paymentMethod: 'cash' })).body;
  const id = lineOf(sale, s.p).id;
  for (const body of [{ items: [] }, { items: [{ saleItemId: id, quantity: 0 }] }, { items: [{ saleItemId: id, quantity: -1 }] }, { items: [{ saleItemId: id, quantity: 1.5 }] }, { items: [{ saleItemId: id, quantity: 1 }], reason: 'because' }, { items: [{ saleItemId: 'x', quantity: 1 }] }, { items: [{ saleItemId: id, quantity: 1 }], note: 'x'.repeat(301) }]) {
    assert.equal((await as(s).post(`/sales/${sale.id}/returns`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await as(s).post('/sales/99999999/returns', { items: [{ saleItemId: id, quantity: 1 }] })).status, 404);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sale_returns`))[0].n, 0);
});

test('legacy full refund endpoint still works and is now a return record too; old refunded sales were backfilled-compatible', async () => {
  const s = await shop(5, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }, { productId: s.q.id, quantity: 1 }], paymentMethod: 'upi' })).body;
  const r = await as(s).post(`/sales/${sale.id}/refund`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'refunded'); assert.equal(r.body.refundAmount, sale.total);
  assert.equal(await stockOf(s, s.p), 100); assert.equal(await stockOf(s, s.q), 100);
  assert.equal(r.body.returns.length, 1);
  assert.equal(r.body.returns[0].completesSale, true);
  assert.deepEqual(r.body.returns[0].refunds, [{ method: 'upi', amount: sale.total }]);
  assert.equal((await as(s).post(`/sales/${sale.id}/refund`)).status, 409, 'cannot refund twice');
  // partial first, then "refund the rest"
  const s2 = await shop(0, 100);
  const sale2 = (await as(s2).post('/sales', { items: [{ productId: s2.p.id, quantity: 3 }], paymentMethod: 'cash' })).body;
  await ret(s2, sale2, [{ saleItemId: lineOf(sale2, s2.p).id, quantity: 1 }]);
  const rest = await as(s2).post(`/sales/${sale2.id}/refund`);
  assert.equal(rest.status, 200); assert.equal(rest.body.refundAmount, 300);
  assert.equal(await stockOf(s2, s2.p), 100);
});

test('return records are append-only and tenant-scoped at the database level', async () => {
  const s = await shop(0, 100);
  const sale = (await as(s).post('/sales', { items: [{ productId: s.p.id, quantity: 2 }], paymentMethod: 'cash' })).body;
  await ret(s, sale, [{ saleItemId: lineOf(sale, s.p).id, quantity: 1 }]);
  await env.db.runAsTenant(s.businessId, async () => {
    for (const t of ['sale_returns', 'sale_return_items', 'sale_return_refunds', 'sale_payments']) {
      await assert.rejects(env.db.query(`UPDATE ${t} SET business_id = business_id`), /permission denied/, `${t} is append-only`);
      assert.equal((await env.db.query(`DELETE FROM ${t}`)).rowCount, 0, `a real business cannot delete ${t} rows`);
    }
    await assert.rejects(env.db.query(`UPDATE sale_items SET returned_qty = quantity + 1`), /check/i, 'returned can never exceed sold');
    await assert.rejects(env.db.query(`UPDATE sales SET refund_amount = total + 1`), /check/i, 'refunded can never exceed the bill');
  });
});
