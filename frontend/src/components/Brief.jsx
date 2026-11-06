import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Skeleton } from './ui';

/** AI Daily Brief — the single dark panel on the dashboard. Text comes from live database numbers. */
export function DailyBrief({ state, compact }) {
  const { data, loading, error, reload } = state;
  return (
    <section className="relative overflow-hidden rounded-xl bg-ink-900 text-white" aria-labelledby="brief-title">
      <svg className="pointer-events-none absolute -right-8 -top-6 w-56 opacity-[.06]" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 21c4-1 6-6 9-12 1 5 4 9 11 12-4 2-8 1-10-1-3 2-7 2-10 1z" fill="#fff" /></svg>
      <div className="relative flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="relative grid size-2.5 place-items-center text-[#4a97ee]"><span className="ping absolute size-2.5 rounded-full" /><span className="relative size-2.5 rounded-full bg-[#4a97ee]" /></span>
          <h2 id="brief-title" className="text-[15px] font-bold">AI Daily Brief</h2>
          {data && <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] font-semibold text-[#9db4c4]">{data.source === 'llm' ? 'Written by AI from live data' : 'Generated from live data'}</span>}
        </div>
        <button onClick={reload} className="rounded-md p-1.5 text-[#9db4c4] hover:bg-ink-700 hover:text-white" aria-label="Refresh brief"><RefreshCw className={`size-4 ${loading ? 'spin' : ''}`} /></button>
      </div>
      <div className="relative px-5 pb-5 pt-3">
        {!data && loading && <div className="space-y-2"><Skeleton className="h-4 w-2/3 !bg-ink-700" /><Skeleton className="h-4 w-1/2 !bg-ink-700" /><Skeleton className="h-4 w-3/5 !bg-ink-700" /></div>}
        {!data && error && <p className="text-sm text-[#f0b4a8]">Unable to load the brief. <button className="underline" onClick={reload}>Try again</button></p>}
        {data && (
          <>
            <div className={`grid gap-x-8 gap-y-1 ${compact ? '' : 'md:grid-cols-[1.4fr_1fr]'}`}>
              <p className="max-w-2xl whitespace-pre-line text-[15px] leading-relaxed text-[#dbe7ef]">{data.text.split('\n\nRecommended action:')[0]}</p>
              <div className="rounded-lg bg-ink-800 p-3.5 md:self-start">
                <p className="text-xs font-semibold text-[#9db4c4]">Recommended action</p>
                <p className="mt-1 text-sm font-semibold">{(data.text.split('Recommended action:')[1] || 'No action needed.').trim()}</p>
                {data.action && !compact && <Link to={data.action.to}><Button size="sm" className="mt-3">{data.action.label}</Button></Link>}
              </div>
            </div>
            {data.notice && <p className="mt-3 text-xs text-[#9db4c4]">{data.notice}</p>}
          </>
        )}
      </div>
    </section>
  );
}
