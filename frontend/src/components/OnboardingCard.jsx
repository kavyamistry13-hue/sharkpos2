import { Link } from 'react-router-dom';
import { Check, ChevronRight, X } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Card } from './ui';

/** "Get your shop ready" checklist for new businesses. Hides itself when finished, dismissed, or if it can't load. */
export default function OnboardingCard() {
  const { user } = useAuth();
  const toast = useToast();
  const state = useAsync(() => api.get('/onboarding'), []);
  const d = state.data;
  if (!d || d.dismissed || (d.complete && d.doneCount === d.total)) return null;
  const dismiss = async () => { try { await api.post('/onboarding/dismiss'); state.reload(); } catch (e) { toast.error(e.message); } };
  const pct = Math.round((d.doneCount / d.total) * 100);
  return (
    <Card className="p-4 sm:p-5" aria-label="Get your shop ready">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{d.complete ? 'Your shop is ready' : 'Get your shop ready'}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{d.doneCount} of {d.total} done{d.complete ? ' — the rest is optional.' : ' — it takes about 10 minutes.'}</p>
        </div>
        {user?.role === 'business_owner' && (
          <button type="button" onClick={dismiss} className="-m-2 grid size-10 shrink-0 place-items-center rounded-lg text-muted hover:bg-line-soft hover:text-text" aria-label="Hide this checklist"><X className="size-4" aria-hidden="true" /></button>
        )}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
      <ul className="mt-3 divide-y divide-line-soft">
        {d.steps.map((s) => (
          <li key={s.id}>
            <Link to={s.to} className="flex min-h-14 items-center gap-3 py-2 hover:bg-canvas/60">
              <span className={`grid size-6 shrink-0 place-items-center rounded-full border ${s.done ? 'border-ok bg-ok text-white' : 'border-line'}`} aria-hidden="true">{s.done && <Check className="size-3.5" />}</span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold ${s.done ? 'text-muted line-through' : ''}`}>{s.title}{!s.required && <span className="ml-2 text-xs font-medium text-muted no-underline">optional</span>}</span>
                {!s.done && <span className="block text-[13px] text-muted">{s.hint}</span>}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="sr-only">{s.done ? 'Done' : 'To do'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
