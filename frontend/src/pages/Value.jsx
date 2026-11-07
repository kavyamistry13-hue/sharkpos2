import { useEffect, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, CardHeader, DataTable, Field, Input, Modal, PageHeader, Select, Stat, Textarea } from '../components/ui';
import { TrendChart } from '../components/charts';
import { dateTime, inr, num } from '../utils/format';

const OUT_TONE = { verified: 'ok', pending: 'warn', neutral: 'neutral', unsuccessful: 'bad', not_measurable: 'neutral', unknown: 'neutral' };
const DEC_LABEL = { accepted: 'Accepted', rejected: 'Rejected', deferred: 'Not now' };
const HEALTH = { healthy: ['ok', 'Healthy'], needs_attention: ['warn', 'Needs attention'], at_risk: ['bad', 'At risk'], insufficient_data: ['neutral', 'Not enough data'], not_available: ['neutral', 'No data'] };
const VALUE_TYPES = [['avoided_loss', 'Avoided loss'], ['recovered_cash', 'Recovered cash'], ['cost_saving', 'Supplier cost saving'], ['margin_improvement', 'Margin improvement'], ['recovered_credit', 'Udhaar collected'], ['inventory_released', 'Stock turned into cash'], ['stockout_impact', 'Stockout impact']];

function Step({ n, title, value, sub }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{n}. {title}</p>
      <p className="mt-1 text-xl font-extrabold num">{value}</p>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}

function Health({ h }) {
  const [tone, label] = HEALTH[h.status] || HEALTH.insufficient_data;
  return (
    <Card>
      <CardHeader title="Store health" subtitle={h.summary} action={<Badge tone={tone}>{h.score === null ? label : `${h.score}/100 · ${label}`}</Badge>} />
      <div className="grid gap-3 p-5 pt-0 md:grid-cols-2">
        {h.dimensions.map((d) => {
          const [t, l] = HEALTH[d.status] || HEALTH.not_available;
          return (
            <details key={d.key} className="rounded-lg border border-line p-3" open={d.available && d.score < 80}>
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-semibold">
                <span>{d.label} <span className="font-normal text-muted">· weight {d.weight}</span></span>
                <Badge tone={t}>{d.available ? `${d.score} · ${l}` : 'Left out'}</Badge>
              </summary>
              {d.available ? (
                <ul className="mt-2 space-y-1 text-sm">{d.factors.map((f, i) => <li key={i} className="flex justify-between gap-3"><span>{f.label}{f.detail ? <span className="text-xs text-muted"> ({f.detail})</span> : null}</span><span className="num font-semibold">{f.impact === 0 ? '0' : f.impact}</span></li>)}</ul>
              ) : <p className="mt-2 text-sm text-muted">{d.note}</p>}
            </details>
          );
        })}
      </div>
      {h.warnings.length > 0 && <p className="px-5 pb-2 text-xs text-warn">{h.warnings.join(' ')}</p>}
      <p className="border-t border-line px-5 py-3 text-xs text-muted">{h.method}</p>
    </Card>
  );
}

function DecisionModal({ id, onClose }) {
  const d = useAsync(() => api.get(`/measurement/decisions/${id}`), [id]);
  return (
    <Modal open onClose={onClose} size="lg" title="Recommendation → action → outcome → value" footer={<Button onClick={onClose}>Close</Button>}>
      <Async state={d} rows={4}>
        {(x) => (
          <div className="space-y-4 text-sm">
            <div><p className="text-xs font-semibold uppercase text-muted">1. Recommendation (as it was shown)</p><p className="font-semibold">{x.recommendation.title}</p><p className="text-muted">{x.recommendation.detail}</p>{x.recommendation.why && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{x.recommendation.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}</div>
            <div><p className="text-xs font-semibold uppercase text-muted">2. Action</p><p>{DEC_LABEL[x.decision]} by {x.decidedBy ? x.decidedBy.name : '—'} · {dateTime(x.decidedAt)}{x.reason ? ` · “${x.reason}”` : ''}</p></div>
            <div><p className="text-xs font-semibold uppercase text-muted">3. Outcome</p>
              {x.outcome ? <><Badge tone={OUT_TONE[x.outcome.status]}>{x.outcome.label}</Badge><p className="mt-1 font-medium">{x.outcome.headline}</p><p className="text-muted">{x.outcome.explanation}</p></> : <p className="text-muted">Only accepted actions are measured.</p>}
              {x.outcomeHistory.length > 1 && <ul className="mt-2 text-xs text-muted">{x.outcomeHistory.map((h) => <li key={h.id}>{dateTime(h.evaluatedAt)} — {h.headline}</li>)}</ul>}</div>
            <div><p className="text-xs font-semibold uppercase text-muted">4. Measured value</p>
              {x.valueEntries.length === 0 ? <p className="text-muted">No ₹ value has been measured from this action.</p> : <ul>{x.valueEntries.map((v) => <li key={v.id} className="flex justify-between gap-3 py-0.5"><span>{v.date} · {v.type}</span><span className={`num font-semibold ${v.effect < 0 ? 'text-bad' : 'text-ok'}`}>{v.effect < 0 ? '−' : '+'}{inr(v.amount, 2)}</span></li>)}</ul>}</div>
          </div>
        )}
      </Async>
    </Modal>
  );
}

function ReportForm({ onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ valueType: 'avoided_loss', amount: '', explanation: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.post('/measurement/value-ledger/reported', { valueType: f.valueType, amount: Number(f.amount), explanation: f.explanation }); toast.success('Saved as user-reported. It is not counted as verified value.'); setF({ valueType: 'avoided_loss', amount: '', explanation: '' }); onDone(); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-semibold">Add a figure you worked out yourself (kept separate, never counted as verified)</summary>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Type"><Select value={f.valueType} onChange={(e) => setF({ ...f, valueType: e.target.value })}>{VALUE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Amount (₹)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="What is this based on? (required)" className="sm:col-span-3"><Textarea rows={2} maxLength={500} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} /></Field>
        <div className="sm:col-span-3"><Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!(Number(f.amount) > 0) || f.explanation.trim().length < 10}>Save as user-reported</Button></div>
      </form>
    </details>
  );
}

export default function Value() {
  const { user } = useAuth();
  const toast = useToast();
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [fix, setFix] = useState(null);
  const [note, setNote] = useState('');
  const roi = useAsync(() => api.get('/measurement/roi', { days }), [days]);
  const health = useAsync(() => api.get('/measurement/store-health'), []);
  const decs = useAsync(() => api.get('/measurement/decisions', { latest: 'true', limit: 50 }), []);
  const led = useAsync(() => api.get('/measurement/value-ledger', { limit: 50 }), []);
  const reload = () => { roi.reload(); health.reload(); decs.reload(); led.reload(); };
  const refresh = async (quiet) => {
    setBusy(true);
    try {
      const r = await api.post('/measurement/evaluate');
      if (!quiet) toast.success(r.newOutcomes || r.newLedgerEntries ? `Measured: ${r.newOutcomes} new outcome(s), ${r.newLedgerEntries} ledger entr${r.newLedgerEntries === 1 ? 'y' : 'ies'}.` : 'Nothing new to measure.');
      if (r.failed.length) toast.error(`${r.failed.length} action(s) could not be measured right now.`);
      reload();
    } catch (e) { if (!quiet) toast.error(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { refresh(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const correct = async () => {
    try { await api.post(`/measurement/value-ledger/${fix.id}/correct`, { note }); toast.success('Reversal recorded. The original entry stays in the ledger.'); setFix(null); setNote(''); reload(); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <PageHeader title="Value & ROI" subtitle="Is SHARKPOS creating value for this store? Only value your own records support is counted. Rule-based, not AI."
        actions={<><Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} className="!w-36"><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></Select><Button variant="secondary" onClick={() => refresh(false)} loading={busy}><RefreshCw className="size-4" aria-hidden="true" />Re-measure</Button></>} />
      <Async state={roi} rows={4}>
        {(r) => (
          <>
            <Card className={`p-4 ${r.answer.verdict === 'value_measured' ? 'border-ok' : ''}`}>
              <p className="text-sm font-semibold">{r.answer.verdict === 'value_measured' ? 'Measured value' : r.answer.verdict === 'pending' ? 'Pending measurement' : r.answer.verdict === 'no_actions_yet' ? 'Nothing to measure yet' : 'No measurable value yet'}</p>
              <p className="mt-1 text-sm text-muted">{r.answer.text}</p>
            </Card>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
              <Step n={1} title="Recommendations" value={num(r.funnel.generated)} sub={`${r.funnel.undecided} not decided yet`} />
              <ArrowRight className="hidden size-5 shrink-0 self-center text-muted lg:block" aria-hidden="true" />
              <Step n={2} title="Actions" value={`${r.funnel.accepted} accepted`} sub={`${r.funnel.rejected} rejected · ${r.funnel.deferred} not now · ${r.funnel.actedUpon} confirmed done in your records`} />
              <ArrowRight className="hidden size-5 shrink-0 self-center text-muted lg:block" aria-hidden="true" />
              <Step n={3} title="Outcomes" value={`${r.funnel.outcomes.verified} verified`} sub={`${r.funnel.outcomes.pending} pending · ${r.funnel.outcomes.neutral + r.funnel.outcomes.unsuccessful} no change/failed · ${r.funnel.outcomes.notMeasurable} not measurable`} />
              <ArrowRight className="hidden size-5 shrink-0 self-center text-muted lg:block" aria-hidden="true" />
              <Step n={4} title="Verified value" value={inr(r.value.verifiedTotal, 0)} sub={r.value.reportedTotal > 0 ? `plus ${inr(r.value.reportedTotal, 0)} user-reported (not verified)` : 'from your own records'} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="Acceptance rate" value={r.rates.acceptanceRate === null ? 'Not enough data' : `${r.rates.acceptanceRate}%`} sub={r.rates.acceptanceInsufficient || 'Accepted ÷ (accepted + rejected)'} />
              <Stat label="Accepted actions that worked" value={r.rates.successRate === null ? 'Not enough data' : `${r.rates.successRate}%`} sub={r.rates.successInsufficient || 'Verified ÷ measured outcomes'} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card><CardHeader title="Verified value over time" subtitle="Cumulative, by month" />
                {r.value.byMonth.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">No value measured in this period.</p> : <div className="px-3 pb-3"><TrendChart data={r.value.byMonth.map((m) => ({ label: m.month, verified: m.cumulativeVerified }))} series={[{ key: 'verified', name: 'Verified value', format: (v) => inr(v, 0) }]} height={220} /></div>}</Card>
              <Card><CardHeader title="Value by category and type" />
                <div className="space-y-3 px-5 pb-5 text-sm">
                  {r.value.byCategory.length === 0 ? <p className="text-muted">No verified value yet.</p> : (<>
                    <DataTable rows={r.value.byCategory} rowKey="category" columns={[{ key: 'c', header: 'Category', render: (x) => x.category }, { key: 't', header: 'Verified', align: 'right', render: (x) => <span className="num font-semibold">{inr(x.total, 0)}</span> }]} />
                    <DataTable rows={r.value.byType} rowKey="valueType" columns={[{ key: 'c', header: 'Kind of value', render: (x) => x.label }, { key: 't', header: 'Verified', align: 'right', render: (x) => <span className="num font-semibold">{inr(x.total, 0)}</span> }]} /></>)}
                </div></Card>
            </div>
            <Card className="p-4"><dl className="grid gap-3 text-sm md:grid-cols-2">{[['Recommendation', r.definitions.recommendation], ['Action', r.definitions.action], ['Outcome', r.definitions.outcome], ['Verified value', r.definitions.verifiedValue]].map(([k, v]) => <div key={k}><dt className="font-semibold">{k}</dt><dd className="text-muted">{v}</dd></div>)}</dl></Card>
          </>
        )}
      </Async>
      <Async state={health} rows={3}>{(h) => <Health h={h} />}</Async>
      <Card>
        <CardHeader title="Your decisions and what happened" subtitle="Click a row for the full chain." />
        <Async state={decs} rows={4}>{(d) => <DataTable rows={d.rows} onRowClick={(r) => setOpen(r.id)} empty={<p className="px-5 pb-4 text-sm text-muted">No decisions yet. Accept or reject a recommendation in the Action Center.</p>} columns={[
          { key: 'r', header: 'Recommendation', render: (r) => <div><p className="font-semibold">{r.recommendation.title}</p><p className="text-xs text-muted">{r.category} · {dateTime(r.decidedAt)}</p></div> },
          { key: 'a', header: 'Action', render: (r) => DEC_LABEL[r.decision] },
          { key: 'o', header: 'Outcome', render: (r) => (r.outcome ? <Badge tone={OUT_TONE[r.outcome.status]}>{r.outcome.label}</Badge> : '—') },
          { key: 'v', header: 'Measured value', align: 'right', render: (r) => (r.outcome && r.outcome.measuredAmount ? <span className="num font-semibold">{inr(r.outcome.measuredAmount, 0)}</span> : '—') }]} />}</Async>
      </Card>
      <Card>
        <CardHeader title="Value ledger" subtitle="Append-only. A correction is a new line; nothing is edited or deleted." />
        <div className="space-y-3 px-5 pb-5">
          <ReportForm onDone={reload} />
          <Async state={led} rows={3}>{(l) => <DataTable rows={l.rows} empty={<p className="text-sm text-muted">No entries.</p>} columns={[
            { key: 'd', header: 'Date', render: (e) => e.date },
            { key: 'k', header: 'Kind', render: (e) => <Badge tone={e.verification === 'verified' ? 'ok' : 'neutral'}>{e.verification === 'verified' ? 'Measured value' : 'User-reported'}</Badge> },
            { key: 't', header: 'What', render: (e) => <div><p className="font-medium">{e.type === 'correction' ? 'Correction · ' : ''}{e.valueLabel}</p><p className="text-xs text-muted">{e.explanation}</p></div> },
            { key: 'a', header: 'Amount', align: 'right', render: (e) => <span className={`num font-semibold ${e.effect < 0 ? 'text-bad' : ''}`}>{e.effect < 0 ? '−' : '+'}{inr(e.amount, 2)}</span> },
            { key: 'x', header: '', render: (e) => (user.role === 'business_owner' && e.type !== 'correction' ? <Button size="sm" variant="ghost" onClick={(ev) => { ev.stopPropagation(); setFix(e); }}>Reverse</Button> : null) }]} />}</Async>
        </div>
      </Card>
      {open && <DecisionModal id={open} onClose={() => setOpen(null)} />}
      {fix && <Modal open onClose={() => setFix(null)} title={`Reverse ${inr(fix.amount, 2)} entry`} footer={<><Button variant="secondary" onClick={() => setFix(null)}>Cancel</Button><Button onClick={correct} disabled={note.trim().length < 3}>Record reversal</Button></>}>
        <p className="mb-2 text-sm text-muted">This adds a new reversing line. The original stays. A reversed value is not added back automatically.</p>
        <Field label="Reason (required)"><Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field></Modal>}
    </div>
  );
}
