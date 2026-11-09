// Barcode helpers shared by the camera scanner, the USB/Bluetooth "keyboard" scanner and manual entry.
// A barcode only IDENTIFIES a product. Price, tax, unit and stock always come from the shop's own product (the server), never from the code.
import { api } from './api';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{3,47}$/;

/** Trim scanner noise (CR/LF/spaces). Returns '' when it cannot be a barcode. The value is a STRING: leading zeros are kept. */
export function cleanCode(raw) {
  const c = String(raw == null ? '' : raw).trim();
  return CODE_RE.test(c) ? c : '';
}

/** GS1 check digit for EAN-8 / UPC-A / EAN-13 / GTIN-14. Camera libraries sometimes return a misread; a wrong check digit is dropped. */
export function gs1Valid(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}
export const isGtinLength = (code) => /^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length);

/** Does typed text look like a barcode (digits, 6+) rather than a product name? Used so normal keyboard search keeps working. */
export const looksLikeBarcode = (text) => /^\d{6,}$/.test(String(text).trim());

// ---- lookup: the ONE place the Counter turns a code into a product. Phase 17 (offline) will answer this from a local cache instead. ----
// Short-lived memory of recent hits makes "scan the same item 5 times" instant; the server re-checks price and stock at sale time anyway.
const recent = new Map();
const TTL_MS = 30000;
export function forgetScans() { recent.clear(); }

/** → { found, matchedBy?, barcode, product?, canRegister } */
export async function lookupBarcode(code) {
  const hit = recent.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await api.get('/products/scan', { code });
  if (value.found) recent.set(code, { at: Date.now(), value });
  return value;
}

// ---- feedback: a short beep + vibration, both optional. The preference is a per-device convenience only (never anything sensitive). ----
let audio = null;
const KEY = 'sp2.scan.sound';
export function soundEnabled() { try { return window.localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
export function setSoundEnabled(on) { try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: keep going */ } }

function tone(freq, ms) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = audio || new Ctx();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* sound is optional */ }
}
/** kind: 'ok' | 'warn' | 'error' */
export function feedback(kind) {
  if (soundEnabled()) tone(kind === 'ok' ? 1046 : kind === 'warn' ? 520 : 220, kind === 'ok' ? 90 : 220);
  try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 40 : [90, 50, 90]); } catch { /* not supported */ }
}

/** True when this browser can open a camera at all (needs https or localhost). */
export const cameraSupported = () => typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && (typeof window === 'undefined' || window.isSecureContext !== false);
