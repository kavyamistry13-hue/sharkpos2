import { useState } from 'react';
import { MessageCircle, Search, Wallet } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, CardHeader, DataTable, Field, Input, Modal, PageHeader, Select, Stat, Textarea } from '../components/ui';
import { dateTime, inr } from '../utils/format';

const BUCKETS = [['0-30', '0–30 days'], ['31-60', '31–60 days'], ['61-90', '61–90 days'], ['90+', '90+ days']];
const ENTRY = { sale: 'Credit sale', payment: 'Payment received', refund: 'Refund of credit sale', adjustment: 'Adjustment' };

function AccountModal({ id, onClose, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const acct = useAsync(() => api.get(`/credit/customers/${id}`), [id]);
  const [pay, setPay] = useState({ amount: '', method: 'cash', note: '' });
  const [limit, setLimit] = useState('');
  const [adj, setAdj] = useState({ amount: '', direction: 'decrease', note: '' });
  const [busy, setBusy] = useState('');
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toast.success(ok); acct.reload(); onChanged(); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const reminder = async (lang) => {
    try { const r = await api.get(`/credit/customers/${id}/reminder`, { lang }); window.open(r.link, '_blank', 'noopener'); toast.info('WhatsApp opened with the message ready. Nothing is sent until you press send.'); }
    catch (e) { toast.error(e.message); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={acct.data ? `${acct.data.name} · udhaar` : 'Udhaar account'} footer={<Button onClick={onClose}>Close</Button>}>
      <Async state={acct} rows={4}>
        {(a) => (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Owes you" value={inr(a.balance, 2)} tone={a.balance > 0 ? 'warn' : a.balance < 0 ? 'ok' : undefined} sub={a.balance < 0 ? 'Customer has paid in advance' : undefined} />
              <Stat label="Credit limit" value={a.enabled ? inr(a.creditLimit) : 'Not enabled'} />
              <Stat label="Still available" value={a.enabled ? inr(a.available, 2) : '—'} />
            </div>
            <div>
              <p className="mb-1.5 text-sm font-semibold">How old is the money owed? <span className="font-normal text-muted">(oldest bills are paid first)</span></p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{BUCKETS.map(([k, l]) => <div key={k} className="rounded-lg border border-line p-2.5"><p className="text-xs text-muted">{l}</p><p className="font-bold num">{inr((a.aging.buckets || {})[k] || 0, 2)}</p></div>)}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={a.balance <= 0} onClick={() => reminder('en')}><MessageCircle className="size-4" aria-hidden="true" />WhatsApp reminder</Button>
              <Button variant="secondary" size="sm" disabled={a.balance <= 0} onClick={() => reminder('hi')}><MessageCircle className="size-4" aria-hidden="true" />WhatsApp (हिंदी)</Button>
            </div>
            <form className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); run('pay', () => api.post(`/credit/customers/${id}/payments`, { amount: Number(pay.amount), method: pay.method, note: pay.note || undefined }).then(() => setPay({ amount: '', method: 'cash', note: '' })), 'Payment recorded.'); }}>
              <Field label="Payment received (₹)"><Input inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
              <Field label="Paid by"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></Select></Field>
              <Field label="Note (optional)" className="sm:col-span-2"><Input value={pay.note} maxLength={300} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></Field>
              <div className="sm:col-span-4"><Button type="submit" size="sm" loading={busy === 'pay'} disabled={!(Number(pay.amount) > 0)}><Wallet className="size-4" aria-hidden="true" />Record payment</Button></div>
            </form>
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); run('limit', () => api.put(`/credit/customers/${id}/limit`, { creditLimit: Number(limit) }), 'Credit limit updated.'); }}>
              <Field label="Set credit limit (₹) — 0 turns udhaar off" hint={`Currently ${inr(a.creditLimit)}`}><Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
              <Button type="submit" size="sm" variant="secondary" loading={busy === 'limit'} disabled={limit === ''}>Save limit</Button>
            </form>
            {user.role === 'business_owner' && (
              <details className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer text-sm font-semibold">Owner adjustment (opening balance, write-off, correction)</summary>
                <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); run('adj', () => api.post(`/credit/customers/${id}/adjustments`, { amount: Number(adj.amount), direction: adj.direction, note: adj.note }).then(() => setAdj({ amount: '', direction: 'decrease', note: '' })), 'Adjustment recorded.'); }}>
                  <Field label="Amount (₹)"><Input inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
                  <Field label="Effect"><Select value={adj.direction} onChange={(e) => setAdj({ ...adj, direction: e.target.value })}><option value="decrease">Owes less (write-off)</option><option value="increase">Owes more (old notebook)</option></Select></Field>
                  <Field label="Reason (required)" className="sm:col-span-3"><Textarea rows={2} value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
                  <div className="sm:col-span-3"><Button type="submit" size="sm" variant="secondary" loading={busy === 'adj'} disabled={!(Number(adj.amount) > 0) || adj.note.trim().length < 3}>Record adjustment</Button></div>
                </form>
              </details>
            )}
            <div>
              <p className="mb-1.5 text-sm font-semibold">History</p>
              {a.history.length === 0 ? <p className="text-sm text-muted">No entries yet.</p> : (
                <ul className="divide-y divide-line-soft text-sm">{a.history.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-3 py-2">
                    <div><p className="font-medium">{ENTRY[h.type] || h.type}{h.invoiceNo ? ` · ${h.invoiceNo}` : ''}{h.method ? ` · ${h.method.toUpperCase()}` : ''}</p><p className="text-xs text-muted">{dateTime(h.createdAt)}{h.by ? ` · ${h.by}` : ''}{h.note ? ` · ${h.note}` : ''}</p></div>
                    <p className={`num font-semibold ${h.effect > 0 ? 'text-warn' : 'text-ok'}`}>{h.effect > 0 ? '+' : '−'}{inr(h.amount, 2)}</p>
                  </li>))}</ul>
              )}
            </div>
          </div>
        )}
      </Async>
    </Modal>
  );
}

function FindCustomer({ onPick }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const res = useAsync(() => (dq.trim().length >= 2 ? api.get('/customers/search', { q: dq }) : Promise.resolve(null)), [dq]);
  const rows = (res.data && (res.data.rows || res.data.customers)) || [];
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">Give udhaar to a customer</p>
      <p className="mb-2 text-xs text-muted">Find the customer, then set a credit limit. Until a limit is set, the till will not allow udhaar for them.</p>
      <Input aria-label="Find customer" placeholder="Type a name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
      {rows.length > 0 && <ul className="mt-2 divide-y divide-line-soft text-sm">{rows.map((c) => <li key={c.id}><button className="flex w-full justify-between py-2 text-left hover:bg-canvas" onClick={() => onPick(c.id)}><span className="font-medium">{c.name}</span><span className="text-muted num">{c.phone}</span></button></li>)}</ul>}
    </Card>
  );
}

export default function Udhaar() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const sum = useAsync(() => api.get('/credit/summary'), []);
  const list = useAsync(() => api.get('/credit/customers', { q: dq }), [dq]);
  const [open, setOpen] = useState(null);
  const refresh = () => { sum.reload(); list.reload(); };
  const cols = [
    { key: 'name', header: 'Customer', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted num">{r.phone}</p></div> },
    { key: 'bal', header: 'Owes', align: 'right', render: (r) => <span className="num font-semibold">{inr(r.balance, 2)}</span> },
    { key: 'age', header: 'Oldest bill', render: (r) => r.oldestDays === null ? '—' : <Badge tone={r.overdue ? 'bad' : 'neutral'}>{r.oldestDays} days{r.overdue ? ' · overdue' : ''}</Badge> },
    { key: 'lim', header: 'Limit', align: 'right', render: (r) => <span className="num">{r.creditLimit > 0 ? inr(r.creditLimit) : 'Off'}</span> },
    { key: 'last', header: 'Last payment', render: (r) => (r.lastPaymentAt ? dateTime(r.lastPaymentAt) : '—') },
  ];
  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <PageHeader title="Udhaar (credit)" subtitle="Who owes you, since when, and a free WhatsApp reminder you send yourself." />
      <Async state={sum} rows={2}>
        {(s) => (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total outstanding" value={inr(s.outstanding, 0)} icon={Wallet} />
            <Stat label="Customers owing" value={s.debtors} />
            <Stat label="Overdue" value={inr(s.overdueAmount, 0)} tone={s.overdueAmount > 0 ? 'bad' : undefined} sub={`${s.overdueCustomers} customer${s.overdueCustomers === 1 ? '' : 's'} past ${s.overdueDays} days`} />
            <Stat label="Collected, last 30 days" value={inr(s.collectedLast30Days || 0, 0)} tone="ok" sub={`Given: ${inr(s.givenLast30Days || 0, 0)}`} />
          </div>
        )}
      </Async>
      <Card>
        <CardHeader title="Customers with udhaar" subtitle="Click a row for the ledger, payments and reminders." />
        <div className="relative mx-4 mb-3 w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" /><Input className="pl-9" aria-label="Search" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Async state={list} rows={5}>{(rows) => <DataTable columns={cols} rows={rows.rows} rowKey="customerId" onRowClick={(r) => setOpen(r.customerId)} />}</Async>
      </Card>
      <FindCustomer onPick={setOpen} />
      <p className="text-xs text-muted">Reminders open WhatsApp with the message typed; nothing is sent automatically.</p>
      {open && <AccountModal id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
    </div>
  );
}
