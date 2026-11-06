import { Link } from 'react-router-dom';
import { Banknote, ReceiptText, PackageSearch, AlertTriangle, TrendingUp, ShieldAlert, ArrowUpRight, ArrowDownRight, ChevronRight } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Async, Badge, Card, CardHeader, EmptyState, Meter, PageHeader, Stat, RiskBadge } from '../components/ui';
import { DailyBrief } from '../components/Brief';
import OnboardingCard from '../components/OnboardingCard';
import { TrendChart, RankBars } from '../components/charts';
import { inr, num, pct, dateTime } from '../utils/format';

function Delta({ value, basis }) {
  if (value === null || value === undefined) return <span>No comparison yet</span>;
  const Up = value >= 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`inline-flex items-center gap-1 font-semibold ${value >= 0 ? 'text-ok' : 'text-bad'}`}><Up className="size-3.5" aria-hidden="true" />{Math.abs(value)}% <span className="font-normal text-muted">vs {basis}</span></span>;
}

export default function Dashboard() {
  const overview = useAsync(() => api.get('/analytics/overview'), []);
  const brief = useAsync(() => api.get('/ai/brief'), []);
  const restock = useAsync(() => api.get('/ai/restock'), []);
  const alerts = useAsync(() => api.get('/risk/alerts', { status: 'open', limit: 3 }), []);
  const invAlerts = useAsync(() => api.get('/inventory/alerts'), []);

  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <PageHeader title="Dashboard" subtitle="Live view of today’s trading, stock and risk." />
      <OnboardingCard />
      <DailyBrief state={brief} />

      <Async state={overview} rows={3} errorText="Unable to load today’s numbers.">
        {(o) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat icon={Banknote} label="Today’s revenue" value={inr(o.kpis.revenue)} sub={<Delta value={o.comparison.revenueChangePct} basis={o.comparison.basis} />} />
              <Stat icon={ReceiptText} label="Orders" value={num(o.kpis.orders)} sub={<Delta value={o.comparison.ordersChangePct} basis={o.comparison.basis} />} />
              <Stat icon={PackageSearch} label="Products" value={num(o.kpis.products)} sub="Active in catalogue" />
              <Link to="/inventory?filter=low" className="block focus-visible:rounded-xl"><Stat icon={AlertTriangle} tone="warn" label="Low stock" value={num(o.kpis.lowStock)} sub="At or below minimum" /></Link>
              <Stat icon={TrendingUp} label="Estimated profit" value={inr(o.kpis.estimatedProfit)} sub="Before tax, after discounts" />
              <Link to="/risk" className="block focus-visible:rounded-xl"><Stat icon={ShieldAlert} tone={o.kpis.riskAlerts ? 'bad' : 'ok'} label="Risk alerts" value={num(o.kpis.riskAlerts)} sub="Transactions to review" /></Link>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader title="Sales by hour today" subtitle={`Revenue so far, up to ${o.localTime}`} />
                <div className="px-3 pb-4">
                  {o.hourly.length ? <TrendChart data={o.hourly} variant="bar" series={[{ key: 'revenue', name: 'Revenue', format: inr }]} height={250} /> : <EmptyState title="No sales yet today" hint="Create a sale in POS and it will appear here." />}
                </div>
              </Card>
              <Card>
                <CardHeader title="Top sellers today" subtitle="Units sold" />
                <div className="px-3 pb-4">
                  {o.topToday.length ? <RankBars data={o.topToday} valueKey="units" name="Units" height={230} nameWidth={140} /> : <EmptyState title="No sales yet" />}
                </div>
              </Card>
            </div>
          </>
        )}
      </Async>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Stockout watchlist" subtitle="Highest risk of running out before a new order could arrive" action={<Link to="/inventory?view=restock" className="inline-flex items-center text-sm font-semibold text-brand">AI Restock<ChevronRight className="size-4" /></Link>} />
          <Async state={restock} rows={4}>
            {(r) => r.rows.length === 0 ? <EmptyState title="No restocking needed" hint="Every product has enough stock for its supplier lead time." /> : (
              <ul className="divide-y divide-line-soft">
                {r.rows.slice(0, 5).map((p) => (
                  <li key={p.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[1.4fr_1fr_auto]">
                    <div className="min-w-0"><p className="truncate font-semibold">{p.name}</p><p className="text-xs text-muted num">{p.stock} in stock · {p.avgDailySales}/day · {p.leadTimeDays}-day lead time</p></div>
                    <div className="order-3 col-span-2 sm:order-none sm:col-span-1"><div className="mb-1 flex justify-between text-xs"><span className="text-muted">Stockout risk</span><span className="font-semibold num">{pct(p.stockoutRisk * 100)}</span></div><Meter value={p.stockoutRisk * 100} tone={p.riskLevel === 'high' ? 'bad' : p.riskLevel === 'medium' ? 'warn' : 'ok'} /></div>
                    <div className="text-right"><p className="text-xs text-muted">Order</p><p className="font-bold num">{p.recommendedQty}</p></div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Transactions to review" action={<Link to="/risk" className="inline-flex items-center text-sm font-semibold text-brand">Risk Center<ChevronRight className="size-4" /></Link>} />
            <Async state={alerts} rows={2}>
              {(a) => a.rows.length === 0 ? <EmptyState title="Nothing flagged" hint="No transactions need review." /> : (
                <ul className="divide-y divide-line-soft">
                  {a.rows.map((x) => (
                    <li key={x.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2"><p className="font-semibold">Transaction #{x.saleId}</p><RiskBadge level={x.severity} /></div>
                      <p className="mt-0.5 text-xs text-muted">{x.employee} · {inr(x.bill)} bill · risk {x.riskScore}%</p>
                    </li>
                  ))}
                </ul>
              )}
            </Async>
          </Card>
          <Card>
            <CardHeader title="Inventory alerts" />
            <Async state={invAlerts} rows={3}>
              {(d) => (
                <ul className="divide-y divide-line-soft">
                  {d.alerts.slice(0, 5).map((a, i) => (
                    <li key={i} className="flex items-start gap-2.5 px-5 py-2.5 text-sm">
                      <Badge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'} className="mt-0.5 shrink-0">{a.severity === 'critical' ? 'Critical' : a.severity === 'warning' ? 'Warning' : 'Info'}</Badge>
                      <span>{a.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Async>
          </Card>
        </div>
      </div>
    </div>
  );
}
