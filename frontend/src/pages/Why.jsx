import { ArrowRight, Calculator, LineChart, Sparkles, ShieldCheck } from 'lucide-react';
import { PageHeader } from '../components/ui';

const ROWS = [
  ['Sales recorded.', 'Sales analyzed.'],
  ['Low stock detected.', 'Stockout predicted + reorder quantity recommended.'],
  ['Transaction completed.', 'Transaction analyzed for abnormal behavior.'],
  ['Reports generated.', 'Ask your business questions naturally.'],
];
const HONEST = [
  { icon: Calculator, title: 'Deterministic calculations', text: 'Billing, tax, discounts, inventory updates and stock counts. Plain code on the server; no AI involved.' },
  { icon: LineChart, title: 'Analytics and prediction', text: 'Sales trends, averages and KPIs from SQL. Demand forecasting uses a weighted moving average with a trend adjustment. It is statistics, not machine learning.' },
  { icon: ShieldCheck, title: 'Anomaly detection', text: 'Transparent rule-based scoring against each cashier’s own history. Every flag shows the points behind it.' },
  { icon: Sparkles, title: 'AI language layer', text: 'Understands your question, explains the numbers and words the recommendations. It only sees figures the database produced, and any answer containing a number it was not given is discarded.' },
];

export default function Why() {
  return (
    <div className="mx-auto max-w-[960px] space-y-8">
      <PageHeader title="Why SHARKPOS AI?" subtitle="Traditional POS tells you what happened. SHARKPOS AI tells you what to do next." />
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-2 bg-canvas px-5 py-2.5 text-sm font-semibold text-muted"><span>Traditional POS</span><span>SHARKPOS AI</span></div>
        {ROWS.map(([a, b]) => (
          <div key={a} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-line-soft px-5 py-4">
            <p className="text-muted">{a}</p><ArrowRight className="size-4 text-brand" aria-hidden="true" /><p className="font-semibold">{b}</p>
          </div>
        ))}
      </div>
      <section aria-labelledby="honest">
        <h2 id="honest" className="mb-1 text-lg font-bold">What is AI here, and what is not</h2>
        <p className="mb-4 text-sm text-muted">Each layer is labelled for what it is.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {HONEST.map((h) => (
            <div key={h.title} className="rounded-xl border border-line bg-white p-5"><h.icon className="mb-3 size-5 text-brand" aria-hidden="true" /><p className="font-bold">{h.title}</p><p className="mt-1 text-sm text-muted">{h.text}</p></div>
          ))}
        </div>
      </section>
    </div>
  );
}
