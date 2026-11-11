// Phase 9 — batches, expiry filters, FEFO and batch-aware receiving, through the real HTTP API as real tenants.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, sell, daysAgoIso } = require('./sprint-helpers');

let env; let api; let A; let B;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const audits = (s, like) => sql(s, `SELECT action, summary FROM audit_logs WHERE action LIKE $1 ORDER BY id`, [like]);
const stockOf = async (s, id) => Number((await as(s).get(`/products/${id}`)).body.stock);
const inDays = (n) => daysAgoIso(-n);
const j = (r) => JSON.stringify(r.body ?? {});
const batchesOf = async (s, id) => (await as(s).get(`/inventory/${id}/batches`)).body.rows;
const addBatch = (s, id, body, who = 'owner') => as(s, who).post(`/inventory/${id}/batches`, body);
async function supplier(s) { return (await as(s).post('/suppliers', { name: uniq('Supp '), leadTimeDays: 3, paymentTermsDays: 15, minOrderValue: 0 })).body; }
async function placedPo(s, sup, lines) {
  const c = await as(s).post('/purchase-orders', { supplierId: sup.id, items: lines }); assert.equal(c.status, 201, j(c));
  return (await as(s).post(`/purchase-orders/${c.body.id}/order`, {})).body;
}

describe('batches and expiry', () => {
  test('a product without batches is untouched: no batch rows, no forced expiry, sale works as before', async () => {
    const p = await addProduct(api, A, { stock: 10 });
    assert.equal((await sell(api, A, p.id, { quantity: 2 })).status, 201);
    assert.equal(await stockOf(A, p.id), 8);
    assert.deepEqual(await batchesOf(A, p.id), []);
    const t = (await as(A).get(`/inventory/${p.id}/timeline`)).body.rows;
    assert.ok(t.every((r) => r.batchId === null));
    assert.ok(!(await as(A).get('/inventory/expiry?within=all')).body.rows.some((r) => r.productId === p.id), 'no expiry date → never listed');
  });

  test('batch stock can be added by owner/manager (not cashier); audit batch.created; same batch number tops up, a different expiry is refused', async () => {
    const p = await addProduct(api, A, { stock: 0 });
    assert.equal((await addBatch(A, p.id, { quantity: 5, batchNo: 'B1' }, 'cashier')).status, 403);
    const r = await addBatch(A, p.id, { quantity: 10, batchNo: 'B1', manufacturedDate: daysAgoIso(10), expiryDate: inDays(20) }, 'manager');
    assert.equal(r.status, 201, j(r)); assert.equal(r.body.stock, 10);
    assert.equal((await addBatch(A, p.id, { quantity: 5, batchNo: 'B1', expiryDate: inDays(20) })).status, 201);
    const clash = await addBatch(A, p.id, { quantity: 1, batchNo: 'B1', expiryDate: inDays(50) });
    assert.equal(clash.status, 409); assert.equal(clash.body.details.code, 'BATCH_EXPIRY_MISMATCH');
    assert.equal((await addBatch(A, p.id, { quantity: 1, batchNo: 'B2', manufacturedDate: inDays(5), expiryDate: inDays(1) })).status, 400, 'expiry before manufacture');
    assert.equal((await addBatch(A, p.id, { quantity: 1 })).status, 400, 'needs a batch number or an expiry');
    const b = await batchesOf(A, p.id);
    assert.equal(b.length, 1); assert.equal(b[0].onHand, 15); assert.equal(b[0].received, 15);
    assert.equal(await stockOf(A, p.id), 15);
    assert.ok((await audits(A, 'batch.created')).length >= 2);
  });

  test('FEFO: sales take the earliest-expiry batch first and each movement names its batch', async () => {
    const p = await addProduct(api, A, { stock: 0 });
    await addBatch(A, p.id, { quantity: 5, batchNo: 'LATE', expiryDate: inDays(60) });
    await addBatch(A, p.id, { quantity: 5, batchNo: 'SOON', expiryDate: inDays(10) });
    await addBatch(A, p.id, { quantity: 5, batchNo: 'NOEXP' });
    assert.equal((await sell(api, A, p.id, { quantity: 7 })).status, 201);
    const by = Object.fromEntries((await batchesOf(A, p.id)).map((b) => [b.batchNo, b.onHand]));
    assert.deepEqual(by, { SOON: 0, LATE: 3, NOEXP: 5 });
    const sales = (await as(A).get(`/inventory/${p.id}/timeline`)).body.rows.filter((r) => r.type === 'sale');
    assert.deepEqual(sales.map((r) => r.quantity).sort((a, b) => a - b), [-5, -2]);
    assert.ok(sales.every((r) => r.batchId));
    assert.equal(await stockOf(A, p.id), 8);
  });

  test('expired batches are never sold; if only expired stock is left the sale is refused and an "expired" adjustment clears it', async () => {
    const p = await addProduct(api, A, { stock: 0 });
    await sql(A, `INSERT INTO stock_batches (product_id, batch_no, expiry_date, quantity_received, quantity_on_hand) VALUES ($1,'OLD',$2,4,4)`, [p.id, daysAgoIso(3)]);
    await sql(A, `UPDATE products SET stock = 4, track_batches = TRUE WHERE id = $1`, [p.id]);
    await addBatch(A, p.id, { quantity: 3, batchNo: 'FRESH', expiryDate: inDays(30) });
    assert.equal((await sell(api, A, p.id, { quantity: 3 })).status, 201, 'sells from FRESH');
    const refused = await sell(api, A, p.id, { quantity: 1 });
    assert.equal(refused.status, 409, j(refused)); assert.equal(refused.body.details.code, 'EXPIRED_STOCK_ONLY');
    assert.equal(await stockOf(A, p.id), 4, 'refused sale left stock alone');
    const adj = await as(A).post(`/inventory/${p.id}/adjust`, { delta: -4, reason: 'expired' });
    assert.equal(adj.status, 201, j(adj));
    const by = Object.fromEntries((await batchesOf(A, p.id)).map((b) => [b.batchNo, b.onHand]));
    assert.deepEqual(by, { OLD: 0, FRESH: 0 });
    assert.equal(await stockOf(A, p.id), 0);
  });

  test('expiry report: expired / 7 / 30 / 90 / all, only items with an expiry date, with at-risk value', async () => {
    const p = await addProduct(api, A, { stock: 0, purchasePrice: 10 });
    await sql(A, `INSERT INTO stock_batches (product_id, batch_no, expiry_date, quantity_received, quantity_on_hand) VALUES ($1,'E',$2,2,2)`, [p.id, daysAgoIso(2)]);
    await sql(A, `UPDATE products SET stock = 2, track_batches = TRUE WHERE id = $1`, [p.id]);
    for (const [no, d] of [['D5', 5], ['D25', 25], ['D80', 80], ['D200', 200]]) await addBatch(A, p.id, { quantity: 1, batchNo: no, expiryDate: inDays(d) });
    const q = async (w) => (await as(A).get(`/inventory/expiry?within=${w}`)).body.rows.filter((r) => r.productId === p.id).map((r) => r.batchNo).sort();
    assert.deepEqual(await q('expired'), ['E']);
    assert.deepEqual(await q('7'), ['D5']);
    assert.deepEqual(await q('30'), ['D25', 'D5']);
    assert.deepEqual(await q('90'), ['D25', 'D5', 'D80']);
    assert.deepEqual(await q('all'), ['D200', 'D25', 'D5', 'D80', 'E']);
    const e = (await as(A).get('/inventory/expiry?within=expired')).body;
    assert.equal(e.rows.find((r) => r.productId === p.id).atRiskValue, 20); assert.ok(e.counts.expired >= 1);
    assert.equal((await as(A).get('/inventory/expiry?within=1000')).status, 400);
    assert.equal((await as(A, 'cashier').get('/inventory/expiry')).status, 403);
  });

  test('legacy product-level expiry dates still appear; tenant isolation for batches and the report', async () => {
    const p = await addProduct(api, A, { stock: 3, expiryDate: inDays(4) });
    assert.ok((await as(A).get('/inventory/expiry?within=7')).body.rows.some((r) => r.productId === p.id && r.source === 'product'));
    assert.ok(!(await as(B).get('/inventory/expiry?within=all')).body.rows.some((r) => r.productId === p.id));
    assert.equal((await as(B).get(`/inventory/${p.id}/batches`)).status, 404);
    assert.equal((await addBatch(B, p.id, { quantity: 1, batchNo: 'X' })).status, 404);
  });
});

describe('purchase receiving with batch / expiry', () => {
  test('receiving captures batch + expiry, links the movement and supplier; partial receipts and a replayed key do not double count', async () => {
    const sup = await supplier(A); const p = await addProduct(api, A, { stock: 2, supplierId: sup.id });
    const po = await placedPo(A, sup, [{ productId: p.id, quantity: 100, unitCost: 30 }]);
    const item = po.items[0].id;
    const key = '11111111-1111-4111-8111-111111111111';
    const r1 = await as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 40, batchNo: 'LOT-A', manufacturedDate: daysAgoIso(5), expiryDate: inDays(90) }] }, { 'Idempotency-Key': key });
    assert.equal(r1.status, 201, j(r1));
    const replay = await as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 40, batchNo: 'LOT-A', expiryDate: inDays(90) }] }, { 'Idempotency-Key': key });
    assert.equal(replay.body.replayed, true);
    assert.equal(await stockOf(A, p.id), 42, 'replay did not add stock again');
    const r2 = await as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 60, batchNo: 'LOT-B', expiryDate: inDays(120) }] });
    assert.equal(r2.status, 201, j(r2)); assert.equal(r2.body.purchaseOrder.status, 'received');
    const b = (await batchesOf(A, p.id)).map((x) => [x.batchNo, x.onHand, x.supplier !== null]);
    assert.deepEqual(b, [['LOT-A', 40, true], ['LOT-B', 60, true]]);
    assert.equal(await stockOf(A, p.id), 102);
    const mv = (await as(A).get(`/inventory/${p.id}/timeline`)).body.rows.filter((r) => r.type === 'restock');
    assert.equal(mv.length, 2); assert.ok(mv.every((r) => r.batchId && r.referenceType === 'goods_receipt'));
    const gri = await sql(A, `SELECT batch_no, expiry_date FROM goods_receipt_items WHERE product_id = $1 ORDER BY id`, [p.id]);
    assert.deepEqual(gri.map((r) => r.batch_no), ['LOT-A', 'LOT-B']);
  });

  test('receiving without batch details behaves exactly as before; a bad batch date rolls the whole receipt back', async () => {
    const sup = await supplier(A); const p = await addProduct(api, A, { stock: 0, supplierId: sup.id });
    const po = await placedPo(A, sup, [{ productId: p.id, quantity: 10, unitCost: 5 }]);
    const item = po.items[0].id;
    const bad = await as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 4, batchNo: 'Z', manufacturedDate: inDays(5), expiryDate: inDays(1) }] });
    assert.equal(bad.status, 400);
    assert.equal(await stockOf(A, p.id), 0); assert.deepEqual(await batchesOf(A, p.id), []);
    assert.equal((await as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 4 }] })).status, 201);
    assert.equal(await stockOf(A, p.id), 4); assert.deepEqual(await batchesOf(A, p.id), []);
  });

  test('concurrent receiving of the same PO line cannot over-receive or double count stock and batches', async () => {
    const sup = await supplier(A); const p = await addProduct(api, A, { stock: 0, supplierId: sup.id });
    const po = await placedPo(A, sup, [{ productId: p.id, quantity: 10, unitCost: 5 }]);
    const item = po.items[0].id;
    const res = await Promise.all(Array.from({ length: 5 }, () => as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: item, quantity: 6, batchNo: 'RACE', expiryDate: inDays(40) }] })));
    assert.equal(res.filter((r) => r.status === 201).length, 1, res.map((r) => r.status).join());
    assert.equal(await stockOf(A, p.id), 6);
    const b = await batchesOf(A, p.id); assert.equal(b.length, 1); assert.equal(b[0].onHand, 6); assert.equal(b[0].received, 6);
  });

  test('concurrent sales on a batch never oversell or drive a batch negative', async () => {
    const p = await addProduct(api, A, { stock: 0 });
    await addBatch(A, p.id, { quantity: 5, batchNo: 'S1', expiryDate: inDays(10) });
    await addBatch(A, p.id, { quantity: 5, batchNo: 'S2', expiryDate: inDays(20) });
    const res = await Promise.all(Array.from({ length: 14 }, () => sell(api, A, p.id, { quantity: 1 })));
    assert.equal(res.filter((r) => r.status === 201).length, 10, res.map((r) => r.status).join());
    assert.equal(await stockOf(A, p.id), 0);
    assert.deepEqual((await batchesOf(A, p.id)).map((b) => b.onHand), [0, 0]);
  });
});
