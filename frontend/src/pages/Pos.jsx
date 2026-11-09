import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Search, ShoppingBag, Trash2, UserPlus, X, Banknote, Smartphone, CreditCard, BadgeCheck, ShoppingCart, Wallet } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, cx } from '../components/ui';
import { InvoiceModal } from '../components/Invoice';
import { inr } from '../utils/format';
import { uuid } from '../utils/uuid';
import { cleanCode, looksLikeBarcode, lookupBarcode } from '../services/barcode';

const PAY = [
  { value: 'cash', label: 'Cash', icon: Banknote },
  { value: 'upi', label: 'UPI', icon: Smartphone },
  { value: 'card', label: 'Card', icon: CreditCard },
  { value: 'credit', label: 'Udhaar', icon: Wallet },
];

export function CustomerPicker({ customer, onChange }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [results, setResults] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return; }
    api.get('/customers/search', { q: dq.trim() }).then((r) => setResults(r.rows)).catch(() => setResults([]));
  }, [dq]);

  const add = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const c = await api.post('/customers', form);
      onChange({ id: c.id, name: c.name, phone: c.phone });
      setAdding(false); setForm({ name: '', phone: '' }); setQ('');
      toast.success(`${c.name} added as a customer.`);
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  if (customer) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-brand-soft px-3 py-2 text-sm">
        <span><span className="font-semibold">{customer.name}</span> <span className="text-muted num">{customer.phone}</span></span>
        <button onClick={() => onChange(null)} className="rounded p-1 text-muted hover:bg-white" aria-label="Remove customer"><X className="size-4" /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer name or phone (optional)" aria-label="Find customer" />
        <Button variant="secondary" onClick={() => setAdding(true)} aria-label="Add new customer"><UserPlus className="size-4" /></Button>
      </div>
      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-white shadow-lg">
          {results.map((c) => (
            <li key={c.id}><button className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-brand-soft" onClick={() => { onChange(c); setQ(''); setResults([]); }}><span className="font-medium">{c.name}</span><span className="text-muted num">{c.phone}</span></button></li>
          ))}
        </ul>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="New customer" size="sm"
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button form="new-customer" type="submit" loading={saving}>Save customer</Button></>}>
        <form id="new-customer" onSubmit={add} className="space-y-3">
          <Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Phone number"><Input required inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="10-digit mobile number" /></Field>
        </form>
      </Modal>
    </div>
  );
}

export default function Pos() {
  const toast = useToast();
  const { user } = useAuth();
  const searchRef = useRef(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 150);
  const products = useAsync(() => api.get('/products/pos-search', { q: dq }), [dq]);
  const limits = useAsync(() => api.get('/sales/limits'), []);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [discType, setDiscType] = useState('percent');
  const [discValue, setDiscValue] = useState('');
  const [pay, setPay] = useState('upi');
  const [tendered, setTendered] = useState('');
  const [bill, setBill] = useState(null);
  const [billError, setBillError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState(null); // { message }
  const [approver, setApprover] = useState({ email: '', password: '' });
  const [approvalError, setApprovalError] = useState('');
  const [invoice, setInvoice] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);

  useEffect(() => { searchRef.current && searchRef.current.focus(); }, []);

  const discount = useMemo(() => {
    const v = parseFloat(discValue);
    return v > 0 ? { type: discType, value: v } : null;
  }, [discType, discValue]);
  const items = useMemo(() => cart.map((c) => ({ productId: c.id, quantity: c.qty })), [cart]);
  const itemsKey = JSON.stringify(items) + JSON.stringify(discount);

  // The backend prices the cart; the screen only displays what it returns.
  useEffect(() => {
    if (!cart.length) { setBill(null); setBillError(''); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.post('/sales/preview', { items, discount }).then((b) => { if (live) { setBill(b); setBillError(''); } }).catch((e) => { if (live) { setBill(null); setBillError(e.message); } });
    }, 180);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const addToCart = useCallback((p) => {
    setCart((c) => {
      const ex = c.find((x) => x.id === p.id);
      if (ex) {
        if (ex.qty >= p.stock) { toast.error(`Only ${p.stock} ${p.unit || ''} of ${p.name} in stock.`.replace('  ', ' ')); return c; }
        return c.map((x) => (x.id === p.id ? { ...x, qty: Math.min(Math.round((x.qty + 1) * 1000) / 1000, p.stock), qtyText: undefined } : x));
      }
      return [...c, { id: p.id, name: p.name, price: p.price, stock: p.stock, qty: 1, unit: p.unit || 'pcs', allowDecimal: Boolean(p.allowDecimal), priceIncludesTax: Boolean(p.priceIncludesTax) }];
    });
  }, [toast]);

  const setQty = (id, qty) => setCart((c) => c.flatMap((x) => {
    if (x.id !== id) return [x];
    const q = Math.round(qty * 1000) / 1000;
    if (q <= 0) return [];
    if (q > x.stock) { toast.error(`Only ${x.stock} ${x.unit} of ${x.name} in stock.`); return [{ ...x, qty: x.stock, qtyText: undefined }]; }
    return [{ ...x, qty: q, qtyText: undefined }];
  }));
  // Loose goods: let the cashier type "0." or "0.75" without the line vanishing mid-typing; the bill uses the parsed number.
  const typeQty = (id, text) => {
    if (!/^\d*\.?\d{0,3}$/.test(text)) return;
    const v = parseFloat(text);
    setCart((c) => c.map((x) => (x.id === id ? { ...x, qtyText: text, qty: v > 0 ? Math.min(v, x.stock) : x.qty } : x)));
  };
  const commitQty = (id, text) => { const v = parseFloat(text); if (!(v > 0)) setQty(id, 0); else setQty(id, v); };

  // A USB/Bluetooth scanner "types" the manufacturer barcode and presses Enter: look it up as a barcode (this shop's mapping), add it to the
  // SAME cart. The camera scanner lives on the Counter screen. Typed names / SKUs keep the normal search below.
  const scanCode = async (raw) => {
    try {
      const code = cleanCode(raw);
      const r = code ? await lookupBarcode(code) : { found: false };
      if (!r.found) { toast.error(r.canRegister ? `Barcode ${raw} is not registered. Open the Counter to register it.` : `Barcode ${raw} is not registered. Ask a manager to register it.`); return; }
      const p = r.product;
      if (p.expired) toast.error(`${p.name} is expired and cannot be sold.`);
      else if (p.stock <= 0) toast.error(`${p.name} is out of stock.`);
      else addToCart(p);
    } catch (e) { toast.error(e.message); }
  };
  const onSearchKey = (e) => {
    if (e.key === 'Enter' && looksLikeBarcode(q)) { scanCode(q.trim()); setQ(''); return; }
    if (e.key === 'Enter' && products.data && products.data.rows.length) {
      const exact = products.data.rows.find((p) => p.sku.toLowerCase() === q.trim().toLowerCase()) || products.data.rows[0];
      addToCart(exact);
      setQ('');
    }
  };

  // One Idempotency-Key per sale. The same key is reused for every retry of the SAME bill (double-tap, lost connection, approval step)
  // and a new one is made as soon as the bill changes, so a retry can never sell twice and a new bill is never mistaken for an old one.
  const attemptRef = useRef(null);
  const keyForBill = () => {
    const sig = JSON.stringify({ i: [...items].map((x) => [x.productId, x.quantity]).sort((a, b) => a[0] - b[0]), d: discount, p: pay, c: customer ? customer.id : null });
    if (!attemptRef.current || attemptRef.current.sig !== sig) attemptRef.current = { sig, key: uuid() };
    return attemptRef.current.key;
  };
  const submitting = useRef(false);

  const reset = () => { setCart([]); setCustomer(null); setDiscValue(''); setTendered(''); setBill(null); setApproval(null); setApprover({ email: '', password: '' }); setCartOpen(false); searchRef.current && searchRef.current.focus(); };

  const creditInfo = useAsync(() => (pay === 'credit' && customer ? api.get(`/credit/customers/${customer.id}/balance`) : Promise.resolve(null)), [pay, customer && customer.id]);

  const submit = async (withApproval) => {
    if (submitting.current) return;            // a second tap while the first is in flight does nothing
    submitting.current = true;
    setBusy(true); setApprovalError('');
    try {
      const sale = await api.post('/sales', { items, discount, paymentMethod: pay, customerId: customer ? customer.id : null, approval: withApproval || null }, {
        idempotencyKey: keyForBill(),
        onRetry: () => toast.info('Connection problem. Retrying safely, the bill will not be charged twice…'),
      });
      attemptRef.current = null;
      setInvoice(sale);
      setApproval(null);
      reset();
      products.reload();
      toast.success(`Sale ${sale.invoiceNo} completed. Stock updated.`);
    } catch (e) {
      if (e.status === 403 && e.details && e.details.code === 'APPROVAL_REQUIRED') { setApproval({ message: e.message }); }
      else if (withApproval) setApprovalError(e.message);
      else toast.error(e.message);
    } finally { submitting.current = false; setBusy(false); }
  };

  const change = pay === 'cash' && bill && parseFloat(tendered) > 0 ? Math.round((parseFloat(tendered) - bill.total) * 100) / 100 : null;
  const itemCount = cart.reduce((a, c) => a + c.qty, 0);
  const limit = limits.data ? limits.data[user.role] : null;

  const cartPanel = (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="flex items-center gap-2 font-bold"><ShoppingBag className="size-5" aria-hidden="true" />Current bill{itemCount > 0 && <Badge tone="info">{itemCount} items</Badge>}</h2>
        <div className="flex gap-1">
          {cart.length > 0 && <Button variant="ghost" size="sm" onClick={reset}>Clear</Button>}
          <button className="rounded-md p-1.5 text-muted hover:bg-line-soft lg:hidden" onClick={() => setCartOpen(false)} aria-label="Close bill"><X className="size-5" /></button>
        </div>
      </div>
      <div className="min-h-[120px] flex-1 overflow-y-auto">
        {cart.length === 0 ? <EmptyState icon={ShoppingCart} title="The bill is empty" hint="Search or tap a product to add it. Press Enter to add the first match." /> : (
          <ul className="divide-y divide-line-soft">
            {cart.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{c.name}</p><p className="text-xs text-muted num">{inr(c.price, 2)} {c.unit === 'pcs' ? 'each' : `per ${c.unit}`}{c.priceIncludesTax ? ' · incl. tax' : ''}</p></div>
                <div className="flex items-center rounded-lg border border-line">
                  <button className="grid size-8 place-items-center text-muted hover:bg-line-soft" onClick={() => setQty(c.id, c.qty - 1)} aria-label={`Decrease ${c.name}`}><Minus className="size-4" /></button>
                  {c.allowDecimal
                    ? <input aria-label={`Quantity of ${c.name} in ${c.unit}`} className="h-8 w-16 border-x border-line text-center text-sm font-semibold num focus:outline-none" inputMode="decimal" value={c.qtyText !== undefined ? c.qtyText : String(c.qty)} onChange={(e) => typeQty(c.id, e.target.value)} onBlur={(e) => commitQty(c.id, e.target.value)} />
                    : <input aria-label={`Quantity of ${c.name}`} className="h-8 w-10 border-x border-line text-center text-sm font-semibold num focus:outline-none" inputMode="numeric" value={c.qty} onChange={(e) => setQty(c.id, parseInt(e.target.value || '0', 10) || 0)} />}
                  {c.allowDecimal && <span className="grid place-items-center pr-2 text-xs text-muted">{c.unit}</span>}
                  <button className="grid size-8 place-items-center text-muted hover:bg-line-soft" onClick={() => setQty(c.id, c.qty + 1)} aria-label={`Increase ${c.name}`}><Plus className="size-4" /></button>
                </div>
                <p className="w-20 text-right text-sm font-semibold num">{inr(c.price * c.qty, 2)}</p>
                <button className="rounded p-1 text-muted hover:text-bad" onClick={() => setQty(c.id, 0)} aria-label={`Remove ${c.name}`}><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-4 border-t border-line p-5">
        <CustomerPicker customer={customer} onChange={setCustomer} />
        <div>
          <p className="mb-1 text-[13px] font-semibold">Discount</p>
          <div className="flex gap-2">
            <Select aria-label="Discount type" value={discType} onChange={(e) => setDiscType(e.target.value)} className="!w-24"><option value="percent">%</option><option value="amount">₹</option></Select>
            <Input aria-label="Discount value" inputMode="decimal" placeholder="0" value={discValue} onChange={(e) => setDiscValue(e.target.value.replace(/[^0-9.]/g, ''))} />
          </div>
          {limit !== null && <p className="mt-1 text-xs text-muted">You can give up to {limit}% without approval. Above that, a manager signs off.</p>}
        </div>
        {billError && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">{billError}</p>}
        <dl className="space-y-1.5 text-sm num">
          <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{bill ? inr(bill.subtotal, 2) : '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Discount{bill && bill.discount > 0 ? ` (${bill.discountPct}%)` : ''}</dt><dd>{bill && bill.discount > 0 ? `−${inr(bill.discount, 2)}` : '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">{bill && bill.taxIncluded > 0 ? (bill.taxAdded > 0 ? 'Tax' : 'Tax (already in prices)') : 'Tax'}</dt><dd>{bill ? inr(bill.tax, 2) : '—'}{bill && bill.taxIncluded > 0 && bill.taxAdded > 0 ? <span className="block text-[11px] text-muted">{inr(bill.taxIncluded, 2)} included, {inr(bill.taxAdded, 2)} added</span> : null}</dd></div>
          <div className="flex justify-between border-t border-line pt-2 text-xl font-extrabold"><dt>Total</dt><dd>{bill ? inr(bill.total, 2) : '₹0.00'}</dd></div>
        </dl>
        <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-4 gap-2">
          {PAY.map((p) => (
            <button key={p.value} role="radio" aria-checked={pay === p.value} onClick={() => setPay(p.value)}
              className={cx('flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-sm font-semibold transition-colors', pay === p.value ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:bg-canvas')}>
              <p.icon className="size-5" aria-hidden="true" />{p.label}
            </button>
          ))}
        </div>
        {pay === 'cash' && (
          <div className="flex items-center gap-3">
            <Input aria-label="Cash received" inputMode="decimal" placeholder="Cash received (optional)" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ''))} />
            {change !== null && <p className={cx('whitespace-nowrap text-sm font-semibold num', change < 0 ? 'text-bad' : 'text-ok')}>{change < 0 ? `Short ${inr(-change, 2)}` : `Change ${inr(change, 2)}`}</p>}
          </div>
        )}
        {pay === 'credit' && (
          <div className="rounded-lg border border-line p-3 text-sm">
            {!customer ? <p className="font-medium text-warn">Choose the customer above. Udhaar needs a customer.</p>
              : !creditInfo.data ? <p className="text-muted">Checking credit…</p>
              : !creditInfo.data.enabled ? <p className="font-medium text-warn">{customer.name} has no credit limit yet. A manager can set one in Udhaar.</p>
              : <p>{customer.name} owes <b className="num">{inr(creditInfo.data.balance, 2)}</b> of a <b className="num">{inr(creditInfo.data.creditLimit, 0)}</b> limit. Available: <b className={cx('num', bill && bill.total > creditInfo.data.available ? 'text-bad' : 'text-ok')}>{inr(creditInfo.data.available, 2)}</b>{bill && bill.total > creditInfo.data.available ? ' — this bill is more than the limit.' : ''}</p>}
          </div>
        )}
        <Button size="lg" className="w-full" disabled={!bill || cart.length === 0 || (pay === 'credit' && (!customer || !creditInfo.data || !creditInfo.data.enabled))} loading={busy} onClick={() => submit(null)}><BadgeCheck className="size-5" aria-hidden="true" />Complete sale{bill ? ` · ${inr(bill.total, 2)}` : ''}</Button>
      </div>
    </Card>
  );

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="POS / Billing" subtitle="Search a product, add it to the bill, take payment. Prices, tax and stock are handled by the server." />
      <div className="grid gap-5 lg:grid-cols-[1fr_440px]">
        <div>
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} aria-label="Search products by name or SKU" placeholder="Search by name, SKU or category — Enter adds the first match"
              className="h-12 w-full rounded-xl border border-line bg-white pl-11 pr-4 text-base placeholder:text-[#8b9aa5] focus:border-brand" />
          </div>
          {products.loading && !products.data ? <div className="grid place-items-center py-16"><Spinner className="size-7" /></div> :
            products.error && !products.data ? <Card><EmptyState title="Unable to load products." hint={products.error.message} action={<Button variant="secondary" onClick={products.reload}>Try again</Button>} /></Card> :
            products.data.rows.length === 0 ? <Card><EmptyState icon={Search} title="No product found" hint="Check the spelling or try a SKU. Out-of-stock and expired items are hidden." /></Card> : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {products.data.rows.map((p) => {
                  const inCart = cart.find((c) => c.id === p.id);
                  return (
                    <li key={p.id}>
                      <button onClick={() => addToCart(p)} className={cx('flex h-full w-full flex-col rounded-xl border bg-white p-3.5 text-left transition-colors hover:border-brand hover:bg-brand-soft/40', inCart ? 'border-brand' : 'border-line')}>
                        <span className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug">{p.name}</span>
                        <span className="mt-2 text-lg font-bold num">{inr(p.price, 2)}</span>
                        <span className="mt-1 flex items-center justify-between text-xs text-muted"><span>{p.category}</span><span className={cx('num', p.stock <= 5 && 'font-semibold text-warn')}>{p.stock} left</span></span>
                        {inCart && <Badge tone="info" className="mt-2 self-start">{inCart.qty} in bill</Badge>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
        <div className="hidden lg:block"><div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl">{cartPanel}</div></div>
      </div>

      {/* Mobile bill bar + sheet */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white p-3 lg:hidden">
        <Button size="lg" className="w-full" onClick={() => setCartOpen(true)}><ShoppingBag className="size-5" aria-hidden="true" />View bill · {itemCount} items{bill ? ` · ${inr(bill.total, 2)}` : ''}</Button>
      </div>
      {cartOpen && <div className="fixed inset-0 z-40 flex flex-col justify-end bg-ink-950/50 lg:hidden"><div className="max-h-[92vh] overflow-y-auto rounded-t-2xl bg-canvas">{cartPanel}</div></div>}
      <div className="h-20 lg:hidden" />

      <Modal open={!!approval} onClose={() => setApproval(null)} title="Manager approval needed" size="sm"
        footer={<><Button variant="secondary" onClick={() => setApproval(null)}>Cancel</Button><Button loading={busy} onClick={() => submit(approver)}>Approve and complete sale</Button></>}>
        <p className="mb-4 text-sm text-muted">{approval && approval.message} Ask a manager or admin to enter their login.</p>
        <div className="space-y-3">
          <Field label="Approver email"><Input type="email" autoComplete="off" value={approver.email} onChange={(e) => setApprover({ ...approver, email: e.target.value })} /></Field>
          <Field label="Approver password" error={approvalError}><Input type="password" autoComplete="off" value={approver.password} onChange={(e) => setApprover({ ...approver, password: e.target.value })} /></Field>
        </div>
      </Modal>
      <InvoiceModal sale={invoice} onClose={() => setInvoice(null)} />
    </div>
  );
}
