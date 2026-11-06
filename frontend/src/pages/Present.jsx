import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { LogoMark, Wordmark } from '../components/Logo';
import { inr, num, pct } from '../utils/format';
import { DailyBrief } from '../components/Brief';

/** Presentation mode: five numbers and three recommendations, readable from the back of a room. */
export default function Present() {
  const overview = useAsync(() => api.get('/analytics/overview'), []);
  const restock = useAsync(() => api.get('/ai/restock'), []);
  const alerts = useAsync(() => api.get('/risk/alerts', { status: 'open', limit: 3 }), []);
  const brief = useAsync(() => api.get('/ai/brief'), []);
  useEffect(() => {
    const t = setInterval(() => { overview.reload(); restock.reload(); alerts.reload(); }, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const o = overview.data;
  const risky = (restock.data ? restock.data.rows : []).filter((r) => r.riskLevel === 'high').slice(0, 4);
  const recs = (restock.data ? restock.data.rows : []).slice(0, 3);
  const flagged = alerts.data ? alerts.data.rows : [];

  return (
    <div className="min-h-full bg-ink-950 p-5 text-white sm:p-10">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3"><LogoMark size={40} /><Wordmark dark /></div>
          <Link to="/dashboard" className="inline-flex items-center gap-2 rounded-lg border border-ink-600 px-3 py-2 text-sm font-semibold text-[#9db4c4] hover:bg-ink-800 hover:text-white"><X className="size-4" aria-hidden="true" />Exit presentation</Link>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl bg-ink-900 p-7 lg:col-span-1"><p className="text-lg text-[#9db4c4]">Revenue today</p><p className="mt-2 text-6xl font-extrabold tracking-tight num">{o ? inr(o.kpis.revenue) : '…'}</p>
            {o && o.comparison.revenueChangePct !== null && <p className="mt-3 text-lg font-semibold text-[#6fd6a8]">{o.comparison.revenueChangePct >= 0 ? '+' : ''}{o.comparison.revenueChangePct}% <span className="font-normal text-[#9db4c4]">vs {o.comparison.basis}</span></p>}</div>
          <div className="rounded-2xl bg-ink-900 p-7"><p className="text-lg text-[#9db4c4]">Sales (orders)</p><p className="mt-2 text-6xl font-extrabold tracking-tight num">{o ? num(o.kpis.orders) : '…'}</p>
            {o && <p className="mt-3 text-lg text-[#9db4c4]">Average bill {inr(o.kpis.aov)}</p>}</div>
          <div className="rounded-2xl bg-ink-900 p-7"><p className="text-lg text-[#9db4c4]">Fraud alerts</p><p className={`mt-2 text-6xl font-extrabold tracking-tight num ${o && o.kpis.riskAlerts ? 'text-[#ff8f7a]' : ''}`}>{o ? num(o.kpis.riskAlerts) : '…'}</p>
            <p className="mt-3 text-lg text-[#9db4c4]">{flagged[0] ? `Top: #${flagged[0].saleId}, risk ${flagged[0].riskScore}%` : 'Nothing to review'}</p></div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl bg-ink-900 p-7" aria-labelledby="p-risk">
            <h2 id="p-risk" className="text-xl font-bold">Stockout risk</h2>
            <ul className="mt-4 space-y-4">
              {risky.length === 0 && <li className="text-[#9db4c4]">No products at high risk.</li>}
              {risky.map((p) => (
                <li key={p.id}><div className="flex items-baseline justify-between"><span className="text-xl font-semibold">{p.name}</span><span className="text-2xl font-bold text-[#ff8f7a] num">{pct(p.stockoutRisk * 100)}</span></div>
                  <p className="text-sm text-[#9db4c4] num">{p.stock} in stock · sells {p.avgDailySales}/day</p></li>
              ))}
            </ul>
          </section>
          <section className="rounded-2xl bg-ink-900 p-7" aria-labelledby="p-rec">
            <h2 id="p-rec" className="text-xl font-bold">AI recommendations</h2>
            <ul className="mt-4 space-y-4">
              {recs.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-4"><span className="text-xl font-semibold">Restock {p.name}</span><span className="text-2xl font-bold text-[#4a97ee] num">{p.recommendedQty} units</span></li>
              ))}
            </ul>
          </section>
        </div>
        <DailyBrief state={brief} compact />
      </div>
    </div>
  );
}
