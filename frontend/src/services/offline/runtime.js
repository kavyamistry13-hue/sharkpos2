// The offline runtime (Phase 17D): ONE object per signed-in session that owns the local storage, the sync engine, the catalog cache and a
// small observable state for the screens. It is framework-free (React only subscribes to it), takes the API client as a parameter, and is
// built only from the already-tested 17B/17C modules. The browser never changes stock, movements, costs or the ledger: it only stores
// sales, sends them through POST /sales and shows what the server answered.
import { OfflineError, openOfflineStorage } from './db.js';
import { scopeKey, scopeOf } from './scope.js';
import { countsByState, enqueueSale, getSale, listSales, queuedQuantities, UNSYNCED, pruneFinished } from './queue.js';
import { availableStock, buildIndex, catalogStatus, findByCode, loadCatalog, refreshCatalog, searchProducts } from './catalog.js';
import { onSessionStart, prepareLogout as prepare, completeLogout as complete } from './lifecycle.js';
import { createApiDismisser, createApiReporter, createApiSender, createHealthProbe, createSyncEngine, PROBE_INTERVAL_MS } from './sync.js';
import { priceCart, totalPaise } from './pricing.js';
import { describeStatus } from './status.js';

export const CATALOG_REFRESH_MS = 10 * 60e3;

const EMPTY = Object.freeze({
  ready: false, available: false, scope: null, role: null, engine: 'idle', navigatorOnline: true,
  counts: {}, unsynced: 0, needsReview: 0, failed: 0, syncing: 0, queue: [], queued: new Map(),
  catalog: { present: false, level: 'none', ageMs: null, generatedAt: null, count: 0 }, discountLimitPct: null, lastSync: null, status: describeStatus({ available: false }),
});

// `openStorage` is replaceable so tests can run on the in-memory twin of IndexedDB.
export function createOfflineRuntime({ api, win = globalThis.window, openStorage = () => openOfflineStorage(), now = () => Date.now(), probe, locks } = {}) {
  let state = { ...EMPTY };
  const listeners = new Set();
  let adapter = null; let scope = null; let role = null; let engine = null; let index = buildIndex(null);
  let timers = []; let generation = 0; let prevEngine = 'idle';

  const emit = (patch) => { state = { ...state, ...patch }; for (const l of listeners) { try { l(); } catch { /* a UI error must never break the runtime */ } } };
  const navOnline = () => (win && win.navigator ? win.navigator.onLine !== false : true);

  async function refresh(extra = {}) {
    if (!adapter || !scope) return;
    const gen = generation; const ad = adapter; const sc = scope;     // captured: the session may end while we read
    const counts = await countsByState(ad, sc);
    const rec = await loadCatalog(ad, sc);
    const all = await listSales(ad, sc);
    const queue = [...all.filter((r) => UNSYNCED.includes(r.state)), ...all.filter((r) => !UNSYNCED.includes(r.state)).slice(-20)];   // everything waiting, plus the last few finished
    const queued = await queuedQuantities(ad, sc);
    if (gen !== generation) return;                                   // the session changed while we were reading
    index = buildIndex(rec);
    const unsynced = UNSYNCED.reduce((a, s) => a + (counts[s] || 0), 0);
    const engineStatus = extra.engine || (engine ? engine.getStatus().status : 'idle');
    const view = { counts, unsynced, needsReview: counts.needs_review || 0, failed: counts.failed || 0, syncing: counts.syncing || 0 };
    emit({ ...extra, ...view, queue, queued, catalog: catalogStatus(rec, now()), engine: engineStatus, navigatorOnline: navOnline(),
      status: describeStatus({ available: true, engine: engineStatus, navigatorOnline: navOnline(), ...view }) });
  }

  async function refreshCatalogNow({ force = false } = {}) {
    if (!adapter || !scope || state.engine === 'offline' || !navOnline()) return { skipped: 'OFFLINE' };
    const gen = generation; const ad = adapter; const sc = scope; const r8 = role;
    const live = () => gen === generation;
    try {
      const r = await refreshCatalog(ad, sc, (p, q) => api.get(p, q), { force });
      if (!live()) return r;
      try { const l = await api.get('/sales/limits'); if (live() && l && Number.isFinite(Number(l[r8]))) await ad.put('meta', `limits:${scopeKey(sc)}`, Number(l[r8])); } catch { /* keep the last known limit */ }
      if (live()) await refresh({ discountLimitPct: await readLimit(ad, sc) });
      return r;
    } catch (e) { return { error: e }; }
  }
  const readLimit = async (ad = adapter, sc = scope) => { const v = await ad.get('meta', `limits:${scopeKey(sc)}`); return Number.isFinite(v) ? v : null; };

  async function start(user) {
    await stop();
    const sc = scopeOf(user);
    generation += 1; const gen = generation;
    if (!sc) { emit({ ...EMPTY, ready: true }); return; }
    const store = await openStorage();
    if (gen !== generation) { if (store) store.close(); return; }
    scope = sc; role = user.role; adapter = store;
    if (!store) { emit({ ...EMPTY, ready: true, available: false, scope: sc, role }); return; }
    await onSessionStart(adapter, scope);
    try { await pruneFinished(adapter, scope); } catch { /* housekeeping only */ }
    engine = createSyncEngine({
      adapter, scope, role, send: createApiSender(api), probe: probe || createHealthProbe(), report: createApiReporter(api), dismiss: createApiDismisser(api), locks,
      onChange: ({ status }) => {
        const wasOffline = prevEngine === 'offline'; prevEngine = status;
        refresh({ engine: status });
        if (wasOffline && status === 'idle') { engine.syncNow({ force: true }).catch(() => {}); refreshCatalogNow().catch(() => {}); }
      },
      onDrained: () => { refreshCatalogNow({ force: true }).catch(() => {}); },
    });
    emit({ ready: true, available: true, scope, role, discountLimitPct: await readLimit() });
    await refresh();
    engine.start({ win });
    timers.push(setInterval(() => { engine.checkConnectivity().catch(() => {}); }, PROBE_INTERVAL_MS));
    timers.push(setInterval(() => { refreshCatalogNow().catch(() => {}); }, CATALOG_REFRESH_MS));
    if (win && win.addEventListener) { const on = () => refresh(); win.addEventListener('online', on); win.addEventListener('offline', on); timers.push({ off: () => { win.removeEventListener('online', on); win.removeEventListener('offline', on); } }); }
    refreshCatalogNow().catch(() => {});
  }

  async function stop() {
    generation += 1;
    for (const t of timers) { if (t && t.off) t.off(); else clearInterval(t); }
    timers = [];
    if (engine) { engine.stop(); engine = null; }
    if (adapter) { try { adapter.close(); } catch { /* already closed */ } adapter = null; }
    scope = null; role = null; index = buildIndex(null); prevEngine = 'idle';
    emit({ ...EMPTY });
  }

  // ---------------------------------------------------------------- selling offline
  const need = () => { if (!adapter || !scope) throw new OfflineError('OFFLINE_UNAVAILABLE', 'Offline sales are not available in this browser.'); };
  /** Is the till in offline mode? (the health probe is the truth; the browser flag is only a hint that can force it) */
  const isOffline = () => state.engine === 'offline' || !navOnline();
  const catalogReady = () => state.catalog.present;
  const searchCatalog = (q) => searchProducts(index, q).map((p) => ({ ...p, stock: availableStock(p, state.queued) })).filter((p) => p.stock > 0);
  const lookupCatalog = (code) => { const r = findByCode(index, code); return r ? { ...r, product: { ...r.product, stock: availableStock(r.product, state.queued) } } : null; };

  /** The bill for an offline cart, from the cached catalog with the SAME computeBill the server uses. */
  function priceOffline(cart, discount) {
    return priceCart(cart.map((c) => ({ productId: c.id, quantity: c.qty })), index.byId, discount || null);
  }

  /**
   * Stores a sale locally. Refuses (with a clear OfflineError) anything the till must not promise offline: credit, a customer link,
   * a discount above this role's own limit, more than the cached stock minus what is already promised.
   * `shownTotal` (₹) is what the customer was shown, when that differs from the catalog price (a sale that failed in the middle of going offline).
   */
  async function recordSale({ key, cart, discount, paymentMethod, customer, shownTotal, cashierName }) {
    need();
    if (customer) throw new OfflineError('OFFLINE_CUSTOMER', 'Customers are not available offline. Remove the customer to sell offline.');
    if (!catalogReady()) throw new OfflineError('OFFLINE_NO_CATALOG', 'The product list has not been downloaded on this device yet, so sales cannot be priced offline.');
    const items = cart.map((c) => ({ productId: c.id, quantity: c.qty }));
    const existing = await getSale(adapter, scope, key);
    if (existing) return { record: existing, duplicate: true };
    for (const it of items) {
      const p = index.byId.get(it.productId);
      if (!p) throw new OfflineError('OFFLINE_UNKNOWN_PRODUCT', 'A product on this bill is not in the offline list.');
      const left = availableStock(p, state.queued);
      if (it.quantity > left) throw new OfflineError('OFFLINE_STOCK', `Only ${left} ${p.unit} of ${p.name} left on this device.`);
    }
    const bill = priceCart(items, index.byId, discount || null);
    if (bill.discount > 0) {
      const limit = state.discountLimitPct;
      if (limit === null || bill.discountPct > limit) throw new OfflineError('OFFLINE_DISCOUNT_LIMIT', `A ${bill.discountPct}% discount needs a manager's approval, which needs a connection. ${limit === null ? 'Discounts are not available offline until this device has been online once.' : `Your limit is ${limit}%.`}`);
    }
    const expectedTotal = shownTotal !== undefined && shownTotal !== null ? Math.round(Number(shownTotal) * 100) : totalPaise(bill);
    const display = { lines: bill.items.map((l) => ({ productId: l.productId, name: l.name, unit: index.byId.get(l.productId).unit, price: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal })), bill: { ...bill, itemCount: items.length }, cashierName };
    const out = await enqueueSale(adapter, scope, { key, items, discount: discount || null, paymentMethod, expectedTotal, display }, { now: now() });
    await refresh();
    return { ...out, bill };
  }

  async function syncNow(opts) { need(); const r = await engine.syncNow(opts); await refresh(); return r; }
  async function resolve(key, opts) {
    need();
    const r = await engine.resolve(key, opts); await refresh();
    if (opts && opts.action !== 'dismiss') engine.syncNow({ force: true }).then(() => refresh()).catch(() => {});
    return r;
  }
  async function checkConnectivity() { if (!engine) return false; const up = await engine.checkConnectivity(); await refresh(); return up; }

  async function prepareLogout() { return adapter && scope ? prepare(adapter, scope) : { unsynced: 0, needsReview: 0, pending: 0 }; }
  async function completeLogout() { return adapter && scope ? complete(adapter, scope) : { unsynced: 0 }; }

  return {
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    getSnapshot: () => state,
    start, stop, refresh, refreshCatalogNow, syncNow, resolve, checkConnectivity, prepareLogout, completeLogout,
    isOffline, searchCatalog, lookupCatalog, priceOffline, recordSale,
  };
}
