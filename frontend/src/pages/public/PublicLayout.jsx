import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { LogoMark, Wordmark } from '../../components/Logo';
import { site } from '../../siteConfig';

const NAV = [{ to: '/#features', label: 'Features' }, { to: '/pricing', label: 'Pricing' }, { to: '/contact', label: 'Contact' }];
const LEGAL = [{ to: '/terms', label: 'Terms of Service' }, { to: '/privacy', label: 'Privacy Policy' }, { to: '/refunds', label: 'Refunds & Cancellation' }];

/** Shared frame for the marketing and legal pages: works from 320 px phones up to wide desktops. */
export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    if (loc.hash) { const el = document.getElementById(loc.hash.slice(1)); if (el) { el.scrollIntoView(); return; } }
    window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  const link = 'rounded-md px-3 py-2 text-sm font-semibold text-muted hover:text-text';
  return (
    <div className="flex min-h-full flex-col bg-white text-text">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:h-16 sm:px-6">
          <Link to="/" className="flex items-center gap-2" aria-label="SHARKPOS home"><LogoMark size={30} /><Wordmark /></Link>
          <nav className="ml-6 hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => <NavLink key={n.to} to={n.to} className={link}>{n.label}</NavLink>)}
          </nav>
          <div className="ml-auto hidden items-center gap-2 md:flex">
            <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-line-soft">Sign in</Link>
            <Link to="/register" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">Start free trial</Link>
          </div>
          <button type="button" className="ml-auto grid size-11 place-items-center rounded-lg hover:bg-line-soft md:hidden" aria-expanded={open} aria-controls="mobile-menu" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(!open)}>
            {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </div>
        {open && (
          <nav id="mobile-menu" className="border-t border-line bg-white px-4 pb-4 pt-2 md:hidden" aria-label="Main">
            {NAV.map((n) => <Link key={n.to} to={n.to} className="block rounded-lg px-3 py-3 text-base font-semibold hover:bg-line-soft">{n.label}</Link>)}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Link to="/login" className="rounded-lg border border-line py-3 text-center font-semibold">Sign in</Link>
              <Link to="/register" className="rounded-lg bg-brand py-3 text-center font-semibold text-white">Start free</Link>
            </div>
          </nav>
        )}
      </header>
      <main id="main" className="flex-1"><Outlet /></main>
      <footer className="border-t border-line bg-canvas">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-2"><LogoMark size={26} /><Wordmark /></div>
            <p className="mt-3 max-w-xs text-sm text-muted">Billing, stock and shop insights for Indian retail — made to run on a phone at the counter.</p>
          </div>
          <nav aria-label="Product"><h2 className="text-sm font-bold">Product</h2><ul className="mt-3 space-y-2 text-sm">
            {NAV.map((n) => <li key={n.to}><Link className="text-muted hover:text-text" to={n.to}>{n.label}</Link></li>)}
            <li><Link className="text-muted hover:text-text" to="/login">Sign in</Link></li>
          </ul></nav>
          <nav aria-label="Legal"><h2 className="text-sm font-bold">Legal</h2><ul className="mt-3 space-y-2 text-sm">
            {LEGAL.map((n) => <li key={n.to}><Link className="text-muted hover:text-text" to={n.to}>{n.label}</Link></li>)}
          </ul></nav>
        </div>
        <div className="border-t border-line px-4 py-4 text-center text-xs text-muted sm:px-6">© {new Date().getFullYear()} {site.legalEntity}. All rights reserved.</div>
      </footer>
    </div>
  );
}
