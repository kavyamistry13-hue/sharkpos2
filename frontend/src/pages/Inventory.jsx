import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Boxes, Check, Sparkles, X, Info, PackageCheck } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, Card, CardHeader, DataTable, EmptyState, Field, Input, Meter, Modal, PageHeader, Segmented, Stat, StockBadge, Tabs } from '../components/ui';
import { inr, num, pct, dateTime } from '../utils/format';

const FILTERS = [
  { value: '', label: 'All' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }, { value: 'over', label: 'Overstocked' },
  { value: 'fast', label: 'Fast-moving' }, { value: 'slow', label: 'Slow-moving' }, { value: 'expiring', label: 'Expiring' },
];

function RiskCell({ p }) {
  const tone = p.riskLevel === 'high' ? 'bad' : p.riskLevel === 'medium' ? 'warn' : 'ok';
  return <div className="min-w-[110px]"><div className="mb-1 flex justify-between text-xs"><span className="font-semibold num">{pct(p.stockoutRisk * 100)}</span><span className="text-muted capitalize">{p.riskLevel}</span></div><Meter value={p.stockoutRisk * 100} tone={tone} /></div>;
}

function ForecastModal({ productId, onClose, onRestock }) {
  const f = useAsync(() => api.get(`/ai/forecast/${productId}`), [productId]);
  const d = f.data;
  return (
    <Modal open onClose={onClose} title={d ? d.product.name : 'Demand forecast'} size="md"
      footer={d && d.recommendedQty > 0 ? <><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => onRestock(productId)}><Sparkles className="size-4" aria-hidden="true" />AI Restock</Button></> : <Button onClick={onClose}>Close</Button>}>
      <Async state={f} rows={4}>
        {(x) => (
          <div className="space-y-4">
            <div className={`rounded-lg p-3.5 text-sm font-semibold ${x.riskLevel === 'high' ? 'bg-bad-soft text-bad' : x.riskLevel === 'medium' ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}>{x.message}</div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[['Current stock', x.product.stock], ['Average daily sales', x.avgDailySales], ['Forecast per day', x.forecastDaily], ['Next 7 days', x.projected7], ['Days until stockout', x.daysToStockout ?? '—'], ['Stockout risk', pct(x.stockoutRisk * 100)], ['Lead time', `${x.product.leadTimeDays} days`], ['Safety stock', x.safetyStock], ['Recommended order', x.recommendedQty ? `${x.recommendedQty} units` : 'None']].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5 text-lg font-bold num">{v}</dd></div>
              ))}
            </dl>
            {x.reasons.length > 0 && <div><p className="mb-1.5 text-sm font-semibold">Why this recommendation?</p><ul className="list-disc space-y-1 pl-5 text-sm text-muted">{x.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
            <p className="flex gap-2 rounded-lg bg-canvas p-3 text-xs text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{x.method}</p>
          </div>
        )}
      </Async>
    </Modal>
  );
}

function RestockTab({ onChanged, focusId }) {
  const toast = useToast();
  const state = useAsync(() => api.get('/ai/restock'), []);
  const [detail, setDetail] = useState(null);
  const [approving, setApproving] = useState(focusId ? { id: focusId } : null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);

  const openApprove = (r) => { setApproving(r); setQty(String(r.recommendedQty)); };
  const approve = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/ai/restock/${approving.id}/approve`, { quantity: parseFloat(qty) });
      toast.success(`Restock approved: ${r.quantity} ${r.unit && r.unit !== 'pcs' ? r.unit : 'units'} of ${r.product}. Expected in ${r.expectedInDays} days.`);
      setApproving(null); state.reload(); onChanged();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const dismiss = async (r) => {
    try { await api.post(`/ai/restock/${r.id}/dismiss`); toast.info(`${r.name} dismissed for 24 hours.`); state.reload(); onChanged(); } catch (e) { toast.error(e.message); }
  };

  return (
    <Async state={state} rows={4} errorText="Unable to load restock recommendations.">
      {(d) => d.rows.length === 0 ? <Card><EmptyState icon={PackageCheck} title="No restocking needed" hint="Stock covers forecast demand for every supplier lead time." /></Card> : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-5 py-3.5">
            <Sparkles className="size-5 text-brand" aria-hidden="true" />
            <p className="text-sm"><span className="font-bold">{d.count} products</span> need ordering, about <span className="font-bold num">{inr(d.totalCost)}</span> at purchase cost. Quantities come from the forecast engine; you approve or dismiss each one.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {d.rows.map((r) => (
              <Card key={r.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="text-xs font-semibold text-brand">AI restock recommendation</p><h3 className="truncate text-lg font-bold">{r.name}</h3><p className="text-xs text-muted">{r.supplier || 'No supplier'} · {r.leadTimeDays}-day lead time</p></div>
                  <Badge tone={r.riskLevel === 'high' ? 'bad' : r.riskLevel === 'medium' ? 'warn' : 'ok'} dot>{r.riskLevel === 'high' ? 'High stockout risk' : r.riskLevel === 'medium' ? 'Medium risk' : 'Low risk'}</Badge>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div><dt className="text-xs text-muted">In stock</dt><dd className="text-lg font-bold num">{r.stock}</dd></div>
                  <div><dt className="text-xs text-muted">Sells per day</dt><dd className="text-lg font-bold num">{r.avgDailySales}</dd></div>
                  <div><dt className="text-xs text-muted">Recommended</dt><dd className="text-lg font-bold text-brand num">{r.recommendedQty} units</dd></div>
                </dl>
                <p className="mt-3 text-sm text-muted">{r.reasons[0]} {r.reasons[1]}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="success" onClick={() => openApprove(r)}><Check className="size-4" aria-hidden="true" />Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => dismiss(r)}><X className="size-4" aria-hidden="true" />Dismiss</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDetail(r.id)}>View details</Button>
                </div>
              </Card>
            ))}
          </div>
          <Modal open={!!approving && !!approving.name} onClose={() => setApproving(null)} title="Approve restock order" size="sm"
            footer={<><Button variant="secondary" onClick={() => setApproving(null)}>Cancel</Button><Button variant="success" loading={busy} onClick={approve}>Approve order</Button></>}>
            {approving && approving.name && <div className="space-y-3"><p className="text-sm text-muted">Order <span className="font-semibold text-text">{approving.name}</span> from {approving.supplier || 'the supplier'}. Estimated cost {inr(approving.estimatedCost)}.</p>
              <Field label={`Quantity (${approving.unit || 'units'})`} hint={`Recommended: ${approving.recommendedQty}`}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))} /></Field></div>}
          </Modal>
          {detail && <ForecastModal productId={detail} onClose={() => setDetail(null)} onRestock={(id) => { setDetail(null); openApprove(d.rows.find((x) => x.id === id)); }} />}
        </>
      )}
    </Async>
  );
}

function OrdersTab({ onChanged }) {
  const toast = useToast();
  const state = useAsync(() => api.get('/inventory/restock-orders'), []);
  const receive = async (o) => {
    try { await api.post(`/inventory/restock-orders/${o.id}/receive`); toast.success(`${o.quantity} ${o.unit && o.unit !== 'pcs' ? o.unit : 'units'} of ${o.product} received. Stock updated.`); state.reload(); onChanged(); }
    catch (e) { toast.error(e.message); }
  };
  return (
    <Card>
      <CardHeader title="Restock orders" subtitle="Approved orders stay open until the goods arrive." />
      <Async state={state} rows={3}>
        {(d) => <DataTable rows={d.rows} columns={[
          { key: 'product', header: 'Product', render: (o) => <div><p className="font-semibold">{o.product}</p><p className="text-xs text-muted">{o.supplier || '—'}</p></div> },
          { key: 'quantity', header: 'Quantity', align: 'right' },
          { key: 'createdAt', header: 'Approved', render: (o) => dateTime(o.createdAt) },
          { key: 'po', header: 'Purchase order', render: (o) => (o.purchaseOrder ? <Link className="text-brand underline" to="/purchasing">{o.purchaseOrder.poNumber}</Link> : <span className="text-muted">—</span>) },
          { key: 'status', header: 'Status', render: (o) => <Badge tone={o.status === 'received' ? 'ok' : 'info'} dot>{o.status === 'received' ? 'Received' : 'On order'}</Badge> },
          { key: 'act', header: <span className="sr-only">Action</span>, align: 'right', render: (o) => o.status === 'approved' ? (o.purchaseOrder ? <Link className="text-sm font-medium text-brand" to="/purchasing">Receive on the PO</Link> : <Button size="sm" variant="secondary" onClick={() => receive(o)}>Mark received</Button>) : null },
        ]} empty={<EmptyState icon={Boxes} title="No restock orders yet" hint="Approve a recommendation in AI Restock to create one." />} />}
      </Async>
    </Card>
  );
}

function AlertsTab() {
  const state = useAsync(() => api.get('/inventory/alerts'), []);
  const groups = [['critical', 'Critical', 'bad'], ['warning', 'Warning', 'warn'], ['info', 'Information', 'info']];
  return (
    <Async state={state} rows={4}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-3">
          {groups.map(([k, label, tone]) => (
            <Card key={k}>
              <CardHeader title={label} action={<Badge tone={tone}>{d.counts[k]}</Badge>} />
              {d.alerts.filter((a) => a.severity === k).length === 0 ? <EmptyState title="All clear" /> : (
                <ul className="max-h-[520px] divide-y divide-line-soft overflow-y-auto">{d.alerts.filter((a) => a.severity === k).map((a, i) => <li key={i} className="px-5 py-2.5 text-sm">{a.message}</li>)}</ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </Async>
  );
}

function ExpiryTab() {
  const state = useAsync(() => api.get('/inventory', { filter: 'expiring' }), []);
  return (
    <Async state={state} rows={4}>
      {(d) => {
        const e = d.summary.expiring;
        const cards = [['Expired', e.expired, 'bad'], ['Expiring within 7 days', e.within7, 'warn'], ['Expiring within 30 days', e.within30, 'info']];
        return (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">{cards.map(([label, x, tone]) => <Stat key={label} label={label} tone={tone} value={`${x.products} products`} sub={`${num(x.units)} units · ${inr(x.value)} at cost`} />)}</div>
            <Card><DataTable rows={d.rows.filter((r) => r.expiryStatus).sort((a, b) => a.daysToExpiry - b.daysToExpiry)} columns={[
              { key: 'name', header: 'Product', render: (r) => <span className="font-semibold">{r.name}</span> },
              { key: 'stock', header: 'Units', align: 'right' },
              { key: 'value', header: 'Value', align: 'right', render: (r) => inr(r.stockValue) },
              { key: 'exp', header: 'Expires', render: (r) => r.daysToExpiry < 0 ? `${Math.abs(r.daysToExpiry)} days ago` : `in ${r.daysToExpiry} days` },
              { key: 'st', header: 'Status', render: (r) => <Badge tone={r.expiryStatus === 'expired' ? 'bad' : r.expiryStatus === 'within7' ? 'warn' : 'info'} dot>{r.expiryStatus === 'expired' ? 'Expired' : r.expiryStatus === 'within7' ? 'Expiring soon' : 'Within 30 days'}</Badge> },
            ]} empty={<EmptyState title="Nothing is close to expiry" />} /></Card>
          </>
        );
      }}
    </Async>
  );
}

export default function Inventory() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'overview';
  const [filter, setFilter] = useState(params.get('filter') || '');
  const [detail, setDetail] = useState(null);
  const [restockFocus, setRestockFocus] = useState(null);
  const inv = useAsync(() => api.get('/inventory', { filter }), [filter]);
  const restockCount = useAsync(() => api.get('/ai/restock'), []);
  const refresh = () => { inv.reload(); restockCount.reload(); };
  const setView = (v) => setParams(v === 'overview' ? {} : { view: v });
  const s = inv.data && inv.data.summary;

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Inventory" subtitle="Stock health, demand forecasts and restocking, based on recent sales." />
      {s && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Stock value" value={inr(s.stockValue)} sub={`${num(s.totalUnits)} units at cost`} />
          <Stat label="Healthy" value={s.healthy} tone="ok" sub="Products with enough cover" />
          <Stat label="Warning" value={s.warning} tone="warn" sub="Watch these" />
          <Stat label="Critical" value={s.critical} tone="bad" sub="Act now" />
          <Stat label="Overstocked" value={s.overstocked} sub="More than 60 days of cover" />
          <Stat label="Slow-moving" value={s.slow} sub={`${inr(s.slowValue)} tied up`} />
        </div>
      )}
      <Tabs value={view} onChange={setView} tabs={[
        { value: 'overview', label: 'Stock overview' },
        { value: 'restock', label: 'AI Restock', count: restockCount.data ? restockCount.data.count : undefined },
        { value: 'orders', label: 'Restock orders' },
        { value: 'alerts', label: 'Alerts' },
        { value: 'expiry', label: 'Expiry' },
      ]} />

      {view === 'overview' && (
        <Card>
          <div className="overflow-x-auto border-b border-line p-4"><Segmented label="Filter products" value={filter} onChange={setFilter} options={FILTERS} /></div>
          <Async state={inv} rows={6} errorText="Unable to load inventory.">
            {(d) => <DataTable rows={d.rows.slice(0, 60)} onRowClick={(r) => setDetail(r.id)} columns={[
              { key: 'name', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted">{r.category}</p></div> },
              { key: 'stock', header: 'Stock', align: 'right', render: (r) => <div><p className="font-semibold">{r.stock}</p><p className="text-xs text-muted">min {r.minimumStock}</p></div> },
              { key: 'avg', header: 'Avg sales/day', align: 'right', render: (r) => <div><p>{r.avgDailySales}</p>{r.trendPct !== 0 && <p className={`text-xs ${r.trendPct > 0 ? 'text-ok' : 'text-muted'}`}>{r.trendPct > 0 ? '+' : ''}{r.trendPct}% this week</p>}</div> },
              { key: 'days', header: 'Days left', align: 'right', render: (r) => r.daysToStockout ?? '—' },
              { key: 'risk', header: 'Stockout risk', render: (r) => <RiskCell p={r} /> },
              { key: 'status', header: 'Status', render: (r) => <StockBadge status={r.stockStatus} /> },
              { key: 'rec', header: 'Restock', align: 'right', render: (r) => r.recommendedQty > 0 ? <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setRestockFocus(r.id); setView('restock'); }}><Sparkles className="size-3.5 text-brand" aria-hidden="true" />{r.recommendedQty}</Button> : <span className="text-muted">—</span> },
            ]} empty={<EmptyState icon={Boxes} title="No products in this view" />} />}
          </Async>
          {inv.data && inv.data.rows.length > 60 && <p className="border-t border-line px-5 py-3 text-xs text-muted">Showing the 60 highest-risk products of {inv.data.rows.length}.</p>}
        </Card>
      )}
      {view === 'restock' && <RestockTab onChanged={refresh} focusId={restockFocus} />}
      {view === 'orders' && <OrdersTab onChanged={refresh} />}
      {view === 'alerts' && <AlertsTab />}
      {view === 'expiry' && <ExpiryTab />}
      {detail && <ForecastModal productId={detail} onClose={() => setDetail(null)} onRestock={() => { setDetail(null); setView('restock'); }} />}
    </div>
  );
}
