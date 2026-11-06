import { useState } from 'react';
import { History } from 'lucide-react';
import { api } from '../services/api';
import { useAsync, useDebounced } from '../hooks/useAsync';
import { Async, Card, DataTable, EmptyState, Input, PageHeader, Pagination, Select } from '../components/ui';
import { dateTime } from '../utils/format';

const GROUPS = [['', 'All activity'], ['auth.', 'Sign-ins'], ['product.', 'Products'], ['sale.', 'Sales & refunds'], ['inventory.', 'Inventory'], ['employee.', 'Employees'], ['settings.', 'Settings']];

export default function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const state = useAsync(() => api.get('/audit', { page, pageSize: 25, action, q: dq }), [page, action, dq]);
  return (
    <div>
      <PageHeader title="Activity log" subtitle="Who did what, and when. Entries cannot be edited or deleted." />
      <Card>
        <div className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row">
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by person or description" aria-label="Search activity" className="sm:max-w-xs" />
          <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter by type" className="sm:max-w-[200px]">{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
        <Async state={state}>
          {(d) => (
            <>
              <DataTable
                rows={d.rows}
                empty={<EmptyState icon={History} title="No activity found" hint="Actions such as sales, price changes and sign-ins will appear here." />}
                columns={[
                  { key: 'createdAt', header: 'When', render: (r) => <span className="num whitespace-nowrap">{dateTime(r.createdAt)}</span> },
                  { key: 'actor', header: 'Who', primary: true, render: (r) => r.actor || 'System' },
                  { key: 'summary', header: 'What happened', render: (r) => r.summary || r.action },
                  { key: 'action', header: 'Type', hideOnMobile: true, render: (r) => <span className="text-xs text-muted">{r.action}</span> },
                ]}
              />
              <Pagination page={page} limit={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </div>
  );
}
