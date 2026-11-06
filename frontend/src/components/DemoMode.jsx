import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { api } from '../services/api';
import { useToast } from '../hooks/useToast';
import { Button, ConfirmDialog } from './ui';

/** Loads the prepared demo dataset. Also used as "Reset demo data" in Settings. */
export function DemoModeButton({ label = 'Demo mode', variant = 'secondary', size = 'sm', reset }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const toast = useToast();
  useEffect(() => { api.get('/demo/status').then((s) => setEnabled(!!s.enabled)).catch(() => setEnabled(false)); }, []);
  if (!enabled) return null;
  const run = async () => {
    setLoading(true);
    try {
      const r = await api.post('/demo/load', { confirm: true });
      toast.success(`Demo data loaded: ${r.summary.sales.toLocaleString('en-IN')} sales, ${r.summary.products} products.`);
      setTimeout(() => window.location.assign('/'), 600);
    } catch (e) {
      toast.error(e.message);
      setLoading(false);
      setOpen(false);
    }
  };
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}><Database className="size-4" aria-hidden="true" />{label}</Button>
      <ConfirmDialog open={open} onClose={() => !loading && setOpen(false)} loading={loading} danger={reset}
        title={reset ? 'Reset demo data?' : 'Load demo data?'}
        confirmLabel={reset ? 'Reset all data' : 'Load demo data'}
        message="This replaces everything in the database (products, sales, customers, alerts) with the prepared demo store: 134 products, about 25,000 sales over 90 days, and a few suspicious transactions to find. User accounts return to the demo logins. It takes a few seconds."
        onConfirm={run} />
    </>
  );
}
