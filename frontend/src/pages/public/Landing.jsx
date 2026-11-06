import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, Boxes, Check, Receipt, ShieldAlert, Smartphone, Sparkles, Users } from 'lucide-react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { Skeleton } from '../../components/ui';
import { PlanCards } from './PlanCards';
import { usePlans } from './usePlans';

const FEATURES = [
  { icon: Receipt, title: 'Fast billing', text: 'Search or tap a product, record cash, UPI or card, and print the invoice. Built for a busy counter.' },
  { icon: Boxes, title: 'Stock you can trust', text: 'Every sale updates stock. Low-stock alerts and restock suggestions tell you what to buy before you run out.' },
  { icon: BarChart3, title: 'Know your day', text: 'Sales, profit estimates and best sellers on one screen — readable on a phone.' },
  { icon: ShieldAlert, title: 'Spot problems early', text: 'Unusual discounts, refunds and cancellations are scored by clear, explainable rules and flagged for the owner to review. Important changes are logged.' },
  { icon: Users, title: 'Staff with the right access', text: 'Owner, manager and cashier logins. Cashiers can bill; only you see the money.' },
  { icon: Sparkles, title: 'AI help when you want it', text: 'Ask questions about your own shop data in plain language. Optional — the product works fully without it.' },
];
const STEPS = [
  ['Create your account', 'Add your shop name. No card needed.'],
  ['Add your products', 'Enter items with price and stock. We start you with common GST categories.'],
  ['Start billing', 'Make your first sale in minutes, from your phone or computer.'],
];

export default function Landing() {
  usePageTitle(null, 'SHARKPOS helps small shops in India bill faster, track stock and understand their day. 14-day free trial.');
  const { plans, error } = usePlans();
  return (
    <>
      <section className="bg-ink-900 text-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold"><Smartphone className="size-3.5" aria-hidden="true" />Works on phone, tablet and computer</p>
            <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">Run your shop smarter, from the counter.</h1>
            <p className="mt-4 max-w-xl text-lg text-white/80">Billing, stock and daily insights for small retail shops in India. Start free for 14 days — no card needed.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/register" className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-brand px-6 font-semibold text-white hover:bg-brand-dark">Start free trial<ArrowRight className="size-4" aria-hidden="true" /></Link>
              <Link to="/pricing" className="inline-flex h-12 items-center justify-center rounded-lg border border-white/30 px-6 font-semibold hover:bg-white/10">See pricing</Link>
            </div>
            <p className="mt-4 text-sm text-white/60">Already using SHARKPOS? <Link to="/login" className="font-semibold text-white underline">Sign in</Link></p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-ink-800 p-5" aria-hidden="true">
            <div className="flex items-center justify-between text-sm text-white/70"><span>Today</span><span>Live</span></div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              {[['Sales (₹)', '18,420'], ['Bills', '64'], ['Low stock', '7']].map(([k, v]) => <div key={k} className="rounded-xl bg-white/5 p-3"><div className="text-xs text-white/60">{k}</div><div className="num mt-1 text-lg font-bold">{v}</div></div>)}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              {['Basmati Rice 5 kg  ×2', 'Toor Dal 1 kg  ×1', 'Amul Butter 500 g  ×1'].map((l) => <div key={l} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2"><span>{l}</span><Check className="size-4 text-emerald-400" /></div>)}
            </div>
            <p className="mt-3 text-xs text-white/50">Illustration with sample numbers.</p>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-14 sm:px-6 sm:py-20" aria-labelledby="features-h">
        <h2 id="features-h" className="text-center text-3xl font-extrabold tracking-tight">Everything the counter needs</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted">One simple tool instead of a billing book, a stock register and guesswork.</p>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-2xl border border-line p-5">
              <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand"><Icon className="size-5" aria-hidden="true" /></span>
              <h3 className="mt-3 font-bold">{title}</h3><p className="mt-1 text-sm text-muted">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-canvas" aria-labelledby="how-h">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <h2 id="how-h" className="text-center text-3xl font-extrabold tracking-tight">Ready in three steps</h2>
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="rounded-2xl bg-white p-5"><span className="grid size-8 place-items-center rounded-full bg-brand text-sm font-bold text-white">{i + 1}</span><h3 className="mt-3 font-bold">{t}</h3><p className="mt-1 text-sm text-muted">{d}</p></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20" aria-labelledby="price-h">
        <h2 id="price-h" className="text-center text-3xl font-extrabold tracking-tight">Pricing that stays simple</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted">14-day free trial on every plan. Your data stays yours, even if you stop.</p>
        <div className="mt-10">
          {!plans && !error && <div className="grid gap-4 md:grid-cols-3" aria-busy="true"><Skeleton className="h-64" /><Skeleton className="h-64" /><Skeleton className="h-64" /></div>}
          {plans && plans.length > 0 && <PlanCards plans={plans} />}
          {(error || (plans && plans.length === 0)) && <p className="text-center text-sm text-muted">See current plans on the <Link to="/pricing" className="font-semibold text-brand underline">pricing page</Link>.</p>}
        </div>
      </section>

      <section className="bg-ink-900 text-white">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
          <h2 className="text-3xl font-extrabold tracking-tight">Try it on your next customer</h2>
          <p className="mt-3 text-white/75">Create an account in a minute. If it is not for you, you lose nothing.</p>
          <Link to="/register" className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-brand px-6 font-semibold hover:bg-brand-dark">Start free trial<ArrowRight className="size-4" aria-hidden="true" /></Link>
        </div>
      </section>
    </>
  );
}
