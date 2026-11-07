import { useState } from 'react';
import { Receipt, Search, Undo2 } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Input, PageHeader, Pagination, RiskBadge, Select } from '../components/ui';
import { InvoiceModal } from '../components/Invoice';
import { dateTime, inr, cap } from '../utils/format';

const STATUS_TONE = { completed: 'ok', refunded: 'warn', cancelled: 'neutral' };

export default function Sales() {
  const { user, isRole } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [payment, setPayment] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useAsync(() => api.get('/sales', { q: dq, from, to, payment, status, page, limit: 20 }), [dq, from, to, payment, status, page]);
  const [open, setOpen] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const [busy, setBusy] = useState(false);

  const view = async (r) => { try { setOpen(await api.get(`/sales/${r.id}`)); } catch (e) { toast.error(e.message); } };
  const refund = async () => {
    setBusy(true);
    try { const s = await api.post(`/sales/${open.id}/refund`); setOpen(s); setRefunding(false); toast.success(`Refund recorded for ${s.invoiceNo}. Stock returned.`); list.reload(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const mgr = isRole('business_owner', 'manager');
  const columns = [
    { key: 'inv', header: 'Invoice', render: (r) => <div><p className="font-semibold num">{r.invoiceNo}</p><p className="text-xs text-muted">{dateTime(r.createdAt)}</p></div> },
    { key: 'who', header: 'Cashier', render: (r) => <div><p>{r.employee}</p><p className="text-xs text-muted">{r.customer || 'Walk-in'}</p></div> },
    { key: 'items', header: 'Items', align: 'right' },
    { key: 'discount', header: 'Discount', align: 'right', render: (r) => (r.discount > 0 ? inr(r.discount, 2) : '—') },
    { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="font-semibold">{inr(r.total, 2)}</span> },
    { key: 'pay', header: 'Payment', render: (r) => (r.paymentMethod === 'credit' ? 'UDHAAR' : r.paymentMethod.toUpperCase()) },
    { key: 'status', header: 'Status', render: (r) => <div className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[r.status]} dot>{cap(r.status)}</Badge>{mgr && r.riskSeverity && <RiskBadge level={r.riskSeverity} />}</div> },
  ];

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Sales" subtitle={user.role === 'cashier' ? 'Your transactions.' : 'Every transaction across the store.'} />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" /><Input className="pl-9" aria-label="Search invoice or customer" placeholder="Invoice or customer" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
          <Input type="date" aria-label="From date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <Input type="date" aria-label="To date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          <Select aria-label="Payment method" value={payment} onChange={(e) => { setPayment(e.target.value); setPage(1); }}><option value="">All payments</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="credit">Udhaar</option></Select>
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option value="completed">Completed</option><option value="refunded">Refunded</option><option value="cancelled">Cancelled</option></Select>
        </div>
        <Async state={list} rows={6} errorText="Unable to load sales.">
          {(d) => (
            <>
              <DataTable rows={d.rows} columns={columns} onRowClick={view} empty={<EmptyState icon={Receipt} title="No sales found" hint="Change the filters, or complete a sale in POS." />} />
              <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
      <InvoiceModal sale={open} onClose={() => setOpen(null)} footerExtra={open && mgr && open.status === 'completed' ? <Button variant="danger" onClick={() => setRefunding(true)}><Undo2 className="size-4" aria-hidden="true" />Refund</Button> : null} />
      <ConfirmDialog open={refunding} onClose={() => setRefunding(false)} danger loading={busy} title="Refund this sale?" confirmLabel="Refund in full" onConfirm={refund}
        message={open ? `${inr(open.total, 2)} will be marked as refunded and the items go back into stock. Refunds are scored for risk.` : ''} />
    </div>
  );
}
