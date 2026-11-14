// Offline storage adapter (Phase 17B). A tiny promise wrapper over IndexedDB — no dependency — plus an in-memory twin with the SAME
// interface, used by the unit tests and as the shape every other offline module codes against.
//
// IMPORTANT: IndexedDB is NOT a security boundary. Anyone with the device can read it. Callers store only the minimum a till needs and
// never a password, token, cost, supplier or customer detail (catalog.js / queue.js whitelist their fields).
//
// Adapter interface (all async):
//   get(store, key) → value | undefined          put(store, key, value)          del(store, key)
//   entries(store) → [[key, value], …]           clear(store)
//   update(store, key, fn) → fn's `result`       fn(prev) runs INSIDE one read-write transaction and returns
//                                                { write: value } | { del: true } | undefined, plus optional { result }.
//                                                That is what makes "read, decide, write" atomic across tabs.
export const DB_NAME = 'sharkpos2-offline';
export const DB_VERSION = 1;
export const STORES = ['meta', 'catalog', 'queue'];

export class OfflineError extends Error {
  constructor(code, message, details) { super(message); this.name = 'OfflineError'; this.code = code; this.details = details; }
}

export const indexedDbAvailable = (factory = globalThis.indexedDB) => !!factory && typeof factory.open === 'function';

const wrap = (err, fallback = 'Offline storage failed.') => {
  if (err instanceof OfflineError) return err;
  const name = err && err.name;
  if (name === 'QuotaExceededError') return new OfflineError('OFFLINE_STORAGE_FULL', 'This device has no room left for offline data.');
  return new OfflineError('OFFLINE_STORAGE_ERROR', (err && err.message) || fallback);
};

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** In-memory adapter. Values are cloned on the way in and out, exactly like IndexedDB, so aliasing bugs show up in tests. */
export function createMemoryAdapter() {
  const data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  const st = (s) => { if (!data[s]) throw new OfflineError('OFFLINE_STORAGE_ERROR', `Unknown store ${s}`); return data[s]; };
  return {
    kind: 'memory',
    async get(s, k) { return clone(st(s).get(k)); },
    async put(s, k, v) { st(s).set(k, clone(v)); },
    async del(s, k) { st(s).delete(k); },
    async entries(s) { return [...st(s).entries()].map(([k, v]) => [k, clone(v)]); },
    async clear(s) { st(s).clear(); },
    async update(s, k, fn) {
      const r = fn(clone(st(s).get(k))) || {};
      if (r.del) st(s).delete(k); else if ('write' in r) st(s).set(k, clone(r.write));
      return r.result;
    },
    close() {},
  };
}

/** Opens (and on first use creates) the IndexedDB database. Rejects with OFFLINE_STORAGE_UNAVAILABLE when the browser cannot provide it. */
export function openIndexedDbAdapter({ name = DB_NAME, factory = globalThis.indexedDB } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDbAvailable(factory)) { reject(new OfflineError('OFFLINE_STORAGE_UNAVAILABLE', 'This browser cannot store offline data (private mode or storage blocked).')); return; }
    let req;
    try { req = factory.open(name, DB_VERSION); } catch (e) { reject(new OfflineError('OFFLINE_STORAGE_UNAVAILABLE', (e && e.message) || 'Could not open offline storage.')); return; }
    req.onupgradeneeded = () => { const db = req.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); };
    req.onblocked = () => reject(new OfflineError('OFFLINE_STORAGE_UNAVAILABLE', 'Offline storage is blocked by another open tab. Close other SharkPOS tabs and reload.'));
    req.onerror = () => reject(new OfflineError('OFFLINE_STORAGE_UNAVAILABLE', (req.error && req.error.message) || 'Could not open offline storage.'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();     // let a newer version of the app upgrade the database instead of blocking it
      const run = (store, mode, work) => new Promise((res, rej) => {
        let tx; try { tx = db.transaction(store, mode); } catch (e) { rej(wrap(e)); return; }
        let out; let failure = null;
        const fail = (e) => { failure = e; try { tx.abort(); } catch { /* already finished */ } };   // keeps the ORIGINAL error (e.g. a refused transition) instead of a generic abort
        const os = tx.objectStore(store);
        try { out = work(os, fail); } catch (e) { fail(e); }
        tx.oncomplete = () => res(typeof out === 'function' ? out() : out);
        tx.onerror = () => { if (!failure) rej(wrap(tx.error)); };
        tx.onabort = () => rej(wrap(failure || tx.error || new Error('Offline storage transaction was aborted.')));
      });
      resolve({
        kind: 'indexeddb',
        get: (s, k) => run(s, 'readonly', (os) => { const r = os.get(k); return () => r.result; }),
        put: (s, k, v) => run(s, 'readwrite', (os) => { os.put(v, k); }),
        del: (s, k) => run(s, 'readwrite', (os) => { os.delete(k); }),
        entries: (s) => run(s, 'readonly', (os) => { const keys = os.getAllKeys(); const vals = os.getAll(); return () => keys.result.map((k, i) => [k, vals.result[i]]); }),
        clear: (s) => run(s, 'readwrite', (os) => { os.clear(); }),
        update: (s, k, fn) => run(s, 'readwrite', (os, fail) => {
          let result;
          const g = os.get(k);
          g.onsuccess = () => {
            let r;
            try { r = fn(g.result) || {}; } catch (e) { fail(e); return; }
            result = r.result;
            if (r.del) os.delete(k); else if ('write' in r) os.put(r.write, k);
          };
          return () => result;
        }),
        close: () => db.close(),
      });
    };
  });
}

/** The adapter the app uses: IndexedDB, or null when unavailable (offline selling is then switched off — never silently held in memory). */
export async function openOfflineStorage(opts) {
  try { return await openIndexedDbAdapter(opts); } catch { return null; }
}
