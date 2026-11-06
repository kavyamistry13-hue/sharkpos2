import { useEffect, useId, useRef } from 'react';
import { AlertTriangle, Lock, Inbox, Loader2, X, ChevronLeft, ChevronRight } from 'lucide-react';

const cx = (...a) => a.filter(Boolean).join(' ');

export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const sizes = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' };
  const variants = {
    primary: 'bg-brand text-white hover:bg-brand-dark',
    dark: 'bg-ink-900 text-white hover:bg-ink-700',
    secondary: 'bg-white text-text border border-line hover:bg-canvas',
    ghost: 'text-muted hover:bg-line-soft hover:text-text',
    danger: 'bg-bad text-white hover:bg-[#8f2a1a]',
    success: 'bg-ok text-white hover:bg-[#12583a]',
  };
  return (
    <button disabled={disabled || loading} className={cx(base, sizes[size], variants[variant], className)} {...rest}>
      {loading && <Loader2 className="size-4 spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export const Card = ({ className, children, ...rest }) => (
  <section className={cx('rounded-xl border border-line bg-white', className)} {...rest}>{children}</section>
);

export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  neutral: 'bg-line-soft text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  dark: 'bg-ink-900 text-white',
};
export function Badge({ tone = 'neutral', dot, children, className }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

const SEVERITY_TONE = { low: 'ok', medium: 'warn', high: 'bad', critical: 'dark', healthy: 'ok', warning: 'warn', critical_: 'bad' };
export const RiskBadge = ({ level }) => (
  <Badge tone={level === 'critical' ? 'bad' : level === 'high' ? 'bad' : level === 'medium' ? 'warn' : 'ok'} dot>
    {level === 'critical' ? 'Critical risk' : level === 'high' ? 'High risk' : level === 'medium' ? 'Medium risk' : 'Low risk'}
  </Badge>
);
export const StockBadge = ({ status }) => {
  const map = { healthy: ['ok', 'Healthy'], warning: ['warn', 'Warning'], critical: ['bad', 'Critical'] };
  const [tone, label] = map[status] || ['neutral', status];
  return <Badge tone={tone} dot>{label}</Badge>;
};
export { SEVERITY_TONE };

export const Spinner = ({ className }) => <Loader2 className={cx('size-5 spin text-muted', className)} aria-label="Loading" />;
export const Skeleton = ({ className }) => <div className={cx('skeleton', className)} aria-hidden="true" />;

export function LoadingBlock({ rows = 4 }) {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-full bg-line-soft text-muted"><Icon className="size-6" aria-hidden="true" /></div>
      <p className="font-semibold">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, code }) {
  if (code === 'PLAN_FEATURE' || code === 'PLAN_LIMIT') {
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center" role="alert">
        <div className="mb-3 grid size-12 place-items-center rounded-full bg-info-soft text-info"><Lock className="size-6" aria-hidden="true" /></div>
        <p className="font-semibold">{message}</p>
        <a href="/billing" className="mt-4 inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:opacity-90">See plans</a>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center" role="alert">
      <div className="mb-3 grid size-12 place-items-center rounded-full bg-bad-soft text-bad"><AlertTriangle className="size-6" aria-hidden="true" /></div>
      <p className="font-semibold">{message || 'Something went wrong.'}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** Renders loading / error / content for a useAsync result. */
export function Async({ state, errorText, rows, children, empty }) {
  if (state.loading && !state.data) return <LoadingBlock rows={rows} />;
  if (state.error && !state.data) return <ErrorState message={state.error.code === 'PLAN_FEATURE' ? state.error.message : (errorText || state.error.message)} code={state.error.code} onRetry={state.reload} />;
  if (empty && empty(state.data)) return empty.node;
  return children(state.data);
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setTimeout(() => ref.current && ref.current.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 30);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev && prev.focus && prev.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl', w)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-lg font-bold">{title}</h2>
          <button data-close onClick={onClose} className="rounded-md p-1 text-muted hover:bg-line-soft" aria-label="Close dialog"><X className="size-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, className }) {
  const id = useId();
  const child = children && children.type ? { ...children, props: { ...children.props, id, 'aria-invalid': error ? true : undefined } } : children;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[13px] font-semibold">{label}</label>
      {child}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p className="mt-1 text-xs font-medium text-bad" role="alert">{error}</p>}
    </div>
  );
}

const inputCls = 'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm placeholder:text-[#8b9aa5] focus:border-brand';
export const Input = ({ className, ...p }) => <input className={cx(inputCls, className)} {...p} />;
export const Select = ({ className, children, ...p }) => <select className={cx(inputCls, 'pr-8', className)} {...p}>{children}</select>;
export const Textarea = ({ className, ...p }) => <textarea className={cx(inputCls, 'h-auto py-2', className)} {...p} />;

export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-white p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={cx('rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors', value === o.value ? 'bg-ink-900 text-white' : 'text-muted hover:text-text')}>
          {o.label}{o.count !== undefined && <span className="ml-1.5 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs({ value, onChange, tabs }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors', value === t.value ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-text')}>
          {t.label}{t.count !== undefined && <span className="ml-2 rounded-full bg-line-soft px-1.5 py-0.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
      <span className="text-muted">Page {page} of {pages} · {total.toLocaleString('en-IN')} results</span>
      <div className="flex gap-1">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, loading }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <p className="text-sm text-muted">{message}</p>
    </Modal>
  );
}

/** Table on desktop; stacked cards on mobile. columns: [{key, header, render?, className?, primary?, hideOnMobile?}] */
export function DataTable({ columns, rows, rowKey = 'id', onRowClick, empty }) {
  if (!rows.length) return empty || <EmptyState title="Nothing to show" />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-line bg-canvas/70 text-left text-[13px] font-semibold text-muted">
              {columns.map((c) => <th key={c.key} scope="col" className={cx('px-5 py-2.5', c.align === 'right' && 'text-right', c.className)}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[rowKey]} onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cx('border-b border-line-soft last:border-0', onRowClick && 'cursor-pointer hover:bg-brand-soft/40')}>
                {columns.map((c) => <td key={c.key} className={cx('px-5 py-3 align-middle', c.align === 'right' && 'text-right num', c.className)}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line-soft md:hidden">
        {rows.map((r) => (
          <li key={r[rowKey]} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx('space-y-1.5 px-4 py-3', onRowClick && 'cursor-pointer active:bg-brand-soft/40')}>
            {columns.filter((c) => !c.hideOnMobile).map((c, i) => (
              <div key={c.key} className={cx('flex items-start justify-between gap-3 text-sm', i === 0 && 'font-semibold')}>
                {i === 0 ? null : <span className="text-muted">{c.header}</span>}
                <span className={cx(i === 0 ? 'w-full' : 'text-right num')}>{c.render ? c.render(r) : r[c.key]}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Stat({ label, value, sub, tone, icon: Icon }) {
  const toneCls = { bad: 'text-bad', warn: 'text-warn', ok: 'text-ok', info: 'text-brand' }[tone];
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-muted"><span>{label}</span>{Icon && <Icon className={cx('size-4', toneCls)} aria-hidden="true" />}</div>
      <p className={cx('mt-1.5 text-[26px] font-bold leading-none tracking-tight num', toneCls)}>{value}</p>
      {sub && <p className="mt-2 text-xs text-muted">{sub}</p>}
    </div>
  );
}

export function Meter({ value, tone }) {
  const color = tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-[#c98500]' : 'bg-ok';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft" role="img" aria-label={`${Math.round(value)} percent`}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${Math.min(100, Math.max(2, value))}%` }} />
    </div>
  );
}
export { cx };
