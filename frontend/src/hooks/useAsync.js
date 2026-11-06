import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads data on mount / when deps change. Returns { data, error, loading, reload }. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return fn().then(
      (data) => { if (id === seq.current) setState({ data, error: null, loading: false }); },
      (error) => { if (id === seq.current) setState((s) => ({ data: s.data, error, loading: false })); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
