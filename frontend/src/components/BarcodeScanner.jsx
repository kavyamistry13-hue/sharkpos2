import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CameraOff, CheckCircle2, Flashlight, Keyboard, ScanLine, Volume2, VolumeX, X, XCircle } from 'lucide-react';
import { Button, Input, Spinner, cx } from './ui';
import { cameraSupported, cleanCode, feedback, gs1Valid, isGtinLength, setSoundEnabled, soundEnabled } from '../services/barcode';
import { inr } from '../utils/format';

// Full-screen camera scanner for the Counter. It reads the barcode ALREADY PRINTED on the product (EAN-13/8, UPC, Code 128/39, ITF) —
// nothing has to be printed or created. It keeps scanning after every product so the cashier never leaves this screen until "Done".
//
// Detection: the browser's native BarcodeDetector when it exists (Chrome on Android: hardware-accelerated, best in low light), otherwise
// ZXing (free, MIT) which is downloaded only when the scanner is opened. Both feed the same accept() below.
//
// The parent decides what a code MEANS (find the product, add it to the bill, open "register this barcode"): onCode(code) → Promise<Result>
//   Result = { kind: 'ok' | 'warn' | 'error', title, name?, price?, qty?, detail? }   (shown at the bottom, announced to screen readers)
// Phase 8.1 reuses this same component on the Scan & Add Products page: `embedded` draws it inside the page instead of full-screen, and `title`,
// `hint` and `doneLabel` re-word it. The camera stays on while the parent shows its form (`paused`), so it never restarts between products.

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const SAME_CODE_RELEASE_MS = 1200;     // a barcode stays LOCKED until it has been out of view this long (or a different code is scanned); holding it up never re-counts
const CONFIRM_WINDOW_MS = 1200;        // non-GTIN symbologies need two identical reads inside this window

const CAMERA_HELP = {
  denied: ['Camera permission is off', 'Allow the camera for this site (tap the lock or camera icon next to the address, choose “Allow”), then tap Try again. Or use a USB/Bluetooth scanner, or enter the barcode manually below.'],
  nocamera: ['No camera found', 'This device has no usable camera. Type the barcode below, or use a USB/Bluetooth scanner.'],
  busy: ['The camera is busy', 'Another app is using the camera. Close it, then tap Try again.'],
  unsupported: ['The camera cannot be used here', 'Camera scanning needs a secure (https) page on a device with a camera. Type the barcode below instead.'],
  error: ['The camera could not start', 'Tap Try again. If it keeps failing, type the barcode below.'],
};

export default function BarcodeScanner({ open, onClose, onCode, paused = false, summary, notice = null, embedded = false, title = 'Scan barcode', hint = 'Point the camera at the barcode on the product', doneLabel = null }) {
  const videoRef = useRef(null);
  const [phase, setPhase] = useState('starting');        // starting | ready | denied | nocamera | busy | unsupported | error
  const [result, setResult] = useState(null);
  const [flash, setFlash] = useState(false);
  const [torch, setTorch] = useState({ available: false, on: false });
  const [sound, setSound] = useState(soundEnabled());
  const [manual, setManual] = useState('');
  const [manualErr, setManualErr] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState(false);               // a frame decoder is running

  // refs so the camera loop (created once) always sees the latest props and never restarts when they change
  const onCodeRef = useRef(onCode); onCodeRef.current = onCode;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const queue = useRef(Promise.resolve());
  const seen = useRef({ code: null, acceptedAt: 0, lastSeen: 0 });
  const pending = useRef({ code: null, at: 0 });
  const trackRef = useRef(null);
  // a result the PARENT produced (e.g. a barcode that was just registered and added) is shown like a scan result
  useEffect(() => { if (open && notice) { setResult(notice); feedback(notice.kind === 'ok' ? 'ok' : 'warn'); if (notice.kind === 'ok') { setFlash(true); setTimeout(() => setFlash(false), 280); } } }, [notice, open]);

  const run = useCallback((code) => {
    // sequential: a slow network can never reorder or drop scans; the camera keeps running meanwhile
    queue.current = queue.current.then(() => onCodeRef.current(code)).then((r) => {
      if (!r) return;
      setResult({ ...r, at: Date.now() });
      feedback(r.kind === 'ok' ? 'ok' : r.kind === 'warn' ? 'warn' : 'error');
      if (r.kind === 'ok') { setFlash(true); setTimeout(() => setFlash(false), 280); }
    }).catch((e) => { setResult({ kind: 'error', title: (e && e.message) || 'Could not look that up. Try again.', at: Date.now() }); feedback('error'); });
  }, []);

  /** One decoded value from either detector. Filters misreads, repeats of the same sighting, and single-frame noise. */
  const accept = useCallback((raw) => {
    const code = cleanCode(raw);
    if (!code) return;
    if (pausedRef.current) {                                       // a form/sheet is open: ignore the read, but a locked code still in view stays locked
      if (code === seen.current.code) seen.current.lastSeen = Date.now();
      return;
    }
    if (isGtinLength(code) && !gs1Valid(code)) return;           // check digit wrong → a misread, ignore silently
    const now = Date.now(); const s = seen.current;
    if (code === s.code) {
      const inView = now - s.lastSeen < SAME_CODE_RELEASE_MS;
      s.lastSeen = now;
      if (inView) return;                                          // same barcode still in front of the lens: locked, not a new scan
    }
    if (!isGtinLength(code)) {
      const p = pending.current;
      if (p.code !== code || now - p.at > CONFIRM_WINDOW_MS) { pending.current = { code, at: now }; return; }
    }
    seen.current = { code, acceptedAt: now, lastSeen: now };
    run(code);
  }, [run]);

  useEffect(() => {
    if (!open) return undefined;
    let stopped = false; let stream = null; let controls = null; let timer = null;
    setPhase('starting'); setResult(null); setTorch({ available: false, on: false }); setLive(false);
    seen.current = { code: null, acceptedAt: 0, lastSeen: 0 };

    (async () => {
      if (!cameraSupported()) { setPhase('unsupported'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        if (stopped) return;
        const n = e && e.name;
        setPhase(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nocamera' : n === 'NotReadableError' || n === 'AbortError' ? 'busy' : 'error');
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getVideoTracks()[0]; trackRef.current = track;
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* autofocus control is optional */ }
      try { const caps = track.getCapabilities ? track.getCapabilities() : {}; setTorch({ available: !!caps.torch, on: false }); } catch { /* optional */ }
      const video = videoRef.current;
      if (!video) return;
      setPhase('ready');

      try {
        let detector = null;
        if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
          try {
            const sup = await window.BarcodeDetector.getSupportedFormats();
            const formats = NATIVE_FORMATS.filter((f) => sup.includes(f));
            if (formats.includes('ean_13')) detector = new window.BarcodeDetector({ formats });
          } catch { detector = null; }
        }
        if (detector) {
          video.srcObject = stream; await video.play().catch(() => {});
          setLive(true);
          const tick = async () => {
            if (stopped) return;
            try { if (video.readyState >= 2 && !document.hidden) (await detector.detect(video)).forEach((b) => accept(b.rawValue)); } catch { /* a frame failed: next one */ }
            timer = setTimeout(tick, 110);
          };
          tick();
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
          if (stopped) return;
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF]);
          hints.set(DecodeHintType.TRY_HARDER, true);                // slower per frame, but reads dim / slightly damaged codes
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80 });
          controls = await reader.decodeFromStream(stream, video, (res) => { if (res && !document.hidden) accept(res.getText()); });
          if (stopped) { controls.stop(); return; }
          setLive(true);
        }
      } catch { if (!stopped) setPhase('error'); }
    })();

    return () => {
      stopped = true; clearTimeout(timer);
      try { if (controls) controls.stop(); } catch { /* already stopped */ }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      trackRef.current = null; setLive(false);
    };
  }, [open, attempt, accept]);

  const toggleTorch = async () => {
    const t = trackRef.current; if (!t) return;
    try { await t.applyConstraints({ advanced: [{ torch: !torch.on }] }); setTorch({ available: true, on: !torch.on }); } catch { setTorch({ available: false, on: false }); }
  };
  const toggleSound = () => { const v = !sound; setSound(v); setSoundEnabled(v); if (v) feedback('ok'); };
  const submitManual = (e) => {
    e.preventDefault();
    const code = cleanCode(manual);
    if (!code) { setManualErr('Enter the digits printed under the barcode (at least 4).'); return; }
    setManualErr(''); setManual(''); run(code);
  };

  if (!open) return null;
  const problem = CAMERA_HELP[phase];
  const tone = result ? (result.kind === 'ok' ? 'bg-ok text-white' : result.kind === 'warn' ? 'bg-warn text-white' : 'bg-bad text-white') : '';
  return (
    <div className={embedded ? 'relative flex h-[78vh] min-h-[480px] flex-col overflow-hidden rounded-2xl bg-black text-white' : 'fixed inset-0 z-50 flex flex-col bg-black text-white'} {...(embedded ? { role: 'region', 'aria-label': title } : { role: 'dialog', 'aria-modal': true, 'aria-label': 'Scan barcodes' })}>
      <div className="flex items-center gap-2 px-3 py-2">
        <ScanLine className="size-6" aria-hidden="true" />
        <h2 className="mr-auto text-lg font-bold">{title}</h2>
        {torch.available && <button onClick={toggleTorch} aria-pressed={torch.on} aria-label="Torch" className={cx('grid size-12 place-items-center rounded-full', torch.on ? 'bg-yellow-300 text-black' : 'bg-white/15')}><Flashlight className="size-6" /></button>}
        <button onClick={toggleSound} aria-pressed={sound} aria-label={sound ? 'Turn beep off' : 'Turn beep on'} className="grid size-12 place-items-center rounded-full bg-white/15">{sound ? <Volume2 className="size-6" /> : <VolumeX className="size-6" />}</button>
        {!embedded && <button onClick={onClose} aria-label="Close scanner" className="grid size-12 place-items-center rounded-full bg-white/15"><X className="size-6" /></button>}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={videoRef} data-testid="scanner-video" className="absolute inset-0 size-full object-cover" playsInline muted autoPlay />
        {problem ? (
          <div className="absolute inset-0 grid place-items-center bg-black/85 p-6 text-center">
            <div className="max-w-sm space-y-3">
              <CameraOff className="mx-auto size-12 text-white/70" aria-hidden="true" />
              <p className="text-xl font-bold" role="alert">{problem[0]}</p>
              <p className="text-base text-white/80">{problem[1]}</p>
              {phase !== 'unsupported' && phase !== 'nocamera' && <Button size="lg" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
            </div>
          </div>
        ) : (
          <>
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className={cx('relative h-[26%] w-[84%] max-w-md rounded-2xl border-4 transition-colors', flash ? 'border-green-400 bg-green-400/25' : paused ? 'border-yellow-300/80' : 'border-white/90')} style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)' }} data-testid="scan-frame">
                <span className="absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" aria-hidden="true" />
              </div>
            </div>
            <p className="pointer-events-none absolute inset-x-0 top-[calc(50%+16%)] px-6 text-center text-base font-semibold drop-shadow">
              {phase === 'starting' ? 'Starting the camera… tap Allow if asked. SHARKPOS only reads barcodes; nothing is recorded or uploaded.' : paused ? 'Finish the step below to keep scanning' : hint}
            </p>
            {phase === 'starting' && <Spinner className="absolute left-1/2 top-1/3 size-8 -translate-x-1/2 text-white" />}
          </>
        )}
      </div>

      <div className="space-y-2 bg-neutral-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div role="status" aria-live="polite" className="min-h-[64px]">
          {result && (
            <div className={cx('flex items-center gap-3 rounded-xl px-4 py-3', tone)} data-testid="scan-result" data-kind={result.kind}>
              {result.kind === 'ok' ? <CheckCircle2 className="size-8 shrink-0" aria-hidden="true" /> : result.kind === 'warn' ? <AlertTriangle className="size-8 shrink-0" aria-hidden="true" /> : <XCircle className="size-8 shrink-0" aria-hidden="true" />}
              <div className="min-w-0 flex-1"><p className="text-base font-bold">{result.title}</p>{result.name && <p className="truncate text-lg font-extrabold">{result.name}</p>}{result.price != null && <p className="text-base num">{inr(result.price, 2)}</p>}{result.detail && <p className="num truncate text-sm opacity-90">{result.detail}</p>}</div>
              {result.qty != null && <span className="rounded-lg bg-white/25 px-3 py-1 text-xl font-extrabold num" aria-label={`Quantity ${result.qty}`}>Qty: {result.qty}</span>}
            </div>
          )}
        </div>
        <form onSubmit={submitManual} className="flex gap-2" aria-label="Enter barcode manually">
          <div className="relative flex-1">
            <Keyboard className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
            <Input aria-label="Enter barcode manually" inputMode="numeric" autoComplete="off" placeholder="Type the barcode number" value={manual} onChange={(e) => { setManual(e.target.value); setManualErr(''); }} className="!h-12 !bg-neutral-800 !pl-10 !text-lg !text-white placeholder:!text-neutral-400 !border-neutral-700" />
          </div>
          <Button type="submit" size="lg" variant="secondary" className="!h-12">Add</Button>
        </form>
        {manualErr && <p role="alert" className="text-sm font-semibold text-yellow-300">{manualErr}</p>}
        <Button size="lg" className="!h-14 w-full text-lg" onClick={onClose} data-testid="scan-done">
          {doneLabel || `Done${summary && summary.count > 0 ? ` · ${summary.count} item${summary.count === 1 ? '' : 's'} · ${inr(summary.total, 2)}` : ''}`}
        </Button>
        <p className="sr-only" aria-live="polite">{live ? 'Camera is scanning' : ''}</p>
      </div>
    </div>
  );
}
