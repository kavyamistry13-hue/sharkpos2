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

async function request(method, path, { body, params, idempotencyKey, onRetry } = {}) {
  const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined;
  let res = null; let data = null; let networkFailed = false;
  for (let n = 0; ; n++) {
    networkFailed = false; res = null; data = null;
    try {
      res = await attempt(method, path, { body, params, headers });
      try { data = await res.json(); } catch { /* empty body */ }
    } catch { networkFailed = true; }
    const transient = networkFailed || isTransient(res.status, data);
    if (!transient || !idempotencyKey || n >= RETRY_DELAYS.length) break;
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
