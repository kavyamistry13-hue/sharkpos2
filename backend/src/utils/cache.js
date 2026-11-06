// Tiny in-memory TTL cache for expensive analytics queries. Keys are ALWAYS namespaced by the current business,
// so one tenant can never be served another tenant's cached numbers.
const { currentBusinessId } = require('../db');
const store = new Map();
const ns = (key) => {
  const bid = currentBusinessId();
  if (bid == null) throw new Error('cache used without a tenant context');
  return `${bid}:${key}`;
};

async function cached(key, ttlMs, loader) {
  const k = ns(key);
  const hit = store.get(k);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = await loader();
  store.set(k, { value, expires: now + ttlMs });
  return value;
}

/** Clears the current business's cache only. */
function invalidateAll() {
  const prefix = `${currentBusinessId()}:`;
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
const clearEverything = () => store.clear();

module.exports = { cached, invalidateAll, clearEverything };
