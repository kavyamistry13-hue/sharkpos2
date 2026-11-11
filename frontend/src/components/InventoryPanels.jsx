import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, PackageCheck, ShoppingCart } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { Async, Badge, Button, Card, CardHeader, DataTable, EmptyState, Input, Pagination, Segmented, Stat } from './ui';
import { inr, num } from '../utils/format';
import { StatusBadge } from './StockTools';

const when = (d) => (d.daysToExpiry < 0 ? `${Math.abs(d.daysToExpiry)} days ago` : d.daysToExpiry === 0 ? 'today' : `in ${d.daysToExpiry} days`);

/** Products at or below their reorder level, with the suggested quantity. A recommendation only: nothing is ordered from here. */
export function ReorderTab({ onAdjust, onHistory }) {
  const state = useAsync(() => api.get('/inventory/reorder'), []);
  return (
    <Async state={state} rows={4} errorText="Unable to load the reorder list.">
      {(d) => (
        <>
          <div className={`mb-4 flex flex-wrap items-center gap-3 rounded-xl border px-5 py-3.5 ${d.count ? 'border-warn/40 bg-warn-soft' : 'border-line bg-white'}`} data-testid="reorder-message">
            {d.count ? <ShoppingCart className="size-5 text-warn" aria-hidden="true" /> : <PackageCheck className="size-5 text-ok" aria-hidden="true" />}
            <p className="text-sm font-bold">{d.message}</p>
            {d.count > 0 && <p className="text-sm text-muted">Suggested quantities are advice — no purchase order is created for you.</p>}
            {d.count > 0 && <Link to="/purchasing" className="ml-auto text-sm font-semibold text-brand">Go to Purchasing →</Link>}
          </div>
          <Card>
            <DataTable rows={d.rows} columns={[
              { key: 'name', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted">{r.supplier || 'No supplier'}</p></div> },
              { key: 'stock', header: 'Stock', align: 'right', render: (r) => <span className="font-bold num">{r.stock} {r.unit}</span> },
              { key: 'min', header: 'Min', align: 'right', render: (r) => <span className="num">{r.minimumStock}</span> },
              { key: 'reo', header: 'Reorder at', align: 'right', render: (r) => <span className="num">{r.reorderLevel ?? <span className="text-muted">= min</span>}</span> },
              { key: 'max', header: 'Max', align: 'right', render: (r) => <span className="num">{r.maxStock ?? <span className="text-muted">—</span>}</span> },
              { key: 'sug', header: 'Suggested order', align: 'right', render: (r) => <span className="font-bold text-brand num">{r.suggestedReorderQty} {r.unit}</span> },
              { key: 'on', header: 'On order', align: 'right', render: (r) => (r.onOrder ? <span className="num">{r.onOrder}</span> : <span className="text-muted">—</span>) },
              { key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', render: (r) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => onHistory(r)}>History</Button><Button size="sm" variant="secondary" onClick={() => onAdjust(r)}>Adjust</Button></div> },
            ]} empty={<EmptyState icon={PackageCheck} title="Nothing needs restocking right now" hint="Products appear here when stock reaches the reorder level (or the minimum stock if no reorder level is set)." />} />
          </Card>
        </>
      )}
    </Async>
  );
}

const WITHIN = [{ value: 'expired', label: 'Expired' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All' }];

/** Batches and legacy product-level expiry dates. Products that have no expiry are never listed. */
export function ExpiryTab() {
  const [within, setWithin] = useState('30');
  const state = useAsync(() => api.get('/inventory/expiry', { within }), [within]);
  const d = state.data;
  return (
    <>
      {d && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Expired" tone="bad" value={d.counts.expired} sub="batches / products" />
          <Stat label="Within 7 days" tone="warn" value={d.counts.within7} />
          <Stat label="Within 30 days" value={d.counts.within30} />
          <Stat label="Within 90 days" value={d.counts.within90} />
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
          <Segmented label="Expiry window" value={within} onChange={setWithin} options={WITHIN} />
          {d && <p className="text-sm text-muted">Value at risk: <span className="font-bold text-text num">{inr(d.rows.reduce((a, r) => a + r.atRiskValue, 0), 2)}</span> at cost</p>}
        </div>
        <Async state={state} rows={4} errorText="Unable to load expiry data.">
          {(x) => <DataTable rowKey="key" rows={x.rows.map((r) => ({ ...r, key: `${r.source}-${r.batchId || r.productId}` }))} columns={[
            { key: 'name', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted num">{r.sku}</p></div> },
            { key: 'batch', header: 'Batch', render: (r) => (r.batchNo ? <span className="num">{r.batchNo}</span> : <span className="text-xs text-muted">Product-level date</span>) },
            { key: 'exp', header: 'Expires', render: (r) => <div><p className="num">{r.expiryDate}</p><p className="text-xs text-muted">{when(r)}</p></div> },
            { key: 'qty', header: 'Quantity', align: 'right', render: (r) => <span className="font-semibold num">{r.quantity} {r.unit}</span> },
            { key: 'val', header: 'Value at risk', align: 'right', render: (r) => <span className="num">{inr(r.atRiskValue, 2)}</span> },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.daysToExpiry < 0 ? 'expired' : r.daysToExpiry <= 7 ? 'within7' : r.daysToExpiry <= 30 ? 'within30' : 'within90'} /> },
          ]} empty={<EmptyState icon={PackageCheck} title="Nothing in this window" hint="Only products with an expiry date or batch are listed — expiry is optional." />} />}
        </Async>
      </Card>
    </>
  );
}

/** Every batch with stock left. "Sells next" marks the batch FEFO will take first for that product. */
export function BatchesTab({ onAddBatch }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q, 250); const [page, setPage] = useState(1);
  const state = useAsync(() => api.get('/inventory/batches', { q: dq.trim(), page, limit: 25 }), [dq, page]);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <Input aria-label="Search batches" className="max-w-xs" placeholder="Search product, SKU or batch no." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <p className="text-xs text-muted">FEFO: sales take the earliest-expiry batch first. Expired batches are never sold.</p>
      </div>
      <Async state={state} rows={4} errorText="Unable to load batches.">
        {(d) => (
          <>
            <DataTable rows={d.rows} columns={[
              { key: 'name', header: 'Product', render: (r) => <div><p className="font-semibold">{r.name}</p><p className="text-xs text-muted num">{r.sku}</p></div> },
              { key: 'batch', header: 'Batch', render: (r) => <span className="num font-semibold">{r.batchNo}</span> },
              { key: 'mfg', header: 'Manufactured', render: (r) => r.manufacturedDate || <span className="text-muted">—</span> },
              { key: 'exp', header: 'Expires', render: (r) => (r.expiryDate ? <span className="num">{r.expiryDate}</span> : <span className="text-muted">No expiry</span>) },
              { key: 'qty', header: 'On hand', align: 'right', render: (r) => <span className="font-semibold num">{r.onHand} <span className="text-xs text-muted">/ {r.received}</span></span> },
              { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'fefo', header: 'FEFO', render: (r) => (r.sellsNext ? <Badge tone="ok" dot>Sells next</Badge> : r.status === 'expired' ? <Badge tone="bad">Not sold</Badge> : <span className="text-xs text-muted">#{r.fefoRank} in line</span>) },
            ]} empty={<EmptyState icon={Boxes} title="No batches yet" hint="Batches are created when you receive goods with a batch number or expiry, or add a batch from a product. Products without batches work as before." />} />
            <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
          </>
        )}
      </Async>
    </Card>
  );
}
export { num, CardHeader };
