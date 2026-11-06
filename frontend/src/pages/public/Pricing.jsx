import { Link } from 'react-router-dom';
import { usePageTitle } from '../../hooks/usePageTitle';
import { Skeleton } from '../../components/ui';
import { CompareTable, PlanCards } from './PlanCards';
import { usePlans } from './usePlans';

const FAQ = [
  ['Do I need a card to start?', 'No. Every plan starts with a 14-day free trial and we do not ask for card details to begin.'],
  ['What happens when my trial or plan ends?', 'Your data is kept. You can still open and read everything, but you cannot create new bills or change records until you renew.'],
  ['Can I change plans later?', 'Yes. Upgrades apply right away. A downgrade takes effect at your next renewal.'],
  ['How do I pay?', 'Online through Razorpay (UPI, cards, net banking and wallets, as Razorpay offers them). Your payment is confirmed by our server before your plan is activated.'],
  ['Where can I read the rules on refunds?', null],
];

export default function Pricing() {
  usePageTitle('Pricing', 'Simple monthly plans for shops of every size. 14-day free trial, no card needed.');
  const { plans, error } = usePlans();
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Simple pricing for every shop</h1>
        <p className="mt-3 text-muted">Start free for 14 days. Pick the plan that fits your counter, change it any time.</p>
      </div>
      <div className="mt-10">
        {!plans && !error && <div className="grid gap-4 md:grid-cols-3" aria-busy="true"><Skeleton className="h-72" /><Skeleton className="h-72" /><Skeleton className="h-72" /></div>}
        {error && <p role="alert" className="rounded-xl border border-line bg-canvas p-6 text-center text-sm">We could not load the plans right now. Please refresh in a minute, or <Link className="font-semibold text-brand underline" to="/register">start your free trial</Link> and choose a plan there.</p>}
        {plans && plans.length === 0 && <p className="text-center text-sm text-muted">Plans are being updated. Please check back shortly.</p>}
        {plans && plans.length > 0 && (<><PlanCards plans={plans} /><h2 className="mb-3 mt-14 text-xl font-bold">Compare plans</h2><CompareTable plans={plans} /></>)}
      </div>
      <section className="mx-auto mt-16 max-w-2xl" aria-labelledby="faq">
        <h2 id="faq" className="text-xl font-bold">Questions</h2>
        <dl className="mt-4 divide-y divide-line">
          {FAQ.map(([q, a]) => (
            <div key={q} className="py-4"><dt className="font-semibold">{q}</dt><dd className="mt-1 text-sm text-muted">{a || <>See our <Link className="font-semibold text-brand underline" to="/refunds">Refunds &amp; Cancellation policy</Link>.</>}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
