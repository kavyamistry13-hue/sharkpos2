import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Search, Trash2, Package, Star, Barcode, ScanLine } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select } from '../components/ui';
import { inr, dateOnly } from '../utils/format';
import { UNITS, DECIMAL_UNITS } from '../utils/units';

const STATUS = { in_stock: ['ok', 'In stock'], low_stock: ['warn', 'Low stock'], out_of_stock: ['bad', 'Out of stock'], expired: ['bad', 'Expired'] };
const EMPTY = { barcode: '', name: '', sku: '', categoryId: '', unit: 'pcs', priceIncludesTax: true, purchasePrice: '', sellingPrice: '', stock: '0', minimumStock: '0', supplierId: '', leadTimeDays: '3', expiryDate: '' };

export function ProductForm({ product, lookups, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(product ? {
    name: product.name, sku: product.sku, categoryId: String(product.categoryId), unit: product.unit || 'pcs', priceIncludesTax: Boolean(product.priceIncludesTax), purchasePrice: String(product.purchasePrice), sellingPrice: String(product.sellingPrice),
    stock: String(product.stock), minimumStock: String(product.minimumStock), supplierId: product.supplierId ? String(product.supplierId) : '', leadTimeDays: String(product.leadTimeDays), expiryDate: product.expiryDate || '',
  } : EMPTY);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const decimalOk = DECIMAL_UNITS.includes(f.unit);

  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    if (!f.name.trim()) er.name = 'Enter a product name.';
    if (!f.categoryId) er.categoryId = 'Choose a category.';
    if (f.sellingPrice === '' || Number(f.sellingPrice) < 0) er.sellingPrice = 'Enter a selling price.';
    if (f.purchasePrice === '' || Number(f.purchasePrice) < 0) er.purchasePrice = 'Enter a purchase price.';
    if (!decimalOk && (!Number.isInteger(Number(f.stock || 0)) || !Number.isInteger(Number(f.minimumStock || 0)))) er.stock = `${f.unit} must be a whole number. Choose kg, g, l, ml or m to use fractions.`;
    setErrs(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    const body = {
      name: f.name.trim(), sku: f.sku.trim() || undefined, categoryId: Number(f.categoryId), unit: f.unit, priceIncludesTax: f.priceIncludesTax, purchasePrice: Number(f.purchasePrice), sellingPrice: Number(f.sellingPrice),
      stock: parseFloat(f.stock || 0), minimumStock: parseFloat(f.minimumStock || 0), supplierId: f.supplierId ? Number(f.supplierId) : null, leadTimeDays: Number(f.leadTimeDays || 0), expiryDate: f.expiryDate || null,
      ...(!product && f.barcode.trim() ? { barcode: f.barcode.trim() } : {}),
    };
    try {
      if (product) await api.put(`/products/${product.id}`, body); else await api.post('/products', body);
      toast.success(product ? `${body.name} updated.` : `${body.name} added.`);
      onSaved();
    } catch (err) { toast.error(err.message); setBusy(false); }
  };

  const pickSupplier = (e) => {
    const s = lookups.suppliers.find((x) => String(x.id) === e.target.value);
    setF({ ...f, supplierId: e.target.value, leadTimeDays: s ? String(s.leadTimeDays) : f.leadTimeDays });
  };

  return (
    <Modal open onClose={onClose} title={product ? 'Edit product' : 'Add product'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="product-form" loading={busy}>{product ? 'Save changes' : 'Add product'}</Button></>}>
      <form id="product-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Product name" error={errs.name} className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="SKU" hint="Leave empty to generate one."><Input value={f.sku} onChange={set('sku')} /></Field>
        {!product && <Field label="Barcode (optional)" hint="The number printed under the barcode on the packet — no label printing needed."><Input inputMode="numeric" autoComplete="off" aria-label="Barcode" value={f.barcode} onChange={set('barcode')} /></Field>}
        <Field label="Category" error={errs.categoryId}><Select value={f.categoryId} onChange={set('categoryId')}><option value="">Choose…</option>{lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.taxRate}% tax)</option>)}</Select></Field>
        <Field label="Sold by (unit)" hint="Kg, g, l, ml and m allow fractions such as 0.75."><Select value={f.unit} onChange={set('unit')}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label={`Selling price (₹ per ${f.unit}, ${f.priceIncludesTax ? 'incl. tax' : 'before tax'})`} error={errs.sellingPrice}><Input inputMode="decimal" value={f.sellingPrice} onChange={set('sellingPrice')} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4" checked={f.priceIncludesTax} onChange={(e) => setF({ ...f, priceIncludesTax: e.target.checked })} />Selling price already includes GST (MRP). Tax is then taken out of the price instead of added on top.</label>
        <Field label="Purchase price (₹, excl. GST)" hint="Used for profit. Updated automatically when you receive goods at a new cost." error={errs.purchasePrice}><Input inputMode="decimal" value={f.purchasePrice} onChange={set('purchasePrice')} /></Field>
        <Field label={`Current stock (${f.unit})`} error={errs.stock}><Input inputMode={decimalOk ? 'decimal' : 'numeric'} value={f.stock} onChange={set('stock')} /></Field>
        <Field label={`Minimum stock (${f.unit})`} hint="Below this, the product shows as low stock."><Input inputMode={decimalOk ? 'decimal' : 'numeric'} value={f.minimumStock} onChange={set('minimumStock')} /></Field>
        <Field label="Supplier"><Select value={f.supplierId} onChange={pickSupplier}><option value="">None</option>{lookups.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Supplier lead time (days)"><Input inputMode="numeric" value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>
        <Field label="Expiry date" hint="Only for perishable items."><Input type="date" value={f.expiryDate} onChange={set('expiryDate')} /></Field>
      </form>
      {product && <BarcodeManager product={product} />}
    </Modal>
  );
}

/** Owner/manager: see, add, replace, make primary and remove the manufacturer barcodes of a product. The server refuses duplicates inside the shop. */
function BarcodeManager({ product }) {
  const toast = useToast();
  const [rows, setRows] = useState(product.barcodes || []);
  const [add, setAdd] = useState('');
  const [edit, setEdit] = useState(null);       // { id, value }
  const [confirm, setConfirm] = useState(null); // id awaiting a second tap
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => setRows((await api.get(`/products/${product.id}/barcodes`)).rows);
  const run = async (fn, ok) => { setBusy(true); setErr(''); try { await fn(); await reload(); if (ok) toast.success(ok); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <section className="mt-6 border-t border-line pt-4" aria-label="Barcodes">
      <h3 className="mb-1 flex items-center gap-2 text-base font-bold"><Barcode className="size-5" aria-hidden="true" />Barcodes</h3>
      <p className="mb-3 text-xs text-muted">Scanning any of these adds this product. Use the number already printed on the packet. A product can have more than one.</p>
      <ul className="divide-y divide-line-soft" data-testid="barcode-list">
        {rows.length === 0 && <li className="py-2 text-sm text-muted">No barcode yet.</li>}
        {rows.map((b) => (
          <li key={b.id} className="flex items-center gap-2 py-2">
            {edit && edit.id === b.id ? (
              <>
                <Input aria-label="New barcode value" className="num flex-1" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
                <Button size="sm" loading={busy} onClick={() => run(async () => { await api.put(`/products/${product.id}/barcodes/${b.id}`, { barcode: edit.value }); setEdit(null); }, 'Barcode replaced.')}>Save</Button>
                <Button size="sm" variant="secondary" onClick={() => { setEdit(null); setErr(''); }}>Cancel</Button>
              </>
            ) : (
              <>
                <span className="num flex-1 break-all font-semibold">{b.barcode}</span>
                {b.isPrimary ? <Badge tone="info">Main</Badge> : <button className="text-xs font-semibold text-brand" disabled={busy} onClick={() => run(() => api.put(`/products/${product.id}/barcodes/${b.id}`, { isPrimary: true }), 'Main barcode changed.')}><Star className="mr-1 inline size-3.5" aria-hidden="true" />Make main</button>}
                <Button size="sm" variant="secondary" onClick={() => { setEdit({ id: b.id, value: b.barcode }); setErr(''); }}>Replace</Button>
                {confirm === b.id
                  ? <Button size="sm" variant="danger" loading={busy} onClick={() => run(async () => { await api.del(`/products/${product.id}/barcodes/${b.id}`); setConfirm(null); }, 'Barcode removed.')}>Sure?</Button>
                  : <Button size="sm" variant="secondary" aria-label={`Remove barcode ${b.barcode}`} onClick={() => setConfirm(b.id)}><Trash2 className="size-4" /></Button>}
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (add.trim()) run(async () => { await api.post(`/products/${product.id}/barcodes`, { barcode: add.trim() }); setAdd(''); }, 'Barcode added.'); }}>
        <Input aria-label="Add another barcode" inputMode="numeric" autoComplete="off" className="num flex-1" placeholder="Type or scan a barcode to add" value={add} onChange={(e) => setAdd(e.target.value)} />
        <Button type="submit" variant="secondary" loading={busy} disabled={!add.trim()}>Add barcode</Button>
      </form>
      {err && <p role="alert" className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
    </section>
  );
}

export default function Products() {
  const { isRole } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState('asc');
  const [page, setPage] = useState(1);
  const lookups = useAsync(() => api.get('/products/lookups'), []);
  const list = useAsync(() => api.get('/products', { q: dq, categoryId, status, sort, dir, page, limit: 25 }), [dq, categoryId, status, sort, dir, page]);
  const [editing, setEditing] = useState(null); // null | 'new' | product
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try { await api.del(`/products/${deleting.id}`); toast.success(`${deleting.name} deleted.`); setDeleting(null); list.reload(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'name', header: 'Product', render: (p) => <div><p className="font-semibold">{p.name}</p><p className="text-xs text-muted num">{p.sku} · {p.category}</p>{p.barcodes && p.barcodes.length > 0 && <p className="text-xs text-muted num" data-testid="row-barcodes">Barcode: {p.barcodes.map((b) => b.barcode).join(' · ')}</p>}</div> },
    { key: 'price', header: 'Price', align: 'right', render: (p) => <div><p>{inr(p.sellingPrice, 2)}</p><p className="text-xs text-muted">{p.priceIncludesTax ? 'incl. tax · ' : ''}cost {inr(p.purchasePrice, 2)}</p></div> },
    { key: 'stock', header: 'Stock', align: 'right', render: (p) => <div><p className="font-semibold">{p.stock}{p.unit && p.unit !== 'pcs' ? ` ${p.unit}` : ''}</p><p className="text-xs text-muted">min {p.minimumStock}</p></div> },
    { key: 'supplier', header: 'Supplier', render: (p) => <div><p>{p.supplier || '—'}</p><p className="text-xs text-muted">{p.leadTimeDays}-day lead time</p></div> },
    { key: 'expiry', header: 'Expiry', render: (p) => (p.expiryDate ? <span className={p.expiryStatus ? 'font-semibold text-warn' : ''}>{dateOnly(p.expiryDate)}</span> : <span className="text-muted">—</span>) },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={STATUS[p.status][0]} dot>{STATUS[p.status][1]}</Badge> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: (p) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil className="size-4" /></Button>
        {isRole('business_owner') && <Button variant="ghost" size="sm" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}><Trash2 className="size-4 text-bad" /></Button>}
      </div>) },
  ];

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Products" subtitle="Add, edit and organise everything you sell." actions={<div className="flex flex-wrap gap-2"><Button onClick={() => setEditing('new')} disabled={!lookups.data}><Plus className="size-4" aria-hidden="true" />Add product</Button><Link to="/products/scan-add" data-testid="scan-add-link" className="inline-flex h-10 items-center gap-2 rounded-lg border border-brand bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft"><ScanLine className="size-4" aria-hidden="true" />Scan &amp; Add Products</Link></div>} />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_auto]">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" /><Input className="pl-9" aria-label="Search products" placeholder="Search name, SKU or category" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
          <Select aria-label="Category" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}><option value="">All categories</option>{lookups.data && lookups.data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option value="in_stock">In stock</option><option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option><option value="expired">Expired</option></Select>
          <Select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Sort: name</option><option value="price">Sort: price</option><option value="stock">Sort: stock</option><option value="category">Sort: category</option><option value="margin">Sort: margin</option><option value="risk">Sort: stockout risk</option></Select>
          <Button variant="secondary" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')} aria-label={`Sort direction: ${dir === 'asc' ? 'ascending' : 'descending'}`}>{dir === 'asc' ? 'A → Z' : 'Z → A'}</Button>
        </div>
        <Async state={list} rows={6} errorText="Unable to load products.">
          {(d) => (
            <>
              <DataTable columns={columns} rows={d.rows} onRowClick={(p) => setEditing(p)} empty={<EmptyState icon={Package} title="No products match" hint="Try clearing the filters, or add a new product." action={<Button onClick={() => setEditing('new')}>Add product</Button>} />} />
              <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
      {editing && lookups.data && <ProductForm product={editing === 'new' ? null : editing} lookups={lookups.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Delete product?" confirmLabel="Delete product" onConfirm={remove}
        message={deleting ? `${deleting.name} will be removed from the catalogue and the POS. Past sales keep their history.` : ''} />
    </div>
  );
}
