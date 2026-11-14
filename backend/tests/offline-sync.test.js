// SHARKPOS 2 — Phase 17C: the REAL browser sync engine (frontend/src/services/offline/*) talking to the REAL API and database.
// Every request goes through POST /sales exactly as a till would send it. The assertions are about what the SERVER ends up with:
// one sale, one stock movement, the right stock, an audit trail, and no cross-tenant leakage.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let O;
const url = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', ...p)).href;
test.before(async () => { env = await boot(); api = client(env.base); O = await import(url('services', 'offline', 'index.js')); });
test.after(async () => { await env.close(); });

const tq = (shop, text, params) => env.db.runAsTenant(shop.businessId, () => env.db.query(text, params)).then((r) => r.rows);
const stockOf = async (shop, p) => Number((await tq(shop, 'SELECT stock FROM products WHERE id = $1', [p.id]))[0].stock);
const count = async (shop, table, where = 'TRUE', params = []) => (await tq(shop, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n;
const saleMovements = (shop, p) => count(shop, 'inventory_movements', `product_id = $1 AND movement_type = 'sale'`, [p.id]);
const scopeOf = (shop, who = 'cashier') => ({ businessId: shop.businessId, userId: shop[who].id });
const mem = () => O.createMemoryAdapter();

/** The sender the app uses (api.post → { status, data }), but over the test HTTP client. `hooks.afterCommit` simulates a lost response. */
function httpSender(token, hooks = {}) {
  const calls = [];
  const send = async (req) => {
    calls.push(req.idempotencyKey);
    const r = await api(token).post('/sales', req.approval ? { ...req.body, approval: req.approval } : req.body, { 'idempotency-key': req.idempotencyKey, 'x-offline-sale': JSON.stringify(req.offlineHeader) });
    if (hooks.dropAfterCommit && r.status < 300 && hooks.dropAfterCommit()) throw new Error('connection reset');
    return { status: r.status, data: r.status < 300 ? r.body : { error: r.body.error, details: r.body.details } };
  };
  return Object.assign(send, { calls });
}
const httpDismisser = (token) => async (req) => { const r = await api(token).post('/sales/offline-dismissals', req); if (r.status >= 300) throw Object.assign(new Error(r.body.error), { status: r.status, details: r.body.details }); return r.body; };
const httpReporter = (token) => async (issues) => { const r = await api(token).post('/sales/sync-issues', { issues }); if (r.status >= 300) throw new Error(r.body.error); return r.body; };
const engine = (a, shop, over = {}) => {
  const who = over.who || 'cashier';
  return O.createSyncEngine({ adapter: a, scope: scopeOf(shop, who), role: who === 'owner' ? 'business_owner' : who, send: httpSender(shop[who].token), probe: async () => true, report: httpReporter(shop[who].token), dismiss: httpDismisser(shop[who].token), locks: null, ...over });
};

/** Enqueue exactly like the offline POS will: price from the downloaded catalog with the SHARED computeBill, expectedTotal in paise. */
async function ringUp(a, shop, cart, { paymentMethod = 'cash', discount = null, who = 'cashier', now } = {}) {
  const scope = scopeOf(shop, who);
  const catalog = await O.loadCatalog(a, scope); const byId = O.buildIndex(catalog).byId;
  const bill = O.priceCart(cart, byId, discount);
  const key = crypto.randomUUID();
  const { record } = await O.enqueueSale(a, scope, { key, items: cart, discount, paymentMethod, expectedTotal: O.totalPaise(bill), display: { lines: [], bill } }, { now });
  return record;
}
const download = async (a, shop, who = 'cashier') => O.refreshCatalog(a, scopeOf(shop, who), async (p, q) => { const r = await api(shop[who].token).get(`${p}?after=${q.after}&limit=${q.limit}`); assert.equal(r.status, 200); return r.body; });
const stateOf = async (a, shop, key, who = 'cashier') => (await O.getSale(a, scopeOf(shop, who), key));

test('journey: catalog download → offline sales priced in the browser (cash, UPI, card; kg + discount) → sync → the server agrees with every rupee, stock moves ONCE', async () => {
  const shop = await makeShop(api); const o = api(shop.owner.token);
  const cat = (await o.post('/categories', { name: uniq('GST18 '), taxRate: 18 })).body;
  const milk = await addProduct(api, shop, { sellingPrice: 49.5, purchasePrice: 40, stock: 30 });
  const rice = await addProduct(api, shop, { categoryId: cat.id, sellingPrice: 63.5, purchasePrice: 50, stock: 40, unit: 'kg', priceIncludesTax: true });
  const soap = await addProduct(api, shop, { categoryId: cat.id, sellingPrice: 120, purchasePrice: 90, stock: 12 });
  const a = mem(); const dl = await download(a, shop); assert.equal(dl.record.count, 3);
  const avg = async (p) => (await tq(shop, 'SELECT avg_cost FROM products WHERE id = $1', [p.id]))[0].avg_cost;
  const avgBefore = [await avg(milk), await avg(rice), await avg(soap)];

  const s1 = await ringUp(a, shop, [{ productId: milk.id, quantity: 3 }, { productId: soap.id, quantity: 1 }]);
  const s2 = await ringUp(a, shop, [{ productId: rice.id, quantity: 2.35 }], { paymentMethod: 'upi', discount: { type: 'percent', value: 7.5 } });
  const s3 = await ringUp(a, shop, [{ productId: milk.id, quantity: 2 }, { productId: rice.id, quantity: 0.5 }], { paymentMethod: 'card', discount: { type: 'amount', value: 10 } });
  assert.equal(await count(shop, 'sales'), 0, 'nothing reaches the server while offline');
  assert.deepEqual([await stockOf(shop, milk), await stockOf(shop, rice), await stockOf(shop, soap)], [30, 40, 12]);

  const e = engine(a, shop); const r = await e.syncNow();
  assert.deepEqual([r.synced, r.failed, r.needsReview], [3, 0, 0], JSON.stringify(await O.listSales(a, scopeOf(shop))));
  assert.deepEqual([await stockOf(shop, milk), await stockOf(shop, rice), await stockOf(shop, soap)], [25, 37.15, 11]);
  for (const [p, n] of [[milk, 2], [rice, 2], [soap, 1]]) assert.equal(await saleMovements(shop, p), n, `${p.name}: one movement per sale line`);
  assert.deepEqual([await avg(milk), await avg(rice), await avg(soap)], avgBefore, 'avg_cost is never changed by a sale');

  const rows = await O.listSales(a, scopeOf(shop));
  assert.ok(rows.every((x) => x.state === 'synced' && x.saleId && /^INV-/.test(x.invoiceNo)));
  for (const rec of rows) {
    const sale = (await tq(shop, 'SELECT total, created_at FROM sales WHERE id = $1', [rec.saleId]))[0];
    assert.equal(Math.round(Number(sale.total) * 100), rec.original.expectedTotal, `${rec.localRef}: the server total equals what the customer was shown offline`);
    assert.ok(Math.abs(sale.created_at.getTime() - Date.now()) < 60e3, 'created_at is the sync time');
  }
  assert.deepEqual((await tq(shop, `SELECT p.method FROM sale_payments p ORDER BY p.sale_id, p.id`)).map((x) => x.method), ['cash', 'upi', 'card']);
  const audits = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.created' ORDER BY id`);
  assert.deepEqual(audits.map((x) => x.new_value.offline.localRef), ['OFF-0001', 'OFF-0002', 'OFF-0003']);
  assert.ok(audits.every((x) => Date.parse(x.new_value.offline.capturedAt) <= Date.parse(x.new_value.offline.syncedAt)));
  assert.equal((await e.syncNow()).attempted, 0); assert.equal(await count(shop, 'sales'), 3, 'a second sync changes nothing');
  assert.ok(s1 && s2 && s3);
});

test('lost response after the sale committed: the retry returns the ORIGINAL sale — one sale, one movement, stock deducted once', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const a = mem(); await download(a, shop); const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 4 }]);
  let drop = true; const send = httpSender(shop.cashier.token, { dropAfterCommit: () => { const d = drop; drop = false; return d; } });
  const e = engine(a, shop, { send });
  let r = await e.syncNow(); assert.equal(r.stoppedBecause, 'NETWORK');
  assert.equal(await count(shop, 'sales'), 1, 'the server committed'); assert.equal((await stateOf(a, shop, rec.key)).state, 'failed');
  r = await e.syncNow({ force: true }); assert.equal(r.synced, 1);
  assert.equal(await count(shop, 'sales'), 1); assert.equal(await saleMovements(shop, p), 1); assert.equal(await stockOf(shop, p), 6);
  assert.deepEqual(send.calls, [rec.key, rec.key], 'the same idempotency key both times');
  assert.equal((await stateOf(a, shop, rec.key)).state, 'synced');
});

test('stock conflict (10 in stock; another till sells 6; this till sold 7 offline): needs_review, nothing written, quantity kept, reported; after a manager adds stock the SAME sale goes through once', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 10 });
  const a = mem(); await download(a, shop);
  const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 7 }]);                  // offline: the till still believes 10 are in stock
  assert.equal((await api(shop.owner.token).post('/sales', { items: [{ productId: p.id, quantity: 6 }], paymentMethod: 'cash' })).status, 201);   // another till, online
  const sales0 = await count(shop, 'sales'); const mv0 = await count(shop, 'inventory_movements');
  const e = engine(a, shop); const r = await e.syncNow();
  assert.deepEqual([r.synced, r.needsReview], [0, 1]);
  const stuck = await stateOf(a, shop, rec.key);
  assert.equal(stuck.state, 'needs_review'); assert.equal(stuck.lastError.code, 'INSUFFICIENT_STOCK'); assert.equal(stuck.lastError.status, 409);
  assert.deepEqual(stuck.lastError.details, { productId: p.id, name: p.name, available: 4, requested: 7 });
  assert.deepEqual(stuck.items, [{ productId: p.id, quantity: 7 }], 'the quantity is never silently changed');
  assert.equal(await stockOf(shop, p), 4, 'stock never goes negative'); assert.equal(await count(shop, 'sales'), sales0); assert.equal(await count(shop, 'inventory_movements'), mv0, 'no partial movement');
  const issues = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.offline_sync_issue'`);
  assert.equal(issues.length, 1); assert.equal(issues[0].new_value.code, 'INSUFFICIENT_STOCK'); assert.equal(issues[0].new_value.key, rec.key);
  await e.syncNow({ force: true }); assert.equal(await count(shop, 'sales'), sales0, 'a needs_review sale is not retried by itself');
  assert.equal((await e.syncNow({ force: true })).attempted, 0);

  // A manager makes the books match reality (the goods did leave the shop), then the cashier retries.
  assert.equal((await api(shop.manager.token).post(`/inventory/${p.id}/adjust`, { delta: 5, reason: 'found_stock', note: 'offline sale reconciliation' })).status, 201);
  await e.resolve(rec.key, { action: 'retry', decidedBy: 'Asha' });
  const r2 = await e.syncNow();
  assert.equal(r2.synced, 1); assert.equal(await stockOf(shop, p), 2); assert.equal(await count(shop, 'sales'), sales0 + 1); assert.equal(await saleMovements(shop, p), 2);
  assert.equal((await stateOf(a, shop, rec.key)).state, 'synced');
  assert.equal((await e.syncNow({ force: true })).attempted, 0); assert.equal(await count(shop, 'sales'), sales0 + 1);
});

test('oldest first: when two offline sales compete for the last stock the EARLIER one wins and the later one needs review', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 5 });
  const a = mem(); await download(a, shop);
  const first = await ringUp(a, shop, [{ productId: p.id, quantity: 4 }], { now: Date.now() - 5000 }); const second = await ringUp(a, shop, [{ productId: p.id, quantity: 3 }], { now: Date.now() - 4000 });
  const r = await engine(a, shop).syncNow();
  assert.deepEqual([r.synced, r.needsReview], [1, 1]);
  assert.equal((await stateOf(a, shop, first.key)).state, 'synced'); assert.equal((await stateOf(a, shop, second.key)).state, 'needs_review');
  assert.equal(await stockOf(shop, p), 1);
});

test('partial batch: [ok, conflict, ok] → the good sales sync, only the conflicting one waits, and it leaves no residue', async () => {
  const shop = await makeShop(api); const p1 = await addProduct(api, shop, { stock: 10 }); const p2 = await addProduct(api, shop, { stock: 1 }); const p3 = await addProduct(api, shop, { stock: 10 });
  const a = mem(); await download(a, shop);
  const k1 = await ringUp(a, shop, [{ productId: p1.id, quantity: 2 }]); const k2 = await ringUp(a, shop, [{ productId: p2.id, quantity: 1 }, { productId: p1.id, quantity: 1 }]); const k3 = await ringUp(a, shop, [{ productId: p3.id, quantity: 2 }]);
  assert.equal((await api(shop.owner.token).post('/sales', { items: [{ productId: p2.id, quantity: 1 }], paymentMethod: 'cash' })).status, 201);   // someone else bought the last p2
  const r = await engine(a, shop).syncNow();
  assert.deepEqual([r.synced, r.needsReview], [2, 1]);
  assert.deepEqual([k1, k2, k3].map(() => null).length, 3);
  assert.equal((await stateOf(a, shop, k1.key)).state, 'synced'); assert.equal((await stateOf(a, shop, k2.key)).state, 'needs_review'); assert.equal((await stateOf(a, shop, k3.key)).state, 'synced');
  assert.deepEqual([await stockOf(shop, p1), await stockOf(shop, p2), await stockOf(shop, p3)], [8, 0, 8], 'the conflicting sale took NOTHING, not even its p1 line');
  assert.equal(await saleMovements(shop, p1), 1);
});

test('price change while offline: needs_review with the server figures, no sale, nothing moved; only a manager can accept the new price; then it syncs once at the new total', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const a = mem(); await download(a, shop); const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 2 }]);
  await api(shop.owner.token).put(`/products/${p.id}`, { sellingPrice: 60 });
  const cashier = engine(a, shop); await cashier.syncNow();
  const stuck = await stateOf(a, shop, rec.key);
  assert.equal(stuck.state, 'needs_review'); assert.equal(stuck.lastError.code, 'OFFLINE_PRICE_CHANGED');
  assert.deepEqual(stuck.lastError.details, { expectedTotal: 105, currentTotal: 126, difference: 21 });
  assert.equal(await count(shop, 'sales'), 0); assert.equal(await stockOf(shop, p), 10);
  // A cashier cannot accept the new price on their own: the SERVER refuses, nothing is recorded, the sale stays on the device for review.
  await cashier.resolve(rec.key, { action: 'accept_price', decidedBy: 'Cash' }); await cashier.syncNow();
  let again = await stateOf(a, shop, rec.key);
  assert.equal(again.state, 'needs_review'); assert.equal(again.lastError.code, 'OFFLINE_PRICE_APPROVAL_REQUIRED'); assert.equal(again.expectedTotal, 10500);
  assert.equal(await count(shop, 'sales'), 0); assert.equal(await stockOf(shop, p), 10);
  // A wrong manager password is refused too (and again nothing is recorded); a CASHIER's credentials are never accepted as a manager's.
  await cashier.resolve(rec.key, { action: 'accept_price', approval: { email: shop.manager.email, password: 'wrong-password' } }); await cashier.syncNow();
  assert.equal((await stateOf(a, shop, rec.key)).state, 'needs_review'); assert.equal(await count(shop, 'sales'), 0);
  const cashierEmail = (await tq(shop, `SELECT email FROM users WHERE id = $1`, [shop.cashier.id]))[0].email;
  await cashier.resolve(rec.key, { action: 'accept_price', approval: { email: cashierEmail, password: 'Passw0rdOK' } }); await cashier.syncNow();
  assert.equal((await stateOf(a, shop, rec.key)).state, 'needs_review'); assert.equal(await count(shop, 'sales'), 0);
  // With a real manager's credentials the same sale (same key) is accepted; the credentials were never written to the device.
  await cashier.resolve(rec.key, { action: 'accept_price', decidedBy: 'Cash', approval: { email: shop.manager.email, password: 'Passw0rdOK' } });
  const stored = JSON.stringify(await a.entries('queue')); assert.ok(!stored.includes('Passw0rdOK') && !stored.includes(shop.manager.email), 'no manager credentials in the queue');
  assert.equal((await cashier.syncNow()).synced, 1);
  const sale = (await tq(shop, 'SELECT total FROM sales'))[0]; assert.equal(Number(sale.total), 126);
  assert.equal(await stockOf(shop, p), 8); assert.equal(await saleMovements(shop, p), 1);
  const acc = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.offline_price_accepted'`);
  assert.equal(acc.length, 1); assert.equal(acc[0].new_value.approvedBy, shop.manager.id); assert.equal(acc[0].new_value.requestedBy, shop.cashier.id); assert.equal(acc[0].new_value.difference, 21);
  const done = await stateOf(a, shop, rec.key); assert.equal(done.original.expectedTotal, 10500); assert.equal(done.decisions.at(-1).type, 'accept_price');
});

test('price change accepted by a manager SESSION needs no extra credentials; a manager session also cannot accept a different total than the one reviewed', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const a = mem(); await download(a, shop); const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 2 }]);
  await api(shop.owner.token).put(`/products/${p.id}`, { sellingPrice: 60 });
  const mgr = engine(a, shop, { send: httpSender(shop.manager.token), dismiss: httpDismisser(shop.manager.token), role: 'manager' }); await mgr.syncNow();
  await mgr.resolve(rec.key, { action: 'accept_price', decidedBy: 'Meera' });
  await api(shop.owner.token).put(`/products/${p.id}`, { sellingPrice: 70 });                 // the price moved AGAIN after the manager looked
  await mgr.syncNow(); assert.equal((await stateOf(a, shop, rec.key)).state, 'needs_review'); assert.equal(await count(shop, 'sales'), 0);
  assert.equal((await stateOf(a, shop, rec.key)).lastError.code, 'OFFLINE_PRICE_CHANGED');
  await mgr.resolve(rec.key, { action: 'accept_price', decidedBy: 'Meera' }); assert.equal((await mgr.syncNow()).synced, 1);
  assert.equal(Number((await tq(shop, 'SELECT total FROM sales'))[0].total), 147);
  const done = await stateOf(a, shop, rec.key); assert.equal(done.original.expectedTotal, 10500); assert.equal(done.decisions[0].type, 'accept_price');
});

test('concurrency: an online sale racing the offline sync for the last stock — exactly one wins, stock is never negative, nothing is duplicated', async () => {
  for (let round = 0; round < 3; round++) {
    const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 10 });
    const a = mem(); await download(a, shop); const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 7 }]);
    const [online, sync] = await Promise.all([api(shop.owner.token).post('/sales', { items: [{ productId: p.id, quantity: 6 }], paymentMethod: 'cash' }), engine(a, shop).syncNow()]);
    const offlineWon = sync.synced === 1; const left = await stockOf(shop, p);
    assert.equal(offlineWon ? online.status : 201, offlineWon ? 409 : 201, 'exactly one of the two could be satisfied');
    assert.equal(left, offlineWon ? 3 : 4); assert.equal(await count(shop, 'sales'), 1); assert.equal(await saleMovements(shop, p), 1);
    assert.equal((await stateOf(a, shop, rec.key)).state, offlineWon ? 'synced' : 'needs_review');
  }
});

test('two tabs syncing the same queue at once (no Web Locks): every sale reaches the server exactly once and every record ends synced', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 100 });
  const a = mem(); await download(a, shop); const keys = [];
  for (let i = 0; i < 8; i++) keys.push((await ringUp(a, shop, [{ productId: p.id, quantity: 1 + (i % 3) }])).key);
  const sends = [httpSender(shop.cashier.token), httpSender(shop.cashier.token), httpSender(shop.cashier.token)];
  await Promise.all(sends.map((s) => engine(a, shop, { send: s }).syncNow()));
  const all = sends.flatMap((s) => s.calls); assert.equal(new Set(all).size, all.length, 'no key was sent twice');
  assert.equal(await count(shop, 'sales'), 8); assert.equal(await saleMovements(shop, p), 8);
  assert.equal(await stockOf(shop, p), 100 - 15);   // 1+2+3+1+2+3+1+2
  assert.deepEqual((await O.listSales(a, scopeOf(shop))).map((x) => x.state), Array(8).fill('synced'));
  // Even if a second tab sent every sale AGAIN (e.g. after a crash), the server answers with the originals and changes nothing.
  const again = httpSender(shop.cashier.token);
  for (const rec of await O.listSales(a, scopeOf(shop))) { const res = await again({ ...O.requestFor(rec) }); assert.equal(res.status, 200); }
  assert.equal(await count(shop, 'sales'), 8); assert.equal(await stockOf(shop, p), 100 - 15);
});

test('cross-tenant: a queue made under shop A can never sell in shop B — the server tripwire refuses it, B is untouched, and B\'s engine does not even see A\'s sales', async () => {
  const A = await makeShop(api); const B = await makeShop(api);
  const pa = await addProduct(api, A, { stock: 10 }); const pb = await addProduct(api, B, { stock: 10 });
  const a = mem(); await download(a, A); const rec = await ringUp(a, A, [{ productId: pa.id, quantity: 2 }]);
  // (1) Something goes wrong in the app and B's token is used to send A's queue.
  const wrongToken = engine(a, A, { send: httpSender(B.cashier.token), report: null });
  const r = await wrongToken.syncNow();
  assert.deepEqual([r.synced, r.needsReview], [0, 1]);
  assert.equal((await stateOf(a, A, rec.key)).lastError.code, 'OFFLINE_TENANT_MISMATCH');
  assert.equal(await count(B, 'sales'), 0); assert.equal(await stockOf(B, pb), 10); assert.equal(await stockOf(A, pa), 10); assert.equal(await count(A, 'sales'), 0);
  // (2) B signs in on the same device: B's engine sees nothing of A's.
  const sendB = httpSender(B.cashier.token); const engB = O.createSyncEngine({ adapter: a, scope: scopeOf(B), role: 'cashier', send: sendB, probe: async () => true, locks: null });
  assert.equal((await engB.syncNow()).attempted, 0); assert.equal(sendB.calls.length, 0);
  assert.equal((await O.listSales(a, scopeOf(B))).length, 0);
  // (3) Even without the tripwire, the JWT decides: B's token plus a legitimate-looking B header cannot reach A's product.
  const forged = await api(B.cashier.token).post('/sales', { items: [{ productId: pa.id, quantity: 1 }], paymentMethod: 'cash', expectedTotal: 0 }, { 'x-offline-sale': JSON.stringify({ capturedAt: new Date().toISOString(), businessId: B.businessId }) });
  assert.equal(forged.status, 404); assert.equal(await stockOf(A, pa), 10);
});

test('authentication: a signed-out/expired session keeps every sale and reports auth_required; after signing in the same keys sync once', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { stock: 10 });
  const a = mem(); await download(a, shop); const k1 = await ringUp(a, shop, [{ productId: p.id, quantity: 1 }]); await ringUp(a, shop, [{ productId: p.id, quantity: 2 }]);
  const e = engine(a, shop, { send: httpSender(null), report: null });
  const r = await e.syncNow();
  assert.equal(r.stoppedBecause, 'AUTH_REQUIRED'); assert.equal(e.getStatus().status, 'auth_required');
  assert.equal(await count(shop, 'sales'), 0); assert.deepEqual((await O.listSales(a, scopeOf(shop))).map((x) => x.state), ['failed', 'pending']);
  const back = engine(a, shop); const r2 = await back.syncNow({ force: true });
  assert.equal(r2.synced, 2); assert.equal(await count(shop, 'sales'), 2); assert.equal(await stockOf(shop, p), 7); assert.equal((await stateOf(a, shop, k1.key)).state, 'synced');
});

test('authorization stays on the server: a cashier\'s offline discount above their limit is refused (needs_review), nothing is sold', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 100, stock: 10 });
  const limits = (await api(shop.cashier.token).get('/sales/limits')).body;
  const over = Math.min(90, Math.ceil((limits.cashierMaxDiscountPct ?? limits.maxDiscountPct ?? 10) + 25));
  const a = mem(); await download(a, shop);
  const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 1 }], { discount: { type: 'percent', value: over } });
  const r = await engine(a, shop).syncNow();
  assert.deepEqual([r.synced, r.needsReview], [0, 1], JSON.stringify(limits));
  const stuck = await stateOf(a, shop, rec.key); assert.equal(stuck.state, 'needs_review'); assert.ok([401, 403, 409, 400].includes(stuck.lastError.status));
  assert.equal(await count(shop, 'sales'), 0); assert.equal(await stockOf(shop, p), 10);
});

test('a product deactivated while the till was offline: needs_review (not a lost sale, not a crash), nothing else is affected', async () => {
  const shop = await makeShop(api); const keep = await addProduct(api, shop, { stock: 10 }); const gone = await addProduct(api, shop, { stock: 10 });
  const a = mem(); await download(a, shop);
  const bad = await ringUp(a, shop, [{ productId: gone.id, quantity: 1 }]); const good = await ringUp(a, shop, [{ productId: keep.id, quantity: 1 }]);
  await api(shop.owner.token).del(`/products/${gone.id}`);
  const r = await engine(a, shop).syncNow();
  assert.deepEqual([r.synced, r.needsReview], [1, 1]);
  assert.equal((await stateOf(a, shop, bad.key)).state, 'needs_review'); assert.ok([404, 409].includes((await stateOf(a, shop, bad.key)).lastError.status));
  assert.equal((await stateOf(a, shop, good.key)).state, 'synced'); assert.equal(await stockOf(shop, gone), 10);
});

test('the sync-issue report is deduplicated on the server and the dismiss decision is audited too', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { stock: 1 });
  const a = mem(); await download(a, shop); const rec = await ringUp(a, shop, [{ productId: p.id, quantity: 1 }]);
  await api(shop.owner.token).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
  const cashier = engine(a, shop); const cashierMail = (await tq(shop, 'SELECT email FROM users WHERE id = $1', [shop.cashier.id]))[0].email;
  await cashier.syncNow(); await O.retryAfterReview(a, scopeOf(shop), rec.key, {}); await cashier.syncNow();    // refused twice for the same reason
  assert.equal((await tq(shop, `SELECT 1 FROM audit_logs WHERE action = 'sale.offline_sync_issue'`)).length, 1, 'same sale + same reason is logged once');
  // Dismissing is decided by the SERVER: a cashier alone is refused (and the sale stays), a cashier with a wrong/cashier/no approval too.
  await assert.rejects(() => cashier.resolve(rec.key, { action: 'dismiss', reason: 'Customer returned the goods', decidedBy: 'Cash' }), (e) => e.status === 403 && e.details.code === 'OFFLINE_DISMISS_APPROVAL_REQUIRED');
  await assert.rejects(() => cashier.resolve(rec.key, { action: 'dismiss', reason: 'Customer returned the goods', approval: { email: shop.manager.email, password: 'nope' } }), (e) => e.status === 403);
  await assert.rejects(() => cashier.resolve(rec.key, { action: 'dismiss', reason: 'Customer returned the goods', approval: { email: cashierMail, password: 'Passw0rdOK' } }), (e) => e.status === 403);
  assert.equal((await stateOf(a, shop, rec.key)).state, 'needs_review'); assert.equal((await tq(shop, `SELECT 1 FROM audit_logs WHERE action = 'sale.offline_dismissed'`)).length, 0);
  await cashier.resolve(rec.key, { action: 'dismiss', reason: 'Customer returned the goods', decidedBy: 'Cash', approval: { email: shop.manager.email, password: 'Passw0rdOK' } });
  const rows = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.offline_dismissed'`);
  assert.equal(rows.length, 1); assert.match(rows[0].new_value.reason, /returned the goods/); assert.equal(rows[0].new_value.approvedBy, shop.manager.id); assert.equal(rows[0].new_value.requestedBy, shop.cashier.id);
  assert.ok(!JSON.stringify(await a.entries('queue')).includes('Passw0rdOK'));
  assert.equal(await count(shop, 'sales'), 1, 'only the online sale exists'); assert.equal((await stateOf(a, shop, rec.key)).state, 'dismissed');
});
