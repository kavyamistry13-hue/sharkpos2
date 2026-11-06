import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Store, UserRound } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { LogoMark, Wordmark } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';
import { inr } from '../utils/format';
import { API_BASE } from '../services/api';

const STEPS = ['Your details', 'Your business'];

/** Two short steps, one question group per screen, so it is easy to finish on a phone. */
export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ ownerName: '', email: '', phone: '', password: '', businessName: '', address: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState([]);
  const [plan, setPlan] = useState(params.get('plan') || '');
  useEffect(() => {
    fetch(`${API_BASE}/api/plans`).then((r) => r.json()).then((d) => {
      const list = d.plans || [];
      setPlans(list);
      // keep the plan chosen on the pricing page if it still exists; otherwise fall back to Business, then the first plan
      setPlan((p) => (list.some((x) => x.code === p) ? p : (list.find((x) => x.code === 'business') || list[0] || {}).code || ''));
    }).catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const validate = (s) => {
    const e = {};
    if (s === 0) {
      if (f.ownerName.trim().length < 2) e.ownerName = 'Enter your name.';
      if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = 'Enter a valid email.';
      if (f.phone && !/^[0-9+\-\s]{7,15}$/.test(f.phone.trim())) e.phone = 'Enter a valid phone number.';
      if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/[0-9]/.test(f.password)) e.password = 'Use at least 8 characters, with letters and numbers.';
    } else if (f.businessName.trim().length < 2) e.businessName = 'Enter your business name.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = (e) => { e.preventDefault(); if (validate(0)) setStep(1); };
  const submit = async (e) => {
    e.preventDefault();
    if (!validate(1)) return;
    setBusy(true);
    setError('');
    try {
      await register({ ownerName: f.ownerName.trim(), email: f.email.trim(), phone: f.phone.trim() || undefined, password: f.password, businessName: f.businessName.trim(), address: f.address.trim() || undefined, ...(plan ? { plan } : {}) });
      nav('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message);
      if (err.status === 409) setStep(0);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center bg-canvas px-4 py-8 sm:py-14">
      <div className="mb-6 flex items-center gap-2.5"><LogoMark size={34} /><Wordmark /></div>
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-sm sm:p-8">
        <ol className="mb-6 flex items-center gap-2" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2" aria-current={i === step ? 'step' : undefined}>
              <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold ${i <= step ? 'bg-brand text-white' : 'bg-line-soft text-muted'}`}>{i + 1}</span>
              <span className={`text-sm ${i === step ? 'font-semibold' : 'text-muted'}`}>{s}</span>
              {i === 0 && <span className="h-px flex-1 bg-line" aria-hidden="true" />}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <form onSubmit={next} className="space-y-4" noValidate>
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight"><UserRound className="size-5 text-brand" aria-hidden="true" />Create your account</h1>
            <Field label="Your name" error={errors.ownerName}><Input autoComplete="name" value={f.ownerName} onChange={set('ownerName')} placeholder="Rahul Patel" /></Field>
            <Field label="Email" error={errors.email}><Input type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} placeholder="rahul@example.com" /></Field>
            <Field label="Mobile number (optional)" error={errors.phone}><Input type="tel" autoComplete="tel" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="98765 43210" /></Field>
            <Field label="Password" hint="At least 8 characters, with letters and numbers." error={errors.password}><Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
            {error && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">{error}</p>}
            <Button type="submit" size="lg" className="w-full">Continue<ArrowRight className="size-4" aria-hidden="true" /></Button>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight"><Store className="size-5 text-brand" aria-hidden="true" />Tell us about your shop</h1>
            <Field label="Business name" error={errors.businessName}><Input autoComplete="organization" value={f.businessName} onChange={set('businessName')} placeholder="ABC Supermarket" /></Field>
            <Field label="Shop address (optional)" hint="Printed on your invoices."><Input autoComplete="street-address" value={f.address} onChange={set('address')} placeholder="12, MG Road, Bengaluru" /></Field>
            {plans.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-sm font-semibold">Choose a plan <span className="font-normal text-muted">— 14-day free trial, no card needed</span></legend>
                <div className="space-y-2">
                  {plans.map((p) => (
                    <label key={p.code} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${plan === p.code ? 'border-brand bg-brand-soft/40' : 'border-line'}`}>
                      <input type="radio" name="plan" className="sr-only" checked={plan === p.code} onChange={() => setPlan(p.code)} />
                      <span className={`grid size-5 shrink-0 place-items-center rounded-full border ${plan === p.code ? 'border-brand bg-brand text-white' : 'border-line'}`} aria-hidden="true">{plan === p.code && <Check className="size-3" />}</span>
                      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{p.name}</span><span className="block text-xs text-muted">{(p.highlights || []).slice(0, 2).join(' · ')}</span></span>
                      <span className="text-sm font-bold num">{inr(p.price)}<span className="text-xs font-medium text-muted">/mo</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {error && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="lg" onClick={() => setStep(0)} aria-label="Back"><ArrowLeft className="size-4" aria-hidden="true" /></Button>
              <Button type="submit" size="lg" className="flex-1" loading={busy}>Create my business</Button>
            </div>
          </form>
        )}
      </div>
      <p className="mt-5 text-sm text-muted">Already have an account? <Link to="/login" className="font-semibold text-brand hover:underline">Sign in</Link></p>
    </div>
  );
}
