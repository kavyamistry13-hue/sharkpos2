import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { Badge, Button, PageHeader, Tabs } from '../components/ui';
import { LogoMark, Wordmark } from '../components/Logo';
import Overview from './platform/Overview';
import Businesses from './platform/Businesses';
import Plans from './platform/Plans';

/** Platform administration — SHARKPOS 2 staff only. The API enforces this; the page is just the interface. */
export default function Platform() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState('overview');
  return (
    <div className="min-h-full bg-canvas">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-white px-4 sm:px-6">
        <LogoMark size={28} /><Wordmark /><Badge tone="info">Platform admin</Badge>
        <span className="ml-auto hidden text-sm text-muted sm:inline">{user.name}</span>
        <Button variant="secondary" size="sm" className="ml-auto sm:ml-0" onClick={logout}><LogOut className="size-4" aria-hidden="true" />Sign out</Button>
      </header>
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Platform" subtitle="Every business, subscription and plan on SHARKPOS 2." />
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'businesses', label: 'Businesses' }, { value: 'plans', label: 'Plans' }]} />
        {tab === 'overview' && <Overview />}
        {tab === 'businesses' && <Businesses />}
        {tab === 'plans' && <Plans />}
      </main>
    </div>
  );
}
