import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Async, Card, CardHeader, PageHeader, Segmented, Stat, EmptyState } from '../components/ui';
import { RankBars, TrendChart } from '../components/charts';
import { inr, num } from '../utils/format';

const RANGES = [{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '3m', label: '3 months' }];
const Change = ({ v }) => (v === null || v === undefined ? <span>No earlier period</span> : <span className={`inline-flex items-center gap-1 font-semibold ${v >= 0 ? 'text-ok' : 'text-bad'}`}>{v >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}{Math.abs(v)}% <span className="font-normal text-muted">vs previous period</span></span>);

export default function Analytics() {
  const [range, setRange] = useState('7d');
  const sales = useAsync(() => api.get('/analytics/sales', { range }), [range]);
  const products = useAsync(() => api.get('/analytics/products', { range: range === 'today' ? '7d' : range }), [range]);
  const unit = { hour: 'hour', day: 'day', week: 'week' };

  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <PageHeader title="Analytics" subtitle="Revenue, orders and product performance." actions={<Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />} />
      <Async state={sales} rows={5} errorText="Unable to load analytics.">
        {(s) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Sales today" value={inr(s.periods.today.revenue)} sub={`${num(s.periods.today.orders)} orders`} />
              <Stat label="Sales this week" value={inr(s.periods.week.revenue)} sub={`Last 7 days · ${num(s.periods.week.orders)} orders`} />
              <Stat label="Sales this month" value={inr(s.periods.month.revenue)} sub={`Last 30 days · ${num(s.periods.month.orders)} orders`} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Revenue in range" value={inr(s.totals.revenue)} sub={<Change v={s.totals.revenueChangePct} />} />
              <Stat label="Orders in range" value={num(s.totals.orders)} sub={<Change v={s.totals.ordersChangePct} />} />
              <Stat label="Average order value" value={inr(s.totals.aov, 2)} sub={<Change v={s.totals.aovChangePct} />} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card><CardHeader title="Revenue trend" subtitle={`By ${unit[s.granularity]}`} /><div className="px-3 pb-4">{s.trend.length ? <TrendChart data={s.trend} series={[{ key: 'revenue', name: 'Revenue', format: inr }]} /> : <EmptyState title="No sales in this range" />}</div></Card>
              <Card><CardHeader title="Order count" subtitle={`Orders per ${unit[s.granularity]}`} /><div className="px-3 pb-4">{s.trend.length ? <TrendChart data={s.trend} variant="bar" yFormat={(v) => v} series={[{ key: 'orders', name: 'Orders', format: num }]} /> : <EmptyState title="No sales in this range" />}</div></Card>
              <Card><CardHeader title="Average order value" subtitle={`Per ${unit[s.granularity]}`} /><div className="px-3 pb-4">{s.trend.length ? <TrendChart data={s.trend} variant="line" series={[{ key: 'aov', name: 'Average order value', format: (v) => inr(v, 2) }]} yFormat={(v) => `₹${v}`} /> : <EmptyState title="No sales in this range" />}</div></Card>
              <Card><CardHeader title="Category performance" subtitle="Item sales by category" /><div className="px-3 pb-4">{s.categories.length ? <RankBars data={s.categories} valueKey="revenue" name="Revenue" format={inr} nameWidth={140} /> : <EmptyState title="No sales in this range" />}</div></Card>
              <Card><CardHeader title="Top-selling products" subtitle="Units sold" /><div className="px-3 pb-4">{s.topProducts.length ? <RankBars data={s.topProducts} valueKey="units" name="Units" nameWidth={160} /> : <EmptyState title="No sales in this range" />}</div></Card>
              <Card><CardHeader title="Payment methods" subtitle="Share of revenue" /><div className="px-3 pb-4">{s.payments.length ? <RankBars data={s.payments.map((p) => ({ ...p, name: p.method.toUpperCase() }))} valueKey="revenue" name="Revenue" format={inr} nameWidth={70} height={150} /> : <EmptyState title="No sales in this range" />}</div></Card>
            </div>
          </>
        )}
      </Async>
      <Async state={products} rows={3}>
        {(p) => (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card><CardHeader title="Fast-moving products" subtitle="Average units per day" /><div className="px-3 pb-4"><RankBars data={p.fastMoving.slice(0, 8)} valueKey="avgDailySales" name="Units per day" nameWidth={160} /></div></Card>
            <Card><CardHeader title="Demand rising" subtitle="Last 7 days vs the 7 before" />
              {p.rising.length ? <ul className="divide-y divide-line-soft">{p.rising.slice(0, 6).map((r) => <li key={r.id} className="flex items-center justify-between px-5 py-2.5 text-sm"><span className="font-medium">{r.name}</span><span className="font-semibold text-ok num">+{r.trendPct}%</span></li>)}</ul> : <EmptyState title="No clear risers" />}
            </Card>
            <Card className="lg:col-span-2"><CardHeader title="Slow-moving products" subtitle="Selling about one unit a day or less, with money tied up in stock" />
              {p.slowMoving.length ? <ul className="divide-y divide-line-soft">{p.slowMoving.map((r) => <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"><span className="font-medium">{r.name}</span><span className="text-muted num">{r.stock} units · {r.avgDailySales}/day</span><span className="font-semibold num">{inr(r.stockValue)}</span></li>)}</ul> : <EmptyState title="Nothing is slow-moving" />}
            </Card>
          </div>
        )}
      </Async>
    </div>
  );
}
