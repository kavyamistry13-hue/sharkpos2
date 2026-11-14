// SHARKPOS 2 — Phase 17B: the offline storage layer of the browser (frontend/src/services/offline/*), run in Node against the in-memory
// adapter, which has the same interface and the same clone-on-write behaviour as IndexedDB. (The real IndexedDB adapter, including a real
// page reload, is exercised in a browser by the Phase 17B browser check.) No server or database is needed.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/sharkpos2_unused';   // only so services/barcodes.js can be required for the parity test; no connection is made
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', ...p)).href;

let O;                                   // the offline module namespace
test.before(async () => { O = await import(url('services', 'offline', 'index.js')); });

const key = () => crypto.randomUUID();
const A = { businessId: 1, userId: 10 };          // cashier A of shop 1
const B = { businessId: 1, userId: 11 };          // cashier B of the SAME shop
const C = { businessId: 2, userId: 10 };          // same user id in ANOTHER shop (ids are small integers in every tenant)
const sale = (over = {}) => ({
  key: key(), items: [{ productId: 5, quantity: 2 }], discount: null, paymentMethod: 'cash', expectedTotal: 10500,
  display: { lines: [{ productId: 5, name: 'Milk', unit: 'pcs', price: 50, quantity: 2, lineTotal: 100 }], bill: { subtotal: 100, discount: 0, discountPct: 0, tax: 5, taxIncluded: 0, taxAdded: 5, total: 105, itemCount: 2 }, cashierName: 'Asha' },
  ...over,
});
const product = (over = {}) => ({ id: 5, name: 'Milk', sku: 'MLK-1', category: 'Dairy', price: 50, stock: 10, taxRate: 5, unit: 'pcs', allowDecimal: false, priceIncludesTax: false, expiryDate: null, barcodes: ['8901234567890'], ...over });
const mem = () => O.createMemoryAdapter();

// ---------------------------------------------------------------- queue: creating
test('queue: a sale is stored pending with a stable key, a local receipt number and ONLY whitelisted fields', async () => {
  const a = mem(); const s = sale();
  const { record, duplicate } = await O.enqueueSale(a, A, { ...s, avgCost: 33, purchasePrice: 30, supplier: 'ACME', accessToken: 'secret', password: 'pw', customer: { name: 'X', phone: '999' } }, { now: Date.parse('2026-11-13T04:00:00Z') });
  assert.equal(duplicate, false);
  assert.equal(record.state, 'pending'); assert.equal(record.key, s.key); assert.equal(record.localRef, 'OFF-0001');
  assert.equal(record.capturedAt, '2026-11-13T04:00:00.000Z'); assert.equal(record.attempts, 0);
  assert.deepEqual(record.original, { expectedTotal: 10500 }); assert.equal(record.unverifiedTender, false);
  const text = JSON.stringify(await a.entries('queue')).toLowerCase();
  for (const forbidden of ['avgcost', 'avg_cost', 'purchase', 'supplier', 'accesstoken', 'secret', 'password', 'refresh', '"customer"', '999']) assert.ok(!text.includes(forbidden), `must not store ${forbidden}`);
});

test('queue: UPI and card are allowed but flagged UNVERIFIED; credit (udhaar) and unknown methods are refused offline', async () => {
  const a = mem();
  assert.equal((await O.enqueueSale(a, A, sale({ paymentMethod: 'upi' }))).record.unverifiedTender, true);
  assert.equal((await O.enqueueSale(a, A, sale({ paymentMethod: 'card' }))).record.unverifiedTender, true);
  assert.equal((await O.enqueueSale(a, A, sale({ paymentMethod: 'cash' }))).record.unverifiedTender, false);
  await assert.rejects(() => O.enqueueSale(a, A, sale({ paymentMethod: 'credit' })), (e) => e.code === 'OFFLINE_PAYMENT_NOT_SUPPORTED' && /udhaar/i.test(e.message));
  await assert.rejects(() => O.enqueueSale(a, A, sale({ paymentMethod: 'bitcoin' })), (e) => e.code === 'OFFLINE_PAYMENT_NOT_SUPPORTED');
  assert.equal((await O.listSales(a, A)).length, 3, 'refused sales leave nothing behind');
});

test('queue: invalid sales are refused (no key, empty, bad quantity/discount/total, too many lines)', async () => {
  const a = mem();
  const cases = [
    [{ key: 'not-a-uuid' }, 'OFFLINE_BAD_KEY'], [{ key: undefined }, 'OFFLINE_BAD_KEY'], [{ items: [] }, 'OFFLINE_EMPTY_SALE'],
    [{ items: [{ productId: 5, quantity: 0 }] }, 'OFFLINE_BAD_ITEM'], [{ items: [{ productId: 5, quantity: -1 }] }, 'OFFLINE_BAD_ITEM'],
    [{ items: [{ productId: 5, quantity: 0.0004 }] }, 'OFFLINE_BAD_ITEM'], [{ items: [{ productId: 'x', quantity: 1 }] }, 'OFFLINE_BAD_ITEM'],
    [{ discount: { type: 'percent', value: 101 } }, 'OFFLINE_BAD_DISCOUNT'], [{ discount: { type: 'free', value: 5 } }, 'OFFLINE_BAD_DISCOUNT'],
    [{ expectedTotal: 105.5 }, 'OFFLINE_BAD_TOTAL'], [{ expectedTotal: -1 }, 'OFFLINE_BAD_TOTAL'], [{ expectedTotal: undefined }, 'OFFLINE_BAD_TOTAL'],
    [{ items: Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, quantity: 1 })) }, 'OFFLINE_TOO_MANY_ITEMS'],
  ];
  for (const [over, code] of cases) await assert.rejects(() => O.enqueueSale(a, A, sale(over)), (e) => e.code === code, JSON.stringify(over).slice(0, 60));
  await assert.rejects(() => O.enqueueSale(a, null, sale()), (e) => e.code === 'OFFLINE_NO_SCOPE');
  assert.equal((await a.entries('queue')).length, 0);
});

test('queue: multiple offline sales keep order and numbering (oldest first); decimal quantities and discounts are kept', async () => {
  const a = mem(); const keys = [];
  for (let i = 0; i < 5; i++) { const s = sale({ items: [{ productId: 5, quantity: i + 0.5 }], discount: i === 2 ? { type: 'percent', value: 10 } : null }); keys.push(s.key); await O.enqueueSale(a, A, s, { now: 1700000000000 + i * 1000 }); }
  const list = await O.listSales(a, A);
  assert.deepEqual(list.map((r) => r.key), keys); assert.deepEqual(list.map((r) => r.localRef), ['OFF-0001', 'OFF-0002', 'OFF-0003', 'OFF-0004', 'OFF-0005']);
  assert.deepEqual(list[2].discount, { type: 'percent', value: 10 }); assert.equal(list[3].items[0].quantity, 3.5);
  assert.equal(await O.unsyncedCount(a, A), 5);
});

test('queue: a duplicate client key with the SAME sale stores nothing new; with a DIFFERENT sale it is refused', async () => {
  const a = mem(); const s = sale();
  const first = await O.enqueueSale(a, A, s);
  const again = await O.enqueueSale(a, A, { ...s }, { now: Date.now() + 60000 });
  assert.equal(again.duplicate, true); assert.equal(again.record.localRef, first.record.localRef); assert.equal(again.record.capturedAt, first.record.capturedAt);
  assert.equal((await O.listSales(a, A)).length, 1);
  await assert.rejects(() => O.enqueueSale(a, A, { ...s, items: [{ productId: 5, quantity: 3 }] }), (e) => e.code === 'OFFLINE_KEY_REUSED');
  await assert.rejects(() => O.enqueueSale(a, A, { ...s, paymentMethod: 'upi' }), (e) => e.code === 'OFFLINE_KEY_REUSED');
  await assert.rejects(() => O.enqueueSale(a, A, { ...s, expectedTotal: 9999 }), (e) => e.code === 'OFFLINE_KEY_REUSED');
  // two "tabs" enqueueing the same key at the same moment still store exactly one record
  const k2 = sale(); const both = await Promise.all([O.enqueueSale(a, A, k2), O.enqueueSale(a, A, { ...k2 })]);
  assert.deepEqual(both.map((r) => r.duplicate).sort(), [false, true]); assert.equal((await O.listSales(a, A)).length, 2);
});

test('queue: a full queue refuses another sale instead of growing without limit', async () => {
  const a = mem();
  for (let i = 0; i < O.MAX_QUEUE; i++) await a.put('queue', key(), { ...(await O.enqueueSale(mem(), A, sale())).record, key: key(), seq: i + 1, state: 'pending' });
  const rows = await a.entries('queue'); assert.equal(rows.length, O.MAX_QUEUE);
  await assert.rejects(() => O.enqueueSale(a, A, sale()), (e) => e.code === 'OFFLINE_QUEUE_FULL');
});

// ---------------------------------------------------------------- queue: state machine, immutability, idempotency key
test('state machine: the allowed paths work and everything else is refused', async () => {
  const a = mem(); const { record } = await O.enqueueSale(a, A, sale()); const k = record.key;
  await assert.rejects(() => O.markSynced(a, A, k), (e) => e.code === 'OFFLINE_BAD_TRANSITION', 'pending cannot jump to synced');
  await assert.rejects(() => O.dismissSale(a, A, k, { reason: 'because', decidedBy: 'x' }), (e) => e.code === 'OFFLINE_BAD_TRANSITION', 'a pending sale cannot be dismissed');
  let r = await O.markSyncing(a, A, k, { now: 1000 }); assert.equal(r.state, 'syncing'); assert.equal(r.attempts, 1);
  r = await O.markFailed(a, A, k, { code: 'NETWORK', message: 'offline', status: 0 }, { now: 2000 }); assert.equal(r.state, 'failed');
  assert.equal(r.lastError.code, 'NETWORK'); assert.equal(r.nextAttemptAt, new Date(2000 + 5000).toISOString());
  r = await O.markSyncing(a, A, k, { now: 9000 }); assert.equal(r.attempts, 2);
  r = await O.markFailed(a, A, k, { code: 'HTTP_503' }, { now: 10000 }); assert.equal(r.nextAttemptAt, new Date(10000 + 10000).toISOString(), 'back-off doubles');
  await O.markSyncing(a, A, k);
  r = await O.markSynced(a, A, k, { saleId: 77, invoiceNo: 'INV-20261113-00077', now: 5000 }); assert.equal(r.state, 'synced'); assert.equal(r.invoiceNo, 'INV-20261113-00077'); assert.equal(r.lastError, null);
  for (const to of [O.markSyncing, (x, y, z) => O.markFailed(x, y, z, {}), (x, y, z) => O.markNeedsReview(x, y, z, {})]) await assert.rejects(() => to(a, A, k), (e) => e.code === 'OFFLINE_BAD_TRANSITION', 'synced is terminal');
  assert.equal(O.backoffMs(1), 5000); assert.equal(O.backoffMs(2), 10000); assert.equal(O.backoffMs(30), 300000);
});

test('immutability: through every state the items, discount, payment, captured time, original total and KEY never change', async () => {
  const a = mem(); const s = sale({ discount: { type: 'amount', value: 5 }, paymentMethod: 'upi' }); const { record: first } = await O.enqueueSale(a, A, s);
  const core = (r) => JSON.stringify([r.key, r.items, r.discount, r.paymentMethod, r.capturedAt, r.original, r.localRef, r.seq, r.businessId, r.userId]);
  const snapshot = core(first);
  await O.markSyncing(a, A, s.key); await O.markNeedsReview(a, A, s.key, { code: 'OFFLINE_PRICE_CHANGED', status: 409, message: 'price' });
  assert.equal(core(await O.getSale(a, A, s.key)), snapshot);
  await O.retryAfterReview(a, A, s.key, { acceptTotalPaise: 11000, decidedBy: 'Manager' });
  const after = await O.getSale(a, A, s.key); assert.equal(core(after), snapshot);
  assert.equal(after.expectedTotal, 10500, 'what the customer was shown is never rewritten'); assert.equal(after.acceptedTotal, 11000); assert.equal(O.requestFor(after).body.acceptPriceTotal, 11000); assert.equal(after.original.expectedTotal, 10500, 'the original offline total is preserved');
  assert.equal(O.requestFor(after).idempotencyKey, s.key, 'the retry uses the ORIGINAL idempotency key');
  assert.deepEqual(O.requestFor(after).body.items, first.items);
  assert.deepEqual(O.requestFor(after).offlineHeader, { capturedAt: first.capturedAt, businessId: 1, localRef: first.localRef });
  // The record handed out is a copy: changing it changes nothing stored.
  const copy = await O.getSale(a, A, s.key); copy.items[0].quantity = 999; copy.key = 'x';
  assert.equal(core(await O.getSale(a, A, s.key)), snapshot);
});

test('needs_review is never retried automatically; only an explicit decision moves it (retry with or without accepting the price, or dismiss with a reason)', async () => {
  const a = mem(); const { record } = await O.enqueueSale(a, A, sale()); const k = record.key;
  await O.markSyncing(a, A, k); await O.markNeedsReview(a, A, k, { code: 'INSUFFICIENT_STOCK', status: 409, message: 'Only 1 left' });
  const r = await O.getSale(a, A, k); assert.equal(r.nextAttemptAt, null); assert.equal(r.lastError.code, 'INSUFFICIENT_STOCK');
  await assert.rejects(() => O.markSyncing(a, A, k), (e) => e.code === 'OFFLINE_BAD_TRANSITION', 'cannot be picked up by the sync loop');
  await assert.rejects(() => O.dismissSale(a, A, k, { reason: ' ', decidedBy: 'M' }), (e) => e.code === 'OFFLINE_REASON_REQUIRED');
  await assert.rejects(() => O.retryAfterReview(a, A, k, { acceptTotalPaise: 1.5 }), (e) => e.code === 'OFFLINE_BAD_TOTAL');
  const back = await O.retryAfterReview(a, A, k, { decidedBy: 'Manager' }); assert.equal(back.state, 'pending'); assert.equal(back.expectedTotal, 10500);
  assert.deepEqual(back.decisions.map((d) => d.type), ['retry']);
  await O.markSyncing(a, A, k); await O.markNeedsReview(a, A, k, { code: 'INSUFFICIENT_STOCK' });
  const dismissed = await O.dismissSale(a, A, k, { reason: 'Customer returned the goods', decidedBy: 'Manager' });
  assert.equal(dismissed.state, 'dismissed'); assert.equal(dismissed.decisions.at(-1).reason, 'Customer returned the goods');
  assert.equal(await O.unsyncedCount(a, A), 0); assert.ok(await O.getSale(a, A, k), 'a dismissed sale is kept, not deleted');
});

// ---------------------------------------------------------------- persistence across reload
test('reload: queued sales survive a new session on the same storage; a request that was in flight becomes pending again with the SAME key', async () => {
  const storage = mem();                                         // the "disk": one adapter object shared by two page lifetimes
  const s1 = sale(); const s2 = sale(); const s3 = sale();
  for (const s of [s1, s2, s3]) await O.enqueueSale(storage, A, s);
  await O.markSyncing(storage, A, s1.key); await O.markSynced(storage, A, s1.key, { saleId: 1, invoiceNo: 'INV-1' });
  await O.markSyncing(storage, A, s2.key);                       // the tab dies here: the response never arrives
  // ---- page reload: everything in memory is gone; only `storage` remains
  const res = await O.onSessionStart(storage, A);
  assert.equal(res.recovered, 1);
  const list = await O.listSales(storage, A);
  assert.deepEqual(list.map((r) => [r.key, r.state]), [[s1.key, 'synced'], [s2.key, 'pending'], [s3.key, 'pending']]);
  assert.equal(list[1].attempts, 1, 'the attempt count is kept');
  assert.equal(O.requestFor(list[1]).idempotencyKey, s2.key);
  // numbering continues after a reload instead of restarting
  assert.equal((await O.enqueueSale(storage, A, sale())).record.localRef, 'OFF-0004');
  assert.equal((await O.countsByState(storage, A)).pending, 3);
});

// ---------------------------------------------------------------- isolation
test('isolation: another user, another shop, even the SAME user id in another shop, can neither see nor touch a queue', async () => {
  const a = mem(); const s = sale(); await O.enqueueSale(a, A, s);
  for (const other of [B, C]) {
    assert.deepEqual(await O.listSales(a, other), []); assert.equal(await O.getSale(a, other, s.key), null);
    assert.equal(await O.unsyncedCount(a, other), 0); assert.equal((await O.queuedQuantities(a, other)).size, 0);
    for (const act of [(k) => O.markSyncing(a, other, k), (k) => O.markFailed(a, other, k, {}), (k) => O.markSynced(a, other, k), (k) => O.retryAfterReview(a, other, k, {}), (k) => O.dismissSale(a, other, k, { reason: 'steal' })]) {
      await assert.rejects(() => act(s.key), (e) => e.code === 'OFFLINE_NOT_FOUND' || e.code === 'OFFLINE_BAD_TRANSITION');
    }
    await assert.rejects(() => O.enqueueSale(a, other, { ...s }), (e) => e.code === 'OFFLINE_KEY_REUSED', 'cannot re-use or overwrite another user\'s key');
    assert.equal(await O.foreignCount(a, other), 1, 'only a COUNT of foreign unsynced sales is visible');
    assert.equal(await O.discardQueue(a, other, {}), 0);
    assert.equal((await O.exportUnsynced(a, other)).includes(s.key), false);
  }
  assert.equal((await O.getSale(a, A, s.key)).state, 'pending', 'the owner\'s sale is untouched');
  await assert.rejects(() => O.getSale(a, { businessId: 0, userId: 1 }, s.key), (e) => e.code === 'OFFLINE_NO_SCOPE');
});

test('isolation: each user gets their own receipt numbering and stock promises', async () => {
  const a = mem();
  await O.enqueueSale(a, A, sale({ items: [{ productId: 5, quantity: 3 }] })); await O.enqueueSale(a, B, sale({ items: [{ productId: 5, quantity: 4 }] }));
  assert.equal((await O.listSales(a, A))[0].localRef, 'OFF-0001'); assert.equal((await O.listSales(a, B))[0].localRef, 'OFF-0001');
  assert.equal((await O.queuedQuantities(a, A)).get(5), 3); assert.equal((await O.queuedQuantities(a, B)).get(5), 4);
});

test('scopeOf: built only from a real signed-in business user; a platform admin or a bad object gives no scope', () => {
  assert.deepEqual(O.scopeOf({ id: 10, businessId: 1, role: 'cashier' }), { businessId: 1, userId: 10 });
  assert.equal(O.scopeOf({ id: 1, businessId: null, role: 'platform_admin' }), null);
  assert.equal(O.scopeOf(null), null); assert.equal(O.scopeOf({ id: 'x', businessId: 1 }), null); assert.equal(O.scopeOf({ id: 3 }), null);
});

// ---------------------------------------------------------------- logout / user switch
test('logout: warns about unsynced sales first, then deletes the catalog but KEEPS the sales; only the same user sees them after signing back in', async () => {
  const a = mem();
  await O.saveCatalog(a, A, { rows: [product()] }); await O.enqueueSale(a, A, sale()); const done = sale(); await O.enqueueSale(a, A, done);
  await O.markSyncing(a, A, done.key); await O.markSynced(a, A, done.key, { saleId: 1 });
  const prep = await O.prepareLogout(a, A); assert.deepEqual(prep, { unsynced: 1, needsReview: 0, pending: 1 });
  assert.equal((await O.listSales(a, A)).length, 2, 'prepareLogout changes nothing');
  assert.equal((await O.completeLogout(a, A)).unsynced, 1);
  assert.equal(await O.loadCatalog(a, A), null, 'product data is gone');
  assert.equal((await a.entries('catalog')).length, 0);
  assert.equal(await O.unsyncedCount(a, B), 0); assert.equal(await O.foreignCount(a, B), 1);
  assert.equal(await O.unsyncedCount(a, A), 1, 'the unsynced sale is still there for its owner');
});

test('user switch: signing in as someone else purges every other catalog, keeps their queue untouched and reports it', async () => {
  const a = mem();
  await O.saveCatalog(a, A, { rows: [product()] }); await O.saveCatalog(a, C, { rows: [product({ id: 9, name: 'Other shop item' })] });
  await O.enqueueSale(a, A, sale());
  const r = await O.onSessionStart(a, B);
  assert.equal(r.purgedCatalogs, 2); assert.equal(r.foreignUnsynced, 1);
  assert.equal((await a.entries('catalog')).length, 0);
  assert.equal((await O.listSales(a, B)).length, 0);
  assert.equal((await O.getSale(a, A, (await O.listSales(a, A))[0].key)).state, 'pending');
});

test('discard: removing unsynced sales needs an explicit confirmation; wipeUserData clears the catalog and numbering too', async () => {
  const a = mem(); await O.saveCatalog(a, A, { rows: [product()] }); await O.enqueueSale(a, A, sale());
  await assert.rejects(() => O.discardQueue(a, A), (e) => e.code === 'OFFLINE_UNSYNCED_SALES' && e.details.unsynced === 1);
  await assert.rejects(() => O.wipeUserData(a, A, {}), (e) => e.code === 'OFFLINE_UNSYNCED_SALES');
  assert.equal((await O.listSales(a, A)).length, 1);
  const exported = JSON.parse(await O.exportUnsynced(a, A)); assert.equal(exported.sales.length, 1); assert.deepEqual(exported.scope, A);
  assert.equal((await O.wipeUserData(a, A, { confirmDiscardUnsyncedSales: true })).discarded, 1);
  assert.deepEqual([(await O.listSales(a, A)).length, await O.loadCatalog(a, A), (await a.entries('meta')).length], [0, null, 0]);
});

test('housekeeping: finished sales are pruned after a week; unsynced ones never are', async () => {
  const a = mem(); const old = sale(); const keep = sale(); const day = 24 * 3600e3; const t0 = Date.parse('2026-11-01T00:00:00Z');
  await O.enqueueSale(a, A, old, { now: t0 }); await O.markSyncing(a, A, old.key, { now: t0 }); await O.markSynced(a, A, old.key, { now: t0 });
  await O.enqueueSale(a, A, keep, { now: t0 });
  assert.equal(await O.pruneFinished(a, A, { now: t0 + 3 * day }), 0);
  assert.equal(await O.pruneFinished(a, A, { now: t0 + 8 * day }), 1);
  assert.deepEqual((await O.listSales(a, A)).map((r) => r.key), [keep.key]);
});

// ---------------------------------------------------------------- catalog
test('catalog: only whitelisted fields are kept — cost, supplier and anything unexpected are dropped; bad rows are skipped; duplicates collapse', async () => {
  const a = mem();
  const rec = await O.saveCatalog(a, A, { generatedAt: '2026-11-13T00:00:00Z', rows: [{ ...product(), avgCost: 31, purchasePrice: 30, supplierId: 4, supplier: 'ACME', margin: 20, costHistory: [1] }, product(), { id: 'x', name: 'bad' }, { id: 6, name: 'NoPrice', price: 'abc', stock: 1, taxRate: 5 }, product({ id: 7, name: 'Rice', sku: 'RC', barcodes: 'nope', expiryDate: 'soon' })] });
  assert.equal(rec.count, 2); assert.deepEqual(Object.keys(rec.rows[0]).sort(), ['allowDecimal', 'barcodes', 'category', 'expiryDate', 'id', 'name', 'price', 'priceIncludesTax', 'sku', 'stock', 'taxRate', 'unit']);
  assert.deepEqual(rec.rows[1].barcodes, []); assert.equal(rec.rows[1].expiryDate, null);
  const text = JSON.stringify(await a.entries('catalog')).toLowerCase();
  for (const f of ['avgcost', 'purchase', 'supplier', 'margin', 'costhistory', 'acme']) assert.ok(!text.includes(f), f);
});

test('catalog: belongs to ONE business+user — another scope never reads it, and a record stamped for someone else is ignored', async () => {
  const a = mem(); await O.saveCatalog(a, A, { rows: [product()] });
  assert.equal(await O.loadCatalog(a, B), null); assert.equal(await O.loadCatalog(a, C), null); assert.equal((await O.loadCatalog(a, A)).count, 1);
  const forged = { ...(await O.loadCatalog(a, A)), businessId: 99 }; await a.put('catalog', 'catalog:1:10', forged);
  assert.equal(await O.loadCatalog(a, A), null, 'a mis-stamped record is not trusted');
});

test('catalog: downloads every page, never replaces a good cache with a half-downloaded one, and does not refresh while sales are waiting', async () => {
  const a = mem(); await O.saveCatalog(a, A, { generatedAt: '2026-11-12T00:00:00Z', rows: [product({ name: 'OLD' })] });
  const all = Array.from({ length: 7 }, (_, i) => product({ id: i + 1, name: `P${i + 1}`, sku: `S${i + 1}`, barcodes: [] }));
  const calls = [];
  const apiGet = async (p, { after, limit }) => { calls.push([after, limit]); const rows = all.filter((x) => x.id > after).slice(0, limit); return { generatedAt: '2026-11-13T01:00:00Z', nextAfter: rows.length === limit && rows.at(-1).id < 7 ? rows.at(-1).id : null, rows }; };
  const failing = async (p, q) => { if (q.after > 0) throw new Error('network'); return apiGet(p, q); };
  await assert.rejects(() => O.refreshCatalog(a, A, failing, { pageSize: 3 }), /network/);
  assert.equal((await O.loadCatalog(a, A)).rows[0].name, 'OLD', 'the previous cache survives a failed download');
  await O.enqueueSale(a, A, sale());
  assert.deepEqual(await O.refreshCatalog(a, A, apiGet, { pageSize: 3 }), { skipped: 'UNSYNCED_SALES' });
  assert.equal((await O.loadCatalog(a, A)).rows[0].name, 'OLD');
  const forced = await O.refreshCatalog(a, A, apiGet, { pageSize: 3, force: true });
  assert.equal(forced.record.count, 7); assert.deepEqual(calls.slice(-3).map((c) => c[0]), [0, 3, 6]);
  assert.equal((await O.loadCatalog(a, A)).generatedAt, '2026-11-13T01:00:00Z');
});

test('catalog: staleness — none / fresh / stale after 24 hours (usable, but the screen must warn)', () => {
  const rec = { generatedAt: '2026-11-13T00:00:00.000Z', count: 3 }; const t = Date.parse('2026-11-13T00:00:00.000Z');
  assert.equal(O.catalogStatus(null).level, 'none'); assert.equal(O.catalogStatus(null).present, false);
  assert.equal(O.catalogStatus(rec, t + 3600e3).level, 'fresh'); assert.equal(O.catalogStatus(rec, t + 24 * 3600e3).level, 'fresh');
  const stale = O.catalogStatus(rec, t + 24 * 3600e3 + 1); assert.equal(stale.level, 'stale'); assert.equal(stale.present, true);
});

test('catalog search: name / SKU / category / barcode; hides out-of-stock and expired like pos-search; barcode forms (UPC-A ↔ EAN-13) match; SKU fallback', async () => {
  const a = mem();
  const rec = await O.saveCatalog(a, A, { rows: [
    product({ id: 1, name: 'Amul Milk', sku: 'MLK', barcodes: ['8901234567895'] }), product({ id: 2, name: 'Rice 5kg', sku: 'RICE5', category: 'Grain', barcodes: ['036000291452'] }),
    product({ id: 3, name: 'Sold Out', stock: 0 }), product({ id: 4, name: 'Old Yoghurt', expiryDate: '2026-01-01' }), product({ id: 5, name: 'Salt', sku: 'SALT', category: 'Grain', barcodes: [] }),
  ] });
  const idx = O.buildIndex(rec); const names = (q) => O.searchProducts(idx, q, { today: '2026-11-13' }).map((p) => p.name);
  assert.deepEqual(names(''), ['Amul Milk', 'Rice 5kg', 'Salt']);
  assert.deepEqual(names('milk'), ['Amul Milk']); assert.deepEqual(names('grain'), ['Rice 5kg', 'Salt']); assert.deepEqual(names('rice5'), ['Rice 5kg']);
  assert.deepEqual(names('sold out'), []); assert.deepEqual(names('yoghurt'), []);
  assert.equal(O.findByCode(idx, '036000291452').product.id, 2);
  assert.equal(O.findByCode(idx, '0036000291452').product.id, 2, 'EAN-13 reading of a stored UPC-A');
  assert.equal(O.findByCode(idx, ' 8901234567895\r\n').matchedBy, 'barcode');
  assert.equal(O.findByCode(idx, 'salt').matchedBy, 'sku');
  assert.equal(O.findByCode(idx, '0000000000000'), null); assert.equal(O.findByCode(idx, ''), null);
});

test('catalog: barcode equivalence is IDENTICAL to the server\'s rule (parity with backend services/barcodes.js)', () => {
  const server = require('../src/services/barcodes');
  const gs1 = (body) => { const d = body.split('').map(Number); let sum = 0; for (let i = d.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += d[i] * w; return body + ((10 - (sum % 10)) % 10); };
  const codes = ['', 'ABC-123', '12345', '8901234567895', '8901234567890', '036000291452', '0036000291452', '00036000291452', '96385074', '0000096385074', '4006381333931', '00012345678905'];
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const len of [7, 11, 12, 13]) for (let i = 0; i < 40; i++) codes.push(gs1(Array.from({ length: len }, () => Math.floor(rnd() * 10)).join('')));
  for (const c of codes) if (c) assert.deepEqual(O.equivalents(c), server.equivalents(c), `equivalents(${c})`);
});

test('catalog: stock the till may still promise = cached stock minus quantities already sold offline (never negative)', async () => {
  const a = mem(); await O.enqueueSale(a, A, sale({ items: [{ productId: 5, quantity: 3 }] })); await O.enqueueSale(a, A, sale({ items: [{ productId: 5, quantity: 4.5 }] }));
  const q = await O.queuedQuantities(a, A);
  assert.equal(q.get(5), 7.5); assert.equal(O.availableStock(product({ stock: 10 }), q), 2.5); assert.equal(O.availableStock(product({ stock: 5 }), q), 0);
  const k = (await O.listSales(a, A))[0].key; await O.markSyncing(a, A, k); await O.markSynced(a, A, k);
  assert.equal((await O.queuedQuantities(a, A)).get(5), 4.5, 'a synced sale no longer counts');
  const k2 = (await O.listSales(a, A))[1].key; await O.markSyncing(a, A, k2); await O.markNeedsReview(a, A, k2, { code: 'INSUFFICIENT_STOCK' });
  assert.equal((await O.queuedQuantities(a, A)).get(5), 4.5, 'a needs_review sale still counts: the goods left the shop');
});

// ---------------------------------------------------------------- storage adapter
test('adapter: update() is read-modify-write in one step and a refused change leaves the stored value as it was; values are cloned', async () => {
  const a = mem(); await a.put('meta', 'n', { v: 1 });
  assert.equal(await a.update('meta', 'n', (p) => ({ write: { v: p.v + 1 }, result: p.v + 1 })), 2);
  await assert.rejects(() => a.update('meta', 'n', () => { throw new Error('refused'); }), /refused/);
  assert.deepEqual(await a.get('meta', 'n'), { v: 2 });
  const got = await a.get('meta', 'n'); got.v = 99; assert.deepEqual(await a.get('meta', 'n'), { v: 2 });
  await a.update('meta', 'n', () => ({ del: true })); assert.equal(await a.get('meta', 'n'), undefined);
  await assert.rejects(() => a.get('nope', 'x'), (e) => e.code === 'OFFLINE_STORAGE_ERROR');
  assert.equal(O.indexedDbAvailable(undefined), false); assert.equal(O.indexedDbAvailable({}), false);
  assert.equal(await O.openOfflineStorage({ factory: undefined }), null, 'no IndexedDB → offline selling is off, never silently in memory');
  await assert.rejects(() => O.openIndexedDbAdapter({ factory: undefined }), (e) => e.code === 'OFFLINE_STORAGE_UNAVAILABLE');
});

test('pricing: priceCart is exactly computeBill over catalog rows (no second tax engine); a product missing from the catalog is refused', async () => {
  const shared = await import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'billing.mjs')).href);
  const rec = await O.saveCatalog(mem(), A, { rows: [product({ id: 1, price: 99.99, taxRate: 18 }), product({ id: 2, name: 'Tea', sku: 'T', price: 120, taxRate: 5, priceIncludesTax: true }), product({ id: 3, name: 'Rice', sku: 'R', price: 63.5, taxRate: 12, unit: 'kg', allowDecimal: true })] });
  const byId = O.buildIndex(rec).byId; const cart = [{ productId: 1, quantity: 3 }, { productId: 2, quantity: 2 }, { productId: 3, quantity: 1.25 }];
  const bill = O.priceCart(cart, byId, { type: 'percent', value: 7.5 });
  assert.deepEqual(bill, shared.computeBill(O.billLinesFor(cart, byId), { type: 'percent', value: 7.5 }));
  assert.equal(O.totalPaise(bill), Math.round(bill.total * 100));
  assert.throws(() => O.priceCart([{ productId: 99, quantity: 1 }], byId), /not in the offline catalog/);
});

test('shared billing: the browser module loads the SAME file as the API (no second tax engine)', async () => {
  const shared = await import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'billing.mjs')).href);
  assert.equal(require('../src/services/billing').computeBill, shared.computeBill);
  const rec = await O.saveCatalog(mem(), A, { rows: [product({ price: 99.99, taxRate: 18 }), product({ id: 6, name: 'Tea', sku: 'T', price: 120, taxRate: 5, priceIncludesTax: true })] });
  const bill = shared.computeBill(rec.rows.map((p) => ({ productId: p.id, name: p.name, quantity: 2, unitPaise: shared.toPaise(p.price), taxRate: p.taxRate, priceIncludesTax: p.priceIncludesTax })), { type: 'percent', value: 10 });
  assert.equal(Number.isInteger(Math.round(bill.total * 100)), true); assert.ok(bill.total > 0);
});
