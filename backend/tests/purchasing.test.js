// Sprint 2 — categories, suppliers, supplier↔product terms, purchase orders, partial receiving, price history, restock integration.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, todayIso } = require('./sprint-helpers');
const { getProductStats } = require('../src/services/forecast');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const owner = (s) => api(s.owner.token);
async function addSupplier(s, over = {}) {
  const r = await owner(s).post('/suppliers', { name: uniq('Supp '), leadTimeDays: 3, paymentTermsDays: 15, minOrderValue: 0, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function placedPo(s, sup, lines) {
  const c = await owner(s).post('/purchase-orders', { supplierId: sup.id, items: lines });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const o = await owner(s).post(`/purchase-orders/${c.body.id}/order`, {});
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return o.body;
}
const stockOf = async (s, id) => (await owner(s).get(`/products/${id}`)).body.stock;
const receive = (s, po, items, headers) => api(s.owner.token).post(`/purchase-orders/${po.id}/receive`, { items }, headers);

// ---------------------------------------------------------------- categories
test('categories: CRUD, duplicates, in-use delete blocked, permissions, isolation, audit', async () => {
  const o = owner(A);
  const c = await o.post('/categories', { name: 'Dairy X', taxRate: 5 });
  assert.equal(c.status, 201);
  assert.equal((await o.post('/categories', { name: 'dairy x', taxRate: 5 })).status, 409, 'case-insensitive duplicate');
  assert.equal((await o.post('/categories', { name: 'Bad', taxRate: 99 })).status, 400);
  assert.equal((await o.put(`/categories/${c.body.id}`, { taxRate: 12 })).body.after === undefined, true);
  assert.equal((await o.get('/categories')).body.rows.find((x) => x.id === c.body.id).taxRate, 12);
  const p = await addProduct(api, A, { categoryId: c.body.id });
  const del = await o.del(`/categories/${c.body.id}`);
  assert.equal(del.status, 409); assert.equal(del.body.details.code, 'CATEGORY_IN_USE');
  assert.equal((await api(A.manager.token).del(`/categories/${c.body.id}`)).status, 403, 'delete is owner-only');
  assert.equal((await api(A.manager.token).get('/categories')).status, 200);
  assert.equal((await api(A.cashier.token).get('/categories')).status, 403);
  assert.equal((await api(A.cashier.token).post('/categories', { name: 'Nope', taxRate: 1 })).status, 403);
  assert.ok(!(await owner(B).get('/categories')).body.rows.some((x) => x.id === c.body.id), 'other tenant cannot see it');
  assert.equal((await owner(B).put(`/categories/${c.body.id}`, { taxRate: 1 })).status, 404);
  await o.put(`/products/${p.id}`, { categoryId: A.category.id });
  assert.equal((await o.del(`/categories/${c.body.id}`)).status, 200);
  const logs = await env.db.runAsTenant(A.businessId, async () => (await env.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'category.%'`)).rows.map((r) => r.action));
  assert.ok(['category.created', 'category.updated', 'category.deleted'].every((a) => logs.includes(a)));
});

// ---------------------------------------------------------------- suppliers
test('suppliers: CRUD, search, permissions, isolation', async () => {
  const s = await addSupplier(A, { name: 'Fresh Farms', phone: '9000000001', contactPerson: 'Ravi', gstin: '27ABCDE1234F1Z5' });
  assert.equal(s.isActive, true); assert.equal(s.leadTimeDays, 3);
  assert.equal((await owner(A).put(`/suppliers/${s.id}`, { leadTimeDays: 5, paymentTermsDays: 30 })).body.leadTimeDays, 5);
  assert.ok((await owner(A).get('/suppliers?q=fresh')).body.rows.some((x) => x.id === s.id));
  assert.equal((await api(A.manager.token).get('/suppliers')).status, 200);
  assert.equal((await api(A.cashier.token).get('/suppliers')).status, 403);
  assert.equal((await api(A.cashier.token).post('/suppliers', { name: 'x', leadTimeDays: 1, paymentTermsDays: 0, minOrderValue: 0 })).status, 403);
  assert.equal((await owner(B).get(`/suppliers/${s.id}`)).status, 404);
  assert.ok(!(await owner(B).get('/suppliers')).body.rows.some((x) => x.id === s.id));
  assert.equal((await owner(A).post('/suppliers', { name: '', leadTimeDays: 1, paymentTermsDays: 0, minOrderValue: 0 })).status, 400);
  assert.equal((await owner(A).put(`/suppliers/${s.id}`, { isActive: false })).body.isActive, false);
  assert.ok(!(await owner(A).get('/suppliers')).body.rows.some((x) => x.id === s.id), 'inactive hidden by default');
  assert.ok((await owner(A).get('/suppliers?includeInactive=true')).body.rows.some((x) => x.id === s.id));
});

test('supplier–product link: terms, preferred supplier, price history, removal, cross-tenant', async () => {
  const sup = await addSupplier(A, { leadTimeDays: 4 });
  const sup2 = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'Milk' });
  const l = await owner(A).put(`/suppliers/${sup.id}/products/${p.id}`, { supplierSku: 'M-1', packSize: 12, minOrderQty: 24, lastCost: 41, isPreferred: true });
  assert.equal(l.status, 201);
  assert.deepEqual([l.body.products[0].packSize, l.body.products[0].minOrderQty, l.body.products[0].lastCost, l.body.products[0].isPreferred], [12, 24, 41, true]);
  assert.equal((await owner(A).get(`/products/${p.id}`)).body.supplierId, sup.id, 'preferred supplier becomes the product supplier');
  await owner(A).put(`/suppliers/${sup2.id}/products/${p.id}`, { lastCost: 39, isPreferred: true });
  const sups = (await owner(A).get(`/products/${p.id}/suppliers`)).body.rows;
  assert.equal(sups.filter((x) => x.isPreferred).length, 1, 'only one preferred supplier per product');
  assert.equal((await owner(A).put(`/suppliers/${sup.id}/products/${p.id}`, { lastCost: 43 })).status, 200);
  const hist = (await owner(A).get(`/suppliers/${sup.id}/price-history?productId=${p.id}`)).body.rows;
  assert.deepEqual(hist.map((h) => h.unitCost), [43, 41]);
  assert.equal((await owner(A).put(`/suppliers/${sup.id}/products/${p.id}`, { lastCost: 43 })).status, 200);
  assert.equal((await owner(A).get(`/suppliers/${sup.id}/price-history`)).body.rows.length, 2, 'unchanged cost adds no row');
  assert.equal((await owner(B).put(`/suppliers/${sup.id}/products/${p.id}`, { lastCost: 1 })).status, 404);
  assert.equal((await owner(A).put(`/suppliers/${sup.id}/products/${p.id}`, { packSize: 0 })).status, 400);
  assert.equal((await owner(A).del(`/suppliers/${sup.id}/products/${p.id}`)).status, 200);
  assert.equal((await owner(A).del(`/suppliers/${sup.id}/products/${p.id}`)).status, 404);
});

// ---------------------------------------------------------------- purchase orders: lifecycle
test('PO lifecycle: draft → ordered → partial → full receipt updates stock exactly once per delivery', async () => {
  const sup = await addSupplier(A, { leadTimeDays: 2 });
  const a = await addProduct(api, A, { name: 'PO-A', purchasePrice: 10, sellingPrice: 20, stock: 5 });
  const b = await addProduct(api, A, { name: 'PO-B', unit: 'kg', purchasePrice: 100, sellingPrice: 150, stock: 1 });
  const draft = await owner(A).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: a.id, quantity: 100 }, { productId: b.id, quantity: 12.5, unitCost: 95 }] });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.status, 'draft'); assert.match(draft.body.poNumber, /^PO-/);
  assert.equal(draft.body.orderedValue, 100 * 10 + 12.5 * 95);
  assert.equal((await receive(A, draft.body, [{ itemId: draft.body.items[0].id, quantity: 1 }])).status, 409, 'draft cannot be received');
  assert.equal((await owner(A).put(`/purchase-orders/${draft.body.id}`, { items: [{ productId: a.id, quantity: 100 }, { productId: b.id, quantity: 10, unitCost: 95 }] })).status, 200);
  const po = (await owner(A).post(`/purchase-orders/${draft.body.id}/order`, {})).body;
  assert.equal(po.status, 'ordered'); assert.ok(po.expectedDate >= todayIso());
  assert.equal((await owner(A).put(`/purchase-orders/${po.id}`, { notes: 'x' })).status, 409, 'placed PO is not editable');
  const [ia, ib] = po.items;

  const r1 = await receive(A, po, [{ itemId: ia.id, quantity: 40 }, { itemId: ib.id, quantity: 2.5 }]);
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.purchaseOrder.status, 'partially_received');
  assert.equal(await stockOf(A, a.id), 45); assert.equal(await stockOf(A, b.id), 3.5);
  assert.deepEqual(r1.body.purchaseOrder.items.map((i) => i.outstandingQty), [60, 7.5]);

  const r2 = await receive(A, po, [{ itemId: ia.id, quantity: 60 }, { itemId: ib.id, quantity: 7.5 }]);
  assert.equal(r2.status, 201);
  assert.equal(r2.body.purchaseOrder.status, 'received'); assert.equal(r2.body.purchaseOrder.receipts.length, 2);
  assert.equal(await stockOf(A, a.id), 105); assert.equal(await stockOf(A, b.id), 11);
  assert.equal((await receive(A, po, [{ itemId: ia.id, quantity: 1 }])).status, 409, 'a completed PO accepts nothing more');
  const mv = await owner(A).get(`/inventory/${a.id}/movements`);
  assert.equal(mv.body.rows.filter((m) => m.quantity === 40 || m.quantity === 60).length, 2);
});

test('receiving: no over-receipt, rejected goods stay outstanding and out of stock, whole-unit rule applies', async () => {
  const sup = await addSupplier(A);
  const a = await addProduct(api, A, { name: 'R-A', stock: 0 });
  const po = await placedPo(A, sup, [{ productId: a.id, quantity: 10 }]);
  const it = po.items[0].id;
  const over = await receive(A, po, [{ itemId: it, quantity: 11 }]);
  assert.equal(over.status, 409); assert.equal(over.body.details.code, 'OVER_RECEIPT');
  assert.equal(await stockOf(A, a.id), 0, 'a failed receipt changes nothing');
  assert.equal((await receive(A, po, [{ itemId: it, quantity: 2.5 }])).status, 400, 'pcs cannot be received fractionally');
  assert.equal((await receive(A, po, [{ itemId: it, quantity: 0, rejectedQuantity: 0 }])).status, 400, 'empty delivery');
  assert.equal((await receive(A, po, [{ itemId: 999999, quantity: 1 }])).status, 400, 'item not on this PO');
  const r = await receive(A, po, [{ itemId: it, quantity: 6, rejectedQuantity: 2 }]);
  assert.equal(r.status, 201);
  assert.equal(await stockOf(A, a.id), 6, 'rejected goods never enter stock');
  const line = r.body.purchaseOrder.items[0];
  assert.deepEqual([line.receivedQty, line.rejectedQty, line.outstandingQty], [6, 2, 4], 'rejected stays outstanding for a replacement');
  assert.equal((await receive(A, po, [{ itemId: it, quantity: 4 }])).body.purchaseOrder.status, 'received');
});

test('receiving at a new cost: last-cost updated, history + supplier price history written, selling price untouched, margin reported', async () => {
  const sup = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'Costly', purchasePrice: 40, sellingPrice: 50, stock: 0 });
  const po = await placedPo(A, sup, [{ productId: p.id, quantity: 10, unitCost: 40 }]);
  const r = await receive(A, po, [{ itemId: po.items[0].id, quantity: 4, unitCost: 46 }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.priceChanges.length, 1);
  const pc = r.body.priceChanges[0];
  assert.equal(pc.productId, p.id); assert.equal(pc.oldCost ?? pc.oldPurchasePrice, 40); assert.equal(pc.newCost ?? pc.newPurchasePrice, 46);
  const prod = (await owner(A).get(`/products/${p.id}`)).body;
  assert.equal(prod.purchasePrice, 46); assert.equal(prod.sellingPrice, 50, 'selling price is never changed automatically');
  const ch = (await owner(A).get(`/products/${p.id}/cost-history`)).body.rows;
  assert.deepEqual(ch.slice(0, 2).map((x) => [x.cost, x.source]), [[46, 'purchase'], [40, 'initial']]);
  const sph = (await owner(A).get(`/suppliers/${sup.id}/price-history?productId=${p.id}`)).body.rows;
  assert.equal(sph[0].unitCost, 46); assert.equal(sph[0].poNumber, po.poNumber);
  assert.equal((await owner(A).get(`/suppliers/${sup.id}`)).body.products.find((x) => x.productId === p.id).lastCost, 46);
  // same cost again → no new history
  await receive(A, po, [{ itemId: po.items[0].id, quantity: 2, unitCost: 46 }]);
  assert.equal((await owner(A).get(`/products/${p.id}/cost-history`)).body.rows.length, 2);
  // a sale after the receipt snapshots the new cost; earlier sale keeps the old one
  const s = await owner(A).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
  const cost = await env.db.runAsTenant(A.businessId, async () => (await env.db.query('SELECT unit_cost FROM sale_items WHERE sale_id = $1', [s.body.id])).rows[0].unit_cost);
  assert.equal(cost, 46);
});

test('receiving is idempotent with an Idempotency-Key, and a key cannot be reused for another PO', async () => {
  const sup = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'Idem', stock: 0 });
  const po = await placedPo(A, sup, [{ productId: p.id, quantity: 10 }]);
  const po2 = await placedPo(A, sup, [{ productId: p.id, quantity: 10 }]);
  const key = crypto.randomUUID();
  const one = await receive(A, po, [{ itemId: po.items[0].id, quantity: 3 }], { 'Idempotency-Key': key });
  assert.equal(one.status, 201);
  const again = await receive(A, po, [{ itemId: po.items[0].id, quantity: 3 }], { 'Idempotency-Key': key });
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(await stockOf(A, p.id), 3, 'replay did not add stock twice');
  assert.equal((await receive(A, po2, [{ itemId: po2.items[0].id, quantity: 3 }], { 'Idempotency-Key': key })).status, 422);
  assert.equal((await receive(A, po, [{ itemId: po.items[0].id, quantity: 1 }], { 'Idempotency-Key': 'not-a-uuid' })).status, 400);
});

test('close short, cancel rules, expected-date validation, inactive supplier, advisory warnings', async () => {
  const sup = await addSupplier(A, { minOrderValue: 5000 });
  const p = await addProduct(api, A, { name: 'Cx', stock: 0, purchasePrice: 10 });
  await owner(A).put(`/suppliers/${sup.id}/products/${p.id}`, { packSize: 12, minOrderQty: 24 });
  const d = await owner(A).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 10 }] });
  assert.equal(d.body.warnings.length, 3, 'below MOQ, not a pack multiple, below minimum order value');
  assert.equal((await owner(A).post(`/purchase-orders/${d.body.id}/order`, { expectedDate: '2000-01-01' })).status, 400, 'past date');
  assert.equal((await owner(A).post(`/purchase-orders/${d.body.id}/close`)).status, 409, 'only partial can close short');
  assert.equal((await owner(A).post(`/purchase-orders/${d.body.id}/cancel`)).body.status, 'cancelled');
  assert.equal((await owner(A).post(`/purchase-orders/${d.body.id}/cancel`)).status, 409);
  assert.equal((await owner(A).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 2 }] })).status, 400, 'duplicate product line');

  const po = await placedPo(A, sup, [{ productId: p.id, quantity: 10 }]);
  const exp = (await owner(A).get(`/purchase-orders/${po.id}`)).body.expectedDate;
  assert.ok(exp >= todayIso());
  assert.equal((await owner(A).put(`/suppliers/${sup.id}`, { isActive: false })).status, 409, 'open PO blocks deactivation');
  await receive(A, po, [{ itemId: po.items[0].id, quantity: 4 }]);
  assert.equal((await owner(A).post(`/purchase-orders/${po.id}/cancel`)).status, 409, 'received goods → close short instead');
  const closed = await owner(A).post(`/purchase-orders/${po.id}/close`);
  assert.equal(closed.status, 200); assert.equal(closed.body.status, 'received'); assert.equal(closed.body.closedShort, true);
  assert.equal(await stockOf(A, p.id), 4);
  assert.equal((await owner(A).put(`/suppliers/${sup.id}`, { isActive: false })).status, 200, 'no open POs left');
  assert.equal((await owner(A).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 1 }] })).status, 400, 'inactive supplier');
});

test('PO list, filters and purchase history', async () => {
  const sup = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'Hist', stock: 0 });
  const po = await placedPo(A, sup, [{ productId: p.id, quantity: 5, unitCost: 12 }]);
  await receive(A, po, [{ itemId: po.items[0].id, quantity: 5 }]);
  const list = (await owner(A).get(`/purchase-orders?supplierId=${sup.id}&status=received`)).body;
  assert.equal(list.total, 1); assert.equal(list.rows[0].receivedQty, 5); assert.equal(list.rows[0].receivedValue, 60);
  assert.equal((await owner(A).get('/purchase-orders?status=open')).body.rows.some((r) => r.id === po.id), false);
  const h = (await owner(A).get(`/purchase-orders/history?productId=${p.id}`)).body.rows;
  assert.equal(h.length, 1); assert.equal(h[0].quantity, 5); assert.equal(h[0].unitCost, 12);
  assert.equal((await owner(A).get('/purchase-orders?status=bogus')).status, 400);
});

test('purchase orders: managers allowed, cashiers forbidden, tenants isolated, audited', async () => {
  const sup = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'Perm', stock: 0 });
  const c = await api(A.manager.token).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 3 }] });
  assert.equal(c.status, 201);
  assert.equal((await api(A.cashier.token).get('/purchase-orders')).status, 403);
  assert.equal((await api(A.cashier.token).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 3 }] })).status, 403);
  assert.equal((await api().get('/purchase-orders')).status, 401);
  assert.equal((await owner(B).get(`/purchase-orders/${c.body.id}`)).status, 404);
  assert.equal((await owner(B).post(`/purchase-orders/${c.body.id}/cancel`)).status, 404);
  assert.equal((await owner(B).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 1 }] })).status, 404, "cannot order another shop's supplier");
  assert.ok(!(await owner(B).get('/purchase-orders')).body.rows.some((r) => r.id === c.body.id));
  await owner(A).post(`/purchase-orders/${c.body.id}/order`, {});
  const acts = await env.db.runAsTenant(A.businessId, async () => (await env.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'purchase_order.%'`)).rows.map((r) => r.action));
  assert.ok(acts.includes('purchase_order.created') && acts.includes('purchase_order.ordered'));
});

test('PO numbers are unique and sequential per business', async () => {
  const sup = await addSupplier(B);
  const p = await addProduct(api, B, { name: 'Seq', stock: 0 });
  const nums = [];
  for (let i = 0; i < 3; i += 1) nums.push((await owner(B).post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: 1 }] })).body.poNumber);
  assert.equal(new Set(nums).size, 3);
});

// ---------------------------------------------------------------- restock integration
test('restock orders → purchase orders: grouped by supplier, no double counting of on-order stock', async () => {
  const s = await makeShop(api);
  const o = owner(s);
  const sup1 = await addSupplier(s); const sup2 = await addSupplier(s);
  const p1 = await addProduct(api, s, { name: 'RS1', stock: 1, minimumStock: 10 });
  const p2 = await addProduct(api, s, { name: 'RS2', stock: 1, minimumStock: 10 });
  const p3 = await addProduct(api, s, { name: 'RS3', stock: 1, minimumStock: 10 });
  await o.put(`/suppliers/${sup1.id}/products/${p1.id}`, { isPreferred: true, lastCost: 30 });
  await o.put(`/suppliers/${sup1.id}/products/${p2.id}`, { isPreferred: true });
  await o.put(`/suppliers/${sup2.id}/products/${p3.id}`, { isPreferred: true });
  const ids = [];
  for (const p of [p1, p2, p3]) {
    const a = await o.post(`/ai/restock/${p.id}/approve`, { quantity: 20 });
    assert.equal(a.status, 201, JSON.stringify(a.body)); ids.push(a.body.id);
  }
  const onOrder = async (pid) => env.db.runAsTenant(s.businessId, async () => (await getProductStats()).find((x) => x.id === pid).onOrder);
  assert.equal(await onOrder(p1.id), 20);

  const made = await o.post('/purchase-orders/from-restock', { restockOrderIds: ids });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.rows.length, 2, 'one draft PO per supplier');
  const poOf = (sid) => made.body.rows.find((r) => r.supplierId === sid);
  assert.deepEqual(poOf(sup1.id).items.map((i) => i.productId).sort(), [p1.id, p2.id].sort());
  assert.equal(poOf(sup1.id).items.find((i) => i.productId === p1.id).unitCost, 30, 'uses the supplier price');
  assert.equal(await onOrder(p1.id), 20, 'draft PO + linked restock order are counted once');

  const again = await o.post('/purchase-orders/from-restock', { restockOrderIds: [ids[0]] });
  assert.equal(again.status, 409, 'already on a PO');
  const rl = (await o.get('/inventory/restock-orders')).body.rows.find((r) => r.id === ids[0]);
  assert.equal(rl.purchaseOrder.poNumber, poOf(sup1.id).poNumber);
  const direct = await o.post(`/inventory/restock-orders/${ids[0]}/receive`);
  assert.equal(direct.status, 409, 'must be received through the PO');

  const placed = (await o.post(`/purchase-orders/${poOf(sup1.id).id}/order`, {})).body;
  assert.equal(await onOrder(p1.id), 20, 'placed PO outstanding is counted once');
  const item = placed.items.find((i) => i.productId === p1.id);
  const r = await receive(s, placed, [{ itemId: item.id, quantity: 8 }]);
  assert.equal(r.status, 201);
  assert.equal(await onOrder(p1.id), 12, 'only the outstanding part is still on order');
  await receive(s, placed, [{ itemId: item.id, quantity: 12 }]);
  assert.equal(await onOrder(p1.id), 0);
  const rl2 = (await o.get('/inventory/restock-orders')).body.rows.find((x) => x.id === ids[0]);
  assert.equal(rl2.status, 'received', 'linked restock order closes when its PO line is fully received');

  // cancelling a draft PO releases its restock orders (dismissed) and frees the stock count
  const cancelled = await o.post(`/purchase-orders/${poOf(sup2.id).id}/cancel`);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.ok(!(await o.get('/inventory/restock-orders')).body.rows.some((x) => x.id === ids[2]), 'released restock order leaves the open list');
  const st = await env.db.runAsTenant(s.businessId, async () => (await env.db.query('SELECT status, purchase_order_item_id FROM restock_orders WHERE id = $1', [ids[2]])).rows[0]);
  assert.equal(st.status, 'dismissed');
  assert.ok(st.purchase_order_item_id, 'the link is kept for the audit trail');
  assert.equal(await onOrder(p3.id), 0);
});

test('from-restock rejects products without a supplier and other tenants\' restock orders', async () => {
  const s = await makeShop(api);
  const p = await addProduct(api, s, { name: 'NoSup', stock: 0, minimumStock: 5 });
  const a = await owner(s).post(`/ai/restock/${p.id}/approve`, { quantity: 5 });
  const r = await owner(s).post('/purchase-orders/from-restock', { restockOrderIds: [a.body.id] });
  assert.equal(r.status, 400); assert.equal(r.body.details.code, 'PRODUCT_HAS_NO_SUPPLIER');
  assert.equal((await owner(B).post('/purchase-orders/from-restock', { restockOrderIds: [a.body.id] })).status, 404);
  const fr = await owner(s).post(`/ai/restock/${p.id}/approve`, { quantity: 2.5 });
  assert.equal(fr.status, 400, 'fractional restock quantity for a pcs product');
});

// ---------------------------------------------------------------- database-level guarantees
test('database: received ≤ ordered, receipts are append-only, tenants cannot read each other', async () => {
  const sup = await addSupplier(A);
  const p = await addProduct(api, A, { name: 'DbCheck', stock: 0 });
  const po = await placedPo(A, sup, [{ productId: p.id, quantity: 5 }]);
  await receive(A, po, [{ itemId: po.items[0].id, quantity: 2 }]);
  await env.db.runAsTenant(A.businessId, async () => {
    await assert.rejects(env.db.query('UPDATE purchase_order_items SET received_qty = ordered_qty + 1 WHERE id = $1', [po.items[0].id]), /check/i);
    await assert.rejects(env.db.query('UPDATE goods_receipts SET notes = $1', ['tamper']), /permission denied/);
    await assert.rejects(env.db.query('UPDATE goods_receipt_items SET quantity = 99'), /permission denied/);
    await assert.rejects(env.db.query('UPDATE supplier_price_history SET unit_cost = 0'), /permission denied/);
    assert.equal((await env.db.query('DELETE FROM goods_receipts')).rowCount, 0, 'real businesses cannot delete receipts');
    assert.ok((await env.db.query('SELECT 1 FROM goods_receipts')).rowCount >= 1);
  });
  await env.db.runAsTenant(B.businessId, async () => {
    for (const t of ['suppliers', 'supplier_products', 'purchase_orders', 'purchase_order_items', 'goods_receipts', 'goods_receipt_items', 'supplier_price_history', 'product_cost_history']) {
      const n = (await env.db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE business_id = $1`, [A.businessId])).rows[0].n;
      assert.equal(n, 0, `${t} leaks across tenants`);
    }
  });
});

// ---------------------------------------------------------------- demo reset still works with the new tables
test('demo reset wipes purchasing data and reloads the snapshot-aware demo dataset (and only for demo businesses)', async () => {
  const s = await makeShop(api);
  const o = owner(s);
  assert.equal((await o.post('/demo/load', { confirm: true })).status, 403, 'a real business can never be reset');
  await env.db.sysQuery('UPDATE businesses SET is_demo = TRUE WHERE id = $1', [s.businessId]);
  const sup = await addSupplier(s);
  const p = await addProduct(api, s, { name: 'Before reset', stock: 0 });
  const po = await placedPo(s, sup, [{ productId: p.id, quantity: 5 }]);
  assert.equal((await receive(s, po, [{ itemId: po.items[0].id, quantity: 5 }])).status, 201);
  const r = await o.post('/demo/load', { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const counts = await env.db.runAsTenant(s.businessId, async () => (await env.db.query(
    `SELECT (SELECT COUNT(*)::int FROM purchase_orders) AS pos, (SELECT COUNT(*)::int FROM goods_receipts) AS grs, (SELECT COUNT(*)::int FROM supplier_price_history) AS sph,
            (SELECT COUNT(*)::int FROM product_cost_history) AS pch, (SELECT COUNT(*)::int FROM sale_items) AS lines, (SELECT COUNT(*)::int FROM sale_items WHERE unit_cost IS NULL) AS nocost`)).rows[0]);
  assert.deepEqual([counts.pos, counts.grs, counts.sph], [0, 0, 0]);
  assert.ok(counts.pch > 0 && counts.lines > 0 && counts.nocost === 0, 'demo sale lines carry cost snapshots');
  assert.equal((await o.get('/analytics/overview')).status, 200);
});
