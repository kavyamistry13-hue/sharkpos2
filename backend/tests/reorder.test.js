// Phase 9 — reorder levels, max stock and suggested reorder quantity (recommendation only), plus the inventory overview totals.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct, sell } = require('./sprint-helpers');

let env; let api; let A; let B;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });
const as = (s, who = 'owner') => api(s[who].token);
const j = (r) => JSON.stringify(r.body ?? {});
const reorder = async (s) => (await as(s).get('/inventory/reorder')).body;

test('min 10, reorder 12, max 50, stock 8 → suggests 42; recommendation only (no purchase order or restock order is created)', async () => {
  const p = await addProduct(api, A, { stock: 8, minimumStock: 10, reorderLevel: 12, maxStock: 50 });
  const r = await reorder(A);
  const row = r.rows.find((x) => x.id === p.id);
  assert.ok(row, j({ r })); assert.equal(row.suggestedReorderQty, 42); assert.equal(row.reorderTrigger, 12);
  assert.match(r.message, /^\d+ products? need restocking$/); assert.equal(r.count, r.rows.length);
  assert.equal((await as(A).get('/purchase-orders')).body.rows.length, 0, 'no PO auto-created');
  assert.equal((await as(A).get('/inventory/restock-orders')).body.rows.length, 0, 'no restock order auto-created');
});

test('a product above its reorder level is not listed; without a reorder level the minimum stock is the trigger; without max stock the engine suggestion is used', async () => {
  const fine = await addProduct(api, A, { stock: 13, minimumStock: 10, reorderLevel: 12, maxStock: 50 });
  const onMin = await addProduct(api, A, { stock: 4, minimumStock: 5 });
  const none = await addProduct(api, A, { stock: 0, minimumStock: 0 });
  const r = await reorder(A);
  assert.ok(!r.rows.some((x) => x.id === fine.id)); assert.ok(!r.rows.some((x) => x.id === none.id), 'no minimum set → never flagged');
  const m = r.rows.find((x) => x.id === onMin.id); assert.ok(m); assert.equal(m.maxStock, null); assert.ok(m.suggestedReorderQty > 0);
  const inv = (await as(A).get('/inventory')).body;
  assert.equal(inv.summary.needReorder, (await reorder(A)).count);
});

test('selling stock down past the reorder level makes the product appear', async () => {
  const p = await addProduct(api, A, { stock: 15, minimumStock: 5, reorderLevel: 10, maxStock: 40 });
  assert.ok(!(await reorder(A)).rows.some((x) => x.id === p.id));
  await sell(api, A, p.id, { quantity: 6 });
  const row = (await reorder(A)).rows.find((x) => x.id === p.id);
  assert.equal(row.stock, 9); assert.equal(row.suggestedReorderQty, 31);
});

test('validation: max ≥ min, reorder ≤ max, whole numbers for counted units; settable on update; cashier cannot read the list', async () => {
  const c = (b) => as(A).post('/products', { name: `V${Math.random()}`, categoryId: A.category.id, purchasePrice: 1, sellingPrice: 2, stock: 1, ...b });
  assert.equal((await c({ minimumStock: 10, maxStock: 5 })).status, 400);
  assert.equal((await c({ minimumStock: 1, maxStock: 10, reorderLevel: 11 })).status, 400);
  assert.equal((await c({ minimumStock: 1, maxStock: 10.5 })).status, 400);
  const p = await addProduct(api, A, { stock: 3, minimumStock: 2 });
  const u = await as(A).put(`/products/${p.id}`, { maxStock: 30, reorderLevel: 6 });
  assert.equal(u.status, 200, j(u)); assert.equal(u.body.maxStock, 30); assert.equal(u.body.reorderLevel, 6);
  assert.equal((await as(A).put(`/products/${p.id}`, { maxStock: 1 })).status, 400, 'below minimum');
  assert.equal((await as(A).put(`/products/${p.id}`, { maxStock: null, reorderLevel: null })).status, 200);
  assert.equal((await as(A, 'cashier').get('/inventory/reorder')).status, 403);
});

test('tenant isolation: another shop never sees this shop\'s reorder list', async () => {
  const p = await addProduct(api, A, { stock: 1, minimumStock: 5, maxStock: 20 });
  assert.ok((await reorder(A)).rows.some((x) => x.id === p.id));
  assert.ok(!(await reorder(B)).rows.some((x) => x.id === p.id));
});

test('overview: cost value, selling value and last-7-day sold / purchased units come from the movement ledger', async () => {
  const p = await addProduct(api, B, { stock: 10, purchasePrice: 20, sellingPrice: 30 });
  await sell(api, B, p.id, { quantity: 3 });
  const s = (await as(B).get('/inventory')).body.summary;
  assert.equal(s.costValue, s.stockValue); assert.equal(s.sellingValue, 7 * 30);
  assert.equal(s.last7Days.soldUnits, 3); assert.ok(s.last7Days.productsChanged >= 1);
});
