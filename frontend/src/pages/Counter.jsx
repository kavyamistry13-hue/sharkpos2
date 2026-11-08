import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Minus, PauseCircle, Plus, Printer, RotateCcw, Search, ShoppingCart, Trash2, X, XCircle } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useAuth } from '../hooks/useAuth';
import { Badge, Button, Card, EmptyState, Input, Modal, Select, Spinner, cx } from '../components/ui';
import { InvoiceModal } from '../components/Invoice';
import { CustomerPicker } from './Pos';
import { inr, dateTime } from '../utils/format';
import { uuid } from '../utils/uuid';

// Cashier counter mode: big controls, one job per screen. It adds NO selling logic of its own — it calls the same server APIs as the normal POS
// (/sales/preview, /sales, /held-bills, /sales/:id/returns). The server prices, taxes, checks stock and enforces roles; this screen only shows results.
const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['credit', 'Udhaar']];
const REASONS = [['changed_mind', 'Customer changed mind'], ['wrong_item', 'Wrong item'], ['damaged', 'Damaged'], ['quality', 'Quality problem'], ['expired', 'Expired'], ['other', 'Other']];
const paise = (v) => Math.round((parseFloat(v) || 0) * 100);

function Banner({ msg, onClose }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div role={ok ? 'status' : 'alert'} className={cx('flex items-center gap-3 rounded-xl px-4 py-3 text-base font-semibold', ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad')}>
      {ok ? <CheckCircle2 className="size-6 shrink-0" aria-hidden="true" /> : <XCircle className="size-6 shrink-0" aria-hidden="true" />}
      <span className="flex-1">{msg.text}</span>
      <button onClick={onClose} aria-label="Dismiss message" className="rounded p-1 hover:bg-white/60"><X className="size-5" /></button>
    </div>
  );
}

/** Pay: one method, or split into several lines that must add up to the bill exactly. */
function PayModal({ open, total, customer, busy, error, onClose, onPay }) {
  const [mode, setMode] = useState('single');
  const [method, setMethod] = useState('cash');
  const [lines, setLines] = useState({ cash: '', upi: '', card: '', credit: '' });
  useEffect(() => { if (open) { setMode('single'); setMethod('cash'); setLines({ cash: '', upi: '', card: '', credit: '' }); } }, [open]);
  const sum = METHODS.reduce((a, [m]) => a + paise(lines[m]), 0);
  const left = paise(total) - sum;
  const needsCustomer = (mode === 'single' ? method === 'credit' : paise(lines.credit) > 0) && !customer;
  const ready = mode === 'single' ? !needsCustomer : left === 0 && sum > 0 && !needsCustomer;
  const submit = () => onPay(mode === 'single' ? { paymentMethod: method } : { payments: METHODS.filter(([m]) => paise(lines[m]) > 0).map(([m]) => ({ method: m, amount: paise(lines[m]) / 100 })) });
  return (
    <Modal open={open} onClose={onClose} title={`Pay ${inr(total, 2)}`} size="md"
      footer={<><Button variant="secondary" size="lg" onClick={onClose}>Back</Button><Button size="lg" disabled={!ready} loading={busy} onClick={submit}>Complete sale</Button></>}>
      <div className="mb-4 flex gap-2" role="radiogroup" aria-label="Payment type">
        {[['single', 'One method'], ['split', 'Split payment']].map(([v, l]) => (
          <button key={v} role="radio" aria-checked={mode === v} onClick={() => setMode(v)} className={cx('h-12 flex-1 rounded-xl border text-base font-semibold', mode === v ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted')}>{l}</button>
        ))}
      </div>
      {mode === 'single' ? (
        <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Payment method">
          {METHODS.map(([m, l]) => <button key={m} role="radio" aria-checked={method === m} onClick={() => setMethod(m)} className={cx('h-16 rounded-xl border text-lg font-bold', method === m ? 'border-brand bg-brand-soft text-brand' : 'border-line')}>{l}</button>)}
        </div>
      ) : (
        <div className="space-y-3">
          {METHODS.map(([m, l]) => (
            <label key={m} className="flex items-center gap-3"><span className="w-20 text-base font-semibold">{l}</span>
              <Input aria-label={`${l} amount`} inputMode="decimal" className="!h-12 text-lg" placeholder="0" value={lines[m]} onChange={(e) => setLines({ ...lines, [m]: e.target.value.replace(/[^0-9.]/g, '') })} />
              <button type="button" className="text-xs font-semibold text-brand" onClick={() => setLines({ ...lines, [m]: String(Math.max(0, (paise(lines[m]) + left) / 100)) })}>Rest</button>
            </label>
          ))}
          <p className={cx('rounded-lg px-3 py-2 text-base font-bold num', left === 0 ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')} role="status">
            {left === 0 ? 'Adds up exactly' : left > 0 ? `${inr(left / 100, 2)} still to collect` : `${inr(-left / 100, 2)} too much`}
          </p>
        </div>
      )}
      {needsCustomer && <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">Udhaar needs a customer. Close this and choose one.</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{error}</p>}
    </Modal>
  );
}

function HeldModal({ open, onClose, onResume, busy }) {
  const state = useAsync(() => (open ? api.get('/held-bills') : Promise.resolve(null)), [open]);
  const discard = async (id) => { await api.post(`/held-bills/${id}/discard`); state.reload(); };
  return (
    <Modal open={open} onClose={onClose} title="Held bills" size="md" footer={<Button variant="secondary" size="lg" onClick={onClose}>Close</Button>}>
      {state.loading && !state.data ? <Spinner className="mx-auto my-6 size-6" /> : !state.data || state.data.holds.length === 0 ? <EmptyState icon={PauseCircle} title="No held bills" hint="Tap Hold on a bill to park it here." /> : (
        <ul className="divide-y divide-line-soft">
          {state.data.holds.map((h) => (
            <li key={h.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><p className="truncate text-base font-semibold">{h.label || `Bill #${h.id}`}</p><p className="text-xs text-muted">{h.itemCount} item(s) · about {inr(h.estimatedTotal, 0)} · {dateTime(h.createdAt)}{h.createdByName ? ` · ${h.createdByName}` : ''}</p></div>
              <Button size="lg" loading={busy === h.id} onClick={() => onResume(h.id)}>Resume</Button>
              <Button size="lg" variant="secondary" aria-label={`Discard held bill ${h.id}`} onClick={() => discard(h.id)}><Trash2 className="size-5" /></Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ReturnModal({ open, onClose, onDone }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const found = useAsync(() => (open && dq.trim().length >= 2 ? api.get('/sales', { q: dq.trim(), limit: 8 }) : Promise.resolve(null)), [open, dq]);
  const [sale, setSale] = useState(null);
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState('changed_mind');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const attempt = useRef(null);
  useEffect(() => { if (open) { setQ(''); setSale(null); setQty({}); setReason('changed_mind'); setErr(''); setResult(null); attempt.current = null; } }, [open]);
  const pick = async (id) => { setErr(''); try { setSale(await api.get(`/sales/${id}`)); setQty({}); } catch (e) { setErr(e.message); } };
  const chosen = sale ? sale.items.filter((i) => parseFloat(qty[i.id]) > 0).map((i) => ({ saleItemId: i.id, quantity: parseFloat(qty[i.id]) })) : [];
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    // The key is tied to THIS return request: a double tap or a retry re-sends the same key and cannot refund twice.
    const sig = JSON.stringify([sale.id, chosen, reason]);
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: uuid() };
    try {
      const r = await api.post(`/sales/${sale.id}/returns`, { items: chosen, reason }, { idempotencyKey: attempt.current.key });
      setResult(r.return); setSale(r.sale); onDone(r.return);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Return items" size="lg"
      footer={result ? <Button size="lg" onClick={onClose}>Done</Button> : <><Button variant="secondary" size="lg" onClick={onClose}>Cancel</Button>{sale && <Button size="lg" disabled={!chosen.length} loading={busy} onClick={submit}>Return selected items</Button>}</>}>
      {result ? (
        <div role="status" className="space-y-2 text-base">
          <p className="flex items-center gap-2 font-bold text-ok"><CheckCircle2 className="size-6" aria-hidden="true" />Return recorded. Give back {inr(result.total, 2)}.</p>
          <ul className="text-sm">{result.refunds.map((r) => <li key={r.method}>{r.method === 'credit' ? 'Taken off udhaar' : `Refund by ${r.method.toUpperCase()}`}: <b className="num">{inr(r.amount, 2)}</b></li>)}</ul>
        </div>
      ) : !sale ? (
        <div>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden="true" /><Input aria-label="Find the bill by invoice number or customer" className="!h-12 pl-10 text-base" autoFocus placeholder="Invoice number or customer" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <ul className="mt-3 divide-y divide-line-soft">
            {found.data && found.data.rows.filter((r) => r.status === 'completed').map((r) => (
              <li key={r.id}><button className="flex w-full items-center justify-between py-3 text-left hover:bg-line-soft" onClick={() => pick(r.id)}><span><b>{r.invoiceNo}</b> <span className="text-xs text-muted">{dateTime(r.createdAt)}</span></span><span className="num font-semibold">{inr(r.total, 2)}</span></button></li>
            ))}
          </ul>
          {found.data && found.data.rows.filter((r) => r.status === 'completed').length === 0 && <p className="mt-3 text-sm text-muted">No returnable bill found. Fully returned bills do not appear here.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted"><b>{sale.invoiceNo}</b> · {inr(sale.total, 2)} · paid {sale.payments.map((p) => `${p.method.toUpperCase()} ${inr(p.amount, 0)}`).join(' + ')}</p>
          <ul className="divide-y divide-line-soft">
            {sale.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1"><p className="truncate text-base font-semibold">{i.name}</p><p className="text-xs text-muted num">Sold {i.quantity}{i.returnedQty > 0 ? ` · already returned ${i.returnedQty}` : ''}</p></div>
                {i.returnableQty > 0 ? <Input aria-label={`Return quantity of ${i.name}`} className="!h-12 !w-24 text-center text-lg" inputMode="decimal" placeholder={`0–${i.returnableQty}`} value={qty[i.id] || ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value.replace(/[^0-9.]/g, '') })} /> : <Badge>Returned</Badge>}
              </li>
            ))}
          </ul>
          <Select aria-label="Return reason" className="!h-12 text-base" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
      )}
      {err && <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm font-semibold text-bad">{err}</p>}
    </Modal>
  );
}

export default function Counter() {
  const { user } = useAuth();
  const searchRef = useRef(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 150);
  const products = useAsync(() => api.get('/products/pos-search', { q: dq }), [dq]);
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [held, setHeld] = useState(null);                  // { id, version, label } when the cart came from a held bill
  const [bill, setBill] = useState(null);
  const [msg, setMsg] = useState(null);
  const [paying, setPaying] = useState(false);
  const [payErr, setPayErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHeld, setShowHeld] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [resuming, setResuming] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [last, setLast] = useState(null);
  const heldCount = useAsync(() => api.get('/held-bills'), [showHeld, msg]);

  useEffect(() => { searchRef.current && searchRef.current.focus(); }, []);
  const items = useMemo(() => cart.map((c) => ({ productId: c.id, quantity: c.qty })), [cart]);
  const itemsKey = JSON.stringify(items);

  useEffect(() => {
    if (!cart.length) { setBill(null); return undefined; }
    let live = true;
    const t = setTimeout(() => { api.post('/sales/preview', { items }).then((b) => live && setBill(b)).catch((e) => { if (live) { setBill(null); setMsg({ type: 'err', text: e.message }); } }); }, 150);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const add = useCallback((p) => setCart((c) => {
    const ex = c.find((x) => x.id === p.id);
    if (ex) return ex.qty >= p.stock ? c : c.map((x) => (x.id === p.id ? { ...x, qty: x.qty + 1 } : x));
    return [...c, { id: p.id, name: p.name, price: p.price, stock: p.stock, qty: 1, unit: p.unit || 'pcs' }];
  }), []);
  const step = (id, d) => setCart((c) => c.flatMap((x) => (x.id !== id ? [x] : (x.qty + d <= 0 ? [] : [{ ...x, qty: Math.min(Math.round((x.qty + d) * 1000) / 1000, x.stock) }]))));
  // The barcode scanner types the code and presses Enter: an exact SKU match is added at once, otherwise the first match.
  const onKey = (e) => {
    if (e.key !== 'Enter' || !products.data || !products.data.rows.length) return;
    add(products.data.rows.find((p) => p.sku.toLowerCase() === q.trim().toLowerCase()) || products.data.rows[0]);
    setQ('');
  };
  const clear = () => { setCart([]); setCustomer(null); setHeld(null); setBill(null); searchRef.current && searchRef.current.focus(); };

  const hold = async () => {
    setBusy(true);
    try {
      const body = { items, customerId: customer ? customer.id : null, label: customer ? customer.name : (held && held.label) || null };
      const r = held ? await api.put(`/held-bills/${held.id}`, { ...body, version: held.version }) : await api.post('/held-bills', body, { idempotencyKey: uuid() });
      const h = r.hold;
      clear();
      setMsg({ type: 'ok', text: `Bill held${h.label ? ` for ${h.label}` : ''}. Nothing was sold or deducted.` });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  const resume = async (id) => {
    setResuming(id);
    try {
      const r = await api.post(`/held-bills/${id}/resume`);
      const live = await api.get('/products/pos-search', { q: '' }).catch(() => ({ rows: [] }));
      const byId = new Map(live.rows.map((p) => [p.id, p]));
      const bad = new Set(r.issues.filter((i) => i.severity !== 'info').map((i) => i.productId));
      setCart(r.hold.items.filter((i) => !bad.has(i.productId)).map((i) => { const p = byId.get(i.productId); return { id: i.productId, name: i.name, price: p ? p.price : i.unitPrice, stock: p ? p.stock : 9999, qty: Number(i.quantity), unit: p ? p.unit || 'pcs' : 'pcs' }; }));
      setCustomer(r.hold.customerId ? { id: r.hold.customerId, name: r.hold.customerName || 'Customer', phone: '' } : null);
      setHeld({ id: r.hold.id, version: r.hold.version, label: r.hold.label });
      setShowHeld(false);
      setMsg(r.issues.length ? { type: bad.size ? 'err' : 'ok', text: r.issues.map((i) => i.message).join(' ') + (bad.size ? ' Those items were taken off the bill.' : '') } : { type: 'ok', text: 'Held bill is back on the counter.' });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setResuming(null); }
  };

  // One idempotency key per payment attempt; the same key is reused on every retry of the SAME bill + payment, so a double tap cannot sell twice.
  const attempt = useRef(null);
  const pay = async (payment) => {
    if (busy) return;
    setBusy(true); setPayErr('');
    const sig = JSON.stringify([items, payment, customer && customer.id, held && held.id]);
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: uuid() };
    try {
      let sale;
      if (held) {
        // keep the server copy in step with any change made at the counter, then complete THAT cart
        const upd = await api.put(`/held-bills/${held.id}`, { items, customerId: customer ? customer.id : null, label: held.label || null, version: held.version });
        sale = await api.post(`/held-bills/${held.id}/complete`, payment, { idempotencyKey: attempt.current.key });
        void upd;
      } else {
        sale = await api.post('/sales', { items, customerId: customer ? customer.id : null, ...payment }, { idempotencyKey: attempt.current.key });
      }
      attempt.current = null;
      setPaying(false); clear(); setLast(sale); setReceipt(sale);
      setMsg({ type: 'ok', text: `Sale ${sale.invoiceNo} complete · ${inr(sale.total, 2)}.` });
      products.reload();
    } catch (e) { setPayErr(e.message); } finally { setBusy(false); }
  };

  const count = cart.reduce((a, c) => a + c.qty, 0);
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-extrabold">Counter <span className="text-sm font-medium text-muted">· {user && user.name}</span></h1>
        <Button size="lg" variant="secondary" onClick={() => { clear(); setMsg(null); }}><ShoppingCart className="size-5" aria-hidden="true" />New sale</Button>
        <Button size="lg" variant="secondary" onClick={() => setShowHeld(true)}><PauseCircle className="size-5" aria-hidden="true" />Held{heldCount.data && heldCount.data.holds.length > 0 ? ` (${heldCount.data.holds.length})` : ''}</Button>
        <Button size="lg" variant="secondary" onClick={() => setShowReturn(true)}><RotateCcw className="size-5" aria-hidden="true" />Return</Button>
        <Button size="lg" variant="secondary" disabled={!last} onClick={() => setReceipt(last)}><Printer className="size-5" aria-hidden="true" />Last receipt</Button>
      </div>
      <Banner msg={msg} onClose={() => setMsg(null)} />
      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Scan barcode or search product" placeholder="Scan barcode or type a product — Enter adds it"
              className="h-14 w-full rounded-xl border border-line bg-white pl-12 pr-4 text-lg focus:border-brand" />
          </div>
          {products.loading && !products.data ? <Spinner className="mx-auto my-10 size-7" /> : !products.data || products.data.rows.length === 0 ? <Card><EmptyState icon={Search} title="No product found" hint="Check the spelling or the code." /></Card> : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {products.data.rows.map((p) => (
                <li key={p.id}><button onClick={() => add(p)} className="flex h-full min-h-[96px] w-full flex-col justify-between rounded-xl border border-line bg-white p-3 text-left hover:border-brand hover:bg-brand-soft/40"><span className="line-clamp-2 text-base font-semibold leading-snug">{p.name}</span><span className="mt-2 flex items-end justify-between"><b className="text-xl num">{inr(p.price, 2)}</b><span className="text-xs text-muted num">{p.stock} left</span></span></button></li>
              ))}
            </ul>
          )}
        </div>
        <Card className="flex flex-col self-start lg:sticky lg:top-20">
          <div className="flex items-center justify-between border-b border-line px-4 py-3"><h2 className="font-bold">Bill{count > 0 && <Badge tone="info" className="ml-2">{count} items</Badge>}{held && <Badge tone="warn" className="ml-2">from held bill</Badge>}</h2>{cart.length > 0 && <Button variant="ghost" onClick={clear}>Clear</Button>}</div>
          <div className="max-h-[42vh] min-h-[110px] overflow-y-auto">
            {cart.length === 0 ? <EmptyState icon={ShoppingCart} title="Bill is empty" hint="Scan or tap a product." /> : (
              <ul className="divide-y divide-line-soft">
                {cart.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1"><p className="truncate text-base font-semibold">{c.name}</p><p className="text-xs text-muted num">{inr(c.price, 2)} × {c.qty}</p></div>
                    <button className="grid size-11 place-items-center rounded-lg border border-line" aria-label={`Less ${c.name}`} onClick={() => step(c.id, -1)}><Minus className="size-5" /></button>
                    <span className="w-8 text-center text-lg font-bold num">{c.qty}</span>
                    <button className="grid size-11 place-items-center rounded-lg border border-line" aria-label={`More ${c.name}`} onClick={() => step(c.id, 1)}><Plus className="size-5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-3 border-t border-line p-4">
            <CustomerPicker customer={customer} onChange={setCustomer} />
            <div className="flex items-baseline justify-between text-2xl font-extrabold num"><span>Total</span><span>{bill ? inr(bill.total, 2) : '₹0.00'}</span></div>
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <Button size="lg" variant="secondary" className="!h-14" disabled={!cart.length} loading={busy && !paying} onClick={hold}><PauseCircle className="size-5" aria-hidden="true" />Hold</Button>
              <Button size="lg" className="!h-14 text-lg" disabled={!cart.length || !bill} onClick={() => { setPayErr(''); setPaying(true); }}>Pay</Button>
            </div>
          </div>
        </Card>
      </div>
      <PayModal open={paying} total={bill ? bill.total : 0} customer={customer} busy={busy} error={payErr} onClose={() => setPaying(false)} onPay={pay} />
      <HeldModal open={showHeld} onClose={() => setShowHeld(false)} onResume={resume} busy={resuming} />
      <ReturnModal open={showReturn} onClose={() => setShowReturn(false)} onDone={(r) => setMsg({ type: 'ok', text: `Return recorded: ${inr(r.total, 2)} to give back.` })} />
      <InvoiceModal sale={receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}
