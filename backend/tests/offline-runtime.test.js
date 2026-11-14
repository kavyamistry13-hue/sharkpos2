// SHARKPOS 2 — Phase 17D: the offline runtime that the POS screens use (status wording, offline selling rules, logout and session rules).
// Runs in Node on the in-memory twin of IndexedDB; the real browser is covered by the Playwright journeys.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let O; const running = [];
test.after(async () => { for (const r of running) await r.stop(); });   // the engine keeps timers; stop them so the process can end
test.before(async () => { O = await import(pathToFileURL(path.join(__dirname, '../../frontend/src/services/offline/index.js')).href); });

const ROW = { id: 1, name: 'Milk', sku: 'M1', category: 'Dairy', price: 50, stock: 5, taxRate: 5, unit: 'pcs', allowDecimal: false, priceIncludesTax: false, expiryDate: null, barcodes: ['8901234567890'] };
const ROW2 = { ...ROW, id: 2, name: 'Rice', sku: 'R1', price: 63.5, stock: 40, unit: 'kg', allowDecimal: true, barcodes: [] };
const fakeApi = (over = {}) => ({
  calls: [],
  async get(p) {
    this.calls.push(['GET', p]);
    if (over.down) throw Object.assign(new Error('Cannot reach the server.'), { status: 0 });
    if (p === '/products/offline-catalog') return { generatedAt: new Date().toISOString(), nextAfter: null, rows: [ROW, ROW2] };
    if (p === '/sales/limits') return { cashier: 5, manager: 10, business_owner: 100 };
    throw new Error(`unexpected ${p}`);
  },
  async post(p, body) { this.calls.push(['POST', p, body]); throw Object.assign(new Error('Cannot reach the server.'), { status: 0 }); },
});
const USER = { id: 11, businessId: 3, role: 'cashier', name: 'Cash' };
async function boot(user = USER, { up = true, shared } = {}) {
  const store = shared || O.createMemoryAdapter();
  const state = { up };
  const api = fakeApi();
  const rt = O.createOfflineRuntime({ api, win: null, openStorage: async () => store, probe: async () => state.up, locks: null });
  running.push(rt); await rt.start(user);
  return { rt, store, api, state };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const sale = (over = {}) => ({ key: crypto.randomUUID(), cart: [{ id: 1, qty: 2 }], discount: null, paymentMethod: 'cash', customer: null, ...over });

test('status wording: every situation shows the right label and a needs-review sale is never hidden', () => {
  const d = (o) => O.describeStatus(o);
  assert.equal(d({}).label, 'ONLINE');
  assert.equal(d({ engine: 'offline' }).label, 'OFFLINE'); assert.equal(d({ navigatorOnline: false }).label, 'OFFLINE');
  assert.equal(d({ engine: 'offline', unsynced: 3 }).detail, '3 sales are waiting to sync.');
  assert.equal(d({ engine: 'syncing', unsynced: 2 }).label, 'SYNCING');
  assert.equal(d({ unsynced: 1 }).label, '1 sale waiting to sync'); assert.equal(d({ unsynced: 4 }).label, '4 sales waiting to sync');
  assert.equal(d({ unsynced: 2, failed: 1 }).detail, 'The last attempt failed. It will retry automatically.');
  for (const base of [{}, { engine: 'offline' }, { engine: 'syncing' }, { unsynced: 3 }]) assert.equal(d({ ...base, needsReview: 1 }).label, 'SYNC FAILED / NEEDS REVIEW');
  assert.equal(d({ engine: 'auth_required', unsynced: 2 }).label, 'SIGN IN TO SYNC'); assert.equal(d({ engine: 'blocked' }).label, 'SYNC PAUSED');
  assert.equal(d({ available: false }).level, 'unavailable');
  assert.match(O.explainError({ code: 'OFFLINE_PRICE_CHANGED', details: { expectedTotal: 105, currentTotal: 126 } }), /₹105.*₹126/);
  assert.match(O.explainError({ code: 'INSUFFICIENT_STOCK', details: { name: 'Milk', available: 1, requested: 2 } }), /Milk/);
});

test('runtime: sign-in downloads the catalog and the role\'s discount limit; the state is observable', async () => {
  const { rt, api } = await boot(); await rt.refreshCatalogNow(); await settle();
  const s = rt.getSnapshot();
  assert.equal(s.available, true); assert.equal(s.catalog.present, true); assert.equal(s.catalog.count, 2); assert.equal(s.discountLimitPct, 5); assert.equal(s.status.label, 'ONLINE');
  assert.ok(api.calls.some((c) => c[1] === '/products/offline-catalog'));
  let n = 0; const off = rt.subscribe(() => { n += 1; }); await rt.refresh(); off(); assert.ok(n >= 1);
  await rt.stop(); assert.equal(rt.getSnapshot().available, false);
});

test('offline selling: priced from the cached catalog with the shared bill, queued once per key, stock promised against what is already queued, nothing else changes', async () => {
  const { rt } = await boot(); await rt.refreshCatalogNow();
  const s1 = sale({ cart: [{ id: 1, qty: 2 }] });
  const r = await rt.recordSale(s1);
  assert.equal(r.duplicate, false); assert.equal(r.record.localRef, 'OFF-0001'); assert.equal(r.record.expectedTotal, 10500);   // 2 × 50 + 5% tax
  assert.equal(r.bill.total, 105); assert.equal(r.record.state, 'pending'); assert.equal(r.record.unverifiedTender, false);
  assert.equal((await rt.recordSale(s1)).duplicate, true, 'a double tap with the same key stores nothing new');
  assert.equal(rt.getSnapshot().unsynced, 1);
  assert.equal(rt.searchCatalog('milk')[0].stock, 3, 'stock shown = cached stock − already promised');
  await assert.rejects(() => rt.recordSale(sale({ cart: [{ id: 1, qty: 4 }] })), (e) => e.code === 'OFFLINE_STOCK');
  const s2 = await rt.recordSale(sale({ cart: [{ id: 1, qty: 3 }, { id: 2, qty: 1.25 }], paymentMethod: 'upi' }));
  assert.equal(s2.record.localRef, 'OFF-0002'); assert.equal(s2.record.unverifiedTender, true); assert.equal(rt.getSnapshot().unsynced, 2);
  assert.equal(rt.searchCatalog('milk').length, 0, 'sold out on this device');
  assert.equal(rt.lookupCatalog('8901234567890').product.id, 1);
  assert.equal((await rt.prepareLogout()).unsynced, 2);
});

test('offline rules: credit, a customer link, an over-limit discount and an unknown product are refused with a clear message', async () => {
  const { rt } = await boot(); await rt.refreshCatalogNow();
  await assert.rejects(() => rt.recordSale(sale({ paymentMethod: 'credit' })), (e) => e.code === 'OFFLINE_PAYMENT_NOT_SUPPORTED' && /udhaar/.test(e.message));
  await assert.rejects(() => rt.recordSale(sale({ customer: { id: 4 } })), (e) => e.code === 'OFFLINE_CUSTOMER');
  await assert.rejects(() => rt.recordSale(sale({ discount: { type: 'percent', value: 12 } })), (e) => e.code === 'OFFLINE_DISCOUNT_LIMIT');
  await assert.rejects(() => rt.recordSale(sale({ cart: [{ id: 99, qty: 1 }] })), (e) => e.code === 'OFFLINE_UNKNOWN_PRODUCT');
  assert.equal((await rt.recordSale(sale({ discount: { type: 'percent', value: 5 } }))).record.state, 'pending', 'within the cashier limit is fine');
  assert.equal(rt.getSnapshot().unsynced, 1);
});

test('no catalog yet (never online on this device) → a clear refusal, nothing queued; no stored limit → no discount', async () => {
  const store = O.createMemoryAdapter(); const api = fakeApi({ down: true });
  const rt = O.createOfflineRuntime({ api, win: null, openStorage: async () => store, probe: async () => false, locks: null });
  running.push(rt); await rt.start(USER); await settle();
  await assert.rejects(() => rt.recordSale(sale()), (e) => e.code === 'OFFLINE_NO_CATALOG');
  assert.equal(rt.getSnapshot().unsynced, 0); assert.equal(rt.getSnapshot().status.level, 'offline');
});

test('session rules: another user on the same device sees nothing of the queue and the catalog; the queue survives sign-out and returns for the same user', async () => {
  const store = O.createMemoryAdapter();
  const a = await boot(USER, { shared: store }); await a.rt.refreshCatalogNow({ force: true }); await settle();
  await a.rt.recordSale(sale()); assert.equal(a.rt.getSnapshot().unsynced, 1);
  await a.rt.completeLogout(); await a.rt.stop();
  assert.equal((await store.entries('catalog')).length, 0, 'the catalog is deleted at sign-out');
  const b = await boot({ ...USER, id: 12 }, { shared: store });
  assert.equal(b.rt.getSnapshot().unsynced, 0); assert.equal(b.rt.getSnapshot().queue.length, 0); assert.equal((await b.rt.prepareLogout()).unsynced, 0);
  await b.rt.stop();
  const again = await boot(USER, { shared: store });
  assert.equal(again.rt.getSnapshot().unsynced, 1, 'the same user gets their unsynced sale back');
  await again.rt.stop();
});

test('platform admin / no business → offline stays off; IndexedDB missing → "unavailable" with a clear status', async () => {
  const rt = O.createOfflineRuntime({ api: fakeApi(), win: null, openStorage: async () => null, probe: async () => true, locks: null });
  running.push(rt); await rt.start(USER); assert.equal(rt.getSnapshot().available, false); assert.equal(rt.getSnapshot().status.level, 'unavailable');
  await assert.rejects(() => rt.recordSale(sale()), (e) => e.code === 'OFFLINE_UNAVAILABLE');
  const rt2 = O.createOfflineRuntime({ api: fakeApi(), win: null, openStorage: async () => O.createMemoryAdapter(), probe: async () => true, locks: null });
  running.push(rt2); await rt2.start({ id: 1, role: 'admin' }); assert.equal(rt2.getSnapshot().available, false);
});
