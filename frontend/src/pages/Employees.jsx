import { useState } from 'react';
import { Pencil, Plus, UserCog } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, DataTable, EmptyState, Field, Input, Modal, PageHeader, RiskBadge, Segmented, Select } from '../components/ui';
import { inr, cap } from '../utils/format';

function EmployeeForm({ emp, onClose, onSaved }) {
  const toast = useToast();
  const { user } = useAuth();
  const [f, setF] = useState(emp ? { name: emp.name, role: emp.role, isActive: emp.isActive, password: '' } : { name: '', email: '', role: 'cashier', password: '', isActive: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      if (emp) await api.put(`/employees/${emp.id}`, { name: f.name, role: f.role, isActive: f.isActive, password: f.password || undefined });
      else await api.post('/employees', f);
      toast.success(emp ? `${f.name} updated.` : `${f.name} added.`); onSaved();
    } catch (err) { toast.error(err.message); setBusy(false); }
  };
  const self = emp && emp.id === user.id;
  return (
    <Modal open onClose={onClose} title={emp ? 'Edit employee' : 'Add employee'} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="emp-form" loading={busy}>{emp ? 'Save changes' : 'Add employee'}</Button></>}>
      <form id="emp-form" onSubmit={submit} className="space-y-3">
        <Field label="Name"><Input required value={f.name} onChange={set('name')} /></Field>
        {!emp && <Field label="Email"><Input type="email" required value={f.email} onChange={set('email')} /></Field>}
        <Field label="Role"><Select value={f.role} onChange={set('role')} disabled={self}><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="business_owner">Owner</option></Select></Field>
        <Field label={emp ? 'New password (optional)' : 'Password'} hint="At least 8 characters."><Input type="password" autoComplete="new-password" required={!emp} minLength={8} value={f.password} onChange={set('password')} /></Field>
        {emp && !self && <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} className="size-4" />Can sign in</label>}
      </form>
    </Modal>
  );
}

export default function Employees() {
  const [days, setDays] = useState(30);
  const state = useAsync(() => api.get('/employees', { days }), [days]);
  const [editing, setEditing] = useState(null);
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Employees" subtitle="Sales performance, discount use and risk by team member." actions={<><Segmented label="Period" value={days} onChange={setDays} options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} /><Button onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add employee</Button></>} />
      <Card>
        <Async state={state} rows={5} errorText="Unable to load employees.">
          {(d) => <DataTable rows={d.rows} columns={[
            { key: 'name', header: 'Employee', render: (r) => <div><p className="font-semibold">{r.name}{!r.isActive && <Badge className="ml-2">Inactive</Badge>}</p><p className="text-xs text-muted">{cap(r.role)} · {r.email}</p></div> },
            { key: 'tx', header: 'Transactions', align: 'right', render: (r) => r.transactions },
            { key: 'rev', header: 'Revenue', align: 'right', render: (r) => <span className="font-semibold">{inr(r.revenue)}</span> },
            { key: 'avg', header: 'Avg transaction', align: 'right', render: (r) => inr(r.avgTransaction) },
            { key: 'disc', header: 'Discounts', align: 'right', render: (r) => <div><p>{inr(r.discounts)}</p><p className="text-xs text-muted">{r.discountVsStore}× store average</p></div> },
            { key: 'ref', header: 'Refunds', align: 'right', render: (r) => r.refunds },
            { key: 'risk', header: 'Risk', render: (r) => <RiskBadge level={r.risk} /> },
            { key: 'edit', header: <span className="sr-only">Edit</span>, align: 'right', render: (r) => <Button variant="ghost" size="sm" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}><Pencil className="size-4" /></Button> },
          ]} empty={<EmptyState icon={UserCog} title="No employees" />} />}
        </Async>
      </Card>
      {editing && <EmployeeForm emp={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); state.reload(); }} />}
    </div>
  );
}
