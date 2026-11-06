// The browser side of duplicate-sale protection: services/api.js retry behaviour and the key generator, run with a fake network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', ...p)).href;

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function withFakeNetwork(script, fn) {
  const real = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, window: globalThis.window };
  const calls = [];
  globalThis.window = { dispatchEvent() {} };
  globalThis.setTimeout = (f) => real.setTimeout(f, 0);                      // do not really wait 1.5–9 s
  globalThis.fetch = async (u, init) => { calls.push({ u: String(u), init }); const step = script[Math.min(calls.length - 1, script.length - 1)]; if (step === 'drop') throw new TypeError('network'); return typeof step === 'function' ? step() : step; };
  try { return await fn(calls); } finally { Object.assign(globalThis, { fetch: real.fetch, setTimeout: real.setTimeout }); if (real.window === undefined) delete globalThis.window; else globalThis.window = real.window; }
}

test('uuid(): valid v4 format, unique, and works without crypto.randomUUID (plain-http tills)', async () => {
  const { uuid } = await import(url('utils', 'uuid.js'));
  const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = new Set(Array.from({ length: 200 }, uuid)); assert.equal(ids.size, 200); for (const i of ids) assert.match(i, RE);
  const c = globalThis.crypto; const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: c.getRandomValues.bind(c) }, configurable: true });
  try { assert.match(uuid(), RE); } finally { Object.defineProperty(globalThis, 'crypto', desc); }
});

test('a sale with a key survives a dropped connection and a restarting server: same key on every attempt, then success', async () => {
  const { api } = await import(url('services', 'api.js'));
  const K = '11111111-1111-4111-8111-111111111111';
  await withFakeNetwork(['drop', jsonRes(502, { error: 'bad gateway' }), jsonRes(503, { error: 'waking' }), jsonRes(200, { id: 7, invoiceNo: 'INV-1' })], async (calls) => {
    const retries = [];
    const sale = await api.post('/sales', { items: [] }, { idempotencyKey: K, onRetry: (n) => retries.push(n) });
    assert.equal(sale.id, 7);
    assert.equal(calls.length, 4);
    assert.deepEqual(retries, [1, 2, 3]);
    for (const c of calls) assert.equal(c.init.headers['idempotency-key'], K, 'every retry carries the SAME key');
  });
});

test('gives up after a bounded number of retries and reports the failure honestly', async () => {
  const { api } = await import(url('services', 'api.js'));
  await withFakeNetwork(['drop'], async (calls) => {
    await assert.rejects(() => api.post('/sales', {}, { idempotencyKey: 'k' }), (e) => e.status === 0 && /Cannot reach the server/.test(e.message));
    assert.equal(calls.length, 4, '1 try + 3 retries');
  });
});

test('requests WITHOUT a key are never retried automatically; real errors (stock, key reuse, validation) are not retried either', async () => {
  const { api } = await import(url('services', 'api.js'));
  await withFakeNetwork(['drop'], async (calls) => {
    await assert.rejects(() => api.post('/customers', {}), (e) => e.status === 0);
    assert.equal(calls.length, 1);
  });
  for (const status of [400, 403, 409, 422]) {
    await withFakeNetwork([jsonRes(status, { error: 'nope', details: { code: 'X' } })], async (calls) => {
      await assert.rejects(() => api.post('/sales', {}, { idempotencyKey: 'k' }), (e) => e.status === status);
      assert.equal(calls.length, 1, `status ${status} is final`);
    });
  }
});

test('"still being processed" (409 IDEMPOTENCY_IN_PROGRESS) is retried with the same key', async () => {
  const { api } = await import(url('services', 'api.js'));
  await withFakeNetwork([jsonRes(409, { error: 'busy', details: { code: 'IDEMPOTENCY_IN_PROGRESS' } }), jsonRes(200, { id: 3 })], async (calls) => {
    assert.equal((await api.post('/sales', {}, { idempotencyKey: 'k' })).id, 3);
    assert.equal(calls.length, 2);
  });
});
