import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Send, Sparkles, Database, Info } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Badge, Button, PageHeader, RiskBadge, cx } from '../components/ui';
import { inr } from '../utils/format';

const SUGGESTIONS = [
  'What should I restock tomorrow?', 'Which products are at risk of stockout?', 'Which products are selling the fastest?', 'Why did sales decrease this week?',
  'Show me suspicious transactions.', 'Which category generated the most revenue?', 'Which employee processed the most sales?', 'What are my slow-moving products?', 'How can I improve inventory management?',
];

function Answer({ m }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[760px] space-y-3">
      <div className="rounded-2xl rounded-tl-sm border border-line bg-white p-4">
        <p className="whitespace-pre-line text-[15px] leading-relaxed">{m.answer}</p>
        {m.table && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm"><thead><tr className="bg-canvas text-left text-xs font-semibold text-muted">{m.table.columns.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}</tr></thead>
              <tbody>{m.table.rows.map((r, i) => <tr key={i} className="border-t border-line-soft">{r.map((c, j) => <td key={j} className={cx('px-3 py-2 num', j === 0 && 'font-semibold')}>{c}</td>)}</tr>)}</tbody></table>
          </div>
        )}
        {m.alerts && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {m.alerts.map((a) => (
              <div key={a.id} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><p className="font-bold">Transaction #{a.saleId}</p><RiskBadge level={a.severity} /></div>
                <p className="mt-1 text-muted">{a.employee} · bill {inr(a.bill)}{a.discount ? ` · discount ${inr(a.discount)}` : ''}</p>
                <p className="mt-1 font-semibold num">Risk score {a.riskScore}%</p>
              </div>
            ))}
          </div>
        )}
        {m.action && <Link to={m.action.to} className="mt-4 inline-block"><Button size="sm" variant="secondary">{m.action.label}</Button></Link>}
      </div>
      {m.why.length > 0 && (
        <div>
          <button className="flex items-center gap-1 text-sm font-semibold text-brand" onClick={() => setOpen(!open)} aria-expanded={open}>Why this recommendation?<ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} /></button>
          {open && <ul className="mt-2 list-disc space-y-1 rounded-lg bg-white p-3 pl-8 text-sm text-muted border border-line">{m.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>
      )}
      <p className="flex items-center gap-1.5 text-xs text-muted">{m.aiUsed ? <><Sparkles className="size-3.5" aria-hidden="true" />Worded by an AI model using figures from your database</> : <><Database className="size-3.5" aria-hidden="true" />Answer built directly from your database</>}</p>
      {m.notice && <p className="flex items-start gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{m.notice}</p>}
    </div>
  );
}

export default function Copilot() {
  const status = useAsync(() => api.get('/ai/status'), []);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current && end.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);

  const ask = async (text) => {
    const question = (text ?? q).trim();
    if (question.length < 2 || busy) return;
    setQ(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    try {
      const r = await api.post('/ai/copilot', { question });
      setMsgs((m) => [...m, { role: 'assistant', ...r }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'error', text: e.status === 429 ? e.message : 'The copilot could not answer that. Your POS still works. Please try again.' }]);
    } finally { setBusy(false); }
  };

  const llm = status.data && status.data.llmConfigured;
  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-[920px] flex-col">
      <PageHeader title="AI Business Copilot" subtitle="Ask about your store in plain language. Numbers always come from your database first." actions={status.data && <Badge tone={llm ? 'ok' : 'neutral'} dot>{llm ? `Language model: ${status.data.model}` : 'Data-driven mode (no language model key)'}</Badge>} />
      <div className="flex-1 space-y-5 overflow-y-auto rounded-xl border border-line bg-canvas/60 p-4 sm:p-5" aria-live="polite">
        {msgs.length === 0 && (
          <div className="mx-auto max-w-xl py-6 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-ink-900 text-[#4a97ee]"><Sparkles className="size-6" aria-hidden="true" /></div>
            <h2 className="text-lg font-bold">What would you like to know?</h2>
            <p className="mt-1 text-sm text-muted">Pick a question or type your own.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line bg-white px-3.5 py-2 text-left text-sm font-medium hover:border-brand hover:bg-brand-soft/50">{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => m.role === 'user'
          ? <div key={i} className="flex justify-end"><p className="max-w-[80%] rounded-2xl rounded-tr-sm bg-ink-900 px-4 py-2.5 text-sm text-white">{m.text}</p></div>
          : m.role === 'error' ? <p key={i} role="alert" className="max-w-[760px] rounded-lg bg-bad-soft px-4 py-3 text-sm font-medium text-bad">{m.text}</p>
          : <Answer key={i} m={m} />)}
        {busy && <p className="flex items-center gap-2 text-sm text-muted"><span className="relative grid size-2.5 place-items-center text-brand"><span className="ping absolute size-2.5 rounded-full" /><span className="relative size-2.5 rounded-full bg-brand" /></span>Looking at your data…</p>}
        <div ref={end} />
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} aria-label="Ask the copilot" placeholder="Ask about stock, sales, customers or risk…" className="h-12 flex-1 rounded-xl border border-line bg-white px-4 focus:border-brand" />
        <Button size="lg" type="submit" loading={busy} disabled={q.trim().length < 2}><Send className="size-4" aria-hidden="true" />Ask</Button>
      </form>
      {msgs.length > 0 && <div className="mt-2 flex gap-2 overflow-x-auto pb-1">{SUGGESTIONS.slice(0, 5).map((s) => <button key={s} onClick={() => ask(s)} disabled={busy} className="whitespace-nowrap rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-muted hover:text-text">{s}</button>)}</div>}
    </div>
  );
}
