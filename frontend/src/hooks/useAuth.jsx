import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, refreshSession, tokenStore } from '../services/api';
import { createOfflineRuntime } from '../services/offline/index.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  // Offline POS (Phase 17D): one runtime per page. Its scope comes ONLY from the authenticated user object below; it starts when a user is
  // signed in and stops when none is. Unsynced sales stay on the device across sign-out (see logout).
  const offlineRef = useRef(null);
  if (!offlineRef.current) offlineRef.current = createOfflineRuntime({ api });
  const offline = offlineRef.current;

  // On first load, try to restore the session from the refresh cookie.
  useEffect(() => {
    let live = true;
    refreshSession().then((r) => { if (live && r) setUser(r.user); }).finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!user) { offline.stop(); return undefined; }
    offline.start(user).catch(() => {});                     // offline support is an extra: a failure here must never block the app
    return () => { offline.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user && user.id, user && user.businessId]);

  /**
   * Signs out. If sales made offline have NOT reached the server yet, nothing happens and { blocked: true, unsynced } comes back so the
   * screen can warn; signing out with { force: true } keeps those sales on this device (they sync after this same user signs in again).
   */
  const logout = useCallback(async ({ force = false } = {}) => {
    const info = await offline.prepareLogout().catch(() => ({ unsynced: 0 }));
    if (info.unsynced > 0 && !force) return { blocked: true, ...info };
    try { await api.post('/auth/logout'); } catch { /* session may already be gone */ }
    await offline.completeLogout().catch(() => {});          // deletes the product cache; keeps unsynced sales
    tokenStore.clear();
    setUser(null);
    return { ok: true };
  }, [offline]);
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

  const value = useMemo(() => ({ user, ready, login, register, logout, offline, isRole: (...roles) => !!user && roles.includes(user.role) }), [user, ready, login, register, logout, offline]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
