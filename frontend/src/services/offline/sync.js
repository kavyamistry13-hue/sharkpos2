// Offline synchronisation (Phase 17C).
//
// The browser NEVER changes stock, inventory movements, avg_cost or the sales ledger. It only replays each queued sale through the normal
// POST /sales (the single authoritative sale path) with the sale's ORIGINAL idempotency key. Exactly-once comes from the server:
// a retry of a sale that already committed returns the original sale (and changes nothing), so a lost response, a crash, a second tab or
// a repeated sync can never create a second sale or a second stock movement.
//
//   * Connectivity is proven by a real request to /api/health/live, not by navigator.onLine (which only says a network card is on).
//   * Sales go one at a time, oldest first, so the earlier sale wins contested stock.
//   * Transient trouble (network, session, 5xx, rate limit, plan) → `failed`, retried with back-off, and the loop stops.
//   * A permanent refusal (stock, price changed, product gone, wrong business, …) → `needs_review`: kept exactly as made, never
//     auto-retried, reported to the audit log, and waits for a person's decision. The loop carries on with the next sale.
//   * Nothing retries forever: after MAX_FAILURES real failures a sale also becomes needs_review.
import { OfflineError } from './db.js';
import { scopeKey, assertScope } from './scope.js';
import {
  listSales, markSyncing, markSynced, markFailed, markNeedsReview, requestFor, recoverInterrupted,
  retryAfterReview, dismissSale, getSale, unsyncedCount, acceptedTotalFor,
} from './queue.js';

export const MAX_FAILURES = 10;                 // real failed attempts (5 s, 10 s … 5 min back-off ≈ 25 min) before a person must look
export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_INTERVAL_MS = 15000;

// ---------------------------------------------------------------- connectivity
/** Is the API really reachable? Any failure, timeout, non-200 or non-JSON answer (captive portal, proxy error page) counts as "no". */
export function createHealthProbe({ base = '', fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return async function probe() {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(`${base}/api/health/live`, { cache: 'no-store', credentials: 'omit', ...(ctl ? { signal: ctl.signal } : {}) });
      if (!res.ok) return false;
      const body = await res.json();
      return !!body && body.status === 'ok';
    } catch { return false; } finally { if (timer) clearTimeout(timer); }
  };
}

// ---------------------------------------------------------------- how a server answer is treated
/**
 * outcome: 'synced' | 'failed' | 'needs_review'.  stop: nothing else would work right now, so end this round.
 * countFailure: whether this uses up the sale's retry budget (network, session and infrastructure trouble does not).
 */
export function classifyResponse(status, data) {
  const code = data && data.details && data.details.code;
  const message = (data && data.error) || '';
  const details = data && data.details;
  const r = (outcome, c, extra = {}) => ({ outcome, code: c, message, status, details, stop: false, countFailure: false, ...extra });
  if (status === 200 || status === 201) return r('synced', null);
  if (status === 401) return r('failed', 'AUTH_REQUIRED', { stop: true });                      // session expired and could not be renewed: sign in again
  if (status === 402) return r('failed', 'SUBSCRIPTION_INACTIVE', { stop: true });
  if (status === 403) return r('needs_review', code || 'FORBIDDEN');
  if (status === 408 || status === 425 || status === 429) return r('failed', status === 429 ? 'RATE_LIMITED' : 'TIMEOUT', { stop: true });
  if (status === 502 || status === 503 || status === 504) return r('failed', 'SERVER_UNAVAILABLE', { stop: true });
  if (status >= 500) return r('failed', 'SERVER_ERROR', { stop: true, countFailure: true });
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') return r('failed', 'IN_PROGRESS');   // another tab/request is mid-flight with this key: look again soon
  if (status === 409) return r('needs_review', code || 'CONFLICT');                           // INSUFFICIENT_STOCK, OFFLINE_PRICE_CHANGED, OFFLINE_TENANT_MISMATCH, …
  if (status === 404) return r('needs_review', code || 'NOT_FOUND');                          // product no longer exists / not visible to this business
  if (status === 422) return r('needs_review', code || 'KEY_REUSED');
  if (status === 400) return r('needs_review', code || 'VALIDATION');
  if (status >= 400) return r('needs_review', code || `HTTP_${status}`);
  return r('failed', 'UNEXPECTED_RESPONSE', { countFailure: true });
}

// ---------------------------------------------------------------- api adapters (thin; the engine itself never imports the api client)
/** send(request) → { status, data } for any answer from the server; THROWS only when the server could not be reached at all. */
export function createApiSender(api) {
  return async function send(req) {
    try {
      const data = await api.post('/sales', req.approval ? { ...req.body, approval: req.approval } : req.body, { idempotencyKey: req.idempotencyKey, headers: { 'x-offline-sale': JSON.stringify(req.offlineHeader) }, noRetry: true });
      return { status: 200, data };
    } catch (e) {
      if (e && Number.isInteger(e.status) && e.status > 0) return { status: e.status, data: { error: e.message, details: e.details } };
      throw e;
    }
  };
}
/** Dismissal is recorded by the SERVER (owner/manager only, audited). Throws the api error on refusal or when unreachable. */
export function createApiDismisser(api) {
  return (req) => api.post('/sales/offline-dismissals', req, { noRetry: true });
}
export function createApiReporter(api) { return (issues) => api.post('/sales/sync-issues', { issues }); }

// ---------------------------------------------------------------- the engine
export function createSyncEngine({ adapter, scope, role, send, probe, report, dismiss, now = () => Date.now(), locks = globalThis.navigator && globalThis.navigator.locks, onChange, onDrained }) {
  assertScope(scope);
  let status = 'idle';                  // idle | offline | syncing | auth_required | blocked
  let last = null;
  let inFlight = null;
  let timer = null; let listeners = null;
  // Manager credentials typed for ONE price decision. Memory only, used for a single request, then dropped: never written to the queue/IndexedDB.
  const approvals = new Map();

  const emit = (patch = {}) => { status = patch.status || status; if (onChange) { try { onChange({ status, last }); } catch { /* a UI error must never break syncing */ } } };

  const issueFor = (record, error) => ({ key: record.key, code: String(error.code).slice(0, 40), message: String(error.message || '').slice(0, 200), localRef: record.localRef, capturedAt: record.capturedAt, total: record.original.expectedTotal / 100 });
  async function tell(record, error) {
    if (!report) return;
    try { await report([issueFor(record, error)]); } catch { /* best effort: the sale and its state are already safe on this device */ }
  }

  async function round(force, haveLock) {
    const out = { status: 'idle', synced: 0, failed: 0, needsReview: 0, attempted: 0, stoppedBecause: null, nextDueAt: null };
    if (!(await probe())) { emit({ status: 'offline' }); return { ...out, status: 'offline', stoppedBecause: 'OFFLINE' }; }
    emit({ status: 'syncing' });
    // Holding the lock means no other tab is syncing, so a record still marked `syncing` belongs to a request that died with its page.
    if (haveLock) await recoverInterrupted(adapter, scope);

    const tried = new Set();            // each sale is attempted at most ONCE per round, so even `force` cannot spin on one stubborn sale
    for (;;) {
      const queue = await listSales(adapter, scope, { states: ['pending', 'failed'] });
      const record = queue.find((r) => !tried.has(r.key));
      if (!record) break;
      tried.add(record.key);
      if (record.state === 'failed' && !force && record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now()) {
        out.nextDueAt = record.nextAttemptAt; out.stoppedBecause = 'BACKOFF'; break;       // keep order: do not jump over a sale that is waiting to retry
      }
      let claimed;
      try { claimed = await markSyncing(adapter, scope, record.key, { now: now() }); } catch { continue; }   // another tab got it first
      out.attempted += 1;

      let resp;
      const approval = approvals.get(claimed.key); approvals.delete(claimed.key);
      try { resp = await send(approval ? { ...requestFor(claimed), approval } : requestFor(claimed)); } catch (e) {
        await markFailed(adapter, scope, claimed.key, { code: 'NETWORK', message: 'Could not reach the server.', status: 0 }, { now: now(), countFailure: false });
        out.failed += 1; out.stoppedBecause = 'NETWORK'; emit({ status: 'offline' }); last = out; return out;
      }
      const c = classifyResponse(resp.status, resp.data);
      const error = { code: c.code, message: c.message, status: c.status, details: c.details };

      if (c.outcome === 'synced') {
        const sale = resp.data || {};
        await markSynced(adapter, scope, claimed.key, { saleId: sale.id ?? null, invoiceNo: sale.invoiceNo ?? null, now: now() });
        out.synced += 1;
      } else if (c.outcome === 'needs_review') {
        await markNeedsReview(adapter, scope, claimed.key, error, { now: now() });
        out.needsReview += 1; await tell(claimed, error);
      } else {
        const failed = await markFailed(adapter, scope, claimed.key, error, { now: now(), countFailure: c.countFailure });
        if ((failed.failures || 0) >= MAX_FAILURES) {
          const giveUp = { code: 'SYNC_RETRIES_EXHAUSTED', message: `Could not be sent after ${MAX_FAILURES} tries (last problem: ${c.code}).`, status: c.status };
          await markNeedsReview(adapter, scope, claimed.key, giveUp, { now: now() });
          out.needsReview += 1; await tell(claimed, giveUp);
        } else out.failed += 1;
      }
      if (c.stop) {
        out.stoppedBecause = c.code;
        emit({ status: c.code === 'AUTH_REQUIRED' ? 'auth_required' : c.code === 'SUBSCRIPTION_INACTIVE' ? 'blocked' : 'idle' });
        last = out; return out;
      }
    }
    const remaining = await unsyncedCount(adapter, scope);
    out.status = 'idle'; out.remaining = remaining;
    emit({ status: 'idle' }); last = out;
    if (remaining === 0 && out.synced > 0 && onDrained) { try { await onDrained(out); } catch { /* best effort */ } }
    return out;
  }

  /**
   * One synchronisation round. Concurrent calls in this page share one round; across tabs a Web Lock (where supported) lets exactly one
   * tab sync, and without Web Locks the atomic pending→syncing step plus server idempotency still guarantee no duplicate.
   * `force` ignores back-off times (used by "Sync now" and after sign-in) but never touches needs_review.
   */
  function syncNow({ force = false } = {}) {
    if (inFlight) return inFlight;
    const run = async () => {
      if (locks && typeof locks.request === 'function') {
        return locks.request(`sharkpos-offline-sync:${scopeKey(scope)}`, { ifAvailable: true }, async (lock) => {
          if (!lock) return { status: 'busy', synced: 0, failed: 0, needsReview: 0, attempted: 0, stoppedBecause: 'OTHER_TAB_SYNCING', nextDueAt: null };
          return round(force, true);
        });
      }
      return round(force, false);
    };
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * A person's decision about a needs_review sale. Retrying is open to anyone. Accepting a new price and dismissing are owner/manager
   * decisions enforced by the SERVER: an owner/manager session is enough; a cashier session must pass `approval` {email, password} of an
   * owner/manager, which is sent once and never stored. The browser does not decide who may do this.
   */
  async function resolve(key, { action, decidedBy, reason, approval } = {}) {
    const record = await getSale(adapter, scope, key);
    if (!record) throw new OfflineError('OFFLINE_NOT_FOUND', 'That offline sale is not on this device for this user.');
    if (record.state !== 'needs_review') throw new OfflineError('OFFLINE_BAD_TRANSITION', 'Only a sale that needs review can be resolved.');
    if (action === 'retry') return retryAfterReview(adapter, scope, key, { decidedBy });
    if (action === 'accept_price') {
      const total = acceptedTotalFor(record);
      if (total === null) throw new OfflineError('OFFLINE_NO_PRICE_CHANGE', 'This sale was not refused because of a price change.');
      const next = await retryAfterReview(adapter, scope, key, { acceptTotalPaise: total, decidedBy });
      if (approval && approval.email && approval.password) approvals.set(record.key, { email: String(approval.email), password: String(approval.password) });
      return next;
    }
    if (action === 'dismiss') {
      if (!dismiss) throw new OfflineError('OFFLINE_NOT_AVAILABLE', 'Dismissing needs a connection to the server.');
      if (!(await probe())) throw new OfflineError('OFFLINE_NEEDS_CONNECTION', 'Dismissing a sale is recorded on the server. Reconnect and try again.');
      const why = String(reason || '').trim();
      if (why.length < 3) throw new OfflineError('OFFLINE_REASON_REQUIRED', 'Say why this sale is being dismissed.');
      // The server decides (owner/manager only) and records it; only after it agrees is the sale dismissed on this device.
      await dismiss({ key: record.key, reason: why.slice(0, 200), localRef: record.localRef, total: record.original.expectedTotal / 100, ...(approval && approval.email ? { approval: { email: String(approval.email), password: String(approval.password || '') } } : {}) });
      return dismissSale(adapter, scope, key, { reason: why, decidedBy });
    }
    throw new OfflineError('OFFLINE_BAD_ACTION', 'Unknown decision.');
  }

  /** Browser wiring: the `online` event is only a HINT to try; a real probe decides. Also re-checks every 15 s while anything waits. */
  function start({ win = globalThis.window, intervalMs = PROBE_INTERVAL_MS } = {}) {
    stop();
    const hint = () => { syncNow().catch(() => {}); };
    const down = () => emit({ status: 'offline' });
    if (win && win.addEventListener) { win.addEventListener('online', hint); win.addEventListener('offline', down); listeners = { win, hint, down }; }
    timer = setInterval(async () => { try { if (status === 'offline' || (await unsyncedCount(adapter, scope)) > 0) await syncNow(); } catch { /* next tick */ } }, intervalMs);
    hint();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (listeners) { listeners.win.removeEventListener('online', listeners.hint); listeners.win.removeEventListener('offline', listeners.down); listeners = null; }
  }

  return { syncNow, resolve, start, stop, getStatus: () => ({ status, last }), checkConnectivity: async () => { const up = await probe(); emit({ status: up ? (status === 'offline' ? 'idle' : status) : 'offline' }); return up; } };
}
