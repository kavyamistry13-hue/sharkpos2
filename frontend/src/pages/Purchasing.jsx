import { useState } from 'react';
import { Plus, Pencil, Trash2, Truck, PackageCheck, ClipboardList, Tags, Search, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { uuid } from '../utils/uuid';
import { Async, Badge, Button, Card, CardHeader, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, Tabs, Textarea } from '../components/ui';
import { inr, dateOnly, dateTime, cap } from '../utils/format';

const STATUS_TONE = { draft: 'neutral', ordered: 'info', partially_received: 'warn', received: 'ok', cancelled: 'bad' };
const STATUS_LABEL = { draft: 'Draft', ordered: 'Ordered', partially_received: 'Partly received', received: 'Received', cancelled: 'Cancelled' };
const qty = (n, unit) => `${n}${unit && unit !== 'pcs' ? ` ${unit}` : ''}`;
const decimalOnly = (v) => v.replace(/[^0-9.]/g, '');

// ------------------------------------------------------------------ new purchase order
function NewPoModal({ onClose, onCreated }) {
  const toast = useToast();
  const suppliers = useAsync(() => api.get('/suppliers'), []);
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const found = useAsync(() => (dq.trim().length >= 2 ? api.get('/products', { q: dq.trim(), limit: 6 }) : Promise.resolve({ rows: [] })), [dq]);
  const [busy, setBusy] = useState(false);

  const add = (p) => {
    if (lines.some((l) => l.productId === p.id)) return;
    setLines([...lines, { productId: p.id, name: p.name, unit: p.unit || 'pcs', quantity: '', unitCost: String(p.purchasePrice) }]);
    setQ('');
  };
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const total = lines.reduce((a, l) => a + (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0), 0);

  const save = async () => {
    if (!supplierId) return toast.error('Choose a supplier.');
    if (!lines.length || lines.some((l) => !(parseFloat(l.quantity) > 0))) return toast.error('Enter a quantity for every product.');
    setBusy(true);
    try {
      const po = await api.post('/purchase-orders', {
        supplierId: Number(supplierId), expectedDate: expectedDate || null, notes: notes.trim() || null,
        items: lines.map((l) => ({ productId: l.productId, quantity: parseFloat(l.quantity), unitCost: parseFloat(l.unitCost) || 0 })),
      });
      toast.success(`${po.poNumber} saved as a draft.`);
      onCreated(po);
    } catch (e) { toast.error(e.message); setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="New purchase order" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save draft</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose…</option>{suppliers.data && suppliers.data.rows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Expected delivery" hint="Optional. Defaults to today plus the supplier's lead time."><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden="true" />
          <Input className="pl-9" aria-label="Add a product" placeholder="Search a product to add" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.data && found.data.rows.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-white shadow-lg">
              {found.data.rows.map((p) => <li key={p.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-brand-soft" onClick={() => add(p)}><span className="font-medium">{p.name}</span><span className="text-muted num">{p.stock} in stock</span></button></li>)}
            </ul>
          )}
        </div>
        {lines.length === 0 ? <p className="text-sm text-muted">No products yet. Search above to add some.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Product</th><th className="pb-1 font-medium">Quantity</th><th className="pb-1 font-medium">Cost each (₹)</th><th className="pb-1 text-right font-medium">Amount</th><th /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.productId} className="border-t border-line-soft">
                <td className="py-1.5 pr-2 font-medium">{l.name}</td>
                <td className="py-1.5 pr-2"><div className="flex items-center gap-1"><Input className="h-9 w-24" inputMode="decimal" aria-label={`Quantity of ${l.name}`} value={l.quantity} onChange={(e) => setLine(i, 'quantity', decimalOnly(e.target.value))} /><span className="text-xs text-muted">{l.unit}</span></div></td>
                <td className="py-1.5 pr-2"><Input className="h-9 w-24" inputMode="decimal" aria-label={`Cost of ${l.name}`} value={l.unitCost} onChange={(e) => setLine(i, 'unitCost', decimalOnly(e.target.value))} /></td>
                <td className="py-1.5 text-right num">{inr((parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0), 2)}</td>
                <td className="py-1.5 pl-2"><Button variant="ghost" size="sm" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4 text-bad" /></Button></td>
              </tr>))}</tbody>
          </table></div>
        )}
        <p className="text-right text-sm font-semibold num">Order value {inr(total, 2)} <span className="font-normal text-muted">(before GST)</span></p>
        <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ receive goods
function ReceiveModal({ po, onClose, onReceived }) {
  const toast = useToast();
  const open = po.items.filter((i) => i.outstandingQty > 0);
  const [rows, setRows] = useState(() => Object.fromEntries(open.map((i) => [i.id, { quantity: '', rejected: '', unitCost: String(i.unitCost) }])));
  const [invoiceNo, setInvoiceNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => uuid());   // one key per receipt screen: a double-tap or retry cannot add the stock twice
  const set = (id, k, v) => setRows({ ...rows, [id]: { ...rows[id], [k]: v } });

  const save = async () => {
    const items = open.map((i) => ({ itemId: i.id, quantity: parseFloat(rows[i.id].quantity) || 0, rejectedQuantity: parseFloat(rows[i.id].rejected) || 0, unitCost: parseFloat(rows[i.id].unitCost) || 0 }))
      .filter((x) => x.quantity > 0 || x.rejectedQuantity > 0);
    if (!items.length) return toast.error('Enter what arrived for at least one product.');
    setBusy(true);
    try {
      const r = await api.post(`/purchase-orders/${po.id}/receive`, { items, invoiceNo: invoiceNo.trim() || null }, { idempotencyKey: key });
      toast.success('Goods received. Stock updated.');
      (r.priceChanges || []).forEach((c) => toast.info(`${c.product}: cost ${inr(c.oldCost, 2)} → ${inr(c.newCost, 2)}. Margin ${c.oldMarginPct ?? '—'}% → ${c.newMarginPct ?? '—'}%. Your selling price was not changed.`));
      onReceived();
    } catch (e) { toast.error(e.message); setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Receive goods · ${po.poNumber}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" loading={busy} onClick={save}>Add to stock</Button></>}>
      <p className="mb-3 text-sm text-muted">Enter what actually arrived in this delivery. Leave a line empty if nothing came. Damaged or rejected goods are not added to stock and stay on order.</p>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Product</th><th className="pb-1 text-right font-medium">Still to come</th><th className="pb-1 font-medium">Received</th><th className="pb-1 font-medium">Rejected</th><th className="pb-1 font-medium">Cost each (₹)</th></tr></thead>
        <tbody>{open.map((i) => (
          <tr key={i.id} className="border-t border-line-soft">
            <td className="py-1.5 pr-2 font-medium">{i.name}</td>
            <td className="py-1.5 pr-2 text-right num">{qty(i.outstandingQty, i.unit)}</td>
            <td className="py-1.5 pr-2"><Input className="h-9 w-20" inputMode="decimal" aria-label={`Received ${i.name}`} value={rows[i.id].quantity} onChange={(e) => set(i.id, 'quantity', decimalOnly(e.target.value))} /></td>
            <td className="py-1.5 pr-2"><Input className="h-9 w-20" inputMode="decimal" aria-label={`Rejected ${i.name}`} value={rows[i.id].rejected} onChange={(e) => set(i.id, 'rejected', decimalOnly(e.target.value))} /></td>
            <td className="py-1.5"><Input className="h-9 w-24" inputMode="decimal" aria-label={`Cost of ${i.name}`} value={rows[i.id].unitCost} onChange={(e) => set(i.id, 'unitCost', decimalOnly(e.target.value))} /></td>
          </tr>))}</tbody>
      </table></div>
      <Field label="Supplier invoice no." className="mt-4"><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ one purchase order
function PoDetail({ id, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(() => api.get(`/purchase-orders/${id}`), [id]);
  const [receiving, setReceiving] = useState(false);
  const [confirm, setConfirm] = useState(null);   // 'cancel' | 'close'
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (path, body, msg) => {
    setBusy(true);
    try { await api.post(`/purchase-orders/${id}/${path}`, body); toast.success(msg); setConfirm(null); state.reload(); onChanged(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const po = state.data;
  return (
    <Modal open onClose={onClose} title={po ? `${po.poNumber} · ${po.supplier}` : 'Purchase order'} size="lg"
      footer={po && (
        <div className="flex w-full flex-wrap justify-end gap-2">
          {po.status === 'draft' && <><Button variant="secondary" onClick={() => setConfirm('cancel')}>Cancel order</Button><Button loading={busy} onClick={() => act('order', expected ? { expectedDate: expected } : {}, 'Order placed.')}>Place order</Button></>}
          {po.status === 'ordered' && <><Button variant="secondary" onClick={() => setConfirm('cancel')}>Cancel order</Button><Button variant="success" onClick={() => setReceiving(true)}><PackageCheck className="size-4" aria-hidden="true" />Receive goods</Button></>}
          {po.status === 'partially_received' && <><Button variant="secondary" onClick={() => setConfirm('close')}>Close short</Button><Button variant="success" onClick={() => setReceiving(true)}><PackageCheck className="size-4" aria-hidden="true" />Receive goods</Button></>}
        </div>)}>
      <Async state={state} rows={4}>
        {(p) => (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[p.status]} dot>{STATUS_LABEL[p.status]}{p.closedShort ? ' (closed short)' : ''}</Badge>
              {p.isOverdue && <Badge tone="bad"><AlertTriangle className="mr-1 inline size-3" aria-hidden="true" />Overdue</Badge>}
              <span className="text-muted">Expected {p.expectedDate ? dateOnly(p.expectedDate) : 'once placed'}</span>
              <span className="ml-auto font-semibold num">{inr(p.orderedValue, 2)} ordered · {inr(p.receivedValue, 2)} received</span>
            </div>
            {p.status === 'draft' && <Field label="Expected delivery date" hint="Leave empty to use the supplier's lead time."><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>}
            {p.warnings.length > 0 && <ul className="space-y-1 rounded-lg bg-warn-soft px-3 py-2 text-warn">{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            <div className="overflow-x-auto"><table className="w-full">
              <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Product</th><th className="pb-1 text-right font-medium">Ordered</th><th className="pb-1 text-right font-medium">Received</th><th className="pb-1 text-right font-medium">Rejected</th><th className="pb-1 text-right font-medium">Outstanding</th><th className="pb-1 text-right font-medium">Cost</th></tr></thead>
              <tbody>{p.items.map((i) => (
                <tr key={i.id} className="border-t border-line-soft num">
                  <td className="py-1.5 pr-2 font-medium font-sans">{i.name}</td>
                  <td className="py-1.5 text-right">{qty(i.orderedQty, i.unit)}</td><td className="py-1.5 text-right">{qty(i.receivedQty, i.unit)}</td>
                  <td className="py-1.5 text-right">{i.rejectedQty || '—'}</td><td className="py-1.5 text-right font-semibold">{qty(i.outstandingQty, i.unit)}</td><td className="py-1.5 text-right">{inr(i.unitCost, 2)}</td>
                </tr>))}</tbody>
            </table></div>
            {p.receipts.length > 0 && (
              <div>
                <h3 className="mb-1 font-semibold">Deliveries</h3>
                <ul className="space-y-1.5">{p.receipts.map((r) => (
                  <li key={r.id} className="rounded-lg bg-line-soft px-3 py-2">
                    <p className="text-xs text-muted">{dateTime(r.receivedAt)} · {r.receivedBy || '—'}{r.invoiceNo ? ` · invoice ${r.invoiceNo}` : ''}</p>
                    <p>{r.items.map((x) => `${x.product} × ${x.quantity}${x.rejectedQuantity ? ` (+${x.rejectedQuantity} rejected)` : ''}`).join(', ')}</p>
                  </li>))}</ul>
              </div>)}
            {p.notes && <p className="text-muted">Notes: {p.notes}</p>}
          </div>)}
      </Async>
      {receiving && po && <ReceiveModal po={po} onClose={() => setReceiving(false)} onReceived={() => { setReceiving(false); state.reload(); onChanged(); }} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={busy} danger={confirm === 'cancel'}
        title={confirm === 'cancel' ? 'Cancel this order?' : 'Close this order short?'} confirmLabel={confirm === 'cancel' ? 'Cancel order' : 'Close short'}
        message={confirm === 'cancel' ? 'Nothing has been received yet. Any restock orders linked to it are released.' : 'The remaining quantities will not be delivered. Stock already received stays.'}
        onConfirm={() => (confirm === 'cancel' ? act('cancel', {}, 'Order cancelled.') : act('close', {}, 'Order closed.'))} />
    </Modal>
  );
}

// ------------------------------------------------------------------ restock orders → purchase orders
function FromRestockModal({ onClose, onCreated }) {
  const toast = useToast();
  const state = useAsync(() => api.get('/inventory/restock-orders'), []);
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const rows = (state.data ? state.data.rows : []).filter((r) => r.status === 'approved' && !r.purchaseOrder);
  const ids = Object.keys(picked).filter((k) => picked[k]).map(Number);

  const make = async () => {
    setBusy(true);
    try { const r = await api.post('/purchase-orders/from-restock', { restockOrderIds: ids }); toast.success(`${r.rows.length} draft purchase order${r.rows.length === 1 ? '' : 's'} created.`); onCreated(); }
    catch (e) { toast.error(e.message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Create purchase orders from restock orders" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} disabled={!ids.length} onClick={make}>Create drafts ({ids.length})</Button></>}>
      <Async state={state} rows={3}>
        {() => rows.length === 0 ? <EmptyState icon={ClipboardList} title="Nothing waiting" hint="Approved restock orders that are not on a purchase order yet appear here." /> : (
          <ul className="divide-y divide-line-soft text-sm">
            {rows.map((r) => (
              <li key={r.id}><label className="flex cursor-pointer items-center gap-3 py-2.5">
                <input type="checkbox" className="size-4" checked={!!picked[r.id]} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })} />
                <span className="flex-1"><span className="font-semibold">{r.product}</span><span className="block text-xs text-muted">{r.supplier || 'No supplier — assign one on the product first'}</span></span>
                <span className="num">{qty(r.quantity, r.unit)}</span>
              </label></li>))}
          </ul>)}
      </Async>
      <p className="mt-3 text-xs text-muted">Drafts are grouped by each product's main supplier. Nothing is ordered until you place the draft.</p>
    </Modal>
  );
}

function OrdersTab() {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [fromRestock, setFromRestock] = useState(false);
  const [openId, setOpenId] = useState(null);
  const state = useAsync(() => api.get('/purchase-orders', { status: status === 'all' ? undefined : status, page, limit: 20 }), [status, page]);
  const columns = [
    { key: 'po', header: 'Order', render: (o) => <div><p className="font-semibold">{o.poNumber}</p><p className="text-xs text-muted">{o.supplier}</p></div> },
    { key: 'status', header: 'Status', render: (o) => <div className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[o.status]} dot>{STATUS_LABEL[o.status]}</Badge>{o.isOverdue && <Badge tone="bad">Overdue</Badge>}</div> },
    { key: 'exp', header: 'Expected', render: (o) => (o.expectedDate ? dateOnly(o.expectedDate) : <span className="text-muted">—</span>) },
    { key: 'val', header: 'Value', align: 'right', render: (o) => <div><p>{inr(o.orderedValue, 2)}</p><p className="text-xs text-muted">{inr(o.receivedValue, 2)} received</p></div> },
    { key: 'qty', header: 'Delivered', align: 'right', render: (o) => `${o.receivedQty} / ${o.orderedQty}` },
  ];
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Select aria-label="Status" className="w-48" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="open">Open orders</option><option value="all">All orders</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <div className="ml-auto flex gap-2"><Button variant="secondary" onClick={() => setFromRestock(true)}>From restock orders</Button><Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden="true" />New order</Button></div>
        </div>
        <Async state={state} rows={4}>
          {(d) => (<>
            <DataTable columns={columns} rows={d.rows} onRowClick={(o) => setOpenId(o.id)} empty={<EmptyState icon={Truck} title="No purchase orders" hint="Create one to order stock from a supplier and track what arrives." action={<Button onClick={() => setCreating(true)}>New order</Button>} />} />
            <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
          </>)}
        </Async>
      </Card>
      {creating && <NewPoModal onClose={() => setCreating(false)} onCreated={(po) => { setCreating(false); state.reload(); setOpenId(po.id); }} />}
      {fromRestock && <FromRestockModal onClose={() => setFromRestock(false)} onCreated={() => { setFromRestock(false); state.reload(); }} />}
      {openId && <PoDetail id={openId} onClose={() => setOpenId(null)} onChanged={state.reload} />}
    </>
  );
}

// ------------------------------------------------------------------ suppliers
const EMPTY_SUP = { name: '', phone: '', email: '', contactPerson: '', address: '', gstin: '', leadTimeDays: '3', paymentTermsDays: '0', minOrderValue: '0', notes: '' };

function SupplierForm({ supplier, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(supplier ? Object.fromEntries(Object.keys(EMPTY_SUP).map((k) => [k, supplier[k] === null || supplier[k] === undefined ? '' : String(supplier[k])])) : EMPTY_SUP);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    if (!f.name.trim()) return toast.error('Enter the supplier name.');
    const body = { ...f, name: f.name.trim(), leadTimeDays: Number(f.leadTimeDays || 0), paymentTermsDays: Number(f.paymentTermsDays || 0), minOrderValue: Number(f.minOrderValue || 0) };
    setBusy(true);
    try { if (supplier) await api.put(`/suppliers/${supplier.id}`, body); else await api.post('/suppliers', body); toast.success('Supplier saved.'); onSaved(); }
    catch (err) { toast.error(err.message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={supplier ? 'Edit supplier' : 'Add supplier'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="supplier-form" loading={busy}>Save supplier</Button></>}>
      <form id="supplier-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact person"><Input value={f.contactPerson} onChange={set('contactPerson')} /></Field>
        <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="GSTIN"><Input value={f.gstin} onChange={set('gstin')} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
        <Field label="Lead time (days)"><Input inputMode="numeric" value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>
        <Field label="Payment terms (days)"><Input inputMode="numeric" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        <Field label="Minimum order value (₹)"><Input inputMode="decimal" value={f.minOrderValue} onChange={set('minOrderValue')} /></Field>
        <Field label="Notes"><Input value={f.notes} onChange={set('notes')} /></Field>
      </form>
    </Modal>
  );
}

function SupplierProducts({ id, onClose }) {
  const toast = useToast();
  const state = useAsync(() => api.get(`/suppliers/${id}`), [id]);
  const history = useAsync(() => api.get(`/suppliers/${id}/price-history`), [id]);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const found = useAsync(() => (dq.trim().length >= 2 ? api.get('/products', { q: dq.trim(), limit: 6 }) : Promise.resolve({ rows: [] })), [dq]);
  const [terms, setTerms] = useState(null);   // { productId, name, packSize, minOrderQty, lastCost, isPreferred }
  const [busy, setBusy] = useState(false);

  const saveTerms = async () => {
    setBusy(true);
    try {
      await api.put(`/suppliers/${id}/products/${terms.productId}`, {
        packSize: parseFloat(terms.packSize) || 1, minOrderQty: parseFloat(terms.minOrderQty) || 1,
        lastCost: terms.lastCost === '' ? null : parseFloat(terms.lastCost), isPreferred: terms.isPreferred,
      });
      toast.success('Saved.'); setTerms(null); state.reload(); history.reload();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const unlink = async (productId) => { try { await api.del(`/suppliers/${id}/products/${productId}`); state.reload(); } catch (e) { toast.error(e.message); } };

  return (
    <Modal open onClose={onClose} title={state.data ? `${state.data.name} · products & prices` : 'Supplier'} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <Async state={state} rows={3}>
        {(s) => (
          <div className="space-y-5 text-sm">
            <div className="relative">
              <Input aria-label="Link a product" placeholder="Search a product this supplier sells" value={q} onChange={(e) => setQ(e.target.value)} />
              {found.data && found.data.rows.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-white shadow-lg">
                  {found.data.rows.map((p) => <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-brand-soft" onClick={() => { setTerms({ productId: p.id, name: p.name, packSize: '1', minOrderQty: '1', lastCost: String(p.purchasePrice), isPreferred: false }); setQ(''); }}>{p.name}</button></li>)}
                </ul>)}
            </div>
            {terms && (
              <div className="grid gap-3 rounded-lg bg-line-soft p-3 sm:grid-cols-4">
                <p className="font-semibold sm:col-span-4">{terms.name}</p>
                <Field label="Pack size"><Input inputMode="decimal" value={terms.packSize} onChange={(e) => setTerms({ ...terms, packSize: decimalOnly(e.target.value) })} /></Field>
                <Field label="Min. order qty"><Input inputMode="decimal" value={terms.minOrderQty} onChange={(e) => setTerms({ ...terms, minOrderQty: decimalOnly(e.target.value) })} /></Field>
                <Field label="Cost (₹)"><Input inputMode="decimal" value={terms.lastCost} onChange={(e) => setTerms({ ...terms, lastCost: decimalOnly(e.target.value) })} /></Field>
                <label className="flex items-end gap-2 pb-2"><input type="checkbox" className="size-4" checked={terms.isPreferred} onChange={(e) => setTerms({ ...terms, isPreferred: e.target.checked })} />Preferred supplier</label>
                <div className="flex gap-2 sm:col-span-4"><Button loading={busy} onClick={saveTerms}>Save</Button><Button variant="secondary" onClick={() => setTerms(null)}>Cancel</Button></div>
              </div>)}
            {s.products.length === 0 ? <p className="text-muted">No products linked yet.</p> : (
              <div className="overflow-x-auto"><table className="w-full">
                <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Product</th><th className="pb-1 text-right font-medium">Pack</th><th className="pb-1 text-right font-medium">Min qty</th><th className="pb-1 text-right font-medium">Last cost</th><th /></tr></thead>
                <tbody>{s.products.map((p) => (
                  <tr key={p.productId} className="border-t border-line-soft num">
                    <td className="py-1.5 pr-2 font-sans font-medium">{p.name}{p.isPreferred && <Badge tone="ok" className="ml-2">Preferred</Badge>}</td>
                    <td className="py-1.5 text-right">{p.packSize}</td><td className="py-1.5 text-right">{p.minOrderQty}</td><td className="py-1.5 text-right">{p.lastCost === null ? '—' : inr(p.lastCost, 2)}</td>
                    <td className="py-1.5 text-right font-sans"><Button variant="ghost" size="sm" aria-label={`Edit terms for ${p.name}`} onClick={() => setTerms({ productId: p.productId, name: p.name, packSize: String(p.packSize), minOrderQty: String(p.minOrderQty), lastCost: p.lastCost === null ? '' : String(p.lastCost), isPreferred: p.isPreferred })}><Pencil className="size-4" /></Button><Button variant="ghost" size="sm" aria-label={`Unlink ${p.name}`} onClick={() => unlink(p.productId)}><Trash2 className="size-4 text-bad" /></Button></td>
                  </tr>))}</tbody>
              </table></div>)}
            <div>
              <h3 className="mb-1 font-semibold">Price history</h3>
              {history.data && history.data.rows.length ? (
                <ul className="max-h-48 divide-y divide-line-soft overflow-y-auto">{history.data.rows.map((h) => <li key={h.id} className="flex justify-between py-1.5"><span>{h.product}<span className="block text-xs text-muted">{dateTime(h.recordedAt)} · {h.poNumber || cap(h.source)}</span></span><span className="font-semibold num">{inr(h.unitCost, 2)}</span></li>)}</ul>
              ) : <p className="text-muted">No prices recorded yet. They are added when you receive goods or enter a cost above.</p>}
            </div>
          </div>)}
      </Async>
    </Modal>
  );
}

function SuppliersTab() {
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const state = useAsync(() => api.get('/suppliers', { includeInactive: showInactive ? 'true' : 'false' }), [showInactive]);
  const [editing, setEditing] = useState(null);
  const [products, setProducts] = useState(null);
  const toggle = async (s) => {
    try { await api.put(`/suppliers/${s.id}`, { isActive: !s.isActive }); state.reload(); } catch (e) { toast.error(e.message); }
  };
  const columns = [
    { key: 'name', header: 'Supplier', render: (s) => <div><p className="font-semibold">{s.name}{!s.isActive && <Badge className="ml-2">Inactive</Badge>}</p><p className="text-xs text-muted">{[s.contactPerson, s.phone].filter(Boolean).join(' · ') || '—'}</p></div> },
    { key: 'lead', header: 'Lead time', render: (s) => `${s.leadTimeDays} days` },
    { key: 'terms', header: 'Payment', render: (s) => (s.paymentTermsDays ? `${s.paymentTermsDays} days` : 'On delivery') },
    { key: 'p', header: 'Products', align: 'right', render: (s) => s.products },
    { key: 'o', header: 'Open orders', align: 'right', render: (s) => s.openOrders },
    { key: 'a', header: <span className="sr-only">Actions</span>, align: 'right', render: (s) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" onClick={() => setProducts(s.id)}>Products</Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}><Pencil className="size-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => toggle(s)}>{s.isActive ? 'Deactivate' : 'Activate'}</Button>
      </div>) },
  ];
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show inactive</label>
          <Button className="ml-auto" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add supplier</Button>
        </div>
        <Async state={state} rows={4}>
          {(d) => <DataTable columns={columns} rows={d.rows} onRowClick={(s) => setProducts(s.id)} empty={<EmptyState icon={Truck} title="No suppliers yet" hint="Add the people you buy from to order and track stock." action={<Button onClick={() => setEditing('new')}>Add supplier</Button>} />} />}
        </Async>
      </Card>
      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); state.reload(); }} />}
      {products && <SupplierProducts id={products} onClose={() => { setProducts(null); state.reload(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ categories
function CategoriesTab() {
  const toast = useToast();
  const { isRole } = useAuth();
  const state = useAsync(() => api.get('/categories'), []);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [taxRate, setTaxRate] = useState('5');
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = (c) => { setEditing(c); setName(c === 'new' ? '' : c.name); setTaxRate(c === 'new' ? '5' : String(c.taxRate)); };
  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) return toast.error('Enter a category name.');
    setBusy(true);
    try {
      const body = { name: name.trim(), taxRate: Number(taxRate || 0) };
      if (editing === 'new') await api.post('/categories', body); else await api.put(`/categories/${editing.id}`, body);
      toast.success('Category saved. New bills use the new tax rate; past bills are unchanged.'); setEditing(null); state.reload();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.del(`/categories/${deleting.id}`); toast.success('Category deleted.'); setDeleting(null); state.reload(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const columns = [
    { key: 'name', header: 'Category', render: (c) => <span className="font-semibold">{c.name}</span> },
    { key: 'tax', header: 'GST rate', align: 'right', render: (c) => `${c.taxRate}%` },
    { key: 'p', header: 'Products', align: 'right', render: (c) => c.products },
    { key: 'a', header: <span className="sr-only">Actions</span>, align: 'right', render: (c) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" onClick={() => open(c)} aria-label={`Edit ${c.name}`}><Pencil className="size-4" /></Button>
        {isRole('business_owner') && <Button variant="ghost" size="sm" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}><Trash2 className="size-4 text-bad" /></Button>}
      </div>) },
  ];
  return (
    <>
      <Card>
        <CardHeader title="Categories" subtitle="The GST rate here applies to new sales. Past invoices keep the rate they were sold at." action={<Button onClick={() => open('new')}><Plus className="size-4" aria-hidden="true" />Add category</Button>} />
        <Async state={state} rows={4}>{(d) => <DataTable columns={columns} rows={d.rows} onRowClick={open} empty={<EmptyState icon={Tags} title="No categories" />} />}</Async>
      </Card>
      {editing && (
        <Modal open onClose={() => setEditing(null)} title={editing === 'new' ? 'Add category' : 'Edit category'} size="sm"
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="category-form" loading={busy}>Save</Button></>}>
          <form id="category-form" onSubmit={save} className="space-y-4" noValidate>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="GST rate (%)"><Input inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(decimalOnly(e.target.value))} /></Field>
          </form>
        </Modal>)}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger loading={busy} title="Delete category?" confirmLabel="Delete category" onConfirm={remove}
        message={deleting ? `${deleting.name} will be removed. This is only possible when no product uses it.` : ''} />
    </>
  );
}

export default function Purchasing() {
  const [tab, setTab] = useState('orders');
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Purchasing" subtitle="Order from suppliers, receive deliveries in parts, and track what you paid." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'orders', label: 'Purchase orders' }, { value: 'suppliers', label: 'Suppliers' }, { value: 'categories', label: 'Categories' }]} />
      {tab === 'orders' && <OrdersTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'categories' && <CategoriesTab />}
    </div>
  );
}
