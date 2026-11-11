// Phase 9 — stock adjustments, the movement timeline and physical stock counts, through the real HTTP API as real tenants.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct, sell } = require('./sprint-helpers');

let env; let api; let A; let B;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const audits = (s, like) => sql(s, `SELECT action, summary FROM audit_logs WHERE action LIKE $1 ORDER BY id`, [like]);
const stockOf = async (s, id) => Number((await as(s).get(`/products/${id}`)).body.stock);
const j = (r) => JSON.stringify(r.body ?? {});

describe('stock adjustment', () => {
  test('owner and manager can adjust with a reason; stock, movement (before/after, reason, user) and audit all agree', async () => {
    const p = await addProduct(api, A, { stock: 20 });
    const r = await as(A).post(`/inventory/${p.id}/adjust`, { delta: -3, reason: 'damaged', note: 'fell off shelf' });
    assert.equal(r.status, 201, j(r));
    assert.equal(r.body.stockBefore, 20); assert.equal(r.body.stock, 17);
    const m = await as(A, 'manager').post(`/inventory/${p.id}/adjust`, { delta: 5, reason: 'found_stock' });
    assert.equal(m.status, 201, j(m)); assert.equal(m.body.stock, 22);
    assert.equal(await stockOf(A, p.id), 22);
    const t = (await as(A).get(`/inventory/${p.id}/timeline`)).body;
    const [last, prev] = t.rows;
    assert.equal(last.reason, 'found_stock'); assert.equal(last.stockBefore, 17); assert.equal(last.stockAfter, 22); assert.equal(last.quantity, 5); assert.equal(last.type, 'adjustment');
    assert.equal(prev.reason, 'damaged'); assert.equal(prev.note, 'fell off shelf'); assert.equal(prev.stockBefore, 20); assert.equal(prev.stockAfter, 17); assert.ok(prev.user);
    assert.equal(prev.tenantId, A.businessId);
    const a = await audits(A, 'inventory.%');
    assert.ok(a.some((x) => x.action === 'inventory.adjusted' && /damaged/.test(x.summary)));
    assert.ok(a.some((x) => x.action === 'inventory.stock_removed') && a.some((x) => x.action === 'inventory.stock_added'));
  });

  test('a cashier cannot adjust; no token is 401; nothing changes', async () => {
    const p = await addProduct(api, A, { stock: 10 });
    assert.equal((await as(A, 'cashier').post(`/inventory/${p.id}/adjust`, { delta: -1, reason: 'lost' })).status, 403);
    assert.equal((await api().post(`/inventory/${p.id}/adjust`, { delta: -1, reason: 'lost' })).status, 401);
    assert.equal((await as(A, 'cashier').get(`/inventory/${p.id}/timeline`)).status, 403);
    assert.equal(await stockOf(A, p.id), 10);
  });

  test('validation: stock can never go negative, reasons must fit the direction, "other" needs a note, whole units stay whole', async () => {
    const p = await addProduct(api, A, { stock: 4 });
    const neg = await as(A).post(`/inventory/${p.id}/adjust`, { delta: -5, reason: 'lost' });
    assert.equal(neg.status, 409); assert.equal(neg.body.details.code, 'NEGATIVE_STOCK');
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 2, reason: 'theft' })).status, 400);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: -2, reason: 'found_stock' })).status, 400);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 1, reason: 'other' })).status, 400);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 1, reason: 'other', note: 'gift' })).status, 201);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 0, reason: 'manual_correction' })).status, 400);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 1, reason: 'bogus' })).status, 400);
    assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: 1.5, reason: 'manual_correction' })).status, 400, 'pcs is whole-number');
    const kg = await addProduct(api, A, { stock: 2, unit: 'kg' });
    assert.equal((await as(A).post(`/inventory/${kg.id}/adjust`, { delta: -0.25, reason: 'damaged' })).status, 201);
    assert.equal(await stockOf(A, kg.id), 1.75);
    assert.equal(await stockOf(A, p.id), 5);
  });

  test('concurrent adjustments and a sale never lose an update (stock = stock + delta under a row lock)', async () => {
    const p = await addProduct(api, A, { stock: 100 });
    const calls = [
      ...Array.from({ length: 10 }, () => as(A).post(`/inventory/${p.id}/adjust`, { delta: -2, reason: 'damaged' })),
      ...Array.from({ length: 5 }, () => as(A, 'manager').post(`/inventory/${p.id}/adjust`, { delta: 3, reason: 'found_stock' })),
      sell(api, A, p.id, { quantity: 4 }),
    ];
    const res = await Promise.all(calls);
    assert.ok(res.every((r) => r.status === 201), res.map((r) => r.status).join());
    assert.equal(await stockOf(A, p.id), 100 - 20 + 15 - 4);
    const t = (await as(A).get(`/inventory/${p.id}/timeline?limit=200`)).body.rows;
    assert.ok(t.every((r) => r.stockAfter !== null), 'every movement records the resulting stock');
  });

  test('an adjustment that would go negative cannot slip through concurrently', async () => {
    const p = await addProduct(api, A, { stock: 5 });
    const res = await Promise.all(Array.from({ length: 4 }, () => as(A).post(`/inventory/${p.id}/adjust`, { delta: -3, reason: 'lost' })));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.equal(res.filter((r) => r.status === 409).length, 3);
    assert.equal(await stockOf(A, p.id), 2);
  });

  test('another shop cannot see or adjust this product (tenant isolation)', async () => {
    const p = await addProduct(api, A, { stock: 10 });
    assert.equal((await as(B).post(`/inventory/${p.id}/adjust`, { delta: -1, reason: 'lost' })).status, 404);
    assert.equal((await as(B).get(`/inventory/${p.id}/timeline`)).status, 404);
    assert.equal(await stockOf(A, p.id), 10);
  });
});

describe('movement timeline', () => {
  test('covers create, sale, return, adjustment with before/after, newest first, paged by keyset', async () => {
    const p = await addProduct(api, A, { stock: 10 });
    const s = await sell(api, A, p.id, { quantity: 3 });
    assert.equal(s.status, 201, j(s));
    await as(A).post(`/inventory/${p.id}/adjust`, { delta: -1, reason: 'expired' });
    const all = (await as(A).get(`/inventory/${p.id}/timeline`)).body;
    assert.deepEqual(all.rows.map((r) => r.type), ['adjustment', 'sale', 'initial']);
    assert.deepEqual(all.rows.map((r) => r.stockAfter), [6, 7, 10]);
    assert.deepEqual(all.rows.map((r) => r.stockBefore), [7, 10, 10 - 10]);
    const p1 = (await as(A).get(`/inventory/${p.id}/timeline?limit=2`)).body;
    assert.equal(p1.rows.length, 2); assert.ok(p1.nextBefore);
    const p2 = (await as(A).get(`/inventory/${p.id}/timeline?limit=2&before=${p1.nextBefore}`)).body;
    assert.deepEqual(p2.rows.map((r) => r.type), ['initial']); assert.equal(p2.nextBefore, null);
  });

  test('history is immutable: the app role cannot UPDATE or DELETE movements', async () => {
    const p = await addProduct(api, A, { stock: 3 });
    await assert.rejects(() => sql(A, `UPDATE inventory_movements SET quantity = 99 WHERE product_id = $1`, [p.id]), /permission denied|violates row-level/i);
    const del = await sql(A, `DELETE FROM inventory_movements WHERE product_id = $1 RETURNING id`, [p.id]).catch(() => 'blocked');
    assert.ok(del === 'blocked' || del.length === 0, 'a real shop cannot delete ledger rows');
    assert.equal((await as(A).get(`/inventory/${p.id}/timeline`)).body.rows.length, 1);
  });
});

describe('physical stock count', () => {
  test('counting and review change nothing; approval applies variances as auditable adjustments and a summary is shown', async () => {
    const [x, y, z] = [await addProduct(api, A, { stock: 10, purchasePrice: 40 }), await addProduct(api, A, { stock: 8, purchasePrice: 10 }), await addProduct(api, A, { stock: 5, purchasePrice: 100 })];
    const c = await as(A, 'manager').post('/stock-counts', { title: 'Shelf A' });
    assert.equal(c.status, 201, j(c)); const id = c.body.id; assert.equal(c.body.status, 'counting');
    await as(A).put(`/stock-counts/${id}/items/${x.id}`, { counted: 10 });   // matched
    await as(A).put(`/stock-counts/${id}/items/${y.id}`, { counted: 6 });    // short 2 → −₹20
    const last = await as(A).put(`/stock-counts/${id}/items/${z.id}`, { counted: 6 });   // over 1 → +₹100
    assert.deepEqual(last.body.summary, { counted: 3, matched: 1, short: 1, over: 1, shortUnits: -2, overUnits: 1, varianceValue: 80 });
    assert.equal(await stockOf(A, y.id), 8, 'recording a count does not touch stock');
    const sub = await as(A).post(`/stock-counts/${id}/submit`);
    assert.equal(sub.body.status, 'review'); assert.equal(await stockOf(A, y.id), 8, 'review does not touch stock either');
    assert.equal((await as(A).put(`/stock-counts/${id}/items/${y.id}`, { counted: 7 })).status, 409, 'locked once sent for review');
    const ok = await as(A).post(`/stock-counts/${id}/approve`);
    assert.equal(ok.status, 200, j(ok)); assert.equal(ok.body.status, 'approved');
    assert.equal(await stockOf(A, x.id), 10); assert.equal(await stockOf(A, y.id), 6); assert.equal(await stockOf(A, z.id), 6);
    const t = (await as(A).get(`/inventory/${y.id}/timeline`)).body.rows[0];
    assert.equal(t.reason, 'stock_count'); assert.equal(t.referenceType, 'stock_count'); assert.equal(t.referenceId, id); assert.equal(t.quantity, -2); assert.equal(t.stockAfter, 6);
    const a = await audits(A, 'inventory.count_%');
    assert.deepEqual(a.map((r) => r.action), ['inventory.count_started', 'inventory.count_submitted', 'inventory.count_approved']);
    assert.equal((await audits(A, 'inventory.adjusted')).filter((r) => /Stock count/.test(r.summary)).length, 2, 'matched product gets no adjustment');
    assert.equal((await as(A).post(`/stock-counts/${id}/approve`)).status, 409, 'cannot be applied twice (no double counting)');
    assert.equal(await stockOf(A, y.id), 6);
  });

  test('RBAC: a cashier can neither start, record nor approve a count', async () => {
    const p = await addProduct(api, A);
    assert.equal((await as(A, 'cashier').post('/stock-counts', {})).status, 403);
    assert.equal((await as(A, 'cashier').get('/stock-counts')).status, 403);
    const c = await as(A).post('/stock-counts', {});
    assert.equal((await as(A, 'cashier').put(`/stock-counts/${c.body.id}/items/${p.id}`, { counted: 1 })).status, 403);
    assert.equal((await as(A, 'cashier').post(`/stock-counts/${c.body.id}/approve`)).status, 403);
    await as(A).post(`/stock-counts/${c.body.id}/cancel`);
  });

  test('approval is refused when stock moved after counting (never overwrites a live sale); cancelling changes nothing', async () => {
    const p = await addProduct(api, A, { stock: 10 });
    const c = (await as(A).post('/stock-counts', {})).body;
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 9 });
    await sell(api, A, p.id, { quantity: 2 });              // stock is now 8 ≠ expected 10
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const r = await as(A).post(`/stock-counts/${c.id}/approve`);
    assert.equal(r.status, 409); assert.equal(r.body.details.code, 'COUNT_STALE'); assert.equal(r.body.details.stale[0].productId, p.id);
    assert.equal(await stockOf(A, p.id), 8);
    const cancelled = await as(A).post(`/stock-counts/${c.id}/cancel`);
    assert.equal(cancelled.body.status, 'cancelled'); assert.equal(await stockOf(A, p.id), 8);
    assert.equal((await as(A).post('/stock-counts', {})).status, 201, 'a new count can start once the old one is closed');
    const open = (await as(A).get('/stock-counts')).body.rows.find((x) => x.status === 'counting');
    await as(A).post(`/stock-counts/${open.id}/cancel`);
  });

  test('only one count may be open at a time; an empty count cannot be submitted; decimal units respect their unit', async () => {
    const kg = await addProduct(api, A, { stock: 2, unit: 'kg' }); const pcs = await addProduct(api, A, { stock: 2 });
    const c = (await as(A).post('/stock-counts', {})).body;
    const second = await as(A).post('/stock-counts', {});
    assert.equal(second.status, 409); assert.equal(second.body.details.code, 'COUNT_ALREADY_OPEN');
    assert.equal((await as(A).post(`/stock-counts/${c.id}/submit`)).status, 400, 'nothing counted');
    assert.equal((await as(A).put(`/stock-counts/${c.id}/items/${pcs.id}`, { counted: 1.5 })).status, 400);
    assert.equal((await as(A).put(`/stock-counts/${c.id}/items/${kg.id}`, { counted: 1.5 })).status, 200);
    await as(A).post(`/stock-counts/${c.id}/cancel`);
  });

  test('tenant isolation: another shop cannot read, count into or approve this count, and cannot count this shop\'s products', async () => {
    const p = await addProduct(api, A, { stock: 5 });
    const c = (await as(A).post('/stock-counts', {})).body;
    assert.equal((await as(B).get(`/stock-counts/${c.id}`)).status, 404);
    assert.equal((await as(B).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 1 })).status, 404);
    assert.equal((await as(B).post(`/stock-counts/${c.id}/approve`)).status, 404);
    assert.ok(!(await as(B).get('/stock-counts')).body.rows.some((r) => r.id === c.id));
    const bc = (await as(B).post('/stock-counts', {})).body;
    assert.equal((await as(B).put(`/stock-counts/${bc.id}/items/${p.id}`, { counted: 1 })).status, 404, 'A\'s product is invisible to B');
    await as(A).post(`/stock-counts/${c.id}/cancel`); await as(B).post(`/stock-counts/${bc.id}/cancel`);
    assert.equal(await stockOf(A, p.id), 5);
  });
});
