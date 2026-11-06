import { Link } from 'react-router-dom';
import { Check, Minus } from 'lucide-react';
import { inr } from '../../utils/format';
import { FEATURE_ROWS } from './usePlans';

/** Plan cards. The middle plan is highlighted only when there are three or more plans. */
export function PlanCards({ plans }) {
  const featured = plans.length >= 3 ? plans[1].code : null;
  return (
    <div className={`grid gap-4 ${plans.length >= 3 ? 'md:grid-cols-3' : plans.length === 2 ? 'md:grid-cols-2' : ''}`}>
      {plans.map((p) => (
        <article key={p.code} className={`flex flex-col rounded-2xl border bg-white p-6 ${p.code === featured ? 'border-brand shadow-lg ring-1 ring-brand' : 'border-line'}`} aria-labelledby={`plan-${p.code}`}>
          {p.code === featured && <span className="mb-2 w-fit rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">Most popular</span>}
          <h3 id={`plan-${p.code}`} className="text-lg font-bold">{p.name}</h3>
          <p className="mt-3"><span className="num text-4xl font-extrabold tracking-tight">{inr(p.price)}</span><span className="text-sm text-muted"> / {p.intervalDays === 30 ? 'month' : `${p.intervalDays} days`}</span></p>
          <p className="mt-1 text-xs text-muted">Prices in Indian rupees. Taxes as applicable.</p>
          <ul className="mt-5 flex-1 space-y-2.5 text-sm">
            {(p.highlights || []).map((h) => <li key={h} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" /><span>{h}</span></li>)}
          </ul>
          <Link to={`/register?plan=${encodeURIComponent(p.code)}`} className={`mt-6 block rounded-lg py-3 text-center text-sm font-semibold ${p.code === featured ? 'bg-brand text-white hover:bg-brand-dark' : 'border border-line hover:bg-canvas'}`}>Start 14-day free trial</Link>
        </article>
      ))}
    </div>
  );
}

/** Side-by-side table. On phones it scrolls sideways inside its own box instead of breaking the page. */
export function CompareTable({ plans }) {
  return (
    <div className="relative overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Plan comparison (scrolls sideways on small screens)">
      <table className="w-full min-w-[520px] border-collapse text-left text-sm">
        <thead><tr className="bg-canvas"><th scope="col" className="p-3 font-semibold">Feature</th>{plans.map((p) => <th key={p.code} scope="col" className="p-3 font-semibold">{p.name}</th>)}</tr></thead>
        <tbody>
          {FEATURE_ROWS.map((r) => (
            <tr key={r.label} className="border-t border-line">
              <th scope="row" className="p-3 font-medium">{r.label}</th>
              {plans.map((p) => {
                const v = r.get(p.features || {});
                return <td key={p.code} className="p-3">{v === true ? <><Check className="size-4 text-ok" aria-hidden="true" /><span className="sr-only">Included</span></> : v === false || v === undefined ? <><Minus className="size-4 text-muted" aria-hidden="true" /><span className="sr-only">Not included</span></> : v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
