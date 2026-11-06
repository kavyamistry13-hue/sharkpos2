import { useState } from 'react';
import { ChevronDown, Eye, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, Card, EmptyState, PageHeader, RiskBadge, Segmented, Stat, cx } from '../components/ui';
import { InvoiceModal } from '../components/Invoice';
import { dateTime, inr, cap } from '../utils/format';

function AlertCard({ a, onStatus, onView }) {
  const [open, setOpen] = useState(false);
  const tone = a.severity === 'critical' || a.severity === 'high' ? 'bg-bad' : a.severity === 'medium' ? 'bg-[#c98500]' : 'bg-ok';
  return (
    <Card className={cx('overflow-hidden', a.status !== 'open' && 'opacity-75')}>
      <div className={cx('h-1', tone)} />
      <div className="grid gap-4 p-5 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">Transaction #{a.saleId}</h3><RiskBadge level={a.severity} />{a.status !== 'open' && <Badge tone="neutral">{cap(a.status)}</Badge>}</div>
          <p className="mt-0.5 text-sm text-muted">{a.employee} · {a.invoiceNo} · {dateTime(a.createdAt)}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Bill (before discount, tax)</dt><dd className="font-bold num">{inr(a.bill, 2)}</dd></div>
            <div><dt className="text-xs text-muted">{a.saleStatus === 'refunded' ? 'Refunded' : 'Discount'}</dt><dd className="font-bold num">{inr(a.saleStatus === 'refunded' ? a.refundAmount : a.discount, 2)}</dd></div>
            {a.normalDiscountRange && <div><dt className="text-xs text-muted">Normal discount range</dt><dd className="font-bold num">{inr(a.normalDiscountRange[0])}–{inr(a.normalDiscountRange[1])}</dd></div>}
            <div><dt className="text-xs text-muted">Paid</dt><dd className="font-bold">{a.paymentMethod.toUpperCase()}</dd></div>
          </dl>
          <p className="mt-3 text-sm"><span className="font-semibold">Reason: </span>{a.reason}</p>
          <p className="mt-1 text-sm"><span className="font-semibold">Recommended action: </span>{a.recommendedAction}</p>
          <button className="mt-3 flex items-center gap-1 text-sm font-semibold text-brand" onClick={() => setOpen(!open)} aria-expanded={open}>Why flagged?<ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} /></button>
          {open && (
            <ul className="mt-2 space-y-2 rounded-lg bg-canvas p-3">
              {a.factors.map((f) => (
                <li key={f.key} className="text-sm"><div className="flex justify-between gap-3"><span className="font-semibold">{f.label}</span><span className="font-bold num">+{f.points} pts</span></div><p className="text-muted">{f.detail}</p></li>
              ))}
              <li className="border-t border-line pt-2 text-sm font-bold">Total risk score: {a.riskScore} / 100</li>
              <li className="text-xs text-muted">Rule-based scoring against the cashier’s own history and store averages. Not a machine-learning model.</li>
            </ul>
          )}
        </div>
        <div className="flex flex-row items-center gap-4 md:flex-col md:items-end">
          <div className="text-center md:text-right"><p className="text-4xl font-extrabold leading-none num">{a.riskScore}<span className="text-lg text-muted">%</span></p><p className="mt-1 text-xs text-muted">Risk score</p></div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button size="sm" variant="secondary" onClick={() => onView(a)}><Eye className="size-4" aria-hidden="true" />Invoice</Button>
            {a.status === 'open' ? <>
              <Button size="sm" variant="success" onClick={() => onStatus(a, 'reviewed')}><ShieldCheck className="size-4" aria-hidden="true" />Mark reviewed</Button>
              <Button size="sm" variant="ghost" onClick={() => onStatus(a, 'dismissed')}><ShieldOff className="size-4" aria-hidden="true" />Dismiss</Button>
            </> : <Button size="sm" variant="ghost" onClick={() => onStatus(a, 'open')}>Reopen</Button>}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function Risk() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const state = useAsync(() => api.get('/risk/alerts', { status: status === 'all' ? undefined : status, limit: 60 }), [status]);
  const [invoice, setInvoice] = useState(null);
  const setAlert = async (a, s) => { try { await api.post(`/risk/alerts/${a.id}/status`, { status: s }); toast.success(s === 'open' ? 'Alert reopened.' : s === 'reviewed' ? `Transaction #${a.saleId} marked reviewed.` : `Alert for #${a.saleId} dismissed.`); state.reload(); } catch (e) { toast.error(e.message); } };
  const view = async (a) => { try { setInvoice(await api.get(`/risk/alerts/${a.id}/sale`)); } catch (e) { toast.error(e.message); } };
  const sum = state.data && state.data.summary;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PageHeader title="Transaction Risk Center" subtitle="Unusual discounts, refunds, bill sizes and cashier behaviour, scored by transparent rules." />
      {sum && <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Open alerts" value={sum.open} tone={sum.open ? 'bad' : 'ok'} /><Stat label="Critical" value={sum.critical} tone={sum.critical ? 'bad' : undefined} /><Stat label="High" value={sum.high} /><Stat label="Medium" value={sum.medium} tone="warn" /></div>}
      <Segmented label="Alert status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'all', label: 'All' }]} />
      <Async state={state} rows={3} errorText="Unable to load risk alerts.">
        {(d) => d.rows.length === 0 ? <Card><EmptyState icon={ShieldCheck} title="No transactions to review" hint="Nothing has been flagged in this view." /></Card> : <div className="space-y-4">{d.rows.map((a) => <AlertCard key={a.id} a={a} onStatus={setAlert} onView={view} />)}</div>}
      </Async>
      <InvoiceModal sale={invoice} onClose={() => setInvoice(null)} />
    </div>
  );
}
