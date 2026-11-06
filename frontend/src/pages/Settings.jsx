import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, CardHeader, Field, Input, PageHeader } from '../components/ui';
import { DemoModeButton } from '../components/DemoMode';

function StoreSettings() {
  const toast = useToast();
  const state = useAsync(() => api.get('/settings'), []);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state.data) setF({ ...state.data, cashierMaxDiscountPct: String(state.data.cashierMaxDiscountPct) }); }, [state.data]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.put('/settings', { ...f, cashierMaxDiscountPct: Number(f.cashierMaxDiscountPct) }); toast.success('Store settings saved.'); state.reload(); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Store" subtitle="Shown on invoices. The discount limit applies at the POS immediately." />
      <Async state={state} rows={4}>{() => f && (
        <form onSubmit={save} className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
          <Field label="Store name"><Input required value={f.storeName} onChange={set('storeName')} /></Field>
          <Field label="GSTIN (optional)"><Input value={f.gstin} onChange={set('gstin')} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.storeAddress} onChange={set('storeAddress')} /></Field>
          <Field label="Invoice footer" className="sm:col-span-2"><Input value={f.invoiceFooter} onChange={set('invoiceFooter')} /></Field>
          <Field label="Cashier discount limit (%)" hint="Above this, a manager or admin must approve at the till. Maximum 30."><Input inputMode="decimal" value={f.cashierMaxDiscountPct} onChange={set('cashierMaxDiscountPct')} /></Field>
          <div className="flex items-end"><Button type="submit" loading={busy}>Save settings</Button></div>
        </form>
      )}</Async>
    </Card>
  );
}

function Password() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.post('/auth/change-password', f); toast.success('Password changed.'); setF({ currentPassword: '', newPassword: '' }); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Change password" />
      <form onSubmit={save} className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
        <Field label="Current password"><Input type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
        <Field label="New password" hint="At least 8 characters."><Input type="password" autoComplete="new-password" required minLength={8} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
        <div><Button type="submit" loading={busy}>Change password</Button></div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const { isRole } = useAuth();
  const ai = useAsync(() => (isRole('business_owner', 'manager') ? api.get('/ai/status') : Promise.resolve(null)), []);
  const demo = useAsync(() => (isRole('business_owner') ? api.get('/demo/status') : Promise.resolve(null)), []);
  return (
    <div className="mx-auto max-w-[900px] space-y-5">
      <PageHeader title="Settings" />
      {isRole('business_owner') && <StoreSettings />}
      <Password />
      {isRole('business_owner', 'manager') && (
        <Card>
          <CardHeader title="AI service" subtitle="Billing, stock, forecasts and risk scores never depend on it." />
          <div className="space-y-2 px-5 pb-5 text-sm">
            <p className="flex items-center gap-2">Language model: {ai.data ? <Badge tone={ai.data.llmConfigured ? 'ok' : 'neutral'} dot>{ai.data.llmConfigured ? `${ai.data.provider} · ${ai.data.model}` : 'Not configured'}</Badge> : '…'}</p>
            <p className="text-muted">Add <code className="rounded bg-line-soft px-1">LLM_API_KEY</code> to <code className="rounded bg-line-soft px-1">backend/.env</code> and restart the API. Without a key, the copilot and daily brief answer from the database directly. If the AI provider fails, the app shows “AI service temporarily unavailable” and keeps working.</p>
          </div>
        </Card>
      )}
      {isRole('business_owner') && (
        <Card>
          <CardHeader title="Demo data" subtitle="For hackathon demos and development." />
          <div className="space-y-3 px-5 pb-5 text-sm">
            <p className="text-muted">Replaces everything with the prepared demo store: 134 products, about 25,000 sales over 90 days, and three suspicious transactions to find.</p>
            {demo.data && !demo.data.enabled ? <p className="font-medium text-warn">Demo mode is disabled on this server.</p> : <DemoModeButton label="Reset demo data" reset variant="danger" size="md" />}
          </div>
        </Card>
      )}
    </div>
  );
}
