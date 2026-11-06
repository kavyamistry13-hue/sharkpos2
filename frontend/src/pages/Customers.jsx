import { useState } from 'react';
import { Lightbulb, Plus, Search, Users } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, Card, DataTable, EmptyState, Field, Input, Modal, PageHeader, Segmented, Select } from '../components/ui';
import { dateOnly, inr, cap } from '../utils/format';

const SEG_TONE = { vip: 'info', regular: 'ok', new: 'warn', inactive: 'neutral' };

function CustomerModal({ id, onClose }) {
  const state = useAsync(() => api.get(`/customers/${id}`), [id]);
  return (
    <Modal open onClose={onClose} title={state.data ? state.data.name : 'Customer'} footer={<Button onClick={onClose}>Close</Button>}>
      <Async state={state} rows={4}>
        {(c) => (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={SEG_TONE[c.segment]} dot>{cap(c.segment)}</Badge><span className="text-sm text-muted num">{c.phone}</span></div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[['Total spending', inr(c.spending)], ['Orders', c.orders], ['Average order', inr(c.avgOrderValue)], ['Favourite category', c.favoriteCategory || '—'], ['Last purchase', c.lastPurchase ? dateOnly(c.lastPurchase) : '—'], ['Purchase frequency', c.purchaseFrequency]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5 font-bold num">{v}</dd></div>
              ))}
            </dl>
            <div className="flex gap-3 rounded-lg bg-brand-soft p-3.5 text-sm"><Lightbulb className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" /><div><p className="font-semibold">Suggested next step</p><p className="mt-0.5">{c.insight}</p><p className="mt-1.5 text-xs text-muted">Based only on purchase history: spend, frequency, recency and categories.</p></div></div>
            {c.topCategories.length > 0 && <div><p className="mb-1.5 text-sm font-semibold">Top categories by spend</p><ul className="space-y-1 text-sm">{c.topCategories.map((t) => <li key={t.name} className="flex justify-between"><span>{t.name}</span><span className="num">{inr(t.spend)}</span></li>)}</ul></div>}
          </div>
        )}
      </Async>
    </Modal>
  );
}

export default function Customers() {
  const toast = useToast();
  const [segment, setSegment] = useState('all');
  const [sort, setSort] = useState('spending');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useAsync(() => api.get('/customers', { segment, sort, q: dq, limit: 100 }), [segment, sort, dq]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  const c = list.data && list.data.counts;

  const add = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api.post('/customers', { ...form, email: form.email || null }); toast.success(`${r.name} added.`); setAdding(false); setForm({ name: '', phone: '', email: '' }); list.reload(); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Customers" subtitle="Who buys, how often and what they like, from purchase history." actions={<Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden="true" />Add customer</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="max-w-full overflow-x-auto"><Segmented label="Segment" value={segment} onChange={setSegment} options={[{ value: 'all', label: 'All', count: c && c.all }, { value: 'vip', label: 'VIP', count: c && c.vip }, { value: 'regular', label: 'Regular', count: c && c.regular }, { value: 'new', label: 'New', count: c && c.new }, { value: 'inactive', label: 'Inactive', count: c && c.inactive }]} /></div>
          <div className="relative ml-auto w-full sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" /><Input className="pl-9" aria-label="Search customers" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="!w-44"><option value="spending">Sort: spending</option><option value="orders">Sort: orders</option><option value="recent">Sort: most recent</option><option value="name">Sort: name</option></Select>
        </div>
        <Async state={list} rows={6} errorText="Unable to load customers.">
          {(d) => <DataTable rows={d.rows} onRowClick={(r) => setOpen(r.id)} columns={[
            { key: 'name', header: 'Customer', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted num">{r.phone}</p></div> },
            { key: 'spending', header: 'Total spending', align: 'right', render: (r) => <span className="font-semibold">{inr(r.spending)}</span> },
            { key: 'orders', header: 'Orders', align: 'right' },
            { key: 'aov', header: 'Avg order', align: 'right', render: (r) => inr(r.avgOrderValue) },
            { key: 'fav', header: 'Favourite', render: (r) => r.favoriteCategory || '—' },
            { key: 'last', header: 'Last purchase', render: (r) => (r.lastPurchase ? dateOnly(r.lastPurchase) : '—') },
            { key: 'freq', header: 'Frequency', render: (r) => r.purchaseFrequency },
            { key: 'seg', header: 'Segment', render: (r) => <Badge tone={SEG_TONE[r.segment]} dot>{cap(r.segment)}</Badge> },
          ]} empty={<EmptyState icon={Users} title="No customers here" hint="Customers added at the POS or here will show up with their purchase history." />} />}
        </Async>
      </Card>
      {open && <CustomerModal id={open} onClose={() => setOpen(null)} />}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add customer" size="sm" footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="add-cust" loading={busy}>Save customer</Button></>}>
        <form id="add-cust" onSubmit={add} className="space-y-3">
          <Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Phone number"><Input required inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email (optional)"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </form>
      </Modal>
    </div>
  );
}
