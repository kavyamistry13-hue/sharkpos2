import { useEffect, useRef } from 'react';

// USB / Bluetooth "keyboard" scanners type the digits very fast and finish with Enter. Typing INSIDE an input is handled by that input;
// this catches a scan when focus is elsewhere (after tapping a button). Human typing is slower than 60 ms per key, so it never triggers.
// onCode(text) receives the raw text; the caller validates it (cleanCode) and decides what it means.
// Timing uses e.timeStamp (when the key was PRESSED), not the time the handler runs: while the camera decoder or a re-render keeps the main
// thread busy, queued keystrokes run late, and measuring at handling time would wrongly look like a slow human and drop the first digits.
// The listener is attached for the whole life of the page and `enabled` is only checked when Enter arrives. (Toggling the listener itself would
// leave a gap right after a form closes, during which the first digits of an immediate next scan are lost and a TRUNCATED barcode would be accepted.)
export function useWedgeScanner(onCode, enabled = true) {
  const cb = useRef(onCode); cb.current = onCode;
  const on = useRef(enabled); on.current = enabled;
  const w = useRef({ buf: '', last: 0 });
  useEffect(() => {
    const onWin = (e) => {
      const t = e.target; const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || e.ctrlKey || e.metaKey || e.altKey) return;
      const now = e.timeStamp; const s = w.current;
      if (now - s.last > 60) s.buf = '';
      s.last = now;
      if (e.key === 'Enter') {
        const b = s.buf; s.buf = '';
        if (on.current && b.length >= 6 && /^[A-Za-z0-9._/+-]+$/.test(b)) { e.preventDefault(); cb.current(b); }
        return;
      }
      if (e.key.length === 1) s.buf += e.key;
    };
    window.addEventListener('keydown', onWin);
    return () => window.removeEventListener('keydown', onWin);
  }, []);
}
