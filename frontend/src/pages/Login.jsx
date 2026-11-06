import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TrendingUp, ShieldCheck, Compass, LogIn } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { LogoMark, Wordmark } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';

// Demo accounts are only offered in development builds; they are never shipped to production.
const DEMO = !import.meta.env.DEV ? [] : [
  { role: 'Owner', email: 'admin@sharkpos.ai', password: 'admin123' },
  { role: 'Manager', email: 'manager@sharkpos.ai', password: 'manager123' },
  { role: 'Cashier', email: 'cashier@sharkpos.ai', password: 'cashier123' },
];
const PILLARS = [
  { icon: TrendingUp, title: 'Predict', text: 'Forecast demand and stockout risk.' },
  { icon: ShieldCheck, title: 'Protect', text: 'Detect suspicious transactions.' },
  { icon: Compass, title: 'Decide', text: 'Turn business data into actionable recommendations.' },
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState(null);

  const submit = async (e, businessId) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await login(email.trim(), password, businessId);
      if (r.businesses) { setChoices(r.businesses); setBusy(false); return; }
      nav(r.user.role === 'cashier' ? '/pos' : r.user.role === 'platform_admin' ? '/platform' : '/dashboard', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.15fr_1fr]">
      <section className="relative flex flex-col justify-between overflow-hidden bg-ink-900 px-6 py-8 text-white sm:px-12 sm:py-12">
        <svg className="pointer-events-none absolute -right-24 -top-10 w-[560px] opacity-[.07]" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 21c4-1 6-6 9-12 1 5 4 9 11 12-4 2-8 1-10-1-3 2-7 2-10 1z" fill="#fff" /></svg>
        <div className="flex items-center gap-2.5"><LogoMark size={36} /><Wordmark dark /></div>
        <div className="my-12 max-w-xl">
          <h1 className="text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl">Your POS knows what you sold. We help you decide what to do next.</h1>
          <p className="mt-5 max-w-md text-[#9db4c4]">Traditional POS tells you what happened. SHARKPOS AI tells you what to do next.</p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {PILLARS.map((p) => (
            <li key={p.title} className="rounded-xl border border-ink-700 bg-ink-800/70 p-4">
              <p.icon className="mb-3 size-5 text-[#4a97ee]" aria-hidden="true" />
              <p className="font-bold">{p.title}</p>
              <p className="mt-1 text-sm text-[#9db4c4]">{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex items-center justify-center px-6 py-10 sm:px-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Intelligent Retail Management</p>
          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@store.com" /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {error && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}><LogIn className="size-4" aria-hidden="true" />Sign in</Button>
          </form>
          {choices && (
            <div className="mt-4 rounded-xl border border-line bg-white p-3" role="group" aria-label="Choose a business">
              <p className="mb-2 text-sm font-semibold">Which business do you want to open?</p>
              <div className="grid gap-2">{choices.map((b) => (
                <button key={b.id} type="button" onClick={() => submit(null, b.id)} className="rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-brand hover:bg-brand-soft/50"><span className="font-semibold">{b.name}</span><span className="ml-2 text-xs text-muted">{b.role.replace('_', ' ')}</span></button>
              ))}</div>
            </div>
          )}
          <p className="mt-5 text-center text-sm text-muted">New to SHARKPOS? <Link to="/register" className="font-semibold text-brand hover:underline">Create your business account</Link></p>
          {DEMO.length > 0 && <div className="mt-8 rounded-xl border border-dashed border-line bg-white p-4">
            <p className="text-[13px] font-semibold">Development demo accounts</p>
            <p className="mt-0.5 text-xs text-muted">Shown in development builds only. Run <span className="num">npm run seed</span> to create them.</p>
            <div className="mt-3 grid gap-2">
              {DEMO.map((d) => (
                <button key={d.role} type="button" onClick={() => { setEmail(d.email); setPassword(d.password); setError(''); }}
                  className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-brand hover:bg-brand-soft/50">
                  <span className="font-semibold">{d.role}</span>
                  <span className="text-xs text-muted num">{d.email} · {d.password}</span>
                </button>
              ))}
            </div>
          </div>}
        </div>
      </section>
    </div>
  );
}
