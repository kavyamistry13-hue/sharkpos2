import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info };
const TONE = { success: 'text-ok', error: 'text-bad', info: 'text-brand' };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((type, message) => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs.slice(-3), { id, type, message }]);
    setTimeout(() => dismiss(id), type === 'error' ? 6500 : 4000);
  }, [dismiss]);
  const api = useMemo(() => ({ success: (m) => push('success', m), error: (m) => push('error', m), info: (m) => push('info', m) }), [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 sm:w-96" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.type];
          return (
            <div key={t.id} className="toast-in flex items-start gap-3 rounded-xl border border-line bg-white p-3.5 shadow-lg">
              <Icon className={`mt-0.5 size-5 shrink-0 ${TONE[t.type]}`} aria-hidden="true" />
              <p className="flex-1 text-sm leading-snug">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="text-muted hover:text-text" aria-label="Dismiss notification"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
