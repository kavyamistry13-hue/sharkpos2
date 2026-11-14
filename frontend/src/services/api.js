// API client. The short-lived access token lives only in memory (never localStorage, so XSS cannot steal a long session);
// the long-lived refresh token is an httpOnly cookie that JavaScript cannot read. On a 401 we silently refresh once.
// In production the API lives on its own sub-domain (e.g. https://api.example.com); VITE_API_URL is set at build time.
// Empty in development: the Vite dev server proxies /api to the local API.
export const API_BASE = ((import.meta.env && import.meta.env.VITE_API_URL) || '').replace(/\/+$/, '');
const CREDENTIALS = API_BASE ? 'include' : 'same-origin';
let accessToken = null;
export const tokenStore = {
  get: () => accessToken,
  set: (t) => { accessToken = t; },
  clear: () => { accessToken = null; },
};

export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; this.code = details && details.code; }
}

const GENERIC = 'Something went wrong. Please try again.';
let refreshing = null;

/** Exchanges the refresh cookie for a new access token. One request at a time, shared by all callers. */
export function refreshSession() {
  if (!refreshing) {
    refreshing = fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', headers: { 'x-requested-with': 'sharkpos' }, credentials: CREDENTIALS })
      .then(async (res) => {
        if (!res.ok) { accessToken = null; return null; }
        const data = await res.json();
        accessToken = data.accessToken;
        return data;
      })
      .catch(() => null)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function send(method, path, body, params, extraHeaders) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString() : '';
  const isAuthCall = path.startsWith('/auth/');
  return fetch(`${API_BASE}/api${path}${qs}`, {
    method,
    credentials: CREDENTIALS,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(isAuthCall ? { 'x-requested-with': 'sharkpos' } : {}), ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Only requests that carry an Idempotency-Key are ever retried automatically: the server guarantees a repeat cannot act twice.
const RETRY_DELAYS = [1500, 4000, 9000];
const isTransient = (status, data) => status === 502 || status === 503 || status === 504 || (status === 409 && data && data.details && data.details.code === 'IDEMPOTENCY_IN_PROGRESS');

async function attempt(method, path, { body, params, headers }) {
  let res = await send(method, path, body, params, headers);
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register') && !path.startsWith('/auth/refresh')) {
    const renewed = await refreshSession();
    if (renewed) res = await send(method, path, body, params, headers);
  }
  return res;
}

// `headers`: extra request headers (the offline sync sends X-Offline-Sale). `noRetry`: skip the automatic retry loop below (the offline sync owns its own back-off).
async function request(method, path, { body, params, idempotencyKey, onRetry, headers: extraHeaders, noRetry } = {}) {
  const headers = (idempotencyKey || extraHeaders) ? { ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...(extraHeaders || {}) } : undefined;
  let res = null; let data = null; let networkFailed = false;
  for (let n = 0; ; n++) {
    networkFailed = false; res = null; data = null;
    try {
      res = await attempt(method, path, { body, params, headers });
      try { data = await res.json(); } catch { /* empty body */ }
    } catch { networkFailed = true; }
    const transient = networkFailed || isTransient(res.status, data);
    if (!transient || !idempotencyKey || noRetry || n >= RETRY_DELAYS.length) break;
    if (onRetry) onRetry(n + 1, RETRY_DELAYS.length);
    await wait(RETRY_DELAYS[n]);
  }
  if (networkFailed) throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  if (!res.ok) {
    if (res.status === 401 && accessToken === null && !path.startsWith('/auth/')) window.dispatchEvent(new Event('sharkpos:unauthorized'));
    if (res.status === 402) window.dispatchEvent(new Event('sharkpos:billing-changed'));
    // 5xx: never show raw backend text
    const message = (res.status >= 500 && res.status !== 503) ? GENERIC : (data && data.error) || GENERIC;
    throw new ApiError(message, res.status, data && data.details);
  }
  return data;
}

export const api = {
  get: (p, params) => request('GET', p, { params }),
  post: (p, body, opts) => request('POST', p, { body: body ?? {}, ...(opts || {}) }),
  put: (p, body) => request('PUT', p, { body }),
  del: (p) => request('DELETE', p),
};

// CSV helpers (Phase 9). Same auth + silent-refresh behaviour as every other call; errors become the same friendly ApiError.
async function csvFetch(method, path, { text, params } = {}) {
  const run = () => fetch(`${API_BASE}/api${path}${params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString() : ''}`, {
    method, credentials: CREDENTIALS,
    headers: { ...(text !== undefined ? { 'content-type': 'text/csv' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: text,
  });
  let res;
  try { res = await run(); if (res.status === 401) { const renewed = await refreshSession(); if (renewed) res = await run(); } } catch { throw new ApiError('Cannot reach the server. Check your connection and try again.', 0); }
  return res;
}
/** Sends CSV text (preview or import). Resolves with the JSON body; failures throw ApiError carrying `details` (row-level errors). */
export async function uploadCsv(path, text) {
  const res = await csvFetch('POST', path, { text });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status >= 500 ? GENERIC : (data && data.error) || GENERIC, res.status, data && data.details);
  return data;
}
/** Downloads a CSV through the browser (Save-as) using the authenticated session. */
export async function downloadCsv(path, fallbackName) {
  const res = await csvFetch('GET', path);
  if (!res.ok) { let d = null; try { d = await res.json(); } catch { /* */ } throw new ApiError(res.status >= 500 ? GENERIC : (d && d.error) || GENERIC, res.status); }
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : fallbackName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
