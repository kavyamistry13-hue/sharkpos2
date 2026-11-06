import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { site } from '../../siteConfig';
import { LEGAL } from './legalContent';

const ORDER = [['terms', 'Terms of Service'], ['privacy', 'Privacy Policy'], ['refunds', 'Refunds & Cancellation']];

/** Renders one legal document. Every page carries a visible DRAFT notice until the owner has had it reviewed. */
export default function Legal({ doc }) {
  const d = LEGAL[doc];
  usePageTitle(d.title, d.summary);
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div role="note" className="mb-6 flex gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-sm text-warn">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <p><strong>Draft for review.</strong> This text has not been reviewed or approved by a lawyer and is not legal advice. Items in [square brackets] still need to be filled in. Do not rely on it until it has been checked.</p>
      </div>
      <h1 className="text-3xl font-extrabold tracking-tight">{d.title}</h1>
      <p className="mt-1 text-sm text-muted">Last updated: {site.lastUpdated}</p>
      <nav aria-label="Legal pages" className="mt-4 flex flex-wrap gap-2 text-sm">
        {ORDER.map(([k, l]) => <Link key={k} to={`/${k}`} aria-current={k === doc ? 'page' : undefined} className={`rounded-full border px-3 py-1.5 font-semibold ${k === doc ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-text'}`}>{l}</Link>)}
      </nav>
      <div className="mt-8 space-y-7">
        {d.sections.map((s) => (
          <section key={s.heading}><h2 className="text-lg font-bold">{s.heading}</h2>{s.paras.map((p) => <p key={p} className="mt-2 leading-relaxed text-text/90">{p}</p>)}</section>
        ))}
      </div>
    </div>
  );
}
