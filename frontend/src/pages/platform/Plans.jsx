import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { useToast } from '../../hooks/useToast';
import { Async, Badge, Button, Card, Field, Input, Modal } from '../../components/ui';
import { inr } from '../../utils/format';

const LIMITS = [['maxUsers', 'Staff logins'], ['maxProducts', 'Products'], ['maxStores', 'Stores']];
const FLAGS = [['advancedReports', 'Advanced reports'], ['aiInsights', 'AI insights & Risk Center'], ['advancedAi', 'Advanced AI']];
const blank = { code: '', name: '', price: '0', intervalDays: '30', features: { maxUsers: 2, maxProducts: 500, maxStores: 1, aiInsights: false, advancedReports: false, advancedAi: false }, highlights: '', sortOrder: '10', isActive: true };
const toForm = (p) => ({ code: p.code, name: p.name, price: String(p.pricePaise / 100), intervalDays: String(p.intervalDays), features: { ...p.features }, highlights: (p.highlights || []).join('\n'), sortOrder: String(p.sortOrder), isActive: p.isActive });

export default function Plans() {
  const toast = useToast();
  const state = useAsync(() => api.get('/platform/plans'), []);
  const [edit, setEdit] = useState(null);      // { id|null, form }
  const [busy, setBusy] = useState(false);
  const f = edit?.form;
  const setF = (patch) => setEdit({ ...edit, form: { ...f, ...patch } });
  const setFeat = (k, v) => setF({ features: { ...f.features, [k]: v } });

  const save = async () => {
    const price = Number(f.price);
    if (!f.name.trim() || !Number.isFinite(price) || price < 0) return toast.error('Enter a name and a valid price.');
    const body = { name: f.name.trim(), pricePaise: Math.round(price * 100), intervalDays: Number(f.intervalDays), features: f.features, highlights: f.highlights.split('\n').map((x) => x.trim()).filter(Boolean), sortOrder: Number(f.sortOrder), isActive: f.isActive };
    setBusy(true);
    try {
      if (edit.id) await api.put(`/platform/plans/${edit.id}`, body); else await api.post('/platform/plans', { code: f.code.trim(), ...body });
      toast.success('Plan saved. Public pricing is updated.'); setEdit(null); state.reload();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Prices, limits and features are stored in the database and take effect immediately. A new price is charged from each business’s next payment; it never changes a period already paid.</p>
        <Button onClick={() => setEdit({ id: null, form: blank })}><Plus className="size-4" aria-hidden="true" />New plan</Button>
      </div>
      <Async state={state} rows={3}>{(d) => (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d.plans.map((p) => (
            <Card key={p.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2"><h3 className="text-lg font-bold">{p.name}</h3><Badge tone={p.isActive ? 'ok' : 'neutral'} dot>{p.isActive ? 'On sale' : 'Hidden'}</Badge></div>
              <p className="mt-1 text-2xl font-extrabold num">{inr(p.pricePaise / 100)}<span className="text-sm font-medium text-muted"> / {p.intervalDays} days</span></p>
              <p className="mt-1 text-xs text-muted">code <code>{p.code}</code> · {p.subscribers} business{p.subscribers === 1 ? '' : 'es'}</p>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-muted">
                <li>{p.features.maxUsers ?? 'Unlimited'} users · {p.features.maxProducts ?? 'Unlimited'} products · {p.features.maxStores ?? 'Unlimited'} store(s)</li>
                <li>{FLAGS.filter(([k]) => p.features[k]).map(([, l]) => l).join(', ') || 'No extra features'}</li>
              </ul>
              <Button variant="secondary" className="mt-4" onClick={() => setEdit({ id: p.id, form: toForm(p) })}>Edit</Button>
            </Card>
          ))}
        </div>
      )}</Async>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${f?.name}` : 'New plan'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save plan</Button></>}>
        {f && (
          <div className="grid gap-4 sm:grid-cols-2">
            {!edit.id && <Field label="Code" hint="Lower-case letters, digits, underscore. Cannot be changed later."><Input value={f.code} onChange={(e) => setF({ code: e.target.value })} placeholder="growth" /></Field>}
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ name: e.target.value })} /></Field>
            <Field label="Price (₹)"><Input type="number" inputMode="decimal" min="0" step="1" value={f.price} onChange={(e) => setF({ price: e.target.value })} /></Field>
            <Field label="Billing period (days)"><Input type="number" inputMode="numeric" min="1" max="366" value={f.intervalDays} onChange={(e) => setF({ intervalDays: e.target.value })} /></Field>
            {LIMITS.map(([k, label]) => (
              <Field key={k} label={`${label} limit`} hint="Leave empty for unlimited.">
                <Input type="number" inputMode="numeric" min="0" value={f.features[k] ?? ''} onChange={(e) => setFeat(k, e.target.value === '' ? null : Number(e.target.value))} placeholder="Unlimited" />
              </Field>
            ))}
            <Field label="Sort order"><Input type="number" inputMode="numeric" value={f.sortOrder} onChange={(e) => setF({ sortOrder: e.target.value })} /></Field>
            <fieldset className="sm:col-span-2"><legend className="mb-1 text-[13px] font-semibold">Features</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">{FLAGS.map(([k, label]) => <label key={k} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={!!f.features[k]} onChange={(e) => setFeat(k, e.target.checked)} />{label}</label>)}</div>
            </fieldset>
            <Field className="sm:col-span-2" label="Bullet points shown on the pricing page" hint="One per line, up to 10."><textarea className="h-28 w-full rounded-lg border border-line px-3 py-2 text-sm" value={f.highlights} onChange={(e) => setF({ highlights: e.target.value })} /></Field>
            <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4" checked={f.isActive} onChange={(e) => setF({ isActive: e.target.checked })} />Offer this plan to new customers <span className="text-muted">(existing subscribers keep it)</span></label>
          </div>
        )}
      </Modal>
    </>
  );
}
