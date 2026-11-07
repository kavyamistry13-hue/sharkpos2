import { useState } from 'react';
import { CheckCircle2, Printer } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Badge, Button, Card, CardHeader, DataTable, Field, Input, PageHeader, Stat, Textarea } from '../components/ui';
import { dateTime, inr, num } from '../utils/format';

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function Reconcile({ r, onSaved }) {
  const toast = useToast();
  const c = r.cash;
  const [actual, setActual] = useState('');
  const [opening, setOpening] = useState(String(c.openingCash));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const expected = Math.round((Number(opening || 0) + c.netCashMovement) * 100) / 100;
  const variance = actual === '' ? null : Math.round((Number(actual) - expected) * 100) / 100;
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.post('/reports/cash-reconciliations', { date: r.date, openingCash: Number(opening || 0), actualCash: Number(actual), notes: notes || undefined }); toast.success('Cash count saved.'); setActual(''); setNotes(''); onSaved(); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Count the cash drawer" subtitle="Expected cash is worked out by the server: opening + cash sales + cash udhaar payments − cash refunds." />
      <form onSubmit={save} className="grid gap-3 p-4 pt-0 sm:grid-cols-3">
        <Field label="Opening cash (₹)" hint={c.openingIsSuggested ? 'Suggested from the last count' : 'From the saved count'}><Input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
        <Field label="Expected in drawer"><p className="flex h-10 items-center text-lg font-bold num">{inr(expected, 2)}</p></Field>
        <Field label="Counted cash (₹)"><Input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
        {variance !== null && <p className={`sm:col-span-3 text-sm font-semibold num ${variance === 0 ? 'text-ok' : 'text-bad'}`}>{variance === 0 ? 'Cash matches exactly.' : variance > 0 ? `Over by ${inr(variance, 2)}` : `Short by ${inr(-variance, 2)}`}</p>}
        <Field label={variance ? 'Why is it different? (required)' : 'Note (optional)'} className="sm:col-span-3"><Textarea rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="sm:col-span-3"><Button type="submit" loading={busy} disabled={actual === '' || (variance !== 0 && variance !== null && notes.trim().length < 3)}><CheckCircle2 className="size-4" aria-hidden="true" />Save cash count</Button></div>
      </form>
      {c.reconciliation && <p className="border-t border-line px-4 py-3 text-sm text-muted">Latest count: {inr(c.reconciliation.actualCash, 2)} against {inr(c.reconciliation.expectedCash, 2)} expected (variance {inr(c.reconciliation.variance, 2)}) by {c.reconciliation.reconciledBy || '—'} · {dateTime(c.reconciliation.createdAt)}. A new count does not erase the old one; both stay in the history.</p>}
    </Card>
  );
}

export default function Closing() {
  const [date, setDate] = useState(today());
  const rep = useAsync(() => api.get('/reports/closing', { date }), [date]);
  const hist = useAsync(() => api.get('/reports/cash-reconciliations', { limit: 30 }), []);
  const saved = () => { rep.reload(); hist.reload(); };
  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PageHeader title="Closing report & cash" subtitle="End-of-day numbers and a cash count that records any difference."
        actions={<><Input type="date" aria-label="Report date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} className="!w-44" /><Button variant="secondary" onClick={() => window.print()}><Printer className="size-4" aria-hidden="true" />Print</Button></>} />
      <Async state={rep} rows={5}>
        {(r) => (
          <>
            <p className="text-xs text-muted">{r.basis}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Bills" value={num(r.sales.count)} sub={`Average ${inr(r.sales.avgBill, 0)}`} />
              <Stat label="Billed total" value={inr(r.sales.billedTotal, 0)} sub={`Discounts ${inr(r.sales.discounts, 0)} · Tax ${inr(r.sales.tax, 0)}`} />
              <Stat label="Refunds" value={inr(r.refunds.amount, 0)} tone={r.refunds.amount > 0 ? 'warn' : undefined} sub={`${r.refunds.count} refund${r.refunds.count === 1 ? '' : 's'}`} />
              <Stat label="Gross profit" value={inr(r.sales.grossProfit, 0)} tone="ok" sub="From the cost saved on each sale" />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card><CardHeader title="How customers paid" /><DataTable rows={r.payments} rowKey="method" columns={[{ key: 'm', header: 'Method', render: (x) => x.method.toUpperCase() }, { key: 'c', header: 'Bills', align: 'right', render: (x) => num(x.count) }, { key: 'a', header: 'Amount', align: 'right', render: (x) => <span className="num">{inr(x.amount, 2)}</span> }]} />
                <p className="px-5 py-3 text-sm text-muted">Udhaar given today: <b className="num">{inr(r.credit.given, 2)}</b> · collected: <b className="num">{inr(r.credit.collected, 2)}</b> · total outstanding: <b className="num">{inr(r.credit.outstandingTotal, 2)}</b></p></Card>
              <Card><CardHeader title="Cash movement" />
                <dl className="space-y-2 p-5 pt-0 text-sm num">
                  {[['Opening cash', r.cash.openingCash], ['+ Cash sales', r.cash.cashSales], ['+ Cash udhaar payments', r.cash.cashCreditPayments], ['− Cash refunds', r.cash.cashRefunds]].map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted">{k}</dt><dd>{inr(v, 2)}</dd></div>)}
                  <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold"><dt>Expected in drawer</dt><dd>{inr(r.cash.expectedCash, 2)}</dd></div>
                </dl></Card>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card><CardHeader title="Cashiers" /><DataTable rows={r.cashiers} rowKey="name" empty={<p className="px-5 pb-4 text-sm text-muted">No sales.</p>} columns={[{ key: 'n', header: 'Cashier', render: (x) => x.name }, { key: 'b', header: 'Bills', align: 'right', render: (x) => x.bills }, { key: 't', header: 'Total', align: 'right', render: (x) => <span className="num">{inr(x.total, 0)}</span> }, { key: 'c', header: 'Cash', align: 'right', render: (x) => <span className="num">{inr(x.cash, 0)}</span> }]} /></Card>
              <Card><CardHeader title="Top products" /><DataTable rows={r.topProducts} rowKey="name" empty={<p className="px-5 pb-4 text-sm text-muted">No sales.</p>} columns={[{ key: 'n', header: 'Product', render: (x) => x.name }, { key: 'u', header: 'Units', align: 'right', render: (x) => num(x.units, 2) }, { key: 'r', header: 'Revenue', align: 'right', render: (x) => <span className="num">{inr(x.revenue, 0)}</span> }]} /></Card>
            </div>
            <Card className="p-4 text-sm"><p className="font-semibold">Stock today</p><p className="mt-1 text-muted">{num(r.inventory.unitsSold, 2)} units sold · {num(r.inventory.stockReceivedUnits, 2)} received ({inr(r.inventory.stockReceivedValue, 0)}) · {r.inventory.lowStockNow} low · {r.inventory.outOfStockNow} out of stock · stock value {inr(r.inventory.stockValueNow, 0)} at cost</p></Card>
            {r.isToday || <p className="text-xs text-muted">Showing a past day. Cash counts for past days can still be recorded.</p>}
            <Reconcile key={`${r.date}-${r.cash.reconciliation ? r.cash.reconciliation.id : 0}`} r={r} onSaved={saved} />
          </>
        )}
      </Async>
      <Card>
        <CardHeader title="Cash count history" subtitle="Every count is kept. The latest count for a day is the one that applies." />
        <Async state={hist} rows={3}>{(h) => <DataTable rows={h.rows} columns={[
          { key: 'd', header: 'Date', render: (x) => x.date }, { key: 'e', header: 'Expected', align: 'right', render: (x) => <span className="num">{inr(x.expectedCash, 2)}</span> },
          { key: 'a', header: 'Counted', align: 'right', render: (x) => <span className="num">{inr(x.actualCash, 2)}</span> },
          { key: 'v', header: 'Variance', align: 'right', render: (x) => <Badge tone={x.variance === 0 ? 'ok' : 'bad'}>{inr(x.variance, 2)}</Badge> },
          { key: 'b', header: 'By', render: (x) => x.reconciledBy || '—' }, { key: 'n', header: 'Note', render: (x) => x.notes || '—' }]} empty={<p className="px-5 pb-4 text-sm text-muted">No counts yet.</p>} />}</Async>
      </Card>
    </div>
  );
}
