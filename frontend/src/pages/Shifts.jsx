import { useState } from 'react';
import { DoorClosed, DoorOpen } from 'lucide-react';
import { api } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { Async, Badge, Button, Card, CardHeader, DataTable, Field, Input, Modal, PageHeader, Select, Stat, Textarea } from '../components/ui';
import { dateTime, inr } from '../utils/format';

function Summary({ s }) {
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      {[['Bills', s.sales.count], ['Billed', inr(s.sales.billedTotal, 2)], ['Refunds', inr(s.sales.refunds, 2)], ['Udhaar given', inr(s.creditGiven, 2)], ['Cash sales', inr(s.cashSales, 2)], ['Cash udhaar payments', inr(s.cashCreditPayments, 2)], ['Cash refunds', inr(s.cashRefunds, 2)], ['Expected in drawer', inr(s.expectedCash, 2)]].map(([k, v]) => (
        <div key={k} className="rounded-lg border border-line p-2.5"><dt className="text-xs text-muted">{k}</dt><dd className="font-bold num">{v}</dd></div>))}
    </dl>
  );
}

function CloseModal({ shift, onClose, onDone }) {
  const { user } = useAuth();
  const toast = useToast();
  const isMgr = user.role !== 'cashier';
  const staff = useAsync(() => (isMgr ? api.get('/employees') : Promise.resolve({ rows: [] })), []);
  const [f, setF] = useState({ countedCash: '', notes: '', handoverTo: '', handoverNote: '' });
  const [busy, setBusy] = useState(false);
  const expected = shift.expectedCash;
  const variance = f.countedCash === '' || expected === null ? null : Math.round((Number(f.countedCash) - expected) * 100) / 100;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      await api.post(`/shifts/${shift.id}/close`, { countedCash: Number(f.countedCash), notes: f.notes || undefined, handoverTo: f.handoverTo ? Number(f.handoverTo) : null, handoverNote: f.handoverNote || undefined });
      toast.success('Shift closed.'); onDone();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const people = ((staff.data && staff.data.rows) || []).filter((p) => p.isActive !== false && p.id !== shift.cashierId);
  return (
    <Modal open onClose={onClose} title={`Close shift · ${shift.cashier}`}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-muted">Expected in drawer: <b className="num text-text">{inr(expected, 2)}</b> (opening {inr(shift.openingCash, 2)} + cash movement). Count the drawer and enter what is really there.</p>
        <Field label="Counted cash (₹)"><Input autoFocus inputMode="decimal" value={f.countedCash} onChange={(e) => setF({ ...f, countedCash: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        {variance !== null && <p className={`text-sm font-semibold num ${variance === 0 ? 'text-ok' : 'text-bad'}`}>{variance === 0 ? 'Matches.' : variance > 0 ? `Over by ${inr(variance, 2)}` : `Short by ${inr(-variance, 2)}`}</p>}
        <Field label={variance ? 'Reason for the difference (required)' : 'Note (optional)'}><Textarea rows={2} maxLength={500} value={f.notes} onChange={set('notes')} /></Field>
        {isMgr && <Field label="Hand over to (optional)"><Select value={f.handoverTo} onChange={set('handoverTo')}><option value="">Nobody in particular</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
        <Field label="Handover note (optional)" hint="Anything the next person should know: pending bills, customer promises, low stock."><Textarea rows={2} maxLength={500} value={f.handoverNote} onChange={set('handoverNote')} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={f.countedCash === '' || (variance !== null && variance !== 0 && f.notes.trim().length < 3)}>Close shift</Button></div>
      </form>
    </Modal>
  );
}

export default function Shifts() {
  const { user } = useAuth();
  const toast = useToast();
  const cur = useAsync(() => api.get('/shifts/current'), []);
  const hist = useAsync(() => api.get('/shifts', { status: 'closed', limit: 30 }), []);
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(null);
  const [view, setView] = useState(null);
  const refresh = () => { cur.reload(); hist.reload(); };
  const open = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.post('/shifts/open', { openingCash: Number(opening || 0) }); toast.success('Shift started.'); setOpening(''); refresh(); }
    catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const cols = [
    { key: 'c', header: 'Cashier', render: (r) => r.cashier },
    { key: 'o', header: 'Opened', render: (r) => dateTime(r.openedAt) },
    { key: 'x', header: 'Closed', render: (r) => dateTime(r.closedAt) },
    { key: 'e', header: 'Expected', align: 'right', render: (r) => <span className="num">{inr(r.expectedCash, 2)}</span> },
    { key: 'n', header: 'Counted', align: 'right', render: (r) => <span className="num">{inr(r.countedCash, 2)}</span> },
    { key: 'v', header: 'Variance', align: 'right', render: (r) => <Badge tone={r.variance === 0 ? 'ok' : 'bad'}>{inr(r.variance, 2)}</Badge> },
    { key: 'h', header: 'Handed to', render: (r) => (r.handoverTo ? r.handoverTo.name : '—') },
  ];
  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PageHeader title="Shifts" subtitle={user.role === 'cashier' ? 'Start your shift, close it with a cash count, and hand over.' : 'Every cashier’s shifts, cash counts and handovers.'} />
      <Async state={cur} rows={3}>
        {({ shift, suggestedOpeningCash }) => shift ? (
          <Card>
            <CardHeader title={`Your shift is open since ${dateTime(shift.openedAt)}`} subtitle={`Opening cash ${inr(shift.openingCash, 2)}`} action={<Button onClick={() => setClosing(shift)}><DoorClosed className="size-4" aria-hidden="true" />Close shift</Button>} />
            <div className="p-4 pt-0"><Summary s={shift.summary} /></div>
          </Card>
        ) : (
          <Card>
            <CardHeader title="You have no open shift" subtitle={`Last counted cash was ${inr(suggestedOpeningCash, 2)}.`} />
            <form onSubmit={open} className="flex flex-wrap items-end gap-3 p-4 pt-0">
              <Field label="Opening cash in drawer (₹)"><Input inputMode="decimal" placeholder={String(suggestedOpeningCash)} value={opening} onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
              <Button type="submit" loading={busy}><DoorOpen className="size-4" aria-hidden="true" />Start shift</Button>
            </form>
          </Card>
        )}
      </Async>
      <Card>
        <CardHeader title="Closed shifts" subtitle="A closed shift is a record and cannot be edited." />
        <Async state={hist} rows={3}>{(h) => <DataTable rows={h.rows} columns={cols} onRowClick={setView} empty={<p className="px-5 pb-4 text-sm text-muted">No closed shifts yet.</p>} />}</Async>
      </Card>
      {closing && <CloseModal shift={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refresh(); }} />}
      {view && <Modal open onClose={() => setView(null)} title={`${view.cashier} · ${dateTime(view.openedAt)}`} footer={<Button onClick={() => setView(null)}>Close</Button>}>
        <div className="space-y-3 text-sm">{view.summary && <Summary s={view.summary} />}
          {view.notes && <p><b>Note:</b> {view.notes}</p>}
          {view.handoverNote && <p><b>Handover{view.handoverTo ? ` to ${view.handoverTo.name}` : ''}:</b> {view.handoverNote}</p>}
          {view.closedBy && <p className="text-muted">Closed by {view.closedBy}</p>}</div></Modal>}
    </div>
  );
}
