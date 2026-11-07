import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { Badge } from './ui';
import { inr } from '../utils/format';

export const SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'neutral' };

export function ActionRow({ a, rank }) {
  return (
    <li className="flex items-start gap-3 py-3">
      {rank !== undefined && <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand">{rank}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={SEV_TONE[a.severity]} dot>{a.severity}</Badge><p className="text-sm font-semibold">{a.title}</p></div>
        {a.detail && <p className="mt-1 text-sm text-muted">{a.detail}</p>}
        {a.why && a.why.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{a.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {a.amount > 0 && <p className="mt-1 text-xs text-muted num">{inr(a.amount, 0)}{a.amountLabel ? ` · ${a.amountLabel}` : ''}</p>}
      </div>
      {a.route && <Link to={a.route} className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand hover:underline">{a.cta || 'Open'}<ChevronRight className="size-4" aria-hidden="true" /></Link>}
    </li>
  );
}

export function TodayList({ data }) {
  if (data.allClear) return <p className="flex items-center gap-2 p-5 text-sm text-ok"><CheckCircle2 className="size-5" aria-hidden="true" />{data.headline}</p>;
  return (
    <div className="px-5 pb-4">
      <p className="mb-1 text-sm font-medium">{data.headline}</p>
      <ul className="divide-y divide-line-soft">{data.actions.map((a) => <ActionRow key={a.id} a={a} rank={a.rank} />)}</ul>
      {data.warnings && data.warnings.length > 0 && <p className="mt-2 text-xs text-warn">Some checks could not run: {data.warnings.join('; ')}</p>}
      <p className="mt-2 text-xs text-muted">{data.method}</p>
    </div>
  );
}
