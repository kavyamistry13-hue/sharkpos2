import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Async, Badge, Card, CardHeader, DataTable, PageHeader, Stat, Tabs } from '../components/ui';
import { ActionRow, SEV_TONE, TodayList } from '../components/TodayList';
import { inr, num, pct } from '../utils/format';

const CATS = [['all', 'All'], ['stock', 'Stock'], ['money', 'Money'], ['suppliers', 'Suppliers'], ['profit', 'Profit'], ['operations', 'Operations']];

function ActionCenter() {
  const [cat, setCat] = useState('all');
  const ac = useAsync(() => api.get('/intelligence/actions', cat === 'all' ? { limit: 100 } : { category: cat, limit: 100 }), [cat]);
  return (
    <Card>
      <CardHeader title="Action Center" subtitle="Everything that needs you, ranked by urgency and rupee impact." />
      <div className="px-5"><Tabs value={cat} onChange={setCat} tabs={CATS.map(([v, l]) => ({ value: v, label: l, count: ac.data && ac.data.counts ? (v === 'all' ? Object.values(ac.data.counts).reduce((a, b) => a + b, 0) : ac.data.counts[v]) : undefined }))} /></div>
      <Async state={ac} rows={5}>
        {(d) => d.actions.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">Nothing here needs attention.</p> : (
          <div className="px-5 pb-4">
            <ul className="divide-y divide-line-soft">{d.actions.map((a) => <ActionRow key={a.id} a={a} />)}</ul>
            {d.warnings && d.warnings.length > 0 && <p className="mt-2 text-xs text-warn">Some checks could not run: {d.warnings.join('; ')}</p>}
            <p className="mt-3 text-xs text-muted">{d.method} Score: {d.scoring}.</p>
          </div>
        )}
      </Async>
    </Card>
  );
}

function Cash() {
  const inv = useAsync(() => api.get('/intelligence/inventory-cash'), []);
  return (
    <Async state={inv} rows={4}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Stock value (at cost)" value={inr(d.totalValue, 0)} sub={`${d.stockedProducts} products in stock`} />
            <Stat label="Cash trapped" value={inr(d.trappedCash, 0)} tone={d.trappedCash > 0 ? 'warn' : 'ok'} sub={`${pct(d.trappedPct, 1)} of stock value`} />
            <Stat label="Dead stock" value={inr(d.buckets.dead.value, 0)} sub={`${d.buckets.dead.products} products`} />
            <Stat label="Excess stock" value={inr(d.buckets.overstock.trappedExcess || 0, 0)} sub={`${d.buckets.overstock.products} products overstocked`} />
          </div>
          <Card><CardHeader title="Where the cash is trapped" subtitle="Largest first." />
            <DataTable rows={d.topTrapped} rowKey="productId" empty={<p className="px-5 pb-4 text-sm text-muted">No trapped stock.</p>} columns={[
              { key: 'n', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted">{r.action}</p></div> },
              { key: 'b', header: 'Why', render: (r) => <Badge tone={r.bucket === 'overstock' ? 'warn' : 'bad'}>{r.bucket === 'overstock' ? 'Excess' : r.bucket === 'expired' ? 'Expired' : 'Dead'}</Badge> },
              { key: 's', header: 'Stock', align: 'right', render: (r) => num(r.stock, 2) },
              { key: 'l', header: 'Last sale', render: (r) => (r.daysSinceLastSale === null ? 'Never' : `${r.daysSinceLastSale} days ago`) },
              { key: 'v', header: 'Trapped', align: 'right', render: (r) => <span className="num font-semibold">{inr(r.trappedValue, 0)}</span> }]} /></Card>
          <Card><CardHeader title="By category" /><DataTable rows={d.byCategory} rowKey="category" columns={[{ key: 'c', header: 'Category', render: (r) => r.category }, { key: 'v', header: 'Stock value', align: 'right', render: (r) => <span className="num">{inr(r.value, 0)}</span> }, { key: 'p', header: 'Share', align: 'right', render: (r) => pct(r.pct, 1) }]} /></Card>
          <p className="text-xs text-muted">{d.basis}</p>
        </div>
      )}
    </Async>
  );
}

function Dead() {
  const d = useAsync(() => api.get('/intelligence/dead-stock'), []);
  return (
    <Card><CardHeader title="Dead stock" subtitle="Products with stock that have not sold." />
      <Async state={d} rows={4}>
        {(x) => (<>
          <DataTable rows={x.rows} rowKey="productId" empty={<p className="px-5 pb-4 text-sm text-muted">No dead stock. Everything on the shelf has sold recently.</p>} columns={[
            { key: 'n', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted">{r.category}{r.supplier ? ` · ${r.supplier}` : ''}</p></div> },
            { key: 's', header: 'Stock', align: 'right', render: (r) => num(r.stock, 2) },
            { key: 'l', header: 'Last sold', render: (r) => (r.expired ? <Badge tone="bad">Expired</Badge> : r.lastSoldOn ? `${r.daysSinceLastSale} days ago` : `Never (added ${r.daysSinceAdded} days ago)`) },
            { key: 'v', header: 'At cost', align: 'right', render: (r) => <span className="num font-semibold">{inr(r.stockValue, 0)}</span> },
            { key: 'a', header: 'Suggested step', render: (r) => <span className="text-xs text-muted">{r.action}</span> }]} />
          <p className="px-5 py-3 text-xs text-muted">{x.basis}</p>
        </>)}
      </Async>
    </Card>
  );
}

function Leaks() {
  const d = useAsync(() => api.get('/intelligence/profit-leaks'), []);
  return (
    <Async state={d} rows={4}>
      {(x) => (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Findings" value={x.summary.findings} tone={x.summary.findings ? 'warn' : 'ok'} />
            <Stat label="Realised loss" value={inr(x.summary.realizedLoss, 0)} tone={x.summary.realizedLoss ? 'bad' : undefined} sub={`Last ${x.windowDays} days, from saved sale costs`} />
            <Stat label="Discounts given" value={inr(x.summary.discountsGiven, 0)} sub={`${x.summary.discountPct}% of sales · ${x.summary.discountedBills} of ${x.summary.bills} bills`} />
          </div>
          <Card><CardHeader title="Profit leaks" subtitle="Selling below cost, thin margins, unpassed cost rises and discount outliers." />
            {x.leaks.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">No leaks found.</p> : <ul className="divide-y divide-line-soft px-5 pb-3">{x.leaks.map((l, i) => <ActionRow key={i} a={{ ...l, route: l.productId ? '/products' : undefined, cta: 'Fix price' }} />)}</ul>}</Card>
          {x.notes.map((n) => <p key={n} className="text-xs text-muted">{n}</p>)}
        </div>
      )}
    </Async>
  );
}

function Suppliers() {
  const d = useAsync(() => api.get('/intelligence/suppliers'), []);
  return (
    <Async state={d} rows={4}>
      {(x) => (
        <div className="space-y-5">
          <Card><CardHeader title="Supplier scorecard" subtitle={`Last ${x.windowDays} days. A supplier is judged only after enough completed orders.`} />
            <DataTable rows={x.suppliers} rowKey="supplierId" empty={<p className="px-5 pb-4 text-sm text-muted">No suppliers yet.</p>} columns={[
              { key: 'n', header: 'Supplier', render: (r) => <div><p className="font-semibold">{r.name}</p>{r.note && <p className="text-xs text-muted">{r.note}</p>}</div> },
              { key: 'o', header: 'Done orders', align: 'right', render: (r) => r.completedOrders },
              { key: 't', header: 'On time', align: 'right', render: (r) => (r.enoughData ? pct(r.onTimePct, 0) : '—') },
              { key: 'f', header: 'Filled', align: 'right', render: (r) => (r.enoughData ? pct(r.fillRatePct, 0) : '—') },
              { key: 'r', header: 'Rejected', align: 'right', render: (r) => (r.enoughData ? pct(r.rejectionPct, 1) : '—') },
              { key: 's', header: 'Spend', align: 'right', render: (r) => <span className="num">{inr(r.spend, 0)}</span> }]} /></Card>
          <Card><CardHeader title="What to do about suppliers" />
            {x.actions.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">Nothing to act on.</p> : <ul className="divide-y divide-line-soft px-5 pb-3">{x.actions.map((a, i) => <ActionRow key={i} a={{ ...a, cta: 'Purchasing' }} />)}</ul>}</Card>
        </div>
      )}
    </Async>
  );
}

export default function Intelligence() {
  const [tab, setTab] = useState('today');
  const today = useAsync(() => api.get('/intelligence/today', { top: 7 }), []);
  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <PageHeader title="Action Center" subtitle="What to do today, where your cash is stuck, and where profit leaks. Rule-based on your own data — not AI or machine learning." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'today', label: 'What should I do today?' }, { value: 'all', label: 'All actions' }, { value: 'cash', label: 'Cash in stock' }, { value: 'dead', label: 'Dead stock' }, { value: 'leaks', label: 'Profit leaks' }, { value: 'sup', label: 'Suppliers' }]} />
      {tab === 'today' && <Card><CardHeader title="What should I do today?" subtitle="Your top priorities, most important first." /><Async state={today} rows={5}>{(d) => <TodayList data={d} />}</Async></Card>}
      {tab === 'all' && <ActionCenter />}
      {tab === 'cash' && <Cash />}
      {tab === 'dead' && <Dead />}
      {tab === 'leaks' && <Leaks />}
      {tab === 'sup' && <Suppliers />}
    </div>
  );
}
