import { useEffect, useState } from 'react';
import { API_BASE } from '../../services/api';

/** Live plan list from the API — prices, limits and highlights are edited by the platform admin, never hard-coded here. */
export function usePlans() {
  const [s, setS] = useState({ plans: null, error: false });
  useEffect(() => {
    let off = false;
    fetch(`${API_BASE}/api/plans`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad')))).then((d) => { if (!off) setS({ plans: d.plans || [], error: false }); }).catch(() => { if (!off) setS({ plans: null, error: true }); });
    return () => { off = true; };
  }, []);
  return s;
}

/** Turns a plan's feature flags into human rows for the comparison table. Unknown/missing limits read as "Unlimited". */
export const lim = (v, one, many) => (v === null || v === undefined ? 'Unlimited' : `${v} ${v === 1 ? one : many}`);
export const FEATURE_ROWS = [
  { label: 'Staff logins', get: (f) => lim(f.maxUsers, 'user', 'users') },
  { label: 'Products', get: (f) => lim(f.maxProducts, 'product', 'products') },
  { label: 'Advanced reports', get: (f) => f.advancedReports },
  { label: 'AI insights & Risk Center', get: (f) => f.aiInsights },
  { label: 'Advanced AI', get: (f) => f.advancedAi },
];
