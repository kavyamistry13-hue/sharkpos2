// What the till shows about connectivity and the sync queue (Phase 17D). Pure function: the same inputs always give the same label,
// so the wording is unit-tested. Order matters: a sale that needs a decision is never hidden behind "ONLINE" or "SYNCING".
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function describeStatus({ available = true, engine = 'idle', navigatorOnline = true, unsynced = 0, needsReview = 0, failed = 0, syncing = 0 } = {}) {
  if (!available) return { level: 'unavailable', label: 'OFFLINE SALES UNAVAILABLE', detail: 'This browser cannot store sales offline. A connection is needed to sell.', tone: 'warn' };
  const waiting = unsynced > 0 ? `${plural(unsynced, 'sale is', 'sales are')} waiting to sync` : '';
  if (needsReview > 0) return { level: 'review', label: 'SYNC FAILED / NEEDS REVIEW', detail: `${plural(needsReview, 'sale needs', 'sales need')} a decision. Nothing was lost; it is still saved on this device.`, tone: 'bad' };
  if (engine === 'auth_required') return { level: 'auth', label: 'SIGN IN TO SYNC', detail: unsynced ? `${waiting}. Sign in again to send ${unsynced === 1 ? 'it' : 'them'}.` : 'Your session ended. Sign in again.', tone: 'warn' };
  if (engine === 'blocked') return { level: 'blocked', label: 'SYNC PAUSED', detail: `${unsynced ? `${waiting}. ` : ''}The subscription is inactive. Renew it to sync.`, tone: 'bad' };
  if (engine === 'offline' || !navigatorOnline) return { level: 'offline', label: 'OFFLINE', detail: unsynced ? `${waiting}.` : 'You can keep selling. Sales are saved on this device and sent when the connection returns.', tone: 'warn' };
  if (engine === 'syncing' || syncing > 0) return { level: 'syncing', label: 'SYNCING', detail: unsynced ? `Sending ${plural(unsynced, 'sale', 'sales')}…` : 'Sending…', tone: 'info' };
  if (unsynced > 0) return { level: 'waiting', label: `${plural(unsynced, 'sale', 'sales')} waiting to sync`, detail: failed > 0 ? 'The last attempt failed. It will retry automatically.' : 'They will be sent automatically.', tone: 'warn' };
  return { level: 'online', label: 'ONLINE', detail: 'Connected. Sales go straight to the server.', tone: 'ok' };
}

/** The human wording for a refusal code kept on a queued sale. */
export function explainError(e) {
  if (!e) return '';
  const d = e.details || {};
  switch (e.code) {
    case 'OFFLINE_PRICE_CHANGED': return `The price changed: ₹${d.expectedTotal} was charged, but it is now ₹${d.currentTotal}.`;
    case 'INSUFFICIENT_STOCK': return d.name ? `Not enough stock for ${d.name}${d.available !== undefined ? ` (${d.available} left, ${d.requested} sold)` : ''}.` : 'Not enough stock for this sale.';
    case 'OFFLINE_PRICE_APPROVAL_REQUIRED': return 'Accepting a different price needs an owner or manager.';
    case 'OFFLINE_TENANT_MISMATCH': return 'This sale was made under a different business and was NOT sent.';
    case 'SYNC_RETRIES_EXHAUSTED': return e.message || 'It could not be sent after many tries.';
    case 'NOT_FOUND': return 'A product on this sale no longer exists.';
    case 'APPROVAL_REQUIRED': return 'The discount needs a manager’s approval.';
    default: return e.message || 'The server did not accept this sale.';
  }
}
