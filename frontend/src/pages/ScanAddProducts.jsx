import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, PackagePlus, PackageSearch, ScanLine, X } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useWedgeScanner } from '../hooks/useWedgeScanner';
import { useToast } from '../hooks/useToast';
import { Button, Card, Field, Input, Select, Spinner, cx } from '../components/ui';
import BarcodeScanner from '../components/BarcodeScanner';
import { ProductForm } from './Products';
import { cleanCode, feedback, forgetScans, lookupBarcode } from '../services/barcode';
import { DECIMAL_UNITS, UNITS } from '../utils/units';
import { inr } from '../utils/format';

// Phase 8.1 — Scan & Add Products (owner / manager). Meant for registering hundreds of products quickly:
//   scan the manufacturer barcode → the form opens with the barcode already filled in → "Save & Scan Next" → the camera is ready again.
// It reuses everything from Phase 8: the same BarcodeScanner (one decoder, kept running the whole session — it is only PAUSED while a form is
// open, never restarted), the same lookup service, the same server routes (POST /products with a barcode is the normal, audited, plan-limited
// product creation, so there is no new creation path). Nothing is guessed from the barcode: it only identifies the product; the shopkeeper
// types the name and prices.

export default function ScanAddProducts() {
  const nav = useNavigate();
  const toast = useToast();
  const lookups = useAsync(() => api.get('/products/lookups'), []);
  const [added, setAdded] = useState(0);                   // products created in THIS session (only after the server said yes)
  const [last, setLast] = useState(null);                  // { name, price, barcode }
  const [form, setForm] = useState(null);                  // { code } — unknown barcode, form open
  const [existing, setExisting] = useState(null);          // { code, id, matchedBy } — barcode already in this shop
  const [editing, setEditing] = useState(null);            // full product being edited through the normal editor
  const [notice, setNotice] = useState(null);
  const remembered = useRef({ categoryId: '', unit: 'pcs', supplierId: '' }); // the next product usually shares the shelf/unit of the last one
  const busyStep = !!(form || existing || editing);

  /** A code arrived (camera, keyboard scanner or manual entry). Returns what the scanner should show. */
  const handleCode = async (raw) => {
    const code = cleanCode(raw);
    if (!code) return { kind: 'error', title: 'That is not a valid barcode. Try again, or type the digits printed under it.' };
    forgetScans();                                          // always ask the server: another device may have just added it
    const r = await lookupBarcode(code);
    if (r.found) {
      setExisting({ code, id: r.product.id, matchedBy: r.matchedBy });
      return { kind: 'warn', title: 'Barcode already registered', name: r.product.name, detail: `Barcode: ${code}` };
    }
    setForm({ code });
    return { kind: 'ok', title: 'Barcode captured', name: code };
  };
  const fromKeyboard = async (raw) => {
    try { const r = await handleCode(raw); if (r) setNotice({ ...r, at: Date.now() }); } catch (e) { setNotice({ kind: 'error', title: (e && e.message) || 'Could not look that up. Try again.', at: Date.now() }); }
  };
  useWedgeScanner(fromKeyboard, !busyStep);

  const saved = (p, code, body) => {
    remembered.current = { categoryId: String(body.categoryId), unit: body.unit, supplierId: body.supplierId ? String(body.supplierId) : '' };   // never price or tax rate: tax follows the category, price is always typed
    setAdded((n) => n + 1);
    setLast({ name: p.name, price: p.sellingPrice, barcode: code });
    setForm(null);
    setNotice({ kind: 'ok', title: '✓ Product added', name: p.name, price: p.sellingPrice, detail: `Barcode: ${code}`, at: Date.now() });
  };
  const raceLost = (code) => { forgetScans(); setForm(null); lookupBarcode(code).then((r) => { if (r.found) setExisting({ code, id: r.product.id, matchedBy: r.matchedBy }); }).catch(() => {}); };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link to="/products" className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-brand"><ArrowLeft className="size-4" aria-hidden="true" />Products</Link>
        <h1 className="text-2xl font-extrabold">Scan &amp; Add Products</h1>
        <p className="mt-1 text-base text-muted">Scan the barcode printed on the product. We&rsquo;ll fill the barcode automatically.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4"><p className="text-sm font-semibold text-muted">Added this session</p><p className="num text-3xl font-extrabold" data-testid="session-count" aria-live="polite">{added}</p></Card>
        <Card className="p-4" data-testid="last-added">
          <p className="text-sm font-semibold text-muted">Last added</p>
          {last ? <><p className="flex items-center gap-1 truncate text-base font-bold"><CheckCircle2 className="size-5 shrink-0 text-ok" aria-hidden="true" /><span className="truncate" data-testid="last-name">{last.name}</span></p><p className="num text-sm text-muted">{inr(last.price, 2)}</p></> : <p className="text-base text-muted">Nothing yet</p>}
        </Card>
      </div>

      {lookups.data && lookups.data.categories.length === 0 && (
        <p role="alert" className="rounded-xl bg-warn-soft px-4 py-3 text-base font-semibold text-warn">Add a category first (Products page), then come back to scan products.</p>
      )}

      <BarcodeScanner
        open embedded paused={busyStep} notice={notice} onCode={handleCode} onClose={() => nav('/products')}
        title="Scan the barcode on the product" hint="Hold the barcode inside the frame" doneLabel={added > 0 ? `Finish · ${added} added` : 'Finish'}
      />
      <p className="text-center text-sm text-muted">Using a USB or Bluetooth scanner? Just scan. No camera? Type the barcode under the camera.</p>

      {form && lookups.data && (
        <ScanForm code={form.code} lookups={lookups.data} defaults={remembered.current} onCancel={() => setForm(null)} onSaved={saved} onExists={raceLost} />
      )}
      {existing && (
        <ExistingPanel info={existing} onDone={() => setExisting(null)} onEdit={(p) => { setExisting(null); setEditing(p); }} onToast={toast} />
      )}
      {editing && lookups.data && (
        <ProductForm product={editing} lookups={lookups.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success('Product updated.'); }} />
      )}
    </div>
  );
}

/** The product form for ONE scanned barcode. Quick mode first (the six fields that matter), everything else under "More details". */
function ScanForm({ code, lookups, defaults, onCancel, onSaved, onExists }) {
  const cats = lookups.categories;
  const sup0 = defaults.supplierId ? lookups.suppliers.find((x) => String(x.id) === defaults.supplierId) : null;   // last supplier used in this session
  const firstCat = defaults.categoryId || String((cats.find((c) => c.name.toLowerCase() === 'general') || cats[0] || {}).id || '');
  const [f, setF] = useState({
    name: '', categoryId: firstCat, sellingPrice: '', purchasePrice: '', stock: '', unit: defaults.unit || 'pcs',
    sku: '', priceIncludesTax: true, minimumStock: '0', supplierId: sup0 ? String(sup0.id) : '', leadTimeDays: sup0 ? String(sup0.leadTimeDays) : '3', expiryDate: '',
  });
  const [more, setMore] = useState(false);
  const [errs, setErrs] = useState({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);
  const decimal = DECIMAL_UNITS.includes(f.unit);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^0-9.]/g, '') });
  // after a failed check, put the cursor on the first highlighted field
  useEffect(() => { const bad = formRef.current && formRef.current.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); }, [errs]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const er = {};
    const sell = parseFloat(f.sellingPrice); const buy = parseFloat(f.purchasePrice); const stock = f.stock === '' ? NaN : parseFloat(f.stock);
    const minStock = f.minimumStock === '' ? 0 : parseFloat(f.minimumStock);
    if (!f.name.trim()) er.name = 'Enter the product name.';
    if (!f.categoryId) er.categoryId = 'Choose a category.';
    if (!(sell >= 0)) er.sellingPrice = 'Enter the selling price.';
    if (!(buy >= 0)) er.purchasePrice = 'Enter the purchase price (0 if unknown).';
    if (!(stock >= 0)) er.stock = 'Enter how many you have (0 if none yet).';
    else if (!decimal && !Number.isInteger(stock)) er.stock = `${f.unit} must be a whole number. Choose kg, g, l, ml or m for fractions.`;
    if (!decimal && !Number.isInteger(minStock)) er.minimumStock = `${f.unit} must be a whole number.`;
    setErrs(er);
    if (Object.keys(er).length) { if (er.minimumStock && !more) setMore(true); return; }
    setBusy(true); setBanner('');
    const body = {
      barcode: code, name: f.name.trim(), sku: f.sku.trim() || undefined, categoryId: Number(f.categoryId), unit: f.unit, priceIncludesTax: f.priceIncludesTax,
      purchasePrice: buy, sellingPrice: sell, stock, minimumStock: minStock, supplierId: f.supplierId ? Number(f.supplierId) : null,
      leadTimeDays: Number(f.leadTimeDays || 0), expiryDate: f.expiryDate || null,
    };
    try {
      const p = await api.post('/products', body);         // the normal product creation: auth, RBAC, tenant, plan limit, atomic barcode link, audit
      feedback('ok');
      onSaved(p, code, body);
    } catch (err) {
      setBusy(false);
      if (err.code === 'BARCODE_TAKEN') { onExists(code); return; }       // someone else registered it a moment ago: the server is the authority
      if (err.status === 0) { setBanner('Could not save product. Please check your connection and try again.'); return; }   // nothing is lost: the form stays filled
      const fields = {};
      if (Array.isArray(err.details)) for (const d of err.details) if (d && d.field) fields[d.field] = d.message;
      if (Object.keys(fields).length) setErrs(fields);
      setBanner(err.message || 'Could not save product. Please try again.');
    }
  };
  const pickSupplier = (e) => { const s = lookups.suppliers.find((x) => String(x.id) === e.target.value); setF({ ...f, supplierId: e.target.value, leadTimeDays: s ? String(s.leadTimeDays) : f.leadTimeDays }); };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label="New product for scanned barcode">
      <div className="max-h-[94vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-lg font-extrabold"><PackagePlus className="size-5" aria-hidden="true" />New product</p>
            <p className="text-xs font-semibold text-muted">Barcode (scanned, locked)</p>
            <p className="num break-all text-xl font-bold tracking-wide" data-testid="scanned-code">{code}</p>
          </div>
          <button onClick={onCancel} aria-label="Cancel and scan again" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-line-soft"><X className="size-6" /></button>
        </div>
        <form ref={formRef} onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Product name" error={errs.name}><Input autoFocus name="name" className="!h-14 text-lg" value={f.name} onChange={set('name')} autoComplete="off" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" error={errs.categoryId}><Select name="categoryId" className="!h-14 text-lg" value={f.categoryId} onChange={set('categoryId')}><option value="">Choose…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Unit"><Select name="unit" className="!h-14 text-lg" value={f.unit} onChange={set('unit')}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Selling price (₹)" error={errs.sellingPrice}><Input name="sellingPrice" className="!h-14 text-lg" inputMode="decimal" value={f.sellingPrice} onChange={num('sellingPrice')} /></Field>
            <Field label="Purchase price (₹)" error={errs.purchasePrice}><Input name="purchasePrice" className="!h-14 text-lg" inputMode="decimal" value={f.purchasePrice} onChange={num('purchasePrice')} /></Field>
          </div>
          <Field label={`Current stock (${f.unit})`} error={errs.stock}><Input name="stock" className="!h-14 text-lg" inputMode={decimal ? 'decimal' : 'numeric'} value={f.stock} onChange={num('stock')} /></Field>

          <button type="button" className="text-sm font-semibold text-brand" onClick={() => setMore(!more)} aria-expanded={more} data-testid="more-details">{more ? 'Hide' : 'More'} details (SKU, tax, minimum stock, supplier, expiry)</button>
          {more && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="SKU" hint="Leave empty to generate one." error={errs.sku}><Input name="sku" className="!h-12" value={f.sku} onChange={set('sku')} autoComplete="off" /></Field>
              <Field label={`Minimum stock (${f.unit})`} hint="Below this it shows as low stock." error={errs.minimumStock}><Input name="minimumStock" className="!h-12" inputMode={decimal ? 'decimal' : 'numeric'} value={f.minimumStock} onChange={num('minimumStock')} /></Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-5" checked={f.priceIncludesTax} onChange={(e) => setF({ ...f, priceIncludesTax: e.target.checked })} />Selling price already includes tax</label>
              <Field label="Supplier"><Select name="supplierId" className="!h-12" value={f.supplierId} onChange={pickSupplier}><option value="">None</option>{lookups.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Supplier lead time (days)" error={errs.leadTimeDays}><Input name="leadTimeDays" className="!h-12" inputMode="numeric" value={f.leadTimeDays} onChange={num('leadTimeDays')} /></Field>
              <Field label="Expiry date" hint="Only for perishable items." error={errs.expiryDate}><Input name="expiryDate" type="date" className="!h-12" value={f.expiryDate} onChange={set('expiryDate')} /></Field>
            </div>
          )}

          {banner && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad" data-testid="save-error">{banner}</p>}
          <div className="grid grid-cols-[1fr_2fr] gap-3 pt-1">
            <Button type="button" size="lg" variant="secondary" className="!h-14" onClick={onCancel}>Cancel</Button>
            <Button type="submit" size="lg" className="!h-14 text-lg" loading={busy} data-testid="save-scan-next"><ScanLine className="size-5" aria-hidden="true" />Save &amp; Scan Next</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The scanned barcode already belongs to a product in this shop: never create a duplicate, never overwrite silently. */
function ExistingPanel({ info, onDone, onEdit, onToast }) {
  const prod = useAsync(() => api.get(`/products/${info.id}`), [info.id]);
  const [qty, setQty] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const p = prod.data;
  const decimal = p ? DECIMAL_UNITS.includes(p.unit) : false;
  const addStock = async (e) => {
    e.preventDefault();
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('Enter how many to add.'); return; }
    if (!decimal && !Number.isInteger(q)) { setErr(`${p.unit} must be a whole number.`); return; }
    setBusy(true); setErr('');
    try { const r = await api.post(`/inventory/${info.id}/add-stock`, { quantity: q }); setQty(''); prod.reload(); onToast.success(`${r.name}: stock is now ${r.stock}.`); }
    catch (er) { setErr(er.status === 0 ? 'Could not save. Please check your connection and try again.' : er.message); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label="Barcode already registered" data-testid="existing-panel">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink shadow-xl sm:rounded-2xl">
        <p className="flex items-center gap-2 text-lg font-extrabold"><PackageSearch className="size-5 text-warn" aria-hidden="true" />Barcode already registered</p>
        <p className="num text-sm font-semibold text-muted">{info.code}{info.matchedBy === 'sku' ? ' (matches this product’s SKU)' : ''}</p>
        {prod.loading && !p ? <Spinner className="mx-auto my-6 size-7" /> : prod.error ? <p role="alert" className="my-4 text-base font-semibold text-bad">Could not load the product. Please try again.</p> : p && (
          <div className="my-4 space-y-1 rounded-xl bg-line-soft p-4">
            <p className="text-xl font-extrabold" data-testid="existing-name">{p.name}</p>
            <p className="num text-sm text-muted">SKU: {p.sku}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
              <div><dt className="text-muted">Selling price</dt><dd className="num text-base font-bold">{inr(p.sellingPrice, 2)}</dd></div>
              <div><dt className="text-muted">Purchase price</dt><dd className="num text-base font-bold">{inr(p.purchasePrice, 2)}</dd></div>
              <div><dt className="text-muted">Stock</dt><dd className="num text-base font-bold" data-testid="existing-stock">{p.stock}{p.unit && p.unit !== 'pcs' ? ` ${p.unit}` : ''}</dd></div>
            </dl>
          </div>
        )}
        {p && (
          <form onSubmit={addStock} className="mb-3 flex gap-2" aria-label="Add stock">
            <Input aria-label="Quantity to add" name="addQty" inputMode={decimal ? 'decimal' : 'numeric'} className="!h-14 flex-1 text-lg" placeholder={`Add stock (${p.unit})`} value={qty} onChange={(e) => { setQty(e.target.value.replace(/[^0-9.]/g, '')); setErr(''); }} data-testid="add-stock-qty" />
            <Button type="submit" size="lg" variant="secondary" className="!h-14" loading={busy} data-testid="add-stock-btn">Add Stock</Button>
          </form>
        )}
        {err && <p role="alert" className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <Button size="lg" variant="secondary" className="!h-14" disabled={!p} onClick={() => onEdit(p)} data-testid="edit-existing">Edit Product</Button>
          <Button size="lg" className={cx('!h-14')} onClick={onDone} data-testid="existing-done">Done</Button>
        </div>
      </div>
    </div>
  );
}
