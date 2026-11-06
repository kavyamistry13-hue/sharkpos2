import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from './useAuth';

const Ctx = createContext({ status: null, reload: () => {} });
export const useBilling = () => useContext(Ctx);

/** Subscription status for the signed-in business (used for the banner, locked features and the renew screen). */
export function BillingProvider({ children }) {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const reload = useCallback(async () => {
    if (!user || user.role === 'platform_admin') { setStatus(null); return null; }
    try { const s = await api.get('/billing/status'); setStatus(s); return s; } catch { return null; }
  }, [user]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    window.addEventListener('sharkpos:billing-changed', reload);
    return () => window.removeEventListener('sharkpos:billing-changed', reload);
  }, [reload]);
  const value = useMemo(() => ({ status, reload }), [status, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
