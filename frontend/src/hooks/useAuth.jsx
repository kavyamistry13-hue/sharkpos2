import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, tokenStore } from '../services/api';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // On first load, try to restore the session from the refresh cookie.
  useEffect(() => {
    let live = true;
    refreshSession().then((r) => { if (live && r) setUser(r.user); }).finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* session may already be gone */ }
    tokenStore.clear();
    setUser(null);
  }, []);
  useEffect(() => {
    const h = () => { tokenStore.clear(); setUser(null); };
    window.addEventListener('sharkpos:unauthorized', h);
    return () => window.removeEventListener('sharkpos:unauthorized', h);
  }, []);

  /** Returns { user } on success or { businesses } when the account belongs to several businesses. */
  const login = useCallback(async (email, password, businessId) => {
    const r = await api.post('/auth/login', { email, password, ...(businessId ? { businessId } : {}) });
    if (r.needsBusiness) return { businesses: r.businesses };
    tokenStore.set(r.accessToken);
    setUser(r.user);
    return { user: r.user };
  }, []);

  const register = useCallback(async (payload) => {
    const r = await api.post('/auth/register', payload);
    tokenStore.set(r.accessToken);
    setUser(r.user);
    return r.user;
  }, []);

  const value = useMemo(() => ({ user, ready, login, register, logout, isRole: (...roles) => !!user && roles.includes(user.role) }), [user, ready, login, register, logout]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
