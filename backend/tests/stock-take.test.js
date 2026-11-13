// Phase 10 — Stock take / cycle counting additions: reopen, explicit recount, stale + deactivated handling, candidate lists, audit.
// Real HTTP API, real tenants, forced RLS. (The base count workflow is covered by stock-ops.test.js.)
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let A; let B;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const j = (r) => JSON.stringify(r.body ?? {});
const stockOf = async (s, id) => Number((await sql(s, 'SELECT stock::text AS v FROM products WHERE id = $1', [id]))[0].v);
const avgOf = async (s, id) => Number((await sql(s, 'SELECT avg_cost::text AS v FROM products WHERE id = $1', [id]))[0].v);
const countRef = (s, id) => sql(s, `SELECT id, product_id, quantity::float AS q, reason, reference_type, reference_id, stock_after::float AS after, batch_id FROM inventory_movements WHERE reference_type = 'stock_count' AND reference_id = $1 ORDER BY id`, [id]);
const audits = (s, like) => sql(s, 'SELECT action, summary, old_value, new_value FROM audit_logs WHERE action LIKE $1 ORDER BY id', [like]);
const sale = async (s, productId, quantity = 1) => { const r = await as(s).post('/sales', { items: [{ productId, quantity }], paymentMethod: 'cash' }); assert.equal(r.status, 201, j(r)); return r.body; };
let sup; async function supplier(s) { if (!sup || sup.s !== s) sup = { s, v: (await as(s).post('/suppliers', { name: `Take Supp ${Math.random().toString(36).slice(2, 7)}`, leadTimeDays: 2, paymentTermsDays: 0, minOrderValue: 0 })).body }; return sup.v; }
async function receive(s, p, qty, cost) {
  const c = await as(s).post('/purchase-orders', { supplierId: (await supplier(s)).id, items: [{ productId: p.id, quantity: qty, unitCost: cost }] });
  const o = (await as(s).post(`/purchase-orders/${c.body.id}/order`, {})).body;
  const r = await as(s).post(`/purchase-orders/${o.id}/receive`, { items: [{ itemId: o.items[0].id, quantity: qty, unitCost: cost }] });
  assert.equal(r.status, 201, j(r));
}
const open = async (s, body = {}) => { const r = await as(s).post('/stock-counts', body); assert.equal(r.status, 201, j(r)); return r.body; };
const closeOpen = async (s) => { for (const c of (await as(s).get('/stock-counts')).body.rows.filter((x) => ['counting', 'review'].includes(x.status))) await as(s).post(`/stock-counts/${c.id}/cancel`); };

describe('reopen (review → counting)', () => {
  test('reopen unlocks editing, keeps items with their original snapshots, and changes no stock and no avg_cost', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 10, purchasePrice: 50 });
    const c = await open(A, { title: 'Aisle 2' });
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 9 });
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const before = (await as(A).get(`/stock-counts/${c.id}`)).body;
    const r = await as(A, 'manager').post(`/stock-counts/${c.id}/reopen`);
    assert.equal(r.status, 200, j(r)); assert.equal(r.body.status, 'counting');
    assert.equal(r.body.submittedAt, null);
    assert.deepEqual(r.body.items.map((i) => [i.productId, i.expected, i.counted, i.unitCost]), before.items.map((i) => [i.productId, i.expected, i.counted, i.unitCost]));
    assert.equal(await stockOf(A, p.id), 10); assert.equal(await avgOf(A, p.id), 50);
    assert.equal((await countRef(A, c.id)).length, 0, 'no movement was written');
    const edit = await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 8 });
    assert.equal(edit.status, 200); assert.equal(edit.body.items[0].counted, 8); assert.equal(edit.body.items[0].expected, 10, 'baseline untouched');
    // back through review and on to approval
    assert.equal((await as(A).post(`/stock-counts/${c.id}/submit`)).status, 200);
    assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 200);
    assert.equal(await stockOf(A, p.id), 8); assert.equal(await avgOf(A, p.id), 50);
    const ev = await audits(A, 'inventory.count_reopened');
    assert.equal(ev.length >= 1, true); assert.match(ev[ev.length - 1].summary, new RegExp(`#${c.id}`));
  });

  test('reopen is refused for counting, approved and cancelled counts with a clear error code', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 5 });
    const c1 = await open(A);
    const r1 = await as(A).post(`/stock-counts/${c1.id}/reopen`);
    assert.equal(r1.status, 409); assert.equal(r1.body.details.code, 'COUNT_NOT_REOPENABLE'); assert.equal(r1.body.details.status, 'counting');
    await as(A).put(`/stock-counts/${c1.id}/items/${p.id}`, { counted: 5 });
    await as(A).post(`/stock-counts/${c1.id}/submit`); await as(A).post(`/stock-counts/${c1.id}/approve`);
    const r2 = await as(A).post(`/stock-counts/${c1.id}/reopen`);
    assert.equal(r2.status, 409); assert.equal(r2.body.details.code, 'COUNT_NOT_REOPENABLE'); assert.equal(r2.body.details.status, 'approved');
    const c2 = await open(A); await as(A).post(`/stock-counts/${c2.id}/cancel`);
    const r3 = await as(A).post(`/stock-counts/${c2.id}/reopen`);
    assert.equal(r3.status, 409); assert.equal(r3.body.details.status, 'cancelled');
    assert.equal((await as(A).get(`/stock-counts/${c1.id}`)).body.status, 'approved', 'a refused reopen changes nothing');
  });

  test('RBAC and tenant isolation: a cashier cannot reopen, another shop cannot reopen this shop\'s count', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 5 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 4 }); await as(A).post(`/stock-counts/${c.id}/submit`);
    assert.equal((await as(A, 'cashier').post(`/stock-counts/${c.id}/reopen`)).status, 403);
    assert.equal((await as(B).post(`/stock-counts/${c.id}/reopen`)).status, 404);
    assert.equal((await as(A).get(`/stock-counts/${c.id}`)).body.status, 'review');
    await closeOpen(A);
  });
});

describe('explicit recount vs normal re-record', () => {
  test('a normal re-record keeps the expected quantity and cost snapshot; { recount: true } refreshes both, and neither touches stock or avg_cost', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 10, purchasePrice: 50 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 9 });                // snapshot: expected 10 @ ₹50
    await sale(A, p.id, 2);                                                                // stock 8
    await env.db.runAsTenant(A.businessId, () => env.db.query('UPDATE products SET avg_cost = 77 WHERE id = $1', [p.id]));   // live average moved on
    const typo = await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 8 });   // plain correction
    assert.equal(typo.status, 200);
    const [i1] = typo.body.items;
    assert.deepEqual([i1.expected, i1.unitCost, i1.counted, i1.stale, i1.currentStock], [10, 50, 8, true, 8], 'baseline preserved, and the row is flagged stale');
    assert.equal(typo.body.recount, undefined);
    assert.equal(typo.body.staleCount, 1);
    assert.equal((await audits(A, 'inventory.count_item_recounted')).length, 0, 'a plain correction is not a recount event');

    const rc = await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 7, recount: true });
    assert.equal(rc.status, 200, j(rc));
    const [i2] = rc.body.items;
    assert.deepEqual([i2.expected, i2.unitCost, i2.counted, i2.stale], [8, 77, 7, false], 'expected := live stock, unit cost := live avg_cost');
    assert.deepEqual([rc.body.recount.previousExpected, rc.body.recount.expected, rc.body.recount.previousUnitCost, rc.body.recount.unitCost], [10, 8, 50, 77]);
    assert.equal(rc.body.staleCount, 0);
    assert.equal(await stockOf(A, p.id), 8, 'recount changes no stock'); assert.equal(await avgOf(A, p.id), 77, 'recount changes no avg_cost');
    assert.equal((await countRef(A, c.id)).length, 0);
    const ev = await audits(A, 'inventory.count_item_recounted');
    assert.equal(ev.length, 1); assert.equal(ev[0].old_value.expected, 10); assert.equal(ev[0].new_value.expected, 8);

    // variance is valued at the REFRESHED snapshot (₹77), and approval applies only the real variance
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const ap = await as(A).post(`/stock-counts/${c.id}/approve`);
    assert.equal(ap.status, 200, j(ap)); assert.equal(ap.body.summary.varianceValue, -77);
    assert.equal(await stockOf(A, p.id), 7); assert.equal(await avgOf(A, p.id), 77, 'a count never recalculates avg_cost');
  });

  test('recount only works while the count is in counting, and by default nothing is a recount', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 6 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 6 });
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const r = await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 5, recount: true });
    assert.equal(r.status, 409); assert.equal(r.body.details.code, 'COUNT_NOT_OPEN');
    assert.equal((await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 5, recount: 'yes' })).status, 400, 'recount must be a real boolean');
    await closeOpen(A);
  });
});

describe('stale approval is all-or-nothing', () => {
  const causes = {
    'a sale': (p) => sale(A, p.id, 2),
    'a purchase receipt': (p) => receive(A, p, 5, 60),
    'a restocked return': async (p) => { const s = await sale(A, p.id, 2); const line = s.items.find((i) => i.productId === p.id); const r = await as(A).post(`/sales/${s.id}/returns`, { items: [{ saleItemId: line.id, quantity: 1, restock: true }], reason: 'changed_mind' }); assert.equal(r.status, 201, j(r)); },
    'a manual adjustment': async (p) => { assert.equal((await as(A).post(`/inventory/${p.id}/adjust`, { delta: -1, reason: 'damaged' })).status, 201); },
  };
  for (const [name, cause] of Object.entries(causes)) {
    test(`${name} after counting makes approval return 409 with a stale list and applies ZERO adjustments (a clean product in the same count is not touched)`, async () => {
      await closeOpen(A);
      const moved = await addProduct(api, A, { stock: 10 }); const clean = await addProduct(api, A, { stock: 10 });
      const c = await open(A);
      await as(A).put(`/stock-counts/${c.id}/items/${moved.id}`, { counted: 9 });
      await as(A).put(`/stock-counts/${c.id}/items/${clean.id}`, { counted: 7 });
      await cause(moved);
      const live = await stockOf(A, moved.id);
      assert.notEqual(live, 10);
      await as(A).post(`/stock-counts/${c.id}/submit`);
      const review = (await as(A).get(`/stock-counts/${c.id}`)).body;
      assert.equal(review.staleCount, 1, 'the screen can see the problem before Approve is clicked');
      assert.deepEqual(review.items.map((i) => [i.productId, i.stale]).sort((a, b) => a[0] - b[0]), [[moved.id, true], [clean.id, false]].sort((a, b) => a[0] - b[0]));
      const r = await as(A).post(`/stock-counts/${c.id}/approve`);
      assert.equal(r.status, 409); assert.equal(r.body.details.code, 'COUNT_STALE');
      assert.deepEqual(r.body.details.stale.map((x) => [x.productId, x.reason, x.expected, x.currentStock]), [[moved.id, 'stock_changed', 10, live]]);
      assert.equal(await stockOf(A, moved.id), live); assert.equal(await stockOf(A, clean.id), 10, 'the clean product was NOT adjusted');
      assert.equal((await countRef(A, c.id)).length, 0, 'no movement written');
      assert.equal((await as(A).get(`/stock-counts/${c.id}`)).body.status, 'review', 'not marked approved');
      await closeOpen(A);
    });
  }

  test('recovery path: reopen, re-count the stale product, submit and approve — only the real variance is applied', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 10 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 9 });
    await sale(A, p.id, 2);                                                                // stock 8
    await as(A).post(`/stock-counts/${c.id}/submit`);
    assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 409);
    assert.equal((await as(A).post(`/stock-counts/${c.id}/reopen`)).status, 200);
    assert.equal((await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 7, recount: true })).status, 200);
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const ap = await as(A).post(`/stock-counts/${c.id}/approve`);
    assert.equal(ap.status, 200, j(ap)); assert.equal(await stockOf(A, p.id), 7);
    const mv = await countRef(A, c.id);
    assert.deepEqual(mv.map((m) => [m.q, m.reason, m.reference_type, m.reference_id, m.after]), [[-1, 'stock_count', 'stock_count', c.id, 7]], 'one movement for the real variance (8 → 7), referencing the count');
  });
});

describe('deactivated product after counting', () => {
  test('approval returns a structured stale entry (reason inactive), applies nothing, and the count can be repaired by removing the item', async () => {
    await closeOpen(A);
    const gone = await addProduct(api, A, { stock: 10 }); const keep = await addProduct(api, A, { stock: 10 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${gone.id}`, { counted: 8 });
    await as(A).put(`/stock-counts/${c.id}/items/${keep.id}`, { counted: 9 });
    await as(A).post(`/stock-counts/${c.id}/submit`);
    assert.equal((await as(A).del(`/products/${gone.id}`)).status, 200);
    const review = (await as(A).get(`/stock-counts/${c.id}`)).body;
    assert.equal(review.staleCount, 1); assert.equal(review.items.find((i) => i.productId === gone.id).inactive, true);
    const r = await as(A).post(`/stock-counts/${c.id}/approve`);
    assert.equal(r.status, 409, j(r)); assert.equal(r.body.details.code, 'COUNT_STALE');
    assert.deepEqual(r.body.details.stale.map((x) => [x.productId, x.reason]), [[gone.id, 'inactive']]);
    assert.equal(await stockOf(A, gone.id), 10); assert.equal(await stockOf(A, keep.id), 10, 'nothing applied');
    assert.equal((await countRef(A, c.id)).length, 0);
    assert.equal((await as(A).get(`/stock-counts/${c.id}`)).body.status, 'review');
    // repair: reopen, drop the archived product, resubmit, approve
    assert.equal((await as(A).post(`/stock-counts/${c.id}/reopen`)).status, 200);
    assert.equal((await as(A).del(`/stock-counts/${c.id}/items/${gone.id}`)).status, 200);
    await as(A).post(`/stock-counts/${c.id}/submit`);
    assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 200);
    assert.equal(await stockOf(A, keep.id), 9);
  });
});

describe('concurrency', () => {
  test('two simultaneous approvals apply the count exactly once', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 10 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 6 }); await as(A).post(`/stock-counts/${c.id}/submit`);
    const rs = await Promise.all([as(A).post(`/stock-counts/${c.id}/approve`), as(A).post(`/stock-counts/${c.id}/approve`), as(A, 'manager').post(`/stock-counts/${c.id}/approve`)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409], rs.map(j).join(' '));
    assert.equal(await stockOf(A, p.id), 6, 'stock changed exactly once (10 → 6, not 2)');
    assert.equal((await countRef(A, c.id)).length, 1);
  });

  test('a sale racing the approval never loses an update: either the count lands first and the sale follows, or approval is refused as stale', async () => {
    for (let round = 0; round < 3; round++) {
      await closeOpen(A);
      const p = await addProduct(api, A, { stock: 10 });
      const c = await open(A);
      await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 9 }); await as(A).post(`/stock-counts/${c.id}/submit`);
      const [ap, s] = await Promise.all([as(A).post(`/stock-counts/${c.id}/approve`), as(A).post('/sales', { items: [{ productId: p.id, quantity: 2 }], paymentMethod: 'cash' })]);
      assert.equal(s.status, 201, j(s));
      if (ap.status === 200) assert.equal(await stockOf(A, p.id), 7, 'count set 9, then the sale took 2');
      else { assert.equal(ap.status, 409); assert.equal(ap.body.details.code, 'COUNT_STALE'); assert.equal(await stockOf(A, p.id), 8, 'sale applied, count refused'); }
    }
    await closeOpen(A);
  });
});

describe('approval semantics stay intact', () => {
  test('variance uses the snapshot cost; movements carry reason stock_count and the count id; avg_cost never changes', async () => {
    await closeOpen(A);
    const a = await addProduct(api, A, { stock: 10, purchasePrice: 40 }); const b = await addProduct(api, A, { stock: 5, purchasePrice: 100 });
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${a.id}`, { counted: 7 });               // −3 @ ₹40
    await as(A).put(`/stock-counts/${c.id}/items/${b.id}`, { counted: 6 });               // +1 @ ₹100
    await env.db.runAsTenant(A.businessId, () => env.db.query('UPDATE products SET purchase_price = 999 WHERE id = ANY($1)', [[a.id, b.id]]));   // purchase_price must be irrelevant
    await as(A).post(`/stock-counts/${c.id}/submit`);
    const ap = await as(A).post(`/stock-counts/${c.id}/approve`);
    assert.equal(ap.status, 200, j(ap));
    assert.deepEqual(ap.body.summary, { counted: 2, matched: 0, short: 1, over: 1, shortUnits: -3, overUnits: 1, varianceValue: -20 }, '−3×40 + 1×100');
    assert.equal(await avgOf(A, a.id), 40); assert.equal(await avgOf(A, b.id), 100);
    const mv = await countRef(A, c.id);
    assert.deepEqual(mv.map((m) => [m.product_id, m.q, m.reason, m.reference_type, m.reference_id, m.after]).sort((x, y) => x[0] - y[0]), [[a.id, -3, 'stock_count', 'stock_count', c.id, 7], [b.id, 1, 'stock_count', 'stock_count', c.id, 6]].sort((x, y) => x[0] - y[0]));
    assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 409, 'cannot be approved twice');
  });

  test('batch / FEFO: a shortage on a batch-tracked product takes the earliest-expiry batch first and the batch totals stay consistent', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 0 });
    const b1 = (await as(A).post(`/inventory/${p.id}/batches`, { quantity: 4, batchNo: 'T-EARLY', expiryDate: '2099-01-01' })).body;
    const b2 = (await as(A).post(`/inventory/${p.id}/batches`, { quantity: 6, batchNo: 'T-LATE', expiryDate: '2099-06-01' })).body;
    assert.ok(b1.batchId && b2.batchId, 'batches created');
    const c = await open(A);
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 7 });
    await as(A).post(`/stock-counts/${c.id}/submit`);
    assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 200);
    assert.equal(await stockOf(A, p.id), 7);
    const rows = await sql(A, 'SELECT batch_no, quantity_on_hand::float AS q FROM stock_batches WHERE product_id = $1 ORDER BY batch_no', [p.id]);
    assert.deepEqual(rows, [{ batch_no: 'T-EARLY', q: 1 }, { batch_no: 'T-LATE', q: 6 }]);
    const [m] = await countRef(A, c.id);
    assert.deepEqual([m.q, m.reason], [-3, 'stock_count']); assert.ok(m.batch_id);
  });
});

describe('audit', () => {
  test('count_started carries the title and note; start, submit, reopen, cancel and approve are all recorded with the count id', async () => {
    await closeOpen(A);
    const p = await addProduct(api, A, { stock: 3 });
    const c = await open(A, { title: 'Shelf C — snacks', note: 'weekly cycle' });
    const started = (await audits(A, 'inventory.count_started')).pop();
    assert.match(started.summary, /Shelf C — snacks/); assert.match(started.summary, /weekly cycle/); assert.equal(started.new_value.title, 'Shelf C — snacks');
    await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 2 });
    await as(A).post(`/stock-counts/${c.id}/submit`); await as(A).post(`/stock-counts/${c.id}/reopen`); await as(A).post(`/stock-counts/${c.id}/submit`); await as(A).post(`/stock-counts/${c.id}/approve`);
    const c2 = await open(A); await as(A).post(`/stock-counts/${c2.id}/cancel`);
    const all = (await sql(A, `SELECT action, entity_type, entity_id, account_id FROM audit_logs WHERE action LIKE 'inventory.count_%' OR (action = 'inventory.adjusted' AND summary LIKE $1) ORDER BY id`, [`%count #${c.id}:%`]));
    const seen = new Set(all.filter((x) => String(x.entity_id) === String(c.id) || x.action === 'inventory.adjusted').map((x) => x.action));
    for (const a of ['inventory.count_started', 'inventory.count_submitted', 'inventory.count_reopened', 'inventory.count_approved', 'inventory.adjusted']) assert.ok(seen.has(a), `${a} recorded`);
    assert.ok(all.some((x) => x.action === 'inventory.count_cancelled' && String(x.entity_id) === String(c2.id)));
    assert.ok(all.every((x) => x.account_id), 'every event names the user');
    const adj = (await audits(A, 'inventory.adjusted')).pop();
    assert.deepEqual([adj.old_value.stock, adj.new_value.stock], [3, 2]);
  });
});

describe('cycle-count candidates (read-only)', () => {
  test('filters, ordering, lastCountedAt only from APPROVED counts, active only, no side effects', async () => {
    const S = await makeShop(api);
    const cat2 = (await as(S).post('/categories', { name: 'Cycle Cat', taxRate: 0 })).body;
    const sp = (await as(S).post('/suppliers', { name: 'Cycle Supplier', leadTimeDays: 2, paymentTermsDays: 0, minOrderValue: 0 })).body;
    const mk = (over) => addProduct(api, S, { categoryId: S.category.id, ...over });
    const low = await mk({ name: 'Low One', stock: 2, minimumStock: 5, purchasePrice: 10 });
    const big = await mk({ name: 'Big Value', stock: 100, purchasePrice: 90, supplierId: sp.id });
    const counted = await mk({ name: 'Counted Long Ago', stock: 20, purchasePrice: 5 });
    const inFlight = await mk({ name: 'In Flight', stock: 8, purchasePrice: 5 });
    const cancelled = await mk({ name: 'Cancelled Only', stock: 8, purchasePrice: 5 });
    const other = await mk({ name: 'Other Cat', stock: 8, purchasePrice: 5, categoryId: cat2.id });
    const archived = await mk({ name: 'Archived One', stock: 8, purchasePrice: 5 });
    await as(S).del(`/products/${archived.id}`);

    // approved count (counted), a cancelled count (cancelled), and one still in progress (inFlight)
    let c = await open(S); await as(S).put(`/stock-counts/${c.id}/items/${counted.id}`, { counted: 20 }); await as(S).post(`/stock-counts/${c.id}/submit`); assert.equal((await as(S).post(`/stock-counts/${c.id}/approve`)).status, 200);
    c = await open(S); await as(S).put(`/stock-counts/${c.id}/items/${cancelled.id}`, { counted: 8 }); await as(S).post(`/stock-counts/${c.id}/cancel`);
    const live = await open(S); await as(S).put(`/stock-counts/${live.id}/items/${inFlight.id}`, { counted: 8 });
    const itemsBefore = await sql(S, 'SELECT count(*)::int AS n FROM stock_count_items', []);
    const stockBefore = await sql(S, 'SELECT id, stock::float AS s FROM products ORDER BY id', []);

    const get = async (qs = '') => { const r = await as(S).get(`/stock-counts/candidates${qs}`); assert.equal(r.status, 200, j(r)); return r.body.rows; };
    const all = await get();
    assert.ok(!all.some((x) => x.id === archived.id), 'active products only');
    const byId = Object.fromEntries(all.map((x) => [x.id, x]));
    assert.ok(byId[counted.id].lastCountedAt && !byId[counted.id].neverCounted, 'approved count sets lastCountedAt');
    assert.equal(byId[inFlight.id].lastCountedAt, null, 'a count in progress is not a completed count');
    assert.equal(byId[cancelled.id].lastCountedAt, null, 'a cancelled count is not a completed count');
    assert.deepEqual([byId[big.id].avgCost, byId[big.id].stockValue, byId[big.id].category, byId[big.id].supplier], [90, 9000, S.category.name || byId[big.id].category, 'Cycle Supplier']);

    assert.deepEqual((await get('?filter=low')).map((x) => x.id), [low.id]);
    const never = (await get('?filter=never')).map((x) => x.id);
    assert.ok(never.includes(inFlight.id) && never.includes(cancelled.id) && !never.includes(counted.id));
    const least = (await get('?filter=least_recent')).map((x) => x.id);
    assert.equal(least[least.length - 1], counted.id, 'never-counted first, the approved one last');
    assert.equal((await get('?filter=value'))[0].id, big.id, 'highest stock value first');
    assert.deepEqual((await get(`?categoryId=${cat2.id}`)).map((x) => x.id), [other.id]);
    assert.deepEqual((await get(`?supplierId=${sp.id}`)).map((x) => x.id), [big.id]);
    assert.deepEqual((await get(`?supplierId=${sp.id}&filter=value`)).map((x) => x.id), [big.id], 'filters combine');
    assert.ok(!(await get(`?countId=${live.id}`)).some((x) => x.id === inFlight.id), 'products already in that count are left out');
    assert.equal((await get('?limit=2')).length, 2);

    assert.equal((await as(S).get('/stock-counts/candidates?filter=nonsense')).status, 400);
    assert.equal((await as(S).get('/stock-counts/candidates?limit=9999')).status, 400);
    assert.deepEqual(await sql(S, 'SELECT count(*)::int AS n FROM stock_count_items', []), itemsBefore, 'creates no count rows');
    assert.deepEqual(await sql(S, 'SELECT id, stock::float AS s FROM products ORDER BY id', []), stockBefore, 'changes no stock');
  });

  test('authorization and tenant isolation: managers can read, cashiers get 403, another shop never sees these products', async () => {
    const p = await addProduct(api, A, { name: 'Iso Candidate', stock: 4 });
    assert.equal((await as(A, 'manager').get('/stock-counts/candidates')).status, 200);
    assert.equal((await as(A, 'cashier').get('/stock-counts/candidates')).status, 403);
    assert.equal((await api('').get('/stock-counts/candidates')).status, 401);
    const mine = (await as(A).get('/stock-counts/candidates?limit=200')).body.rows;
    assert.ok(mine.some((x) => x.id === p.id));
    assert.ok(!(await as(B).get('/stock-counts/candidates?limit=200')).body.rows.some((x) => x.id === p.id));
    // another shop's category / supplier / count ids simply match nothing
    assert.deepEqual((await as(B).get(`/stock-counts/candidates?categoryId=${A.category.id}`)).body.rows, []);
    const c = await open(A);
    assert.equal((await as(B).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 1, recount: true })).status, 404);
    await closeOpen(A);
  });
});
