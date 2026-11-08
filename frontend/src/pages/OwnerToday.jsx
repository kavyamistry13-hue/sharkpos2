import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, CheckCircle2, HeartPulse, Receipt, TrendingUp, Users, Wallet, Zap } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Async, Badge, Card, CardHeader, PageHeader, Stat } from '../components/ui';
import { TodayList } from '../components/TodayList';
import { inr } from '../utils/format';

// Every figure is tagged so the owner can tell a fact from a guess. The wording comes from the server (`kinds`).
const KIND = {
  actual: { label: 'Actual', tone: 'ok' },
  estimated: { label: 'Estimated', tone: 'warn' },
  forecast: { label: 'Forecast', tone: 'info' },
  recommendation: { label: 'Recommendation', tone: 'neutral' },
};
export function KindTag({ kind, kinds }) {
  const k = KIND[kind];
  return k ? <span title={kinds && kinds[kind]}><Badge tone={k.tone}>{k.label}</Badge></span> : null;
}
const SEV = { critical: 'bad', high: 'bad', medium: 'warn', low: 'neutral' };

function Business({ d }) {
  const b = d.business;
  const change = b.vsYesterday.changePct;
  return (
    <section aria-labelledby="biz-h">
      <h2 id="biz-h" className="mb-3 text-base font-bold">1 · Today’s business</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Banknote} label="Sales (net)" value={inr(b.sales.value)} sub={<><KindTag kind="actual" kinds={d.kinds} /> {change === null ? 'No sales yesterday to compare.' : `${change > 0 ? '+' : ''}${change}% vs yesterday`}</>} />
        <Stat icon={TrendingUp} label="Gross profit" value={inr(b.grossProfit.value)} sub={<><KindTag kind="estimated" kinds={d.kinds} /> {b.grossProfit.note}</>} />
        <Stat icon={Receipt} label="Bills" value={b.bills.value} sub={<><KindTag kind="actual" kinds={d.kinds} /> Average {inr(b.avgBill.value)}{b.refunds.count > 0 ? ` · ${b.refunds.count} return(s) ${inr(b.refunds.value)}` : ''}</>} />
        <Stat icon={Users} label="Customers" value={b.customers.known + b.customers.walkIn} sub={<><KindTag kind="actual" kinds={d.kinds} /> {b.customers.known} known, {b.customers.walkIn} walk-in bills</>} />
      </div>
      <Card className="mt-3">
        <CardHeader title="How customers paid" subtitle="A split bill counts under each method it was paid with." action={<KindTag kind="actual" kinds={d.kinds} />} />
        <div className="px-5 pb-4">
          {b.payments.length === 0 ? <p className="text-sm text-muted">No payments yet today.</p> : (
            <ul className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              {b.payments.map((p) => <li key={p.method}><span className="text-muted">{p.method === 'credit' ? 'Udhaar' : p.method.toUpperCase()}</span> <b className="num">{inr(p.amount)}</b> <span className="text-xs text-muted">({p.count})</span></li>)}
            </ul>
          )}
        </div>
      </Card>
    </section>
  );
}

function Attention({ d }) {
  return (
    <section aria-labelledby="attn-h">
      <h2 id="attn-h" className="mb-3 text-base font-bold">2 · Needs your attention</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {d.needsAttention.map((x) => {
          const quiet = x.count === 0 || (!x.severity && x.key !== 'credit');
          return (
            <Card key={x.key} className={quiet ? '' : 'border-warn/40'}>
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-semibold">{quiet ? <CheckCircle2 className="size-4 text-ok" aria-hidden="true" /> : <AlertTriangle className="size-4 text-warn" aria-hidden="true" />}{x.label}</p>
                  {x.severity && <Badge tone={SEV[x.severity]} dot>{x.severity}</Badge>}
                </div>
                <p className="mt-2 text-sm text-muted">{x.detail}</p>
                {x.items && x.items.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted">{x.items.map((t, i) => <li key={i}>{t}</li>)}</ul>}
                {!quiet && <Link to={x.to} className="mt-3 inline-block text-sm font-semibold text-brand hover:underline">Open</Link>}
              </div>
            </Card>
          );
        })}
      </div>
      {d.forecast.stockoutRiskProducts > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm"><KindTag kind="forecast" kinds={d.kinds} /> {d.forecast.stockoutRiskProducts} more product(s) may run out soon{d.forecast.items.length ? `: ${d.forecast.items.map((i) => i.name).join(', ')}` : ''}. {d.forecast.note}</p>
      )}
    </section>
  );
}

export default function OwnerToday() {
  const state = useAsync(() => api.get('/intelligence/owner-today', { top: 5 }), []);
  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <PageHeader title="Today" subtitle="What should I pay attention to today? Facts first, then what SHARKPOS suggests." actions={<Link to="/intelligence" className="text-sm font-semibold text-brand hover:underline">All actions</Link>} />
      <Async state={state} rows={6}>
        {(d) => (
          <>
            <Business d={d} />
            <Attention d={d} />
            <section aria-labelledby="rec-h">
              <h2 id="rec-h" className="mb-3 flex items-center gap-2 text-base font-bold">3 · SHARKPOS recommends <KindTag kind="recommendation" kinds={d.kinds} /></h2>
              <Card><TodayList data={d.recommendations} /></Card>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Card><div className="flex items-center gap-3 p-4 text-sm"><HeartPulse className="size-5 text-brand" aria-hidden="true" /><div><p className="font-semibold">Store health: {d.health && d.health.score !== null ? `${d.health.score}/100` : 'not enough data yet'}</p><p className="text-xs text-muted">{d.health ? d.health.summary : 'Unavailable right now.'} <Link to="/value" className="font-semibold text-brand hover:underline">Details</Link></p></div></div></Card>
                <Card><div className="flex items-center gap-3 p-4 text-sm"><Wallet className="size-5 text-brand" aria-hidden="true" /><div><p className="font-semibold">Verified value, last {d.value ? d.value.days : 90} days: {d.value ? inr(d.value.verifiedTotal) : '—'}</p><p className="text-xs text-muted"><KindTag kind="actual" kinds={d.kinds} /> {d.value ? d.value.note : 'Unavailable right now.'}</p></div></div></Card>
              </div>
            </section>
            {d.warnings.length > 0 && <p className="flex items-center gap-2 text-xs text-warn"><Zap className="size-4" aria-hidden="true" />Some checks could not run: {d.warnings.join('; ')}</p>}
          </>
        )}
      </Async>
    </div>
  );
}
