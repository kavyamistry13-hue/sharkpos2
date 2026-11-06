import { useState } from 'react';
import { Building2, Search } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useToast } from '../../hooks/useToast';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Modal, Pagination, Select } from '../../components/ui';
import { dateOnly, dateTime } from '../../utils/format';

const SUB_TONE = { trialing: 'info', active: 'ok', past_due: 'warn', expired: 'bad', cancelled: 'neutral' };

export default function Businesses() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [confirm, setConfirm] = useState(null);     // { business, status }
  const [extend, setExtend] = useState(null);       // business
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const state = useAsync(() => api.get('/platform/businesses', { page, pageSize: 25, ...(dq ? { q: dq } : {}) }), [page, dq]);

  const act = async (fn, ok) => { setBusy(true); try { await fn(); toast.success(ok); state.reload(); } catch (e) { toast.error(e.message); } finally { setBusy(false); setConfirm(null); setExtend(null); } };
  return (
    <>
      <div className="mb-4 max-w-md">
        <label htmlFor="biz-search" className="sr-only">Search businesses</label>
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input id="biz-search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by business, owner or email" className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm" /></div>
      </div>
      <Card>
        <Async state={state}>{(d) => (
          <>
            <DataTable rows={d.rows} empty={<EmptyState icon={Building2} title={dq ? 'No business matches your search' : 'No businesses yet'} />} columns={[
              { key: 'name', header: 'Business', primary: true, render: (r) => <span className="font-semibold">{r.name}{r.isDemo && <Badge className="ml-2">Demo</Badge>}<span className="block text-xs font-normal text-muted">{r.owner} · {r.ownerEmail}</span></span> },
              { key: 'plan', header: 'Plan', render: (r) => r.plan || '—' },
              { key: 'subscription', header: 'Subscription', render: (r) => r.subscription ? <Badge tone={SUB_TONE[r.subscription]} dot>{r.subscription.replace('_', ' ')}</Badge> : '—' },
              { key: 'trialEnd', header: 'Trial / paid until', hideOnMobile: true, render: (r) => dateOnly(r.subscription === 'trialing' ? r.trialEnd : r.paidUntil) },
              { key: 'users', header: 'Users' },
              { key: 'status', header: 'Access', render: (r) => <Badge tone={r.status === 'active' ? 'ok' : 'bad'} dot>{r.status}</Badge> },
              { key: 'lastActive', header: 'Last active', hideOnMobile: true, render: (r) => dateTime(r.lastActive) },
              { key: 'actions', header: '', render: (r) => (
                <span className="flex flex-wrap justify-end gap-2">
                  {['trialing', 'expired', 'cancelled'].includes(r.subscription) && <Button size="sm" variant="secondary" onClick={() => { setDays('7'); setExtend(r); }}>Extend trial</Button>}
                  {r.status === 'active' ? <Button size="sm" variant="secondary" onClick={() => setConfirm({ business: r, status: 'suspended' })}>Suspend</Button> : <Button size="sm" onClick={() => setConfirm({ business: r, status: 'active' })}>Activate</Button>}
                </span>) },
            ]} />
            <Pagination page={page} limit={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}</Async>
      </Card>
      <ConfirmDialog open={!!confirm} danger={confirm?.status === 'suspended'} loading={busy} onClose={() => setConfirm(null)}
        title={confirm?.status === 'suspended' ? 'Suspend this business?' : 'Activate this business?'}
        message={confirm ? (confirm.status === 'suspended' ? `${confirm.business.name} will be locked out until you activate it again. Its data is not deleted.` : `${confirm.business.name} will be able to sign in again.`) : ''}
        confirmLabel={confirm?.status === 'suspended' ? 'Suspend' : 'Activate'}
        onConfirm={() => act(() => api.post(`/platform/businesses/${confirm.business.id}/status`, { status: confirm.status }), `${confirm.business.name} is now ${confirm.status}.`)} />
      <Modal open={!!extend} onClose={() => setExtend(null)} title="Extend free trial" size="sm"
        footer={<><Button variant="secondary" onClick={() => setExtend(null)}>Cancel</Button><Button loading={busy} onClick={() => act(() => api.post(`/platform/businesses/${extend.id}/extend-trial`, { days: Number(days) }), `Trial extended by ${days} days.`)}>Extend</Button></>}>
        <p className="mb-3 text-sm text-muted">{extend?.name}. Days are added to the end of the current trial, or from today if it has already ended. Not available for paying businesses.</p>
        <Field label="Extra days"><Select value={days} onChange={(e) => setDays(e.target.value)}>{[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
      </Modal>
    </>
  );
}
