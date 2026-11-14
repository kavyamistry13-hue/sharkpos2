import { useSyncExternalStore } from 'react';
import { useAuth } from './useAuth';

/** The offline runtime plus its live state: { offline (methods), state, status, unsynced, isOffline }. Re-renders when the queue or connection changes. */
export function useOffline() {
  const { offline } = useAuth();
  const state = useSyncExternalStore(offline.subscribe, offline.getSnapshot, offline.getSnapshot);
  return { offline, state, status: state.status, unsynced: state.unsynced, isOffline: state.available && offline.isOffline() };
}
