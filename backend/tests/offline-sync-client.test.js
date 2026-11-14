// SHARKPOS 2 — Phase 17C: the browser-side synchronisation engine (frontend/src/services/offline/sync.js), run in Node against the
// in-memory storage adapter and a scripted fake server. (The same engine against the REAL API and database is in offline-sync.test.js.)
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', ...p)).href;

let O;
test.before(async () => { O = await import(url('services', 'offline', 'index.js')); });

const A = { businessId: 1, userId: 10 };
const B = { businessId: 1, userId: 11 };
const key = () => crypto.randomUUID();
const mem = () => O.createMemoryAdapter();
const sale = (over = {}) => ({ key: key(), items: [{ productId: 5, quantity: 2 }], paymentMethod: 'cash', expectedTotal: 10500, display: {}, ...over });
const queueSales = async (a, n, scope = A, over = () => ({})) => { const keys = []; for (let i = 0; i < n; i++) { const s = sale(over(i)); keys.push(s.key); await O.enqueueSale(a, scope, s, { now: 1700000000000 + i * 1000 }); } return keys; };
const states = async (a, scope = A) => (await O.listSales(a, scope)).map((r) => r.state);

/** A scripted server that also behaves like the real one for idempotency: a key that already committed is answered with the ORIGINAL sale. */
function fakeServer({ script = [] } = {}) {
  const committed = new Map(); const calls = []; let active = 0; let maxActive = 0; let nextId = 100;
  const send = async (req) => {
    active += 1; maxActive = Math.max(maxActive, active); calls.push(req);
    try {
      await new Promise((r) => setImmediate(r));
      const step = script.shift() || {};
      if (step.dropBefore) throw new Error('network down');                    // request never reached the server
      if (committed.has(req.idempotencyKey)) return { status: 200, data: committed.get(req.idempotencyKey) };   // replay
      if (step.status && step.status >= 400) return { status: step.status, data: { error: step.error || 'refused', details: step.details } };
      const sale = { id: nextId++, invoiceNo: `INV-${nextId}`, total: req.body.expectedTotal / 100 };
      committed.set(req.idempotencyKey, sale);
      if (step.dropAfter) throw new Error('network down');                     // committed, but the answer was lost
      return { status: 201, data: sale };
    } finally { active -= 1; }
  };
  return { send, committed, calls, get maxActive() { return maxActive; } };
}
const engineFor = (a, srv, over = {}) => { const clock = over.clock || { t: Date.parse('2026-11-13T10:00:00Z') }; const reports = []; const dismissals = []; const e = O.createSyncEngine({ adapter: a, scope: A, role: 'cashier', send: srv.send, probe: async () => true, report: async (i) => { reports.push(...i); }, dismiss: async (r) => { dismissals.push(r); if (over.dismissStatus) throw Object.assign(new Error('refused'), { status: over.dismissStatus }); return { dismissed: true }; }, now: () => clock.t, locks: null, ...over }); return Object.assign(e, { clock, reports, dismissals }); };

// ---------------------------------------------------------------- success path
test('sync: sales are sent one at a time, OLDEST FIRST, with their original key, body and X-Offline-Sale metadata; successes become synced', async () => {
  const a = mem(); const keys = await queueSales(a, 3, A, (i) => ({ items: [{ productId: 5, quantity: i + 1 }], paymentMethod: i === 1 ? 'upi' : 'cash', discount: i === 2 ? { type: 'percent', value: 5 } : null }));
  const srv = fakeServer(); const e = engineFor(a, srv);
  const r = await e.syncNow();
  assert.deepEqual([r.synced, r.failed, r.needsReview, r.status], [3, 0, 0, 'idle']);
  assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), keys, 'oldest first');
  assert.equal(srv.maxActive, 1, 'strictly sequential');
  assert.deepEqual(srv.calls[2].body, { items: [{ productId: 5, quantity: 3 }], paymentMethod: 'cash', discount: { type: 'percent', value: 5 }, expectedTotal: 10500 });
  assert.equal(srv.calls[1].body.paymentMethod, 'upi');
  assert.deepEqual(Object.keys(srv.calls[0].offlineHeader).sort(), ['businessId', 'capturedAt', 'localRef']);
  assert.equal(srv.calls[0].offlineHeader.businessId, 1); assert.equal(srv.calls[0].offlineHeader.localRef, 'OFF-0001');
  const list = await O.listSales(a, A);
  assert.deepEqual(list.map((x) => x.state), ['synced', 'synced', 'synced']); assert.ok(list.every((x) => x.saleId && x.invoiceNo && x.syncedAt));
  assert.equal(srv.committed.size, 3);
  assert.equal((await e.syncNow()).attempted, 0, 'nothing left to send');
});

test('sync: onDrained fires once, only when the queue is really empty', async () => {
  const a = mem(); await queueSales(a, 2); let drained = 0;
  const srv = fakeServer({ script: [{}, { status: 409, details: { code: 'INSUFFICIENT_STOCK' } }] });
  await engineFor(a, srv, { onDrained: () => { drained += 1; } }).syncNow();
  assert.equal(drained, 0, 'one sale still needs review');
  const b = mem(); await queueSales(b, 2); const srv2 = fakeServer(); const e2 = engineFor(b, srv2, { onDrained: () => { drained += 1; } });
  await e2.syncNow(); await e2.syncNow(); assert.equal(drained, 1);
});

// ---------------------------------------------------------------- connectivity
test('connectivity: when the API probe fails nothing is sent and nothing changes — even if the browser claims to be online', async () => {
  const a = mem(); await queueSales(a, 2); const srv = fakeServer(); let probes = 0; const changes = [];
  const e = engineFor(a, srv, { probe: async () => { probes += 1; return false; }, onChange: (c) => changes.push(c.status) });
  const r = await e.syncNow();
  assert.equal(r.status, 'offline'); assert.equal(r.stoppedBecause, 'OFFLINE'); assert.equal(srv.calls.length, 0); assert.equal(probes, 1);
  assert.deepEqual(await states(a), ['pending', 'pending']); assert.equal(e.getStatus().status, 'offline'); assert.ok(changes.includes('offline'));
  assert.equal((await O.listSales(a, A))[0].attempts, 0, 'a failed probe is not an attempt');
});

test('health probe: only a 200 JSON {status:"ok"} counts; errors, timeouts, captive-portal HTML and other statuses are "offline"', async () => {
  const mk = (fetchFn, timeoutMs) => O.createHealthProbe({ base: 'https://api.example.com', fetchFn, timeoutMs });
  const seen = []; const good = mk(async (u, o) => { seen.push([u, o.cache, o.credentials]); return { ok: true, json: async () => ({ status: 'ok' }) }; });
  assert.equal(await good(), true); assert.deepEqual(seen[0].slice(0, 3), ['https://api.example.com/api/health/live', 'no-store', 'omit']);
  assert.equal(await mk(async () => ({ ok: false, json: async () => ({ status: 'ok' }) }))(), false);
  assert.equal(await mk(async () => ({ ok: true, json: async () => { throw new Error('<html>'); } }))(), false);
  assert.equal(await mk(async () => ({ ok: true, json: async () => ({ status: 'degraded' }) }))(), false);
  assert.equal(await mk(async () => { throw new TypeError('Failed to fetch'); })(), false);
  const hang = mk((u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))), 30);
  const t0 = Date.now(); assert.equal(await hang(), false); assert.ok(Date.now() - t0 < 1000, 'a hung connection is cut off by the timeout');
});

// ---------------------------------------------------------------- failure, retry, exactly once
test('network failure mid-batch: the sale in flight is failed (not counted), the rest stay pending untouched; retry later reuses the SAME keys', async () => {
  const a = mem(); const keys = await queueSales(a, 3);
  const srv = fakeServer({ script: [{}, { dropBefore: true }] }); const e = engineFor(a, srv);
  let r = await e.syncNow();
  assert.deepEqual([r.synced, r.failed, r.stoppedBecause], [1, 1, 'NETWORK']); assert.equal(e.getStatus().status, 'offline');
  assert.deepEqual(await states(a), ['synced', 'failed', 'pending']);
  const mid = (await O.listSales(a, A))[1]; assert.equal(mid.lastError.code, 'NETWORK'); assert.equal(mid.failures, 0, 'a network outage never uses up the retry budget');
  r = await e.syncNow();                                                      // still inside the back-off window
  assert.deepEqual([r.attempted, r.stoppedBecause], [0, 'BACKOFF']); assert.equal(r.nextDueAt, mid.nextAttemptAt);
  r = await e.syncNow({ force: true });
  assert.deepEqual(await states(a), ['synced', 'synced', 'synced']); assert.equal(r.synced, 2);
  assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), [keys[0], keys[1], keys[1], keys[2]], 'the retry used the original key, never a new one');
  assert.equal(srv.committed.size, 3);
});

test('retry after back-off: not attempted early, attempted when due, and ORDER is kept (a later sale never jumps over a waiting one)', async () => {
  const a = mem(); const keys = await queueSales(a, 2);
  const srv = fakeServer({ script: [{ status: 503 }] }); const e = engineFor(a, srv);
  assert.equal((await e.syncNow()).stoppedBecause, 'SERVER_UNAVAILABLE');
  const first = (await O.listSales(a, A))[0]; assert.equal(first.state, 'failed'); assert.equal(first.nextAttemptAt, new Date(e.clock.t + 5000).toISOString());
  e.clock.t += 4000; assert.equal((await e.syncNow()).attempted, 0, 'too early');
  assert.equal(srv.calls.length, 1, 'the second sale was NOT sent ahead of the first');
  e.clock.t += 2000; const r = await e.syncNow();
  assert.deepEqual([r.synced, srv.calls.map((c) => c.idempotencyKey)], [2, [keys[0], keys[0], keys[1]]]);
});

test('timeout AFTER the sale committed: the retry returns the original sale — one sale, synced once', async () => {
  const a = mem(); const [k] = await queueSales(a, 1);
  const srv = fakeServer({ script: [{ dropAfter: true }] }); const e = engineFor(a, srv);
  assert.equal((await e.syncNow()).stoppedBecause, 'NETWORK'); assert.equal(srv.committed.size, 1, 'the server DID commit');
  assert.equal((await O.getSale(a, A, k)).state, 'failed');
  const r = await e.syncNow({ force: true });
  assert.equal(r.synced, 1); assert.equal(srv.committed.size, 1, 'still exactly one sale on the server');
  assert.equal((await O.getSale(a, A, k)).saleId, [...srv.committed.values()][0].id, 'recorded against the ORIGINAL sale');
});

test('a tab that died mid-request: after a reload the sale is sent again with the same key and is not duplicated', async () => {
  const a = mem(); const [k] = await queueSales(a, 1); const srv = fakeServer();
  await O.markSyncing(a, A, k);
  // the dead page's request had actually committed on the server
  srv.committed.set(k, { id: 55, invoiceNo: 'INV-55' });
  const lockMgr = { request: async (n, o, fn) => fn({ name: n }) };
  const r = await engineFor(a, srv, { locks: lockMgr }).syncNow();
  assert.equal(r.synced, 1); assert.equal(srv.committed.size, 1); assert.equal((await O.getSale(a, A, k)).saleId, 55);
  assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), [k]);
});

test('without a Web Lock a "syncing" record is left alone (it may belong to a live request in another tab)', async () => {
  const a = mem(); const [k] = await queueSales(a, 1); const srv = fakeServer(); await O.markSyncing(a, A, k);
  const r = await engineFor(a, srv, { locks: null }).syncNow();
  assert.equal(r.attempted, 0); assert.equal(srv.calls.length, 0); assert.equal((await O.getSale(a, A, k)).state, 'syncing');
});

// ---------------------------------------------------------------- duplicate sync requests
test('duplicate sync: calling syncNow many times at once shares ONE round; each sale is sent once', async () => {
  const a = mem(); await queueSales(a, 3); const srv = fakeServer(); const e = engineFor(a, srv);
  const rs = await Promise.all([e.syncNow(), e.syncNow(), e.syncNow(), e.syncNow({ force: true })]);
  assert.equal(srv.calls.length, 3); assert.ok(rs.every((r) => r === rs[0])); assert.equal(srv.committed.size, 3);
});

test('duplicate sync across tabs WITH Web Locks: one tab syncs, the other reports busy and sends nothing', async () => {
  const a = mem(); await queueSales(a, 3); const srv = fakeServer();
  let held = false; const locks = { request: async (n, o, fn) => { if (held) return fn(null); held = true; try { return await fn({ name: n }); } finally { held = false; } } };
  const [r1, r2] = await Promise.all([engineFor(a, srv, { locks }).syncNow(), engineFor(a, srv, { locks }).syncNow()]);
  assert.deepEqual([r1.status, r2.status].sort(), ['busy', 'idle']); assert.equal(srv.calls.length, 3); assert.equal(srv.committed.size, 3);
});

test('duplicate sync across tabs WITHOUT Web Locks: the atomic pending→syncing step means no sale is sent twice', async () => {
  const a = mem(); await queueSales(a, 6); const srv = fakeServer();
  await Promise.all([engineFor(a, srv).syncNow(), engineFor(a, srv).syncNow(), engineFor(a, srv).syncNow()]);
  const sent = srv.calls.map((c) => c.idempotencyKey);
  assert.equal(new Set(sent).size, sent.length, 'no key was sent twice'); assert.equal(srv.committed.size, 6);
  assert.deepEqual(await states(a), Array(6).fill('synced'));
});

// ---------------------------------------------------------------- conflicts
test('stock conflict: needs_review (never auto-retried), quantity untouched, later sales still sync, the issue is reported', async () => {
  const a = mem(); const keys = await queueSales(a, 3, A, (i) => ({ items: [{ productId: 5, quantity: i === 1 ? 7 : 1 }] }));
  const srv = fakeServer({ script: [{}, { status: 409, error: 'Insufficient stock for Milk. Only 4 pcs left.', details: { code: 'INSUFFICIENT_STOCK', productId: 5, name: 'Milk', available: 4, requested: 7 } }] });
  const e = engineFor(a, srv); const r = await e.syncNow();
  assert.deepEqual([r.synced, r.needsReview, r.failed], [2, 1, 0]);
  const [s1, s2, s3] = await O.listSales(a, A);
  assert.deepEqual([s1.state, s2.state, s3.state], ['synced', 'needs_review', 'synced']);
  assert.equal(s2.lastError.code, 'INSUFFICIENT_STOCK'); assert.deepEqual(s2.lastError.details, { productId: 5, name: 'Milk', available: 4, requested: 7 });
  assert.deepEqual(s2.items, [{ productId: 5, quantity: 7 }], 'the requested quantity is never changed'); assert.equal(s2.key, keys[1]);
  assert.equal(e.reports.length, 1); assert.deepEqual([e.reports[0].key, e.reports[0].code, e.reports[0].localRef, e.reports[0].total], [keys[1], 'INSUFFICIENT_STOCK', 'OFF-0002', 105]);
  const before = srv.calls.length; await e.syncNow({ force: true }); await e.syncNow({ force: true });
  assert.equal(srv.calls.length, before, 'a needs_review sale is never sent again by the sync loop, not even with force');
});

test('stock conflict recovery: after a manager fixes stock, an explicit retry sends the SAME key and the sale goes through exactly once', async () => {
  const a = mem(); const [k] = await queueSales(a, 1);
  const srv = fakeServer({ script: [{ status: 409, details: { code: 'INSUFFICIENT_STOCK' } }] }); const e = engineFor(a, srv, { role: 'cashier' });
  await e.syncNow();
  await e.resolve(k, { action: 'retry', decidedBy: 'Asha' });                  // retry is open to the cashier
  assert.equal((await O.getSale(a, A, k)).state, 'pending');
  await e.syncNow(); assert.equal((await O.getSale(a, A, k)).state, 'synced');
  assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), [k, k]); assert.equal(srv.committed.size, 1);
});

test('price change: needs_review keeps the original sale and the server figures; accepting sends the reviewed total + one-shot manager credentials that are never stored', async () => {
  const a = mem(); const [k] = await queueSales(a, 1);
  const details = { code: 'OFFLINE_PRICE_CHANGED', expectedTotal: 105, currentTotal: 126, difference: 21 };
  const srv = fakeServer({ script: [{ status: 409, error: 'The price changed', details }, { status: 403, error: 'needs a manager', details: { code: 'OFFLINE_PRICE_APPROVAL_REQUIRED' } }] });
  const e = engineFor(a, srv, { role: 'cashier' }); await e.syncNow();
  const rec = await O.getSale(a, A, k);
  assert.equal(rec.state, 'needs_review'); assert.deepEqual(rec.lastError.details, { expectedTotal: 105, currentTotal: 126, difference: 21 });
  assert.equal(rec.expectedTotal, 10500); assert.equal(rec.original.expectedTotal, 10500); assert.equal(O.acceptedTotalFor(rec), 12600);
  // The browser does not decide who may accept: the request goes out and the SERVER refuses.
  await e.resolve(k, { action: 'accept_price', decidedBy: 'Cash' });
  const back = await O.getSale(a, A, k);
  assert.equal(back.state, 'pending'); assert.equal(back.expectedTotal, 10500, 'what the customer was shown is NEVER rewritten'); assert.equal(back.acceptedTotal, 12600);
  assert.deepEqual(back.decisions.map((d) => [d.type, d.by, d.totalPaise]), [['accept_price', 'Cash', 12600]]); assert.deepEqual(back.items, [{ productId: 5, quantity: 2 }]);
  await e.syncNow();
  const refused = await O.getSale(a, A, k);
  assert.equal(srv.calls.at(-1).body.expectedTotal, 10500); assert.equal(srv.calls.at(-1).body.acceptPriceTotal, 12600); assert.equal(srv.calls.at(-1).approval, undefined);
  assert.equal(refused.state, 'needs_review'); assert.equal(refused.lastError.code, 'OFFLINE_PRICE_APPROVAL_REQUIRED'); assert.equal(O.acceptedTotalFor(refused), 12600, 'can be accepted again with a manager');
  await e.resolve(k, { action: 'accept_price', decidedBy: 'Cash', approval: { email: 'mgr@shop.test', password: 'secret-pw' } });
  assert.ok(!JSON.stringify(await a.entries('queue')).includes('secret-pw') && !JSON.stringify(await a.entries('queue')).includes('mgr@shop.test'), 'credentials are not stored');
  await e.syncNow();
  assert.deepEqual(srv.calls.at(-1).approval, { email: 'mgr@shop.test', password: 'secret-pw' }); assert.equal(srv.calls.at(-1).idempotencyKey, k);
  assert.equal((await O.getSale(a, A, k)).state, 'synced');
});

test('dismiss is decided by the server first: refused → the sale stays; accepted → dismissed locally; it needs a connection and a reason', async () => {
  const a = mem(); const [k] = await queueSales(a, 1);
  const srv = fakeServer({ script: [{ status: 409, details: { code: 'INSUFFICIENT_STOCK' } }] });
  const refusing = engineFor(a, srv, { role: 'cashier', dismissStatus: 403 }); await refusing.syncNow();
  await assert.rejects(() => refusing.resolve(k, { action: 'dismiss', reason: 'because' }), (err) => err.status === 403);
  assert.equal((await O.getSale(a, A, k)).state, 'needs_review');
  const offline = engineFor(a, srv, { role: 'cashier', probe: async () => false });
  await assert.rejects(() => offline.resolve(k, { action: 'dismiss', reason: 'because' }), (err) => err.code === 'OFFLINE_NEEDS_CONNECTION');
  const ok = engineFor(a, srv, { role: 'cashier' });
  await assert.rejects(() => ok.resolve(k, { action: 'dismiss', reason: ' ' }), (err) => err.code === 'OFFLINE_REASON_REQUIRED');
  const done = await ok.resolve(k, { action: 'dismiss', reason: 'Customer left', decidedBy: 'Cash', approval: { email: 'mgr@shop.test', password: 'secret-pw' } });
  assert.equal(done.state, 'dismissed'); assert.deepEqual(ok.dismissals[0], { key: k, reason: 'Customer left', localRef: done.localRef, total: 105, approval: { email: 'mgr@shop.test', password: 'secret-pw' } });
  assert.ok(!JSON.stringify(await a.entries('queue')).includes('secret-pw'));
});

test('price change decision: "accept" only applies to a price refusal; dismiss needs a reason and is reported; a decision is not available for other states', async () => {
  const a = mem(); const [k1, k2] = await queueSales(a, 2);
  const srv = fakeServer({ script: [{ status: 409, details: { code: 'INSUFFICIENT_STOCK' } }, { status: 409, details: { code: 'INSUFFICIENT_STOCK' } }] });
  const m = engineFor(a, srv, { role: 'business_owner' }); await m.syncNow();
  await assert.rejects(() => m.resolve(k1, { action: 'accept_price' }), (e) => e.code === 'OFFLINE_NO_PRICE_CHANGE');
  await assert.rejects(() => m.resolve(k1, { action: 'dismiss', reason: '' }), (e) => e.code === 'OFFLINE_REASON_REQUIRED');
  await assert.rejects(() => m.resolve(k1, { action: 'wat' }), (e) => e.code === 'OFFLINE_BAD_ACTION');
  const done = await m.resolve(k1, { action: 'dismiss', reason: 'Customer took fewer items', decidedBy: 'Owner' });
  assert.equal(done.state, 'dismissed'); assert.equal(m.dismissals.length, 1); assert.match(m.dismissals[0].reason, /fewer items/);
  await assert.rejects(() => m.resolve(k1, { action: 'retry' }), (e) => e.code === 'OFFLINE_BAD_TRANSITION');
  await assert.rejects(() => m.resolve(key(), { action: 'retry' }), (e) => e.code === 'OFFLINE_NOT_FOUND');
  assert.equal((await O.getSale(a, A, k2)).state, 'needs_review');
});

// ---------------------------------------------------------------- classification
test('classification: every kind of server answer ends in the right state and stops the round only when nothing else could work', () => {
  const t = (status, code) => O.classifyResponse(status, { error: 'x', details: code ? { code } : undefined });
  const shape = (c) => [c.outcome, c.code, c.stop, c.countFailure];
  assert.deepEqual(shape(t(201)), ['synced', null, false, false]); assert.deepEqual(shape(t(200)), ['synced', null, false, false]);
  assert.deepEqual(shape(t(401)), ['failed', 'AUTH_REQUIRED', true, false]); assert.deepEqual(shape(t(402)), ['failed', 'SUBSCRIPTION_INACTIVE', true, false]);
  assert.deepEqual(shape(t(429)), ['failed', 'RATE_LIMITED', true, false]); assert.deepEqual(shape(t(503)), ['failed', 'SERVER_UNAVAILABLE', true, false]);
  assert.deepEqual(shape(t(500)), ['failed', 'SERVER_ERROR', true, true]);
  assert.deepEqual(shape(t(409, 'IDEMPOTENCY_IN_PROGRESS')), ['failed', 'IN_PROGRESS', false, false]);
  assert.deepEqual(shape(t(409, 'INSUFFICIENT_STOCK')), ['needs_review', 'INSUFFICIENT_STOCK', false, false]);
  assert.deepEqual(shape(t(409, 'OFFLINE_PRICE_CHANGED')), ['needs_review', 'OFFLINE_PRICE_CHANGED', false, false]);
  assert.deepEqual(shape(t(409, 'OFFLINE_TENANT_MISMATCH')), ['needs_review', 'OFFLINE_TENANT_MISMATCH', false, false]); assert.deepEqual(shape(t(409)), ['needs_review', 'CONFLICT', false, false]);
  assert.deepEqual(shape(t(404)), ['needs_review', 'NOT_FOUND', false, false]); assert.deepEqual(shape(t(403)), ['needs_review', 'FORBIDDEN', false, false]);
  assert.deepEqual(shape(t(400)), ['needs_review', 'VALIDATION', false, false]); assert.deepEqual(shape(t(422)), ['needs_review', 'KEY_REUSED', false, false]);
  assert.deepEqual(shape(t(418)), ['needs_review', 'HTTP_418', false, false]);
});

test('session expired (401): the round stops with status auth_required, nothing is lost or reordered, and syncing resumes after sign-in', async () => {
  const a = mem(); const keys = await queueSales(a, 3);
  const srv = fakeServer({ script: [{ status: 401 }] }); const e = engineFor(a, srv);
  const r = await e.syncNow();
  assert.equal(r.stoppedBecause, 'AUTH_REQUIRED'); assert.equal(e.getStatus().status, 'auth_required'); assert.equal(srv.calls.length, 1);
  assert.deepEqual(await states(a), ['failed', 'pending', 'pending']); assert.equal((await O.listSales(a, A))[0].lastError.code, 'AUTH_REQUIRED'); assert.equal((await O.listSales(a, A))[0].failures, 0);
  const r2 = await e.syncNow({ force: true });                                // after signing in again
  assert.equal(r2.synced, 3); assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), [keys[0], keys[0], keys[1], keys[2]]);
});

test('subscription lapsed (402): stops with status blocked and keeps every sale', async () => {
  const a = mem(); await queueSales(a, 2); const srv = fakeServer({ script: [{ status: 402 }] }); const e = engineFor(a, srv);
  await e.syncNow(); assert.equal(e.getStatus().status, 'blocked'); assert.deepEqual(await states(a), ['failed', 'pending']);
});

test('nothing retries forever: after MAX_FAILURES real server failures the sale becomes needs_review; network and session trouble never counts', async () => {
  const a = mem(); const [k] = await queueSales(a, 1);
  const srv = fakeServer({ script: Array.from({ length: 40 }, () => ({ dropBefore: true })) }); const e = engineFor(a, srv);
  for (let i = 0; i < 25; i++) await e.syncNow({ force: true });
  let rec = await O.getSale(a, A, k); assert.equal(rec.state, 'failed'); assert.equal(rec.failures, 0, '25 network failures used none of the budget'); assert.ok(rec.attempts >= 25);
  const srv2 = fakeServer({ script: Array.from({ length: 40 }, () => ({ status: 500 })) }); const e2 = engineFor(a, srv2);
  for (let i = 0; i < O.MAX_FAILURES + 3; i++) await e2.syncNow({ force: true });
  rec = await O.getSale(a, A, k);
  assert.equal(rec.state, 'needs_review'); assert.equal(rec.lastError.code, 'SYNC_RETRIES_EXHAUSTED'); assert.equal(srv2.calls.length, O.MAX_FAILURES, 'it stopped trying by itself');
  assert.equal(e2.reports.at(-1).code, 'SYNC_RETRIES_EXHAUSTED');
});

test('a reporting failure never breaks syncing, and force cannot spin on one in-progress sale', async () => {
  const a = mem(); await queueSales(a, 2);
  const srv = fakeServer({ script: [{ status: 409, details: { code: 'INSUFFICIENT_STOCK' } }] });
  const r = await engineFor(a, srv, { report: async () => { throw new Error('reporting is down'); } }).syncNow();
  assert.deepEqual([r.needsReview, r.synced], [1, 1]);
  const b = mem(); await queueSales(b, 1); const busy = fakeServer({ script: Array.from({ length: 50 }, () => ({ status: 409, details: { code: 'IDEMPOTENCY_IN_PROGRESS' } })) });
  const rb = await engineFor(b, busy).syncNow({ force: true }); assert.equal(busy.calls.length, 1, 'one attempt per sale per round'); assert.equal(rb.attempted, 1);
});

// ---------------------------------------------------------------- isolation
test('isolation: an engine only ever sends ITS user\'s sales; another user\'s queue on the same device is never touched', async () => {
  const a = mem(); const mine = await queueSales(a, 2, A); const theirs = await queueSales(a, 2, B);
  const srv = fakeServer(); const e = engineFor(a, srv);
  await e.syncNow();
  assert.deepEqual(srv.calls.map((c) => c.idempotencyKey), mine); assert.ok(srv.calls.every((c) => !theirs.includes(c.idempotencyKey)));
  assert.deepEqual(await states(a, B), ['pending', 'pending']);
  assert.equal(srv.calls.every((c) => c.offlineHeader.businessId === 1), true);
});

// ---------------------------------------------------------------- browser wiring
test('start/stop: the browser "online" event only triggers a real round; "offline" only flips the indicator; the interval re-checks while sales wait', async () => {
  const a = mem(); await queueSales(a, 1); const srv = fakeServer(); let up = false; const changes = [];
  const handlers = {}; const win = { addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; } };
  const e = engineFor(a, srv, { probe: async () => up, onChange: (c) => changes.push(c.status) });
  e.start({ win, intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(srv.calls.length, 0, 'the API is not reachable, so nothing was sent'); assert.equal(e.getStatus().status, 'offline');
  up = true; handlers.online();                                                // the browser says "online" AND the probe now succeeds
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(srv.calls.length, 1); assert.equal((await O.listSales(a, A))[0].state, 'synced');
  handlers.offline(); assert.equal(e.getStatus().status, 'offline');
  e.stop(); assert.deepEqual(Object.keys(handlers), []);
});
