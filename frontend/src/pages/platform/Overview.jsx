import { Building2, CalendarClock, CircleDollarSign, TrendingUp, UserPlus, AlertTriangle, BadgeCheck, Hourglass } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Async, Button, Card, CardHeader, Stat } from '../../components/ui';
import { inr, num } from '../../utils/format';

const rupees = (paise) => inr(paise / 100);

export default function Overview() {
  const ov = useAsync(() => api.get('/platform/overview'), []);
  const ops = useAsync(() => api.get('/platform/ops'), []);
  return (
    <div className="space-y-6">
      <Async state={ov} rows={2}>{(o) => (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Building2} label="Businesses" value={num(o.businesses.total)} sub={`${o.businesses.suspended} suspended`} />
            <Stat icon={UserPlus} label="New sign-ups (7 days)" value={num(o.businesses.new7)} sub={`${num(o.businesses.new30)} in the last 30 days`} />
            <Stat icon={Hourglass} label="On free trial" value={num(o.subscriptions.trialing)} tone="info" />
            <Stat icon={BadgeCheck} label="Paying" value={num(o.subscriptions.active + o.subscriptions.past_due)} tone="ok" sub={`${o.subscriptions.past_due} past due`} />
            <Stat icon={CalendarClock} label="Expired / cancelled" value={`${num(o.subscriptions.expired)} / ${num(o.subscriptions.cancelled)}`} tone={o.subscriptions.expired ? 'warn' : undefined} sub="Data kept, read-only" />
            <Stat icon={TrendingUp} label="Monthly recurring revenue" value={rupees(o.revenue.mrrPaise)} sub="From paying plans, estimated" />
            <Stat icon={CircleDollarSign} label="Collected, last 30 days" value={rupees(o.revenue.last30DaysPaise)} sub={`${rupees(o.revenue.allTimePaise)} all time`} />
            <Stat icon={AlertTriangle} label="Failed payments (30 days)" value={num(o.revenue.failedPayments30Days)} tone={o.revenue.failedPayments30Days ? 'warn' : 'ok'} />
          </div>
          <Card>
            <CardHeader title="Paying businesses by plan" subtitle="Demo businesses are not counted." />
            <div className="px-5 pb-4">
              {Object.keys(o.payingByPlan).length === 0 ? <p className="text-sm text-muted">No paying businesses yet.</p> : (
                <ul className="divide-y divide-line-soft">{Object.entries(o.payingByPlan).map(([name, n]) => <li key={name} className="flex justify-between py-2 text-sm"><span className="font-medium">{name}</span><span className="num">{n}</span></li>)}</ul>
              )}
            </div>
          </Card>
        </>
      )}</Async>
      <section aria-label="Server health">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-muted">Server health (since last restart)</h2><Button size="sm" variant="secondary" onClick={() => { ops.reload(); ov.reload(); }}>Refresh</Button></div>
        <Async state={ops} rows={1}>{(o) => (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Requests" value={o.requests} sub={`up ${Math.floor(o.uptimeSeconds / 3600)}h ${Math.floor((o.uptimeSeconds % 3600) / 60)}m`} />
            <Stat label="Server errors" value={o.status5xx} tone={o.status5xx ? 'bad' : 'ok'} sub={`${o.dbErrors} database`} />
            <Stat label="Response time" value={o.responseMs.p95 === null ? '—' : `${Math.round(o.responseMs.p95)} ms`} sub="95th percentile" tone={o.responseMs.p95 > 1500 ? 'warn' : undefined} />
            <Stat label="Failed logins / payments" value={`${o.authFailures} / ${o.paymentFailures}`} tone={o.paymentFailures ? 'warn' : undefined} />
          </div>
        )}</Async>
      </section>
    </div>
  );
}
