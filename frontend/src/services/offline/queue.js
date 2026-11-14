// The offline sale queue (Phase 17B). A queued sale is a PENDING REQUEST to the normal POST /sales path — it never touches stock, inventory
// movements, avg_cost or the sales ledger. Those change only when the server accepts the sale (17C).
//
// Record = an immutable core (what was sold, how it was paid, the total the customer was shown, the idempotency key) + mutable sync state.
// The core is never rewritten. The idempotency key is the record's key and NEVER changes, so every retry is the same request.
//
// States:   pending → syncing → synced
//                      ├────→ failed        (transient: network, 5xx, 429, session expired) — retried automatically
//                      └────→ needs_review  (permanent refusal: stock, price changed, product gone, …) — never auto-retried
//           needs_review → pending  (explicit decision: retry, optionally accepting the new total)
//           needs_review → dismissed (explicit decision with a reason; nothing is sent)
//           syncing → pending  (the tab died mid-request: outcome unknown, safe to resend with the same key)
import { OfflineError } from './db.js';
import { assertScope, sameScope, scopeKey } from './scope.js';

export const STATES = ['pending', 'syncing', 'synced', 'failed', 'needs_review', 'dismissed'];
export const UNSYNCED = ['pending', 'syncing', 'failed', 'needs_review'];
export const OFFLINE_PAYMENT_METHODS = ['cash', 'upi', 'card'];   // credit (udhaar) needs the server (customer limit under a row lock)
export const MAX_QUEUE = 500;
const MAX_ITEMS = 100;                                              // same cap as POST /sales
const RETAIN_MS = 7 * 24 * 3600e3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TRANSITIONS = {
  pending: ['syncing'],
  syncing: ['synced', 'failed', 'needs_review', 'pending'],
  failed: ['syncing', 'pending', 'needs_review'],
  needs_review: ['pending', 'dismissed'],
  synced: [],
  dismissed: [],
};

const bad = (code, message, details) => new OfflineError(code, message, details);
const round3 = (n) => Math.round(n * 1000) / 1000;
const isoNow = (now) => new Date(now).toISOString();
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Next attempt delay after `attempts` tries: 5 s, 10 s, 20 s … capped at 5 minutes. */
export const backoffMs = (attempts) => Math.min(5 * 60e3, 5000 * 2 ** Math.max(0, attempts - 1));

// ---------------------------------------------------------------- validation (whitelists: nothing else is ever stored)
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw bad('OFFLINE_EMPTY_SALE', 'Add at least one product.');
  if (items.length > MAX_ITEMS) throw bad('OFFLINE_TOO_MANY_ITEMS', `A bill can have at most ${MAX_ITEMS} lines.`);
  return items.map((i) => {
    const q = Number(i && i.quantity);
    if (!Number.isInteger(i && i.productId) || i.productId <= 0) throw bad('OFFLINE_BAD_ITEM', 'A bill line has no valid product.');
    if (!Number.isFinite(q) || q <= 0 || q > 1e6 || Math.abs(q * 1000 - Math.round(q * 1000)) > 1e-6) throw bad('OFFLINE_BAD_ITEM', 'A bill line has an invalid quantity.');
    return { productId: i.productId, quantity: round3(q) };
  });
}
function cleanDiscount(d) {
  if (d == null) return null;
  const v = Number(d.value);
  if (!['amount', 'percent'].includes(d.type) || !Number.isFinite(v) || v < 0 || (d.type === 'percent' && v > 100)) throw bad('OFFLINE_BAD_DISCOUNT', 'The discount is not valid.');
  return v > 0 ? { type: d.type, value: v } : null;
}
function cleanDisplay(d) {
  const lines = ((d && d.lines) || []).slice(0, MAX_ITEMS).map((l) => ({ productId: l.productId, name: str(l.name, 160), unit: str(l.unit, 8), price: num(l.price), quantity: num(l.quantity), lineTotal: num(l.lineTotal) }));
  const b = (d && d.bill) || {};
  return {
    lines,
    bill: { subtotal: num(b.subtotal), discount: num(b.discount), discountPct: num(b.discountPct), tax: num(b.tax), taxIncluded: num(b.taxIncluded), taxAdded: num(b.taxAdded), total: num(b.total), itemCount: num(b.itemCount) },
    cashierName: d && d.cashierName ? str(d.cashierName, 80) : null,
  };
}

/** What makes two enqueue calls "the same sale" (used to tell a harmless duplicate from a reused key). */
const fingerprint = (r) => JSON.stringify({ b: r.businessId, u: r.userId, i: [...r.items].sort((a, b) => a.productId - b.productId), d: r.discount, p: r.paymentMethod, t: r.original.expectedTotal });

// ---------------------------------------------------------------- creating
async function nextRef(adapter, scope) {
  const n = await adapter.update('meta', `seq:${scopeKey(scope)}`, (prev) => ({ write: (prev || 0) + 1, result: (prev || 0) + 1 }));
  return { seq: n, localRef: `OFF-${String(n).padStart(4, '0')}` };
}

/**
 * Stores a sale for later submission. `key` is the idempotency key (a uuid made ONCE for this bill — the POS already makes one per bill).
 * Re-enqueueing the same key with the same sale returns the existing record (duplicate: true) and never stores a second copy;
 * the same key with a DIFFERENT sale is refused, exactly as the server would refuse it.
 */
export async function enqueueSale(adapter, scope, input, { now = Date.now() } = {}) {
  assertScope(scope);
  const key = String(input && input.key || '').toLowerCase();
  if (!UUID.test(key)) throw bad('OFFLINE_BAD_KEY', 'A sale needs a client-generated idempotency key (UUID).');
  if (!OFFLINE_PAYMENT_METHODS.includes(input.paymentMethod)) {
    throw bad('OFFLINE_PAYMENT_NOT_SUPPORTED', input.paymentMethod === 'credit' ? 'Credit (udhaar) needs a connection to the server. Choose cash, UPI or card, or wait until you are online.' : 'That payment method is not available offline.');
  }
  const expectedTotal = Number(input.expectedTotal);
  if (!Number.isInteger(expectedTotal) || expectedTotal < 0) throw bad('OFFLINE_BAD_TOTAL', 'The bill total (in paise) is missing.');
  const items = cleanItems(input.items);
  const discount = cleanDiscount(input.discount);

  const existing = await adapter.get('queue', key);
  const incoming = { businessId: scope.businessId, userId: scope.userId, items, discount, paymentMethod: input.paymentMethod, original: { expectedTotal } };
  if (existing) {
    if (fingerprint(existing) !== fingerprint(incoming)) throw bad('OFFLINE_KEY_REUSED', 'This idempotency key was already used for a different sale.');
    if (!sameScope(existing, scope)) throw bad('OFFLINE_SCOPE_MISMATCH', 'That sale belongs to another business or user on this device.');
    return { record: existing, duplicate: true };
  }
  const unsynced = (await listSales(adapter, scope)).filter((r) => UNSYNCED.includes(r.state)).length;
  if (unsynced >= MAX_QUEUE) throw bad('OFFLINE_QUEUE_FULL', `${MAX_QUEUE} sales are already waiting to sync on this device. Reconnect before selling more.`);

  const { seq, localRef } = await nextRef(adapter, scope);
  const record = {
    v: 1, key, seq, localRef, businessId: scope.businessId, userId: scope.userId,
    capturedAt: isoNow(now), items, discount, paymentMethod: input.paymentMethod,
    unverifiedTender: input.paymentMethod !== 'cash',       // UPI/card are recorded, not verified, while offline
    expectedTotal, original: { expectedTotal }, display: cleanDisplay(input.display),
    state: 'pending', attempts: 0, failures: 0, lastAttemptAt: null, nextAttemptAt: null, lastError: null, syncedAt: null, saleId: null, invoiceNo: null, decisions: [],
  };
  const won = await adapter.update('queue', key, (prev) => (prev ? { result: false } : { write: record, result: true }));
  if (!won) return { record: await adapter.get('queue', key), duplicate: true };     // another tab stored the same key first
  return { record, duplicate: false };
}

// ---------------------------------------------------------------- reading (always filtered to the caller's scope)
const inScope = (r, scope) => r && sameScope(r, scope);

export async function getSale(adapter, scope, key) {
  assertScope(scope);
  const r = await adapter.get('queue', String(key).toLowerCase());
  return inScope(r, scope) ? r : null;
}
export async function listSales(adapter, scope, { states } = {}) {
  assertScope(scope);
  return (await adapter.entries('queue')).map(([, v]) => v).filter((r) => inScope(r, scope) && (!states || states.includes(r.state))).sort((a, b) => a.seq - b.seq);
}
export async function countsByState(adapter, scope) {
  const out = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of await listSales(adapter, scope)) out[r.state] += 1;
  return out;
}
/** Sales that still have to reach the server. Shift closing is blocked while this is above zero. */
export async function unsyncedCount(adapter, scope) { const c = await countsByState(adapter, scope); return UNSYNCED.reduce((a, s) => a + c[s], 0); }
/** How many records on this device belong to someone ELSE (count only — their content is never returned). */
export async function foreignCount(adapter, scope) {
  assertScope(scope);
  return (await adapter.entries('queue')).filter(([, v]) => !sameScope(v, scope) && UNSYNCED.includes(v.state)).length;
}
/** productId → quantity already promised to customers offline and not yet synced; the offline cart caps against stock minus this. */
export async function queuedQuantities(adapter, scope) {
  const m = new Map();
  for (const r of await listSales(adapter, scope, { states: UNSYNCED })) for (const i of r.items) m.set(i.productId, round3((m.get(i.productId) || 0) + i.quantity));
  return m;
}
/** The request to send for a record: body for POST /sales plus the X-Offline-Sale metadata. The key and items are exactly as first stored. */
export function requestFor(record) {
  return {
    idempotencyKey: record.key,
    body: { items: record.items, paymentMethod: record.paymentMethod, ...(record.discount ? { discount: record.discount } : {}), expectedTotal: record.expectedTotal, ...(record.acceptedTotal != null ? { acceptPriceTotal: record.acceptedTotal } : {}) },
    offlineHeader: { capturedAt: record.capturedAt, businessId: record.businessId, localRef: record.localRef },
  };
}

// ---------------------------------------------------------------- transitions (the only way sync state ever changes)
async function move(adapter, scope, key, to, patch, { now = Date.now(), decision } = {}) {
  assertScope(scope);
  const k = String(key).toLowerCase();
  return adapter.update('queue', k, (prev) => {
    if (!prev || !inScope(prev, scope)) throw bad('OFFLINE_NOT_FOUND', 'That offline sale is not on this device for this user.');
    if (!(TRANSITIONS[prev.state] || []).includes(to)) throw bad('OFFLINE_BAD_TRANSITION', `A ${prev.state} sale cannot become ${to}.`, { from: prev.state, to });
    const next = { ...prev, ...patch(prev), state: to, ...(decision ? { decisions: [...prev.decisions, { ...decision, at: isoNow(now), from: prev.state }] } : {}) };
    return { write: next, result: next };
  });
}
// Only small, non-sensitive facts about WHY the server refused are kept (the figures a person needs to decide).
const DETAIL_KEYS = ['productId', 'name', 'available', 'requested', 'expectedTotal', 'currentTotal', 'difference'];
const cleanDetails = (d) => (d && typeof d === 'object' ? Object.fromEntries(DETAIL_KEYS.filter((k) => d[k] !== undefined && ['string', 'number'].includes(typeof d[k])).map((k) => [k, typeof d[k] === 'string' ? str(d[k], 160) : d[k]])) : null);
const errorInfo = (e) => ({ code: str(e && e.code || 'UNKNOWN', 40), message: str(e && e.message || '', 200), status: e && Number.isInteger(e.status) ? e.status : null, details: cleanDetails(e && e.details), at: null });

export const markSyncing = (a, s, k, { now = Date.now() } = {}) => move(a, s, k, 'syncing', (p) => ({ attempts: p.attempts + 1, lastAttemptAt: isoNow(now), nextAttemptAt: null }), { now });
export const markSynced = (a, s, k, { saleId = null, invoiceNo = null, now = Date.now() } = {}) => move(a, s, k, 'synced', () => ({ saleId, invoiceNo, syncedAt: isoNow(now), lastError: null, nextAttemptAt: null }), { now });
// countFailure=false for "the network/session was the problem": those must never use up the retry budget of a sale.
export const markFailed = (a, s, k, error, { now = Date.now(), countFailure = true } = {}) => move(a, s, k, 'failed', (p) => ({ lastError: { ...errorInfo(error), at: isoNow(now) }, failures: (p.failures || 0) + (countFailure ? 1 : 0), nextAttemptAt: isoNow(now + backoffMs(p.attempts)) }), { now });
export const markNeedsReview = (a, s, k, error, { now = Date.now() } = {}) => move(a, s, k, 'needs_review', () => ({ lastError: { ...errorInfo(error), at: isoNow(now) }, nextAttemptAt: null }), { now });

/**
 * An explicit person's decision to try a needs_review sale again. With acceptTotalPaise (price changed) the figure is stored as `acceptedTotal` and sent as
 * acceptPriceTotal; expectedTotal (what the customer was shown) is NEVER rewritten, so the server still sees the difference and itself
 * requires an owner/manager. Who decided is kept in `decisions`, and the items are never touched.
 */
export async function retryAfterReview(adapter, scope, key, { acceptTotalPaise, decidedBy, now = Date.now() } = {}) {
  if (acceptTotalPaise !== undefined && (!Number.isInteger(acceptTotalPaise) || acceptTotalPaise < 0)) throw bad('OFFLINE_BAD_TOTAL', 'The accepted total is not valid.');
  return move(adapter, scope, key, 'pending', (p) => ({
    ...(acceptTotalPaise !== undefined ? { acceptedTotal: acceptTotalPaise } : {}), nextAttemptAt: null, failures: 0,   // an explicit decision gets a fresh retry budget
  }), { now, decision: { type: acceptTotalPaise !== undefined ? 'accept_price' : 'retry', by: str(decidedBy, 80), ...(acceptTotalPaise !== undefined ? { totalPaise: acceptTotalPaise } : {}) } });
}
/** An explicit decision NOT to send the sale. A reason is mandatory; the record is kept (not deleted) so the decision stays visible. */
export async function dismissSale(adapter, scope, key, { reason, decidedBy, now = Date.now() } = {}) {
  const r = str(reason, 200).trim();
  if (r.length < 3) throw bad('OFFLINE_REASON_REQUIRED', 'Say why this sale is being dismissed.');
  return move(adapter, scope, key, 'dismissed', () => ({ nextAttemptAt: null }), { now, decision: { type: 'dismiss', by: str(decidedBy, 80), reason: r } });
}

/** The total (paise) the server would charge now, when the last refusal was OFFLINE_PRICE_CHANGED; otherwise null. Used by "accept the new price". */
export function acceptedTotalFor(record) {
  const e = record && record.lastError;
  if (e && e.code === 'OFFLINE_PRICE_CHANGED' && e.details && Number.isFinite(e.details.currentTotal)) return Math.round(e.details.currentTotal * 100);
  // The server refused the approval itself (403): the same reviewed total can be accepted again with a valid owner/manager.
  if (e && e.status === 403 && record.acceptedTotal != null) return record.acceptedTotal;
  return null;
}

/** After a reload no request can still be in flight from this page, so a `syncing` record means "outcome unknown": resend with the SAME key. */
export async function recoverInterrupted(adapter, scope) {
  let n = 0;
  for (const r of await listSales(adapter, scope, { states: ['syncing'] })) {
    try { await move(adapter, scope, r.key, 'pending', () => ({}), {}); n += 1; } catch { /* another tab finished it */ }
  }
  return n;
}

// ---------------------------------------------------------------- housekeeping
export async function pruneFinished(adapter, scope, { olderThanMs = RETAIN_MS, now = Date.now() } = {}) {
  let n = 0;
  for (const r of await listSales(adapter, scope, { states: ['synced', 'dismissed'] })) {
    const at = Date.parse(r.syncedAt || (r.decisions[r.decisions.length - 1] || {}).at || r.capturedAt);
    if (now - at > olderThanMs) { await adapter.del('queue', r.key); n += 1; }
  }
  return n;
}
/** A copy of this user's unsynced sales as JSON, so a manager can rescue them if a device is retired. Contains only whitelisted fields. */
export async function exportUnsynced(adapter, scope) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), scope: { businessId: scope.businessId, userId: scope.userId }, sales: await listSales(adapter, scope, { states: UNSYNCED }) }, null, 2);
}
/** Deletes this user's whole queue. Refuses unless the caller explicitly confirms that unsynced sales will be lost. */
export async function discardQueue(adapter, scope, { confirmDiscardUnsyncedSales = false } = {}) {
  const unsynced = await unsyncedCount(adapter, scope);
  if (unsynced > 0 && confirmDiscardUnsyncedSales !== true) throw bad('OFFLINE_UNSYNCED_SALES', `${unsynced} sale(s) have not reached the server. Sync them or confirm that they should be discarded.`, { unsynced });
  let n = 0;
  for (const r of await listSales(adapter, scope)) { await adapter.del('queue', r.key); n += 1; }
  return n;
}
