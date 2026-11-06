import { useState } from 'react';
import { Check, CreditCard, Lock } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useBilling } from '../hooks/useBilling';
import { Async, Badge, EmptyState, Button, Card, CardHeader, ConfirmDialog, DataTable, Meter, Modal, PageHeader } from '../components/ui';
import { dateOnly, inr } from '../utils/format';

const STATUS = {
  trialing: { tone: 'info', label: 'Free trial' }, active: { tone: 'ok', label: 'Active' }, past_due: { tone: 'warn', label: 'Payment overdue' },
  cancelled: { tone: 'neutral', label: 'Cancelled' }, expired: { tone: 'bad', label: 'Expired' },
};

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'));
    document.head.appendChild(s);
  });
}

const featureList = (p) => {
  const f = p.features || {};
  return [
    `${f.maxStores || 1} store${(f.maxStores || 1) > 1 ? 's (coming soon)' : ''}`,
    `Up to ${f.maxUsers} users`,
    f.maxProducts ? `Up to ${f.maxProducts} products` : 'Unlimited products',
    f.advancedReports ? 'Advanced reports & analytics' : 'Basic reports',
    f.aiInsights && 'AI insights',
    f.advancedAi && 'Advanced AI',
  ].filter(Boolean);
};

export default function Billing() {
  const toast = useToast();
  const { reload: reloadStatus } = useBilling();
  const q = useAsync(() => api.get('/billing'), []);
  const [busy, setBusy] = useState('');
  const [mockOrder, setMockOrder] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const refresh = async () => { await q.reload(); reloadStatus(); };

  const verify = async (payload) => {
    await api.post('/billing/verify', payload);
    toast.success('Payment received. Your subscription is active.');
    await refresh();
  };

  const startCheckout = async (planCode) => {
    setBusy(planCode || 'renew');
    try {
      const o = await api.post('/billing/checkout', planCode ? { planCode } : {});
      if (o.provider === 'razorpay') {
        await loadRazorpay();
        const rz = new window.Razorpay({
          key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: 'SHARKPOS 2', description: `${o.plan.name} plan — 1 month`,
          prefill: o.prefill, theme: { color: '#1f68c1' },
          handler: (r) => verify({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }).catch((e) => toast.error(e.message)),
        });
        rz.open();
      } else if (o.provider === 'mock') setMockOrder(o);
      else toast.error('Online payments are not set up yet. Please contact support.');
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };

  const payMock = async () => {
    setBusy('mock');
    try {
      const sim = await api.post('/billing/dev/simulate-payment', { orderId: mockOrder.orderId });
      await verify(sim);
      setMockOrder(null);
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };

  const change = async (planCode) => {
    setBusy(planCode);
    try {
      const r = await api.post('/billing/change-plan', { planCode });
      if (r.applied === 'now') toast.success('Plan changed.');
      else if (r.applied === 'at_renewal') toast.success('Your plan will change at the next renewal.');
      await refresh();
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };

  const act = (fn, msg) => async () => { setBusy('x'); try { await fn(); toast.success(msg); await refresh(); } catch (e) { toast.error(e.message); } finally { setBusy(''); setConfirmCancel(false); } };

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" subtitle="Your plan, usage and payment history." />
      <Async state={q}>{(b) => {
        const st = STATUS[b.status] || STATUS.expired;
        const trial = b.status === 'trialing';
        const lapsed = ['expired', 'cancelled', 'past_due'].includes(b.status);
        const dateLabel = trial ? `Trial ends ${dateOnly(b.trialEnd)}` : b.cancelAtPeriodEnd ? `Ends ${dateOnly(b.periodEnd)}` : b.status === 'active' ? `Next billing ${dateOnly(b.nextBillingDate)}` : `Ended ${dateOnly(b.periodEnd)}`;
        return (
          <>
            {lapsed && (
              <div role="alert" className="rounded-xl border border-line bg-white p-4 sm:flex sm:items-center sm:justify-between">
                <p className="text-sm font-medium">Your subscription has {b.status === 'cancelled' ? 'ended' : b.status === 'past_due' ? 'a payment overdue' : 'expired'}. Your data is safe.</p>
                <Button className="mt-3 sm:mt-0" loading={busy === 'renew'} onClick={() => startCheckout()}>Renew Subscription</Button>
              </div>
            )}
            <Card>
              <CardHeader title="Current plan" action={<Badge tone={st.tone} dot>{st.label}</Badge>} />
              <div className="grid gap-4 p-4 sm:grid-cols-3 sm:p-5">
                <div><p className="text-xs text-muted">Plan</p><p className="text-lg font-bold">{b.plan.name}</p></div>
                <div><p className="text-xs text-muted">Price</p><p className="text-lg font-bold num">{inr(b.plan.price)}<span className="text-sm font-medium text-muted"> / month</span></p></div>
                <div><p className="text-xs text-muted">{trial ? 'Free trial' : 'Billing'}</p><p className="text-lg font-bold">{dateLabel}</p>{b.daysLeft != null && b.status !== 'expired' && <p className="text-xs text-muted">{b.daysLeft} day{b.daysLeft === 1 ? '' : 's'} left</p>}</div>
              </div>
              {b.pendingPlan && <p className="px-5 pb-3 text-sm text-muted">Switching to {b.pendingPlan.name} at your next renewal.</p>}
              <div className="flex flex-wrap gap-2 border-t border-line p-4 sm:px-5">
                {(b.status === 'active' || b.status === 'past_due') && <Button loading={busy === 'renew'} onClick={() => startCheckout()}><CreditCard className="size-4" aria-hidden="true" />Renew now</Button>}
                {trial && <Button loading={busy === b.plan.code} onClick={() => startCheckout(b.plan.code)}><CreditCard className="size-4" aria-hidden="true" />Pay now &amp; subscribe</Button>}
                {b.cancelAtPeriodEnd ? <Button variant="secondary" loading={busy === 'x'} onClick={act(() => api.post('/billing/resume'), 'Cancellation withdrawn.')}>Keep my subscription</Button>
                  : ['trialing', 'active', 'past_due'].includes(b.status) && <Button variant="secondary" onClick={() => setConfirmCancel(true)}>Cancel subscription</Button>}
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-3">
              {b.plans.map((p) => {
                const current = p.code === b.plan.code;
                const higher = p.price > b.plan.price;
                const direct = trial || (b.status === 'active' && !higher && !current);
                let label = lapsed || trial ? (current && trial ? 'Current plan' : 'Select') : current ? 'Current plan' : higher ? 'Upgrade' : 'Downgrade';
                if (lapsed) label = `Subscribe — ${inr(p.price)}`;
                const disabled = current && (trial || b.status === 'active');
                return (
                  <Card key={p.code} className={current ? 'ring-2 ring-brand' : ''}>
                    <div className="p-5">
                      <div className="flex items-baseline justify-between"><h3 className="text-lg font-bold">{p.name}</h3>{current && <Badge tone="info">Your plan</Badge>}</div>
                      <p className="mt-1 text-3xl font-extrabold tracking-tight num">{inr(p.price)}<span className="text-sm font-medium text-muted"> / month</span></p>
                      <ul className="mt-4 space-y-2 text-sm">
                        {featureList(p).map((x) => <li key={x} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />{x}</li>)}
                      </ul>
                      <Button className="mt-5 w-full" variant={higher || lapsed ? 'primary' : 'secondary'} disabled={disabled} loading={busy === p.code}
                        onClick={() => (direct ? change(p.code) : startCheckout(p.code))}>{label}</Button>
                    </div>
                  </Card>
                );
              })}
            </div>

            <Card>
              <CardHeader title="Usage" subtitle="Against your plan limits." />
              <div className="grid gap-5 p-5 sm:grid-cols-2">
                {[['Users', b.usage.users, b.plan.features.maxUsers], ['Products', b.usage.products, b.plan.features.maxProducts]].map(([n, v, max]) => (
                  <div key={n}><div className="mb-1 flex justify-between text-sm"><span className="font-medium">{n}</span><span className="text-muted num">{v} / {max ?? 'Unlimited'}</span></div>{max != null && <Meter value={Math.min(100, (v / max) * 100)} tone={v >= max ? 'bad' : 'ok'} />}</div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title="Payment history" />
              <DataTable rowKey="id" rows={b.payments} empty={<EmptyState title="No payments yet" />}
                columns={[
                  { key: 'createdAt', header: 'Date', render: (r) => dateOnly(r.paidAt || r.createdAt) },
                  { key: 'plan', header: 'Plan' },
                  { key: 'amount', header: 'Amount', render: (r) => inr(r.amount) },
                  { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'paid' ? 'ok' : r.status === 'failed' ? 'bad' : 'neutral'}>{r.status === 'created' ? 'Not completed' : r.status}</Badge> },
                ]} />
            </Card>
            {b.gateway.provider === 'mock' && <p className="text-xs text-muted"><Lock className="mr-1 inline size-3" aria-hidden="true" />Development mode: payments are simulated. Real payments need Razorpay keys.</p>}
          </>
        );
      }}</Async>

      <ConfirmDialog open={confirmCancel} danger title="Cancel subscription?" confirmLabel="Cancel at period end" loading={busy === 'x'} onClose={() => setConfirmCancel(false)}
        message="You keep full access until the end of the period you've paid for. After that your data stays safe but becomes read-only. You can renew any time." onConfirm={act(() => api.post('/billing/cancel'), 'Your subscription will end at the period end.')} />
      <Modal open={!!mockOrder} onClose={() => setMockOrder(null)} title="Test payment (development only)" footer={<><Button variant="secondary" onClick={() => setMockOrder(null)}>Cancel</Button><Button loading={busy === 'mock'} onClick={payMock}>Pay {mockOrder && inr(mockOrder.amount / 100)}</Button></>}>
        <p className="text-sm text-muted">This stands in for the Razorpay window. Pay {mockOrder && inr(mockOrder.amount / 100)} for the {mockOrder?.plan.name} plan? The payment is still verified by the server.</p>
      </Modal>
    </div>
  );
}
