import { useState } from 'react';
import { Layers } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, DataTable, EmptyState, Field, Input, Modal, Select, Textarea } from './ui';
import { dateOnly, dateTime } from '../utils/format';
import { DECIMAL_UNITS } from '../utils/units';

// Phase 9 stock tools. Every rule (reasons, negative stock, rounding, RBAC) is enforced by the API; this only collects input and shows what the server returns.
export const REASONS = [
  ['damaged', 'Damaged', 'out'], ['expired', 'Expired', 'out'], ['lost', 'Lost', 'out'], ['theft', 'Theft', 'out'],
  ['found_stock', 'Found stock', 'in'], ['counting_error', 'Counting error', 'any'], ['manual_correction', 'Manual correction', 'any'], ['other', 'Other (add a note)', 'any'],
];
const MOVE = { sale: 'Sale', refund: 'Return', restock: 'Goods received', initial: 'Opening stock', adjustment: 'Adjustment' };
const reasonLabel = (r) => (r === 'stock_count' ? 'Stock count' : (REASONS.find((x) => x[0] === r) || [])[1] || '');
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n));

/** Owner / manager only (the page is guarded and the API returns 403 for a cashier). Two steps: enter, then confirm the resulting stock. */
export function AdjustModal({ product, onClose, onDone }) {
  const toast = useToast();
  const [dir, setDir] = useState('out');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState('edit');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const decimal = DECIMAL_UNITS.includes(product.unit);
  const n = parseFloat(qty);
  const delta = Number.isFinite(n) ? (dir === 'out' ? -n : n) : NaN;
  const after = Number.isFinite(delta) ? Math.round((Number(product.stock) + delta) * 1000) / 1000 : null;
  const allowed = REASONS.filter(([, , d]) => d === 'any' || d === dir);

  const review = () => {
    if (!(n > 0)) return setErr('Enter how many to add or remove.');
    if (!decimal && !Number.isInteger(n)) return setErr(`${product.unit} must be a whole number.`);
    if (after < 0) return setErr(`Only ${product.stock} in stock — that would make stock negative.`);
    if (!reason) return setErr('Choose a reason.');
    if (reason === 'other' && !note.trim()) return setErr('Add a short note for "Other".');
    setErr(''); setStep('confirm');
  };
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/inventory/${product.id}/adjust`, { delta, reason, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.success(`${product.name}: stock is now ${r.stock}.`);
      onDone(r);
    } catch (e) { setErr(e.message); setStep('edit'); setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Adjust stock — ${product.name}`} size="md"
      footer={step === 'edit'
        ? <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={review}>Review change</Button></>
        : <><Button variant="secondary" onClick={() => setStep('edit')} disabled={busy}>Back</Button><Button variant={dir === 'out' ? 'danger' : 'success'} loading={busy} onClick={submit} data-testid="confirm-adjust">Confirm adjustment</Button></>}>
      {step === 'edit' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Current stock: <span className="font-bold text-text num">{product.stock} {product.unit}</span></p>
          <div role="group" aria-label="Direction" className="grid grid-cols-2 gap-2">
            {[['out', 'Remove stock'], ['in', 'Add stock']].map(([v, l]) => (
              <button key={v} type="button" aria-pressed={dir === v} onClick={() => { setDir(v); setReason(''); }} className={`h-11 rounded-lg border text-sm font-semibold ${dir === v ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted'}`}>{l}</button>
            ))}
          </div>
          <Field label={`Quantity (${product.unit})`}><Input aria-label="Adjustment quantity" inputMode={decimal ? 'decimal' : 'numeric'} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))} autoFocus /></Field>
          <Field label="Reason"><Select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose a reason…</option>{allowed.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Note" hint={reason === 'other' ? 'Required for “Other”.' : 'Optional.'}><Textarea aria-label="Note" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {after !== null && after >= 0 && <p className="rounded-lg bg-canvas px-3 py-2 text-sm">Stock will become <span className="font-bold num">{after} {product.unit}</span></p>}
          {err && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>You are about to <span className="font-bold">{dir === 'out' ? 'remove' : 'add'} {n} {product.unit}</span> {dir === 'out' ? 'from' : 'to'} <span className="font-bold">{product.name}</span>.</p>
          <dl className="grid grid-cols-3 gap-2 rounded-lg border border-line p-3 text-center"><div><dt className="text-xs text-muted">Now</dt><dd className="text-lg font-bold num">{product.stock}</dd></div><div><dt className="text-xs text-muted">Change</dt><dd className="text-lg font-bold num">{delta > 0 ? '+' : ''}{delta}</dd></div><div><dt className="text-xs text-muted">After</dt><dd className="text-lg font-bold text-brand num">{after}</dd></div></dl>
          <p className="text-muted">Reason: <span className="font-semibold text-text">{reasonLabel(reason)}</span>{note.trim() ? ` — ${note.trim()}` : ''}. This is recorded in the stock history and cannot be edited later.</p>
        </div>
      )}
    </Modal>
  );
}

/** Per-product movement history, newest first, with "load more" (keyset paging). */
export function TimelineModal({ product, onClose }) {
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useAsync(async () => { const d = await api.get(`/inventory/${product.id}/timeline`, { limit: 25 }); setRows(d.rows); setMore(d.nextBefore); return d; }, [product.id]);
  const loadMore = async () => { setLoadingMore(true); try { const d = await api.get(`/inventory/${product.id}/timeline`, { limit: 25, before: more }); setRows((r) => [...r, ...d.rows]); setMore(d.nextBefore); } finally { setLoadingMore(false); } };
  const ref = (r) => (r.referenceType === 'sale' ? `Sale #${r.referenceId}` : r.referenceType === 'refund' ? `Return of sale #${r.referenceId}` : r.referenceType === 'goods_receipt' ? `Receipt #${r.referenceId}` : r.referenceType === 'stock_count' ? `Count #${r.referenceId}` : '—');
  return (
    <Modal open onClose={onClose} title={`Stock history — ${product.name}`} size="xl" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <Async state={first} rows={5} errorText="Unable to load the stock history.">
        {() => (
          <>
            <DataTable rows={rows} columns={[
              { key: 'at', header: 'When', render: (r) => <span className="whitespace-nowrap">{dateTime(r.createdAt)}</span> },
              { key: 'type', header: 'Type', render: (r) => <div><p className="font-semibold">{MOVE[r.type] || r.type}</p>{r.reason && <p className="text-xs text-muted">{reasonLabel(r.reason)}</p>}</div> },
              { key: 'qty', header: 'Change', align: 'right', render: (r) => <span className={`font-bold num ${r.quantity < 0 ? 'text-bad' : 'text-ok'}`}>{r.quantity > 0 ? '+' : ''}{r.quantity}</span> },
              { key: 'before', header: 'Before', align: 'right', render: (r) => <span className="num">{fmt(r.stockBefore)}</span> },
              { key: 'after', header: 'After', align: 'right', render: (r) => <span className="num font-semibold">{fmt(r.stockAfter)}</span> },
              { key: 'note', header: 'Note', render: (r) => r.note || <span className="text-muted">—</span> },
              { key: 'user', header: 'By', render: (r) => r.user || <span className="text-muted">—</span> },
              { key: 'ref', header: 'Reference', render: (r) => <span className="text-xs">{ref(r)}{r.batchId ? ` · batch #${r.batchId}` : ''}</span> },
            ]} empty={<EmptyState title="No stock movements yet" />} />
            {more && <div className="p-3 text-center"><Button variant="secondary" loading={loadingMore} onClick={loadMore}>Load older movements</Button></div>}
          </>
        )}
      </Async>
    </Modal>
  );
}

/** Add stock that arrives with a batch number / expiry (optional fields — products without batches are never forced to have them). */
export function AddBatchModal({ product, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ quantity: '', batchNo: '', manufacturedDate: '', expiryDate: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const decimal = DECIMAL_UNITS.includes(product.unit);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const q = parseFloat(f.quantity);
    if (!(q > 0)) return setErr('Enter the quantity received.');
    if (!decimal && !Number.isInteger(q)) return setErr(`${product.unit} must be a whole number.`);
    if (!f.batchNo.trim() && !f.expiryDate) return setErr('Enter a batch number or an expiry date.');
    if (f.manufacturedDate && f.expiryDate && f.manufacturedDate > f.expiryDate) return setErr('Expiry cannot be before the manufacturing date.');
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/inventory/${product.id}/batches`, { quantity: q, ...(f.batchNo.trim() ? { batchNo: f.batchNo.trim() } : {}), ...(f.manufacturedDate ? { manufacturedDate: f.manufacturedDate } : {}), ...(f.expiryDate ? { expiryDate: f.expiryDate } : {}) });
      toast.success(`Batch ${r.batchNo} added. Stock is now ${r.stock}.`); onDone(r);
    } catch (er) { setErr(er.message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Add batch — ${product.name}`} size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="batch-form" loading={busy}><Layers className="size-4" aria-hidden="true" />Add batch</Button></>}>
      <form id="batch-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label={`Quantity (${product.unit})`}><Input inputMode={decimal ? 'decimal' : 'numeric'} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value.replace(/[^0-9.]/g, '') })} autoFocus /></Field>
        <Field label="Batch number"><Input value={f.batchNo} onChange={set('batchNo')} maxLength={40} /></Field>
        <Field label="Manufactured on"><Input type="date" value={f.manufacturedDate} onChange={set('manufacturedDate')} /></Field>
        <Field label="Expires on"><Input type="date" value={f.expiryDate} onChange={set('expiryDate')} /></Field>
        <p className="text-xs text-muted sm:col-span-2">Sales take the earliest-expiry batch first (FEFO). Expired batches are never sold.</p>
        {err && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad sm:col-span-2">{err}</p>}
      </form>
    </Modal>
  );
}

export const StatusBadge = ({ status }) => {
  const m = { expired: ['bad', 'Expired'], within7: ['warn', '≤ 7 days'], within30: ['warn', '≤ 30 days'], within90: ['info', '≤ 90 days'], ok: ['ok', 'OK'], no_expiry: ['neutral', 'No expiry'] }[status] || ['neutral', status];
  return <Badge tone={m[0]} dot>{m[1]}</Badge>;
};
export { dateOnly };
