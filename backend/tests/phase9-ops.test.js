// Phase 9 — Owner Today action lines and supplier-intelligence additions, built on the existing engines.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let A;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); });
after(async () => { await env.close(); });
const as = (who = 'owner') => api(A[who].token);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('Owner Today lists products to restock, expired stock and purchases awaiting receiving — with the numbers from the books', async () => {
  const low = await addProduct(api, A, { stock: 3, minimumStock: 10, maxStock: 40 });
  const bt = await addProduct(api, A, { stock: 0, purchasePrice: 5 });
  await as().post(`/inventory/${bt.id}/batches`, { quantity: 4, batchNo: 'OLD', expiryDate: inDays(30) });
  await env.db.runAsTenant(A.businessId, () => env.db.query(`UPDATE stock_batches SET expiry_date = current_date - 2 WHERE batch_no = 'OLD'`));
  const sup = (await as().post('/suppliers', { name: uniq('S '), leadTimeDays: 3, paymentTermsDays: 15, minOrderValue: 0 })).body;
  const po = (await as().post('/purchase-orders', { supplierId: sup.id, items: [{ productId: low.id, quantity: 10, unitCost: 5 }] })).body;
  await as().post(`/purchase-orders/${po.id}/order`, {});
  const d = (await as().get('/intelligence/owner-today')).body;
  const k = Object.fromEntries(d.needsAttention.map((x) => [x.key, x]));
  assert.ok(k.restock.count >= 1); assert.match(k.restock.detail, /need restocking/); assert.ok(k.restock.items.some((t) => t.includes('suggested order')));
  assert.equal(k.expired.count, 1); assert.match(k.expired.detail, /₹20/); assert.equal(k.expired.severity, 'high');
  assert.equal(k.purchases.count, 1); assert.equal(k.restock.to, '/inventory?view=reorder');
  assert.equal((await as('cashier').get('/intelligence/owner-today')).status, 403);
});

test('supplier intelligence adds pending orders, last purchase, average unit cost and most-purchased product', async () => {
  const sup = (await as().post('/suppliers', { name: uniq('Intel '), leadTimeDays: 3, paymentTermsDays: 15, minOrderValue: 0 })).body;
  const p = await addProduct(api, A, { stock: 0, name: 'Intel Rice' }); const q = await addProduct(api, A, { stock: 0, name: 'Intel Dal' });
  const po = (await as().post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 10, unitCost: 20 }, { productId: q.id, quantity: 5, unitCost: 40 }] })).body;
  await as().post(`/purchase-orders/${po.id}/order`, {});
  await as().post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: po.items[0].id, quantity: 10 }] });
  const s = (await as().get('/intelligence/suppliers')).body.suppliers.find((x) => x.supplierId === sup.id);
  assert.ok(s, 'supplier appears'); assert.equal(s.pendingOrders, 1); assert.ok(s.lastPurchase);
  assert.equal(s.avgUnitCost, 20); assert.deepEqual(s.mostPurchased, { product: 'Intel Rice', units: 10 });
  assert.equal((await as('cashier').get('/intelligence/suppliers')).status, 403);
});
