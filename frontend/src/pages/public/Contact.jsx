import { Mail } from 'lucide-react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { site } from '../../siteConfig';

export default function Contact() {
  usePageTitle('Contact', 'How to reach SHARKPOS support.');
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-extrabold tracking-tight">Contact us</h1>
      <p className="mt-3 text-muted">Questions about plans, billing or your account? Write to us and include your business name.</p>
      <div className="mt-8 space-y-4 rounded-2xl border border-line p-5">
        <p className="flex items-start gap-3"><Mail className="mt-0.5 size-5 text-brand" aria-hidden="true" /><span>{site.supportEmail ? <a className="font-semibold text-brand underline" href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a> : <span className="text-muted">[Support email — to be added before launch]</span>}</span></p>
        <p className="text-sm text-muted"><strong className="text-text">{site.legalEntity}</strong><br />{site.address}</p>
      </div>
      <p className="mt-4 text-sm text-muted">Please never email your password or full card number. We will never ask for them.</p>
    </div>
  );
}
