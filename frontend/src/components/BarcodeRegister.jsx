import { useEffect, useState } from 'react';
import { Link2, PackagePlus, Search, ShieldAlert, X } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { Button, Field, Input, Select, Spinner, cx } from './ui';
import { inr } from '../utils/format';
import { DECIMAL_UNITS, UNITS } from '../utils/units';

// Shown when a scanned manufacturer barcode is not yet linked to a product IN THIS SHOP (another shop may already have it — that is separate).
//   Owner / manager : create the product right here (name, price, unit, stock) or link the barcode to a product that already exists.
//   Cashier         : cannot change products (RBAC), so they are told to ask a manager. The server enforces this too.
// onDone(scan) receives the server's scan result for the new mapping, so the Counter can add the product to the bill straight away.
export default function BarcodeRegister({ code, canRegister, onClose, onDone }) {
  const [mode, setMode] = useState('choose');           // choose | create | link
  useEffect(() => { setMode('choose'); }, [code]);
  if (!code) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label="Barcode not registered">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-extrabold">{mode === 'link' ? 'Add to an existing product' : mode === 'create' ? 'New product for this barcode' : 'Barcode not registered for your shop'}</p>
            <p className="num mt-0.5 break-all text-xl font-bold tracking-wide" data-testid="unknown-code">{code}</p>
          </div>
          <button onClick={onClose} aria-label="Cancel" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-line-soft"><X className="size-6" /></button>
        </div>
        {!canRegister ? (
          <div className="space-y-4">
            <p role="alert" className="flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-3 text-base font-semibold text-warn"><ShieldAlert className="mt-0.5 size-6 shrink-0" aria-hidden="true" />This barcode is not in your shop yet. Ask a manager or the owner to register it, then scan again.</p>
            <Button size="lg" variant="secondary" className="!h-14 w-full" onClick={onClose}>OK</Button>
          </div>
        ) : mode === 'choose' ? (
          <div className="space-y-3">
            <Button size="lg" className="!h-16 w-full text-lg" onClick={() => setMode('create')} data-testid="create-product"><PackagePlus className="size-6" aria-hidden="true" />Create new product</Button>
            <Button size="lg" variant="secondary" className="!h-16 w-full text-lg" onClick={() => setMode('link')} data-testid="link-product"><Link2 className="size-6" aria-hidden="true" />Add to existing product</Button>
            <Button size="lg" variant="ghost" className="!h-14 w-full" onClick={onClose}>Cancel</Button>
          </div>
        ) : mode === 'create' ? <CreateForm code={code} onBack={() => setMode('choose')} onDone={onDone} /> : <LinkForm code={code} onBack={() => setMode('choose')} onDone={onDone} />}
      </div>
    </div>
  );
}

function CreateForm({ code, onBack, onDone }) {
  const lookups = useAsync(() => api.get('/products/lookups'), []);
  const [f, setF] = useState({ name: '', price: '', unit: 'pcs', stock: '', categoryId: '', cost: '' });
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cats = lookups.data ? lookups.data.categories : [];
  const categoryId = f.categoryId || (cats.find((c) => c.name.toLowerCase() === 'general') || cats[0] || {}).id || '';
  const decimal = DECIMAL_UNITS.includes(f.unit);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const price = parseFloat(f.price); const stock = f.stock === '' ? NaN : parseFloat(f.stock);
    if (!f.name.trim()) return setErr('Enter the product name.');
    if (!(price >= 0)) return setErr('Enter the selling price.');
    if (!(stock >= 0)) return setErr('Enter how many you have in stock (0 if none yet).');
    if (!decimal && !Number.isInteger(stock)) return setErr(`${f.unit} must be a whole number. Choose kg, g, l, ml or m for fractions.`);
    if (!categoryId) return setErr('Add a category first (Products), then register this barcode.');
    setErr(''); setBusy(true);
    try {
      const body = { barcode: code, name: f.name.trim(), sellingPrice: price, unit: f.unit, stock, categoryId: Number(categoryId), ...(f.cost !== '' ? { purchasePrice: parseFloat(f.cost) } : {}) };
      onDone(await api.post('/products/quick-create', body));
    } catch (er) { setErr(er.message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="Product name"><Input autoFocus aria-label="Product name" className="!h-14 text-lg" value={f.name} onChange={set('name')} autoComplete="off" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Selling price (₹)"><Input aria-label="Selling price" className="!h-14 text-lg" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="Unit"><Select aria-label="Unit" className="!h-14 text-lg" value={f.unit} onChange={set('unit')}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      </div>
      <Field label={`In stock now (${f.unit})`} hint="Count what you have. It is used to track stock."><Input aria-label="Stock in hand" className="!h-14 text-lg" inputMode={decimal ? 'decimal' : 'numeric'} value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
      <button type="button" className="text-sm font-semibold text-brand" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Hide' : 'More'} details (category, cost)</button>
      {more && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category"><Select aria-label="Category" className="!h-12" value={categoryId} onChange={set('categoryId')}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Cost price (₹, optional)" hint="For profit reports."><Input aria-label="Cost price" className="!h-12" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        </div>
      )}
      {err && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
      <div className="grid grid-cols-[1fr_2fr] gap-3">
        <Button type="button" size="lg" variant="secondary" className="!h-14" onClick={onBack}>Back</Button>
        <Button type="submit" size="lg" className="!h-14 text-lg" loading={busy} disabled={lookups.loading && !lookups.data} data-testid="save-product">Save &amp; add to bill</Button>
      </div>
    </form>
  );
}

function LinkForm({ code, onBack, onDone }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const found = useAsync(() => (dq.trim().length >= 2 ? api.get('/products', { q: dq.trim(), limit: 8 }) : Promise.resolve(null)), [dq]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const link = async (p) => {
    if (busy) return;
    setBusy(p.id); setErr('');
    try { onDone((await api.post(`/products/${p.id}/barcodes`, { barcode: code })).scan); } catch (e) { setErr(e.message); setBusy(null); }
  };
  return (
    <div className="space-y-3">
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden="true" /><Input aria-label="Find the product" autoFocus className="!h-14 pl-10 text-lg" placeholder="Search product name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {found.loading && <Spinner className="mx-auto size-6" />}
      <ul className="divide-y divide-line-soft">
        {found.data && found.data.rows.map((p) => (
          <li key={p.id}>
            <button disabled={!!busy} onClick={() => link(p)} className={cx('flex w-full items-center gap-3 py-3 text-left hover:bg-line-soft', busy === p.id && 'opacity-60')} data-testid="link-option">
              <span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold">{p.name}</span><span className="block text-xs text-muted num">{inr(p.sellingPrice, 2)} · stock {p.stock} {p.unit}{p.barcodes && p.barcodes.length ? ` · ${p.barcodes.length} barcode${p.barcodes.length === 1 ? '' : 's'}` : ''}</span></span>
              <span className="text-sm font-bold text-brand">Link</span>
            </button>
          </li>
        ))}
      </ul>
      {found.data && found.data.rows.length === 0 && <p className="text-sm text-muted">No product found. Try another word, or go back and create a new product.</p>}
      {err && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
      <Button size="lg" variant="secondary" className="!h-14 w-full" onClick={onBack}>Back</Button>
    </div>
  );
}
