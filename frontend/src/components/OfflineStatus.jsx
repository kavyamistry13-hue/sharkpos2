// Offline POS (Phase 17D): the always-visible connection/sync status, the queue panel where waiting sales and decisions live, and the
// provisional receipt shown after a sale is saved offline. Presentation only: every rule is in services/offline and, for money decisions,
// on the server.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudOff, RefreshCw, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useOffline } from '../hooks/useOffline';
import { Badge, Button, Field, Input, Modal, Textarea, cx } from './ui';
import { dateTime, inr } from '../utils/format';
import { acceptedTotalFor, explainError } from '../services/offline/index.js';

const DOT = { ok: 'bg-ok', info: 'bg-info', warn: 'bg-warn', bad: 'bg-bad' };
const PILL = { ok: 'border-line bg-white text-ink-800', info: 'border-info/30 bg-info-soft text-info', warn: 'border-warn/40 bg-warn-soft text-warn', bad: 'border-bad/40 bg-bad-soft text-bad' };
const STATE_BADGE = { pending: ['warn', 'Waiting'], syncing: ['info', 'Sending'], failed: ['warn', 'Retrying'], needs_review: ['bad', 'Needs review'], synced: ['ok', 'Synced'], dismissed: ['neutral', 'Dismissed'] };

/** Header pill: ONLINE / OFFLINE / SYNCING / "N sales waiting to sync" / SYNC FAILED / NEEDS REVIEW. Opens the queue panel. */
export function OfflineStatusPill() {
  const { state, status } = useOffline();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!state.ready || !state.scope) return null;
  const Icon = status.level === 'offline' ? WifiOff : status.level === 'review' || status.level === 'auth' || status.level === 'blocked' ? TriangleAlert : status.level === 'syncing' ? RefreshCw : status.level === 'unavailable' ? CloudOff : Wifi;
  return (
    <>
      <button type="button" data-testid="offline-status" data-level={status.level} onClick={() => setOpen(true)} aria-label={`Connection status: ${status.label}. Open the sync queue.`}
        className={cx('inline-flex max-w-[11.5rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide sm:max-w-none sm:text-xs', PILL[status.tone] || PILL.ok)}>
        <span className={cx('size-2 shrink-0 rounded-full', DOT[status.tone] || DOT.ok, status.level === 'syncing' && 'animate-pulse')} aria-hidden="true" />
        <Icon className={cx('hidden size-3.5 shrink-0 sm:block', status.level === 'syncing' && 'spin')} aria-hidden="true" />
        <span className="truncate">{status.label}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">{status.label}</span>
      {/* In a portal: the sticky header uses backdrop-blur, which would make it the containing block of a fixed dialog and crop it. */}
      {open && createPortal(<OfflineQueuePanel open={open} onClose={close} />, document.body)}
    </>
  );
}

function RecordRow({ r, canDecideHere, onDecide, busyKey }) {
  const [badgeTone, badgeText] = STATE_BADGE[r.state] || ['neutral', r.state];
  const newTotal = acceptedTotalFor(r);
  const review = r.state === 'needs_review';
  return (
    <li className="px-1 py-3" data-testid="queue-row" data-state={r.state} data-ref={r.localRef}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold num">{r.localRef}</span>
        <Badge tone={badgeTone}>{badgeText}</Badge>
        {r.unverifiedTender && <Badge tone="warn">{r.paymentMethod.toUpperCase()} · unverified</Badge>}
        <span className="ml-auto font-semibold num">{inr(r.original.expectedTotal / 100, 2)}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">Sold {dateTime(r.capturedAt)} · {r.items.length} item{r.items.length === 1 ? '' : 's'} · {r.paymentMethod}{r.invoiceNo ? ` · ${r.invoiceNo}` : ''}</p>
      {r.lastError && (review || r.state === 'failed') && <p role="alert" className={cx('mt-1.5 rounded-md px-2.5 py-1.5 text-sm', review ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')}>{explainError(r.lastError)}</p>}
      {review && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={busyKey === `${r.key}:retry`} onClick={() => onDecide(r, 'retry')}>Try again</Button>
          {newTotal !== null && <Button size="sm" onClick={() => onDecide(r, 'accept_price', newTotal)}>Accept new price {inr(newTotal / 100, 2)}</Button>}
          <Button size="sm" variant="danger" onClick={() => onDecide(r, 'dismiss')}>Dismiss sale</Button>
        </div>
      )}
      {canDecideHere}
    </li>
  );
}

/** The decision form: reason for a dismissal, and (for a cashier session) the owner/manager who approves. The SERVER checks all of it. */
function DecisionForm({ decision, role, onCancel, onSubmit, busy, error }) {
  const [reason, setReason] = useState('');
  const [mgr, setMgr] = useState({ email: '', password: '' });
  const isDismiss = decision.action === 'dismiss';
  const needsApprover = role === 'cashier';
  const ready = (!isDismiss || reason.trim().length >= 3) && (!needsApprover || (mgr.email && mgr.password));
  return (
    <form className="mt-2 space-y-3 rounded-lg border border-line bg-canvas p-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ reason: reason.trim(), approval: needsApprover ? mgr : undefined }); }} data-testid="decision-form">
      <p className="text-sm font-semibold">{isDismiss ? 'Dismiss this sale? It will NOT be recorded and the customer is not billed.' : `Accept the new price ${inr(decision.total / 100, 2)}? The sale is recorded at the current price.`}</p>
      {isDismiss && <Field label="Why is it being dismissed? (required)"><Textarea rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      {needsApprover && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner / manager email"><Input type="email" autoComplete="off" value={mgr.email} onChange={(e) => setMgr({ ...mgr, email: e.target.value })} /></Field>
          <Field label="Their password"><Input type="password" autoComplete="off" value={mgr.password} onChange={(e) => setMgr({ ...mgr, password: e.target.value })} /></Field>
        </div>
      )}
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      <div className="flex gap-2"><Button type="submit" size="sm" loading={busy} disabled={!ready}>{isDismiss ? 'Dismiss sale' : 'Accept new price'}</Button><Button type="button" size="sm" variant="secondary" onClick={onCancel}>Cancel</Button></div>
      {needsApprover && <p className="text-xs text-muted">Only an owner or manager can do this. Their login is checked by the server and is never saved on this device.</p>}
    </form>
  );
}

export function OfflineQueuePanel({ open, onClose }) {
  const { user } = useAuth();
  const { offline, state, status, isOffline } = useOffline();
  const [decision, setDecision] = useState(null);       // { key, action, total }
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const rows = state.queue;
  const open_ = rows.filter((r) => ['pending', 'syncing', 'failed', 'needs_review'].includes(r.state));
  const done = rows.filter((r) => ['synced', 'dismissed'].includes(r.state));
  const cat = state.catalog;
  const cancel = () => { setDecision(null); setError(''); };
  // Another tab may have added or synced sales: re-read the shared local storage whenever the panel opens.
  useEffect(() => { if (open) offline.refresh().catch(() => {}); }, [open, offline]);

  const decide = (r, action, total) => {
    setError('');
    if (action === 'retry') { setBusy(`${r.key}:retry`); offline.resolve(r.key, { action: 'retry', decidedBy: user.name }).catch((e) => setError(e.message)).finally(() => setBusy('')); return; }
    setDecision({ key: r.key, action, total });
  };
  const submit = async ({ reason, approval }) => {
    setBusy('decision'); setError('');
    try { await offline.resolve(decision.key, { action: decision.action, reason, approval, decidedBy: user.name }); setDecision(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  const sync = async () => { setError(''); setBusy('sync'); try { await offline.checkConnectivity(); await offline.syncNow({ force: true }); } catch (e) { setError(e.message); } finally { setBusy(''); } };

  const footer = <><Button variant="secondary" loading={busy === 'sync'} disabled={!state.available} onClick={sync}><RefreshCw className="size-4" aria-hidden="true" />Sync now</Button><Button onClick={onClose}>Close</Button></>;
  return (
    <Modal open={open} onClose={onClose} title="Offline sales & sync" size="md" footer={footer}>
      <div data-testid="queue-panel">
        <p className={cx('rounded-lg px-3 py-2 text-sm font-semibold', status.tone === 'bad' ? 'bg-bad-soft text-bad' : status.tone === 'warn' ? 'bg-warn-soft text-warn' : status.tone === 'info' ? 'bg-info-soft text-info' : 'bg-ok-soft text-ok')}>{status.label}<span className="block text-xs font-normal">{status.detail}</span></p>
        <p className="mt-2 text-xs text-muted">
          {cat.present ? `Product list on this device: ${cat.count} ${cat.count === 1 ? 'product' : 'products'}, downloaded ${dateTime(cat.generatedAt)}${cat.level === 'stale' ? '. It is more than a day old, so prices may be out of date.' : '.'}` : 'No product list is saved on this device yet. Offline selling needs it; it downloads while online.'}
          {isOffline ? ' Stock shown offline is the saved count minus offline sales.' : ''}
        </p>
        {error && !decision && <p role="alert" className="mt-2 text-sm font-medium text-bad">{error}</p>}
        <h3 className="mb-1 mt-4 text-sm font-bold">Waiting to sync ({open_.length})</h3>
        {open_.length === 0 ? <p className="text-sm text-muted">Nothing is waiting. Every sale made on this device has reached the server.</p> : (
          <ul className="divide-y divide-line-soft">
            {open_.map((r) => (
              <RecordRow key={r.key} r={r} busyKey={busy} onDecide={decide}
                canDecideHere={decision && decision.key === r.key ? <DecisionForm decision={decision} role={user.role} busy={busy === 'decision'} error={error} onCancel={cancel} onSubmit={submit} /> : null} />
            ))}
          </ul>
        )}
        {done.length > 0 && (
          <>
            <h3 className="mb-1 mt-4 text-sm font-bold">Recently finished</h3>
            <ul className="divide-y divide-line-soft">{[...done].reverse().map((r) => <RecordRow key={r.key} r={r} onDecide={decide} />)}</ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Shown right after a sale is saved on this device. It is NOT a tax invoice: the server has not seen the sale yet. */
export function OfflineReceiptModal({ result, onClose }) {
  const { state } = useOffline();
  if (!result) return null;
  const { record, bill } = result;
  const live = state.queue.find((r) => r.key === record.key) || record;
  const lines = (record.display && record.display.lines) || [];
  const b = (record.display && record.display.bill) || bill || {};
  const total = record.original.expectedTotal / 100;
  const synced = live.state === 'synced';
  return (
    <Modal open onClose={onClose} title={synced ? 'Sale synced' : 'Sale saved on this device'} size="sm" footer={<Button onClick={onClose} data-testid="offline-receipt-close">Done</Button>}>
      <div data-testid="offline-receipt" className="space-y-3 text-sm">
        <div className={cx('rounded-lg px-3 py-2', synced ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
          <p className="text-base font-extrabold num">{record.localRef}</p>
          <p className="font-semibold">{synced ? `Recorded by the server as ${live.invoiceNo || 'a normal invoice'}.` : 'PROVISIONAL RECEIPT. Not a tax invoice yet.'}</p>
          {!synced && <p className="text-xs">The server has not recorded this sale. It will be sent automatically when the connection is back, and the real invoice number is issued then.</p>}
        </div>
        <ul className="divide-y divide-line-soft">
          {lines.map((l) => <li key={l.productId} className="flex justify-between gap-3 py-1.5"><span>{l.name} <span className="text-muted num">× {l.quantity}{l.unit && l.unit !== 'pcs' ? ` ${l.unit}` : ''}</span></span><span className="num">{inr(l.lineTotal, 2)}</span></li>)}
        </ul>
        <dl className="space-y-1 num">
          {b.discount > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd>−{inr(b.discount, 2)}</dd></div>}
          <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd>{inr(b.tax || 0, 2)}</dd></div>
          <div className="flex justify-between border-t border-line pt-2 text-lg font-extrabold"><dt>Total</dt><dd>{inr(total, 2)}</dd></div>
        </dl>
        <p className="font-semibold">Paid by {record.paymentMethod.toUpperCase()}{record.unverifiedTender ? ' (unverified)' : ''}</p>
        {record.unverifiedTender && <p className="text-xs text-warn">UPI and card payments are not checked while offline. Confirm the payment reached you before the customer leaves.</p>}
      </div>
    </Modal>
  );
}

/** Small reusable notice for pages that must not act while sales are still waiting (shift close, cash count). */
export function UnsyncedNotice({ className }) {
  const { unsynced, state } = useOffline();
  if (!state.available || unsynced === 0) return null;
  return (
    <p role="alert" data-testid="unsynced-notice" className={cx('rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn', className)}>
      {unsynced} offline {unsynced === 1 ? 'sale is' : 'sales are'} still waiting to sync from this device. Open the status at the top and sync {unsynced === 1 ? 'it' : 'them'} before closing, or the totals will be wrong.
    </p>
  );
}
