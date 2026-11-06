import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Package, Boxes, Receipt, Users, LineChart, Sparkles, ShieldAlert, UserCog, Settings, HelpCircle, Menu, X, LogOut, Presentation, History, CreditCard } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { LogoMark, Wordmark } from '../components/Logo';
import { Button, Badge } from '../components/ui';
import SubscriptionBanner from '../components/SubscriptionBanner';
import { DemoModeButton } from '../components/DemoMode';
import { initials, cap } from '../utils/format';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['business_owner', 'manager'] },
  { to: '/pos', label: 'POS / Billing', icon: ShoppingCart, roles: ['business_owner', 'manager', 'cashier'] },
  { to: '/products', label: 'Products', icon: Package, roles: ['business_owner', 'manager'] },
  { to: '/inventory', label: 'Inventory', icon: Boxes, roles: ['business_owner', 'manager'] },
  { to: '/sales', label: 'Sales', icon: Receipt, roles: ['business_owner', 'manager', 'cashier'] },
  { to: '/customers', label: 'Customers', icon: Users, roles: ['business_owner', 'manager'] },
  { to: '/analytics', label: 'Analytics', icon: LineChart, roles: ['business_owner', 'manager'] },
  { to: '/copilot', label: 'AI Business Copilot', icon: Sparkles, roles: ['business_owner', 'manager'] },
  { to: '/risk', label: 'Risk Center', icon: ShieldAlert, roles: ['business_owner', 'manager'] },
  { to: '/employees', label: 'Employees', icon: UserCog, roles: ['business_owner', 'manager'] },
  { to: '/audit', label: 'Activity log', icon: History, roles: ['business_owner'] },
  { to: '/billing', label: 'Billing', icon: CreditCard, roles: ['business_owner'] },
  { to: '/settings', label: 'Settings', icon: Settings, roles: ['business_owner', 'manager', 'cashier'] },
  { to: '/why', label: 'Why SHARKPOS AI?', icon: HelpCircle, roles: ['business_owner', 'manager', 'cashier'] },
];

function SideNav({ onNavigate }) {
  const { user } = useAuth();
  return (
    <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
      {NAV.filter((n) => n.roles.includes(user.role)).map((n) => (
        <NavLink key={n.to} to={n.to} onClick={onNavigate}
          className={({ isActive }) => `group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? 'bg-ink-700 text-white' : 'text-[#9db4c4] hover:bg-ink-800 hover:text-white'}`}>
          <n.icon className="size-[18px] shrink-0" aria-hidden="true" />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Sidebar({ onNavigate }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex items-center gap-2.5 px-5 py-5"><LogoMark /><Wordmark dark /></div>
      <SideNav onNavigate={onNavigate} />
      <div className="border-t border-ink-700 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-700 text-[13px] font-bold text-white" aria-hidden="true">{initials(user.name)}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{user.name}</p>
            <p className="text-xs text-[#9db4c4]">{cap(user.role)}</p>
          </div>
          <button onClick={logout} className="rounded-md p-2 text-[#9db4c4] hover:bg-ink-800 hover:text-white" aria-label="Sign out"><LogOut className="size-[18px]" /></button>
        </div>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const [open, setOpen] = useState(false);
  const { user, isRole } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const current = NAV.find((n) => loc.pathname.startsWith(n.to));

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 lg:block"><div className="fixed inset-y-0 w-64"><Sidebar /></div></aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-ink-950/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 shadow-2xl"><Sidebar onNavigate={() => setOpen(false)} /></div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur sm:px-6">
          <button className="rounded-md p-2 text-muted hover:bg-line-soft lg:hidden" onClick={() => setOpen(!open)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <p className="text-sm font-semibold text-muted">{current ? current.label : ''}</p>
          <div className="ml-auto flex items-center gap-2">
            {isRole('business_owner', 'manager') && (
              <Button variant="secondary" size="sm" onClick={() => nav('/present')}><Presentation className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Presentation mode</span></Button>
            )}
            {isRole('business_owner') && <DemoModeButton label="Demo mode" />}
            <Badge tone="info" className="hidden sm:inline-flex">{cap(user.role)}</Badge>
          </div>
        </header>
        <SubscriptionBanner />
        <main className="flex-1 p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
