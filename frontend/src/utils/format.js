export const inr = (n, d = 0) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const num = (n, d = 0) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d });
export const pct = (n, d = 0) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(d)}%`);
export const signedPct = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n}%`);
export const dateTime = (v) =>
  v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
export const dateOnly = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');
export const initials = (name = '') => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
