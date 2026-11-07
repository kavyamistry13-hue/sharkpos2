import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Badge, Button, Input } from './ui';
import { inr } from '../utils/format';

export const SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'neutral' };

const DEC_TONE = { accepted: 'ok', rejected: 'neutral', deferred: 'warn' };
const DEC_LABEL = { accepted: 'Accepted', rejected: 'Rejected', deferred: 'Not now' };

/** Latest decision per recommendation, keyed by action id. */
export function useDecisions() {
  const st = useAsync(() => api.get('/measurement/decisions', { latest: 'true', limit: 200 }).catch(() => ({ rows: [] })), []);
  const map = {};
  ((st.data && st.data.rows) || []).forEach((d) => { map[d.actionKey] = d; });
  return { map, reload: st.reload };
}

function DecisionControls({ a, current, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const send = async (decision, why) => {
    setBusy(decision);
    try {
      const r = await api.post('/measurement/decisions', { actionId: a.id, decision, ...(why ? { reason: why } : {}) });
      toast.success(r.duplicate ? 'Already recorded.' : decision === 'accepted' ? 'Accepted. SHARKPOS will measure what happens next. No value is claimed yet.' : 'Recorded.');
      setRejecting(false); setReason(''); onChanged();
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {current && <Badge tone={DEC_TONE[current.decision]}>{DEC_LABEL[current.decision]}{current.outcome ? ` · ${current.outcome.label}` : ''}</Badge>}
        {current && current.outcome && <span className="text-xs text-muted">{current.outcome.headline}</span>}
        {(!current || current.decision !== 'accepted') && <Button size="sm" onClick={() => send('accepted')} loading={busy === 'accepted'}>Accept</Button>}
        {(!current || current.decision === 'accepted') && <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>Reject</Button>}
        {!current && <Button size="sm" variant="ghost" onClick={() => send('deferred')} loading={busy === 'deferred'}>Not now</Button>}
      </div>
      {rejecting && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); send('rejected', reason.trim() || undefined); }}>
          <Input aria-label="Reason (optional)" placeholder="Why? (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="max-w-xs" />
          <Button size="sm" type="submit" variant="secondary" loading={busy === 'rejected'}>Confirm reject</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

export function ActionRow({ a, rank, decisions }) {
  return (
    <li className="flex items-start gap-3 py-3">
      {rank !== undefined && <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand">{rank}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={SEV_TONE[a.severity]} dot>{a.severity}</Badge><p className="text-sm font-semibold">{a.title}</p></div>
        {a.detail && <p className="mt-1 text-sm text-muted">{a.detail}</p>}
        {a.why && a.why.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{a.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {a.amount > 0 && <p className="mt-1 text-xs text-muted num">{inr(a.amount, 0)}{a.amountLabel ? ` · ${a.amountLabel}` : ''}</p>}
        {decisions && a.id && <DecisionControls a={a} current={decisions.map[a.id]} onChanged={decisions.reload} />}
      </div>
      {a.route && <Link to={a.route} className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand hover:underline">{a.cta || 'Open'}<ChevronRight className="size-4" aria-hidden="true" /></Link>}
    </li>
  );
}

export function TodayList({ data }) {
  const decisions = useDecisions();
  if (data.allClear) return <p className="flex items-center gap-2 p-5 text-sm text-ok"><CheckCircle2 className="size-5" aria-hidden="true" />{data.headline}</p>;
  return (
    <div className="px-5 pb-4">
      <p className="mb-1 text-sm font-medium">{data.headline}</p>
      <ul className="divide-y divide-line-soft">{data.actions.map((a) => <ActionRow key={a.id} a={a} rank={a.rank} decisions={decisions} />)}</ul>
      {data.warnings && data.warnings.length > 0 && <p className="mt-2 text-xs text-warn">Some checks could not run: {data.warnings.join('; ')}</p>}
      <p className="mt-2 text-xs text-muted">{data.method} A recommendation is not a saving: accepting only starts the measurement.</p>
    </div>
  );
}
