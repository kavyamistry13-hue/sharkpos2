// The Cloudflare Pages Function that carries /api to the API on free hosting. Run here with a fake network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'functions', 'api', '[[path]].js')).href);
const env = { API_ORIGIN: 'https://api.example.test', PROXY_SHARED_SECRET: 's'.repeat(40) };

test('proxy function: strips spoofed trust headers, adds the secret and the real IP, keeps every cookie', async () => {
  const { onRequest } = await load();
  let seen;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'sp2_refresh=abc; Path=/api/auth; HttpOnly; Secure; SameSite=Strict');
    h.append('set-cookie', 'other=1; Path=/');
    return new Response('{"ok":true}', { status: 200, headers: h });
  };
  try {
    const req = new Request('https://app.pages.test/api/auth/login?x=1', {
      method: 'POST', body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-sp-client-ip': '6.6.6.6', 'x-sp-proxy-secret': 'forged', 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '203.0.113.5', 'x-requested-with': 'sharkpos', cookie: 'sp2_refresh=old', authorization: 'Bearer t' },
    });
    const res = await onRequest({ request: req, env });
    assert.equal(seen.url, 'https://api.example.test/api/auth/login?x=1');
    assert.equal(seen.init.headers.get('x-sp-proxy-secret'), env.PROXY_SHARED_SECRET, 'forged secret replaced by the real one');
    assert.equal(seen.init.headers.get('x-sp-client-ip'), '203.0.113.5', 'IP comes from Cloudflare, not from the visitor');
    assert.equal(seen.init.headers.get('x-forwarded-for'), null);
    assert.equal(seen.init.headers.get('x-requested-with'), 'sharkpos');
    assert.equal(seen.init.headers.get('cookie'), 'sp2_refresh=old');
    assert.equal(seen.init.headers.get('authorization'), 'Bearer t');
    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 2, 'both Set-Cookie headers survive');
    assert.match(res.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { globalThis.fetch = realFetch; }
});

test('proxy function: not configured → 503; API asleep → writes fail fast, reads are retried', async () => {
  const { onRequest } = await load();
  assert.equal((await onRequest({ request: new Request('https://app.pages.test/api/x'), env: {} })).status, 503);
  const realFetch = globalThis.fetch; const realTimeout = globalThis.setTimeout;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('', { status: calls < 3 ? 503 : 200 }); };
  globalThis.setTimeout = (fn) => realTimeout(fn, 0); // do not really wait 8 s per retry
  try {
    const post = await onRequest({ request: new Request('https://app.pages.test/api/sales', { method: 'POST', body: '{}' }), env });
    assert.equal(post.status, 503); assert.equal(calls, 1, 'a POST is never replayed automatically');
    assert.match((await post.json()).error, /waking up/);
    calls = 0;
    const get = await onRequest({ request: new Request('https://app.pages.test/api/products'), env });
    assert.equal(get.status, 200); assert.equal(calls, 3, 'GET retried until the API woke up');
  } finally { globalThis.fetch = realFetch; globalThis.setTimeout = realTimeout; }
});
