import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Lock, Search, X } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, Card, CardHeader, ConfirmDialog, DataTable, EmptyState, Field, Input, Select, Stat } from './ui';
import { inr, dateTime, dateOnly } from '../utils/format';
import { DECIMAL_UNITS } from '../utils/units';

// Physical stock count (Phase 9; Phase 10 adds reopen, explicit re-count, stale warnings and a cycle-count list). Counting and review NEVER change
// stock; only "Approve" does, on the server, as audited adjustments.
const STATUS = { counting: ['info', 'Counting'], review: ['warn', 'In review'], approved: ['ok', 'Approved'], cancelled: ['neutral', 'Cancelled'] };

function Summary({ s }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="count-summary">
      <Stat label="Counted" value={s.counted} />
      <Stat label="Matched" value={s.matched} tone="ok" />
      <Stat label="Short" value={s.short} tone={s.short ? 'bad' : undefined} sub={s.shortUnits ? `${s.shortUnits} units` : undefined} />
      <Stat label="Over" value={s.over} tone={s.over ? 'warn' : undefined} sub={s.overUnits ? `+${s.overUnits} units` : undefined} />
      <Stat label="Estimated variance" value={`${s.varianceValue < 0 ? '−' : s.varianceValue > 0 ? '+' : ''}${inr(Math.abs(s.varianceValue), 2)}`} tone={s.varianceValue < 0 ? 'bad' : undefined} sub="at cost price" />
    </div>
  );
}

function ProductPicker({ onPick, disabled }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const inputRef = useRef(null);
  const res = useAsync(() => (dq.trim().length >= 2 ? api.get('/products', { q: dq.trim(), limit: 8 }) : Promise.resolve(null)), [dq]);
  const rows = res.data ? res.data.rows : [];
  // A USB/Bluetooth scanner types the code and presses Enter: if exactly one product matches, take it straight away.
  const onKey = (e) => { if (e.key === 'Enter' && rows.length === 1 && q.trim() === dq.trim()) { e.preventDefault(); onPick(rows[0]); setQ(''); } };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden="true" />
      <Input ref={inputRef} aria-label="Find product to count" className="!h-12 pl-10" placeholder="Type a name, SKU or scan a barcode" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} disabled={disabled} autoComplete="off" />
      {q.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-white shadow-lg" role="listbox">
          {res.loading && !res.data && <li className="px-4 py-3 text-sm text-muted">Searching…</li>}
          {res.data && rows.length === 0 && <li className="px-4 py-3 text-sm text-muted">No product found.</li>}
          {rows.map((p) => <li key={p.id}><button role="option" aria-selected="false" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-line-soft" onClick={() => { onPick(p); setQ(''); }}><span className="min-w-0"><span className="block truncate font-semibold">{p.name}</span><span className="block text-xs text-muted num">{p.sku} · system stock {p.stock} {p.unit}</span></span><span className="text-sm font-bold text-brand">Count</span></button></li>)}
        </ul>
      )}
    </div>
  );
}

function CountRow({ item, locked, onSave, onRemove }) {
  const [v, setV] = useState(String(item.counted));
  const [recount, setRecount] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { setV(String(item.counted)); setRecount(false); }, [item.counted, item.expected]);
  const dec = DECIMAL_UNITS.includes(item.unit);
  const save = () => { if (v !== '' && (recount || Number(v) !== item.counted)) onSave(item.productId, Number(v), recount); };
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-3">
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-semibold">{item.name}</p>
        <p className="text-xs text-muted num">{item.sku} · expected {item.expected} {item.unit}</p>
        {item.inactive && <p className="mt-0.5 text-xs font-semibold text-bad">This product was archived after it was counted — {locked ? 'reopen the count and remove it.' : 'remove it from the count.'}</p>}
        {!item.inactive && item.stale && <p className="mt-0.5 text-xs font-semibold text-warn">Stock changed to {item.currentStock} since you counted (expected {item.expected}). {locked ? 'Reopen the count to re-count it.' : recount ? 'Enter what you count now.' : 'Re-count it before approving.'}</p>}
      </div>
      <Input ref={inputRef} aria-label={`Counted quantity for ${item.name}`} className="!h-11 !w-28 text-right num" inputMode={dec ? 'decimal' : 'numeric'} value={v} disabled={locked} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      {!locked && item.stale && !item.inactive && <Button variant="secondary" size="sm" onClick={() => { setRecount(true); setV(''); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }}>Re-count</Button>}
      <div className="w-24 text-right"><p className={`font-bold num ${item.variance < 0 ? 'text-bad' : item.variance > 0 ? 'text-warn' : 'text-ok'}`}>{item.variance > 0 ? '+' : ''}{item.variance}</p><p className="text-xs text-muted num">{item.variance === 0 ? 'matched' : `${item.varianceValue < 0 ? '−' : '+'}${inr(Math.abs(item.varianceValue), 2)}`}</p></div>
      {!locked && <Button variant="ghost" size="sm" aria-label={`Remove ${item.name} from the count`} onClick={() => onRemove(item.productId)}><X className="size-4" /></Button>}
    </div>
  );
}

/** Cycle counting: a read-only list of products worth counting next (nothing is created until you enter a quantity). */
const FOCUS = [['least_recent', 'Not counted for longest'], ['never', 'Never counted'], ['low', 'Low stock'], ['value', 'Highest stock value']];
function CandidateList({ countId, onAdd, disabled }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState('least_recent');
  const [categoryId, setCategoryId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const lookups = useAsync(() => (open ? api.get('/products/lookups') : Promise.resolve(null)), [open]);
  const res = useAsync(() => (open ? api.get('/stock-counts/candidates', { filter: focus, categoryId: categoryId || undefined, supplierId: supplierId || undefined, countId, limit: 12 }) : Promise.resolve(null)), [open, focus, categoryId, supplierId, countId]);
  if (!open) return <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)} data-testid="count-list-open">Suggest products to count</Button>;
  const rows = res.data ? res.data.rows : [];
  return (
    <Card>
      <CardHeader title="Products to count next" subtitle="Pick a focus, then add products to this count. Nothing changes until you enter a quantity." action={<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>} />
      <div className="grid gap-3 px-4 pb-3 sm:grid-cols-3">
        <Field label="Focus"><Select aria-label="Count focus" value={focus} onChange={(e) => setFocus(e.target.value)}>{FOCUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Category"><Select aria-label="Category filter" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All</option>{lookups.data && lookups.data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Supplier"><Select aria-label="Supplier filter" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">All</option>{lookups.data && lookups.data.suppliers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      </div>
      {res.loading && !res.data && <p className="px-4 pb-3 text-sm text-muted">Loading…</p>}
      {res.data && rows.length === 0 && <p className="px-4 pb-3 text-sm text-muted">Nothing to suggest for this focus.</p>}
      {rows.map((p) => (
        <div key={p.id} className="flex items-center gap-3 border-t border-line-soft px-4 py-2.5">
          <div className="min-w-0 flex-1"><p className="truncate font-semibold">{p.name}</p><p className="text-xs text-muted num">{p.sku} · stock {p.stock} {p.unit} · {p.neverCounted ? 'never counted' : `last counted ${dateOnly(p.lastCountedAt)}`}</p></div>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAdd(p)}>Add</Button>
        </div>
      ))}
      {rows.length > 1 && <div className="border-t border-line-soft px-4 py-2.5 text-right"><Button size="sm" disabled={disabled} onClick={() => rows.forEach(onAdd)}>Add all {rows.length}</Button></div>}
    </Card>
  );
}

/** A product picked but not counted yet: nothing is saved (and no quantity is assumed) until the counted number is entered. */
function PendingRow({ p, onSave, onDrop }) {
  const [v, setV] = useState('');
  const dec = DECIMAL_UNITS.includes(p.unit);
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line-soft bg-brand-soft/40 px-4 py-3">
      <div className="min-w-0 flex-1 basis-40"><p className="truncate font-semibold">{p.name}</p><p className="text-xs text-muted num">{p.sku} · enter what you counted</p></div>
      <Input aria-label={`Counted quantity for ${p.name}`} autoFocus className="!h-11 !w-28 text-right num" inputMode={dec ? 'decimal' : 'numeric'} placeholder="0" value={v} onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && v !== '') onSave(p, Number(v)); }} />
      <Button size="sm" disabled={v === ''} onClick={() => onSave(p, Number(v))}>Save</Button>
      <Button variant="ghost" size="sm" aria-label={`Skip ${p.name}`} onClick={() => onDrop(p.id)}><X className="size-4" /></Button>
    </div>
  );
}

function CountDetail({ id, onBack, onChanged }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState([]);
  const first = useAsync(async () => { const x = await api.get(`/stock-counts/${id}`); setD(x); return x; }, [id]);
  const act = async (name, fn, ok) => {
    setBusy(name); setErr(null);
    try { const r = await fn(); setD(r); if (ok) toast.success(ok); onChanged(); return true; } catch (e) { setErr(e); toast.error(e.message); return false; } finally { setBusy(''); setConfirm(''); }
  };
  const locked = !d || d.status !== 'counting';
  const st = d && STATUS[d.status];
  return (
    <Async state={first} rows={5} errorText="Unable to load this stock count.">
      {() => d && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={onBack}>← All counts</Button>
            <h2 className="text-lg font-bold">{d.title} #{d.id}</h2><Badge tone={st[0]} dot>{st[1]}</Badge>
            {locked && <span className="flex items-center gap-1 text-xs text-muted"><Lock className="size-3.5" aria-hidden="true" />Quantities are locked</span>}
          </div>
          {d.status === 'counting' && <p className="rounded-lg bg-canvas px-4 py-2.5 text-sm text-muted">Count each product on the shelf and enter what you find. <b>Stock does not change</b> until a manager approves the count.</p>}
          {d.status === 'review' && <p className="rounded-lg bg-warn-soft px-4 py-2.5 text-sm font-semibold text-warn">Review the differences. Approving will correct stock to the counted quantities and record each change in the stock history.</p>}
          {d.status === 'approved' && <p className="rounded-lg bg-ok-soft px-4 py-2.5 text-sm font-semibold text-ok">Approved {dateTime(d.approvedAt)}{d.approvedBy ? ` by ${d.approvedBy}` : ''}. Stock was corrected.</p>}
          {d.status === 'cancelled' && <p className="rounded-lg bg-canvas px-4 py-2.5 text-sm text-muted">This count was cancelled. Stock was not changed.</p>}
          {d.items.length > 0 && <Summary s={d.summary} />}
          {d.staleCount > 0 && ['counting', 'review'].includes(d.status) && (
            <div role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" data-testid="stale-warning">
              <p className="font-bold">{d.staleCount} product{d.staleCount === 1 ? '' : 's'} changed or {d.staleCount === 1 ? 'was' : 'were'} archived since {d.staleCount === 1 ? 'it was' : 'they were'} counted.</p>
              <p className="mt-0.5">{d.status === 'review' ? 'Approval will be refused until this is fixed: go back to counting, then re-count or remove them.' : 'Re-count or remove them before sending the count for review.'}</p>
            </div>
          )}
          {err && err.details && err.details.code === 'COUNT_STALE' && (
            <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
              <p className="font-bold">Stock changed after these products were counted — nothing was applied.</p>
              <ul className="mt-1 list-disc pl-5">{err.details.stale.map((s) => <li key={s.productId}>{s.reason === 'inactive' ? `${s.name}: archived after it was counted` : `${s.name}: counted against ${s.expected}, now ${s.currentStock}`}</li>)}</ul>
              <p className="mt-1">Use “Back to counting”, then re-count or remove these products — or cancel this count.</p>
            </div>
          )}
          {d.status === 'counting' && <ProductPicker onPick={(p) => setPending((x) => (x.some((y) => y.id === p.id) ? x : [p, ...x]))} disabled={!!busy} />}
          {d.status === 'counting' && <CandidateList countId={id} disabled={!!busy} onAdd={(p) => setPending((x) => (x.some((y) => y.id === p.id) ? x : [p, ...x]))} />}
          <Card>
            <CardHeader title="Products counted" subtitle={d.items.length ? `${d.items.length} product${d.items.length === 1 ? '' : 's'}` : undefined} />
            {pending.map((p) => <PendingRow key={p.id} p={p} onDrop={(pid) => setPending((x) => x.filter((y) => y.id !== pid))} onSave={(prod, c) => act('save', () => api.put(`/stock-counts/${id}/items/${prod.id}`, { counted: c })).then((done) => { if (done) setPending((x) => x.filter((y) => y.id !== prod.id)); })} />)}
            {d.items.length === 0 && pending.length === 0 ? <EmptyState icon={ClipboardCheck} title="Nothing counted yet" hint="Search or scan a product above, then enter the quantity you counted." /> : d.items.map((it) => (
              <CountRow key={it.productId} item={it} locked={locked} onSave={(pid, c, recount) => act('save', () => api.put(`/stock-counts/${id}/items/${pid}`, recount ? { counted: c, recount: true } : { counted: c }), recount ? 'Re-counted against today\'s stock.' : undefined)} onRemove={(pid) => act('rm', () => api.del(`/stock-counts/${id}/items/${pid}`))} />
            ))}
          </Card>
          <div className="flex flex-wrap justify-end gap-2">
            {['counting', 'review'].includes(d.status) && <Button variant="secondary" disabled={!!busy} onClick={() => setConfirm('cancel')}>Cancel count</Button>}
            {d.status === 'review' && <Button variant="secondary" disabled={!!busy} loading={busy === 'reopen'} onClick={() => act('reopen', () => api.post(`/stock-counts/${id}/reopen`), 'Back to counting. Stock unchanged.')} data-testid="reopen-count">Back to counting</Button>}
            {d.status === 'counting' && <Button disabled={!d.items.length || !!busy} loading={busy === 'submit'} onClick={() => act('submit', () => api.post(`/stock-counts/${id}/submit`), 'Sent for review.')}>Send for review</Button>}
            {d.status === 'review' && <Button variant="success" disabled={!!busy || d.staleCount > 0} loading={busy === 'approve'} onClick={() => setConfirm('approve')} data-testid="approve-count">Approve & correct stock</Button>}
          </div>
          <ConfirmDialog open={confirm === 'approve'} onClose={() => setConfirm('')} loading={busy === 'approve'} title="Approve this count?" confirmLabel="Approve & correct stock"
            message={`Stock will be corrected for ${d.summary.short + d.summary.over} product(s) (estimated ${d.summary.varianceValue < 0 ? 'loss' : 'gain'} ${inr(Math.abs(d.summary.varianceValue), 2)}). This is recorded in the stock history and cannot be undone.`}
            onConfirm={() => act('approve', () => api.post(`/stock-counts/${id}/approve`), 'Count approved. Stock corrected.')} />
          <ConfirmDialog open={confirm === 'cancel'} onClose={() => setConfirm('')} danger loading={busy === 'cancel'} title="Cancel this count?" confirmLabel="Cancel count" message="The quantities you entered are kept for reference, but no stock will be changed."
            onConfirm={() => act('cancel', () => api.post(`/stock-counts/${id}/cancel`), 'Count cancelled. Stock unchanged.')} />
        </div>
      )}
    </Async>
  );
}

export default function StockCount() {
  const toast = useToast();
  const list = useAsync(() => api.get('/stock-counts'), []);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const start = async () => {
    setBusy(true);
    try { const c = await api.post('/stock-counts', title.trim() ? { title: title.trim() } : {}); setTitle(''); list.reload(); setOpen(c.id); }
    catch (e) { if (e.details && e.details.countId) { toast.info(e.message); setOpen(e.details.countId); } else toast.error(e.message); } finally { setBusy(false); }
  };
  if (open) return <CountDetail id={open} onBack={() => { setOpen(null); list.reload(); }} onChanged={list.reload} />;
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Start a new physical count" hint="Count a shelf, an aisle or the whole shop. Only one count can be open at a time." className="min-w-[220px] flex-1"><Input aria-label="Count name" placeholder="e.g. Aisle 2 — snacks" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Button onClick={start} loading={busy} data-testid="start-count"><ClipboardCheck className="size-4" aria-hidden="true" />Start count</Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Stock counts" />
        <Async state={list} rows={3} errorText="Unable to load stock counts.">
          {(d) => <DataTable rows={d.rows} onRowClick={(r) => setOpen(r.id)} columns={[
            { key: 'title', header: 'Count', render: (r) => <div><p className="font-semibold">{r.title}</p><p className="text-xs text-muted">#{r.id} · started by {r.startedBy || '—'}</p></div> },
            { key: 'at', header: 'Started', render: (r) => dateTime(r.startedAt) },
            { key: 'items', header: 'Products', align: 'right' },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS[r.status][0]} dot>{STATUS[r.status][1]}</Badge> },
          ]} empty={<EmptyState icon={ClipboardCheck} title="No stock counts yet" hint="Start a count to compare what is on the shelf with what the system says." />} />}
        </Async>
      </Card>
    </div>
  );
}
