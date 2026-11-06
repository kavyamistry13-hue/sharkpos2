// Cloudflare Pages Function: forwards every /api/* request from the web app's own address to the API.
// Why: on free hosting the web app (xxx.pages.dev) and the API (xxx.onrender.com) are different "sites", so the browser would
// never send our SameSite=Strict login cookie to the API. Through this proxy the browser only ever talks to ONE origin, so the
// cookie, CSRF protection and CORS design keep working unchanged and no paid custom domain is needed.
// Bindings (Pages → Settings → Variables and Secrets): API_ORIGIN (e.g. https://sharkpos2-api.onrender.com), PROXY_SHARED_SECRET (secret).

const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'x-sp-proxy-secret', 'x-sp-client-ip']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequest({ request, env }) {
  if (!env.API_ORIGIN || !env.PROXY_SHARED_SECRET) return json(503, { error: 'The service is not configured yet.' });
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);

  const headers = new Headers();
  for (const [k, v] of request.headers) if (!HOP.has(k.toLowerCase())) headers.set(k, v);
  headers.set('x-sp-proxy-secret', env.PROXY_SHARED_SECRET);
  headers.set('x-sp-client-ip', request.headers.get('cf-connecting-ip') || '');

  const idempotent = request.method === 'GET' || request.method === 'HEAD';
  const body = idempotent ? undefined : await request.arrayBuffer();
  // A sleeping free API needs up to ~1 minute to start. Reads are retried while it wakes; writes are never replayed automatically.
  const attempts = idempotent ? 8 : 1;
  let res;
  for (let i = 0; i < attempts; i++) {
    try {
      res = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
      if (![502, 503, 504].includes(res.status)) break;
    } catch { res = null; }
    if (i < attempts - 1) await sleep(8000);
  }
  if (!res || [502, 503, 504].includes(res.status)) {
    return json(503, { error: 'The server is waking up. Please wait a few seconds and try again.' });
  }

  const out = new Headers();
  for (const [k, v] of res.headers) if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) out.set(k, v);
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);   // keep every cookie, unchanged
  out.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers: out });
}
