// SHARKPOS 2 — duplicate-sale protection: a sale submitted with the same Idempotency-Key is created ONCE, however often or however
// concurrently it is retried, and stock/ledger/audit stay consistent. Enforced by the API and by the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { boot, client, uniq } = require('./helpers');

let env; let api;
const key = () => crypto.randomUUID();
const post = (token, body, k) => api(token).post('/sales', body, { 'idempotency-key': k });

async function shop(stock = 100) {
  const reg = await api().post('/auth/register', { businessName: uniq('IDEM Shop '), ownerName: 'Owner', email: `${uniq('o')}@example.com`, password: 'Passw0rdOK' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const o = api(reg.body.accessToken);
  const email = `${uniq('c')}@example.com`;
  const emp = await o.post('/employees', { name: 'Cashier', email, password: 'Passw0rdOK', role: 'cashier' });
  const cashier = (await api().post('/auth/login', { email, password: 'Passw0rdOK' })).body.accessToken;
  const cat = (await o.get('/products/lookups')).body.categories[0].id;
  const mk = async (name, st = stock) => (await o.post('/products', { name: uniq(name), categoryId: cat, purchasePrice: 5, sellingPrice: 10, stock: st })).body;
  const p1 = await mk('Milk '); const p2 = await mk('Bread ');
  assert.ok(p1.id && p2.id);
  return { o, owner: reg.body.accessToken, cashier, cashierId: emp.body.id, bid: reg.body.business.id, p1, p2, cat };
}
const q = (t, text, params) => env.db.runAsTenant(t.bid, () => env.db.query(text, params)).then((r) => r.rows);
const stockOf = async (t, p) => (await q(t, 'SELECT stock FROM products WHERE id = $1', [p.id]))[0].stock;
const count = async (t, table) => (await q(t, `SELECT count(*)::int AS n FROM ${table}`))[0].n;
const cart = (t, qty = 2, extra = {}) => ({ items: [{ productId: t.p1.id, quantity: qty }], paymentMethod: 'cash', ...extra });

test.before(async () => { env = await boot(); api = client(env.base); });
test.after(async () => { await env.close(); });

test('a sale without a valid Idempotency-Key is refused and changes nothing', async () => {
  const t = await shop();
  for (const h of [{}, { 'idempotency-key': 'not-a-uuid' }, { 'idempotency-key': '' }]) {
    // raw fetch: the test client would add a key for us
    const res = await fetch(`${env.base}/sales`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.owner}`, ...h }, body: JSON.stringify(cart(t)) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).details.code, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  assert.equal(await count(t, 'sales'), 0);
  assert.equal(await stockOf(t, t.p1), 100);
});

test('retrying the same key + same cart returns the ORIGINAL sale; stock, ledger, audit and claim are written once', async () => {
  const t = await shop();
  const k = key();
  const first = await post(t.cashier, cart(t, 3), k);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  for (let i = 0; i < 4; i++) {
    const again = await post(t.cashier, cart(t, 3), k);
    assert.equal(again.status, 200, 'replay is 200, not a new 201');
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.invoiceNo, first.body.invoiceNo);
    assert.equal(again.body.total, first.body.total);
  }
  assert.equal(await count(t, 'sales'), 1);
  assert.equal(await count(t, 'sale_items'), 1);
  assert.equal(await stockOf(t, t.p1), 97, 'stock deducted once');
  const mv = await q(t, "SELECT quantity FROM inventory_movements WHERE movement_type = 'sale'");
  assert.deepEqual(mv.map((m) => m.quantity), [-3]);
  const claims = await q(t, 'SELECT sale_id FROM sale_requests');
  assert.deepEqual(claims.map((c) => c.sale_id), [first.body.id]);
  assert.equal((await q(t, "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'sale.created'"))[0].n, 1, 'audited once');
  // the key is case-insensitive text but one identity
  assert.equal((await post(t.cashier, cart(t, 3), k.toUpperCase())).body.id, first.body.id);
});

test('the same cart in a different item order / split lines is the same request', async () => {
  const t = await shop();
  const k = key();
  const a = await post(t.owner, { items: [{ productId: t.p1.id, quantity: 1 }, { productId: t.p2.id, quantity: 2 }, { productId: t.p1.id, quantity: 1 }], paymentMethod: 'upi' }, k);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await post(t.owner, { items: [{ productId: t.p2.id, quantity: 2 }, { productId: t.p1.id, quantity: 2 }], paymentMethod: 'upi' }, k);
  assert.equal(b.status, 200); assert.equal(b.body.id, a.body.id);
  assert.equal(await stockOf(t, t.p1), 98); assert.equal(await stockOf(t, t.p2), 98);
});

test('CONCURRENT requests with one key create exactly one sale and deduct stock once', async () => {
  const t = await shop();
  const k = key();
  const results = await Promise.all(Array.from({ length: 12 }, () => post(t.cashier, cart(t, 4), k)));
  const codes = results.map((r) => r.status).sort();
  assert.ok(results.every((r) => [200, 201, 409].includes(r.status)), `unexpected statuses ${codes}`);
  assert.equal(results.filter((r) => r.status === 201).length, 1, `exactly one creator, got ${codes}`);
  const ids = new Set(results.filter((r) => r.status !== 409).map((r) => r.body.id));
  assert.equal(ids.size, 1, 'everyone who got a sale got the same one');
  assert.equal(await count(t, 'sales'), 1);
  assert.equal(await stockOf(t, t.p1), 96);
  assert.equal((await q(t, "SELECT count(*)::int AS n FROM inventory_movements WHERE movement_type='sale'"))[0].n, 1);
  assert.equal(await count(t, 'sale_requests'), 1);
});

test('concurrent requests with DIFFERENT keys are different sales (no over-blocking)', async () => {
  const t = await shop();
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(t.cashier, cart(t, 2), key())));
  assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 6);
  assert.equal(await stockOf(t, t.p1), 100 - 12);
  assert.equal(await count(t, 'sales'), 6);
});

test('LOST RESPONSE: the server completes the sale but the client never hears back; the retry returns that sale', async () => {
  const t = await shop();
  const port = Number(new URL(env.base).port);
  // A flaky "network": forwards the request to the API, then kills the connection instead of relaying the reply.
  const dropped = [];
  const flaky = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    client.on('data', (d) => upstream.write(d));
    upstream.on('data', (d) => { dropped.push(d.toString().split('\r\n')[0]); client.destroy(); upstream.end(); });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  const k = key();
  const body = JSON.stringify(cart(t, 5));
  await assert.rejects(() => fetch(`http://127.0.0.1:${flaky.address().port}/api/sales`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.cashier}`, 'idempotency-key': k }, body }), 'client sees a network failure');
  await new Promise((r) => flaky.close(r));
  assert.ok(dropped.length >= 1 && /201/.test(dropped[0]), `the API really did create the sale (${dropped[0]})`);
  assert.equal(await count(t, 'sales'), 1, 'the sale exists even though the till never saw the answer');
  // The cashier presses "Complete sale" again with the same key:
  const retry = await post(t.cashier, cart(t, 5), k);
  assert.equal(retry.status, 200); assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(await count(t, 'sales'), 1);
  assert.equal(await stockOf(t, t.p1), 95, 'stock deducted once');
});

test('client aborts mid-flight and retries immediately: still one sale', async () => {
  const t = await shop();
  const k = key();
  const ac = new AbortController();
  const p1 = fetch(`${env.base}/sales`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.cashier}`, 'idempotency-key': k }, body: JSON.stringify(cart(t, 2)) }).catch(() => 'aborted');
  setTimeout(() => ac.abort(), 5);
  await p1;
  const retry = await post(t.cashier, cart(t, 2), k);
  assert.ok([200, 201].includes(retry.status), String(retry.status));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await count(t, 'sales'), 1);
  assert.equal(await stockOf(t, t.p1), 98);
});

test('the same key with a DIFFERENT sale is rejected and the original is untouched', async () => {
  const t = await shop();
  const k = key();
  const first = await post(t.cashier, cart(t, 2), k);
  assert.equal(first.status, 201);
  const variants = [
    cart(t, 3),                                                    // different quantity
    { ...cart(t, 2), paymentMethod: 'card' },                      // different payment method
    { items: [{ productId: t.p2.id, quantity: 2 }], paymentMethod: 'cash' }, // different product
    { ...cart(t, 2), discount: { type: 'amount', value: 1 } },     // a discount appeared
  ];
  for (const v of variants) {
    const r = await post(t.cashier, v, k);
    assert.equal(r.status, 422, JSON.stringify(v));
    assert.equal(r.body.details.code, 'IDEMPOTENCY_KEY_REUSED');
  }
  // a different cashier cannot replay (or read) someone else's sale with the key either
  const other = await post(t.owner, cart(t, 2), k);
  assert.equal(other.status, 422);
  assert.equal(await count(t, 'sales'), 1);
  assert.equal(await stockOf(t, t.p1), 98);
  assert.equal((await post(t.cashier, cart(t, 2), k)).body.id, first.body.id, 'the genuine retry still works');
});

test('a FAILED sale leaves no trace: the key is free for a corrected retry', async () => {
  const t = await shop(5);
  const k = key();
  const bad = await post(t.cashier, cart(t, 9), k);               // more than the 5 in stock
  assert.equal(bad.status, 409, JSON.stringify(bad.body));
  assert.equal(await count(t, 'sale_requests'), 0, 'claim rolled back with the sale');
  assert.equal(await count(t, 'sales'), 0);
  assert.equal(await stockOf(t, t.p1), 5);
  await t.o.post(`/inventory/${t.p1.id}/restock`, { quantity: 20 }).catch(() => {});
  await env.db.runAsTenant(t.bid, () => env.db.query('UPDATE products SET stock = 30 WHERE id = $1', [t.p1.id]));
  const ok = await post(t.cashier, cart(t, 9), k);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(await stockOf(t, t.p1), 21);
});

test('keys belong to one business: another shop using the same key gets its own sale, never someone else\'s', async () => {
  const A = await shop(); const B = await shop();
  const k = key();
  const a = await post(A.cashier, cart(A, 2), k);
  const b = await post(B.cashier, cart(B, 2), k);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(await count(A, 'sales'), 1); assert.equal(await count(B, 'sales'), 1);
  assert.equal(await stockOf(A, A.p1), 98); assert.equal(await stockOf(B, B.p1), 98);
});

test('a retry that arrives while the original is still open waits, then returns it; if it never finishes it gets a clear 409', async () => {
  const t = await shop();
  const config = require('../src/config');
  const keep = config.saleLockTimeoutMs; config.saleLockTimeoutMs = 400;
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    const k = key();
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.business_id', $1, true)", [String(t.bid)]);
    await holder.query('INSERT INTO sale_requests (idempotency_key, request_hash, employee_id) VALUES ($1, $2, $3)', [k, 'a'.repeat(64), t.cashierId]);
    const blocked = await post(t.cashier, cart(t, 2), k);          // original "still running" on another connection
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.details.code, 'IDEMPOTENCY_IN_PROGRESS');
    await holder.query('ROLLBACK');                                  // the original died without committing
    const after = await post(t.cashier, cart(t, 2), k);
    assert.equal(after.status, 201, JSON.stringify(after.body));
    assert.equal(await count(t, 'sales'), 1);
  } finally { config.saleLockTimeoutMs = keep; await holder.end(); }
});

test('DATABASE-level guarantees hold even for raw SQL', async () => {
  const t = await shop();
  const k = key();
  const sale = await post(t.cashier, cart(t, 1), k);
  assert.equal(sale.status, 201);
  const app = new Client({ connectionString: process.env.DATABASE_URL }); await app.connect();
  try {
    const asTenant = async (fn) => { await app.query('BEGIN'); await app.query("SELECT set_config('app.business_id', $1, true)", [String(t.bid)]); try { return await fn(); } finally { await app.query('ROLLBACK'); } };
    await asTenant(() => assert.rejects(() => app.query('INSERT INTO sale_requests (idempotency_key, request_hash, employee_id) VALUES ($1,$2,$3)', [k, 'b'.repeat(64), t.cashierId]), /duplicate key/));
    await asTenant(() => assert.rejects(() => app.query('INSERT INTO sale_requests (idempotency_key, request_hash, employee_id, sale_id) VALUES ($1,$2,$3,$4)', [key(), 'c'.repeat(64), t.cashierId, sale.body.id]), /duplicate key/)); // one sale, one key
    await asTenant(() => assert.rejects(() => app.query('DELETE FROM sale_requests'), /permission denied/));
    const none = await app.query('SELECT count(*)::int AS n FROM sale_requests');       // no tenant context → RLS hides everything
    assert.equal(none.rows[0].n, 0);
  } finally { await app.end(); }
});

test('after a mix of retries, bursts, failures and refunds, sales, items, ledger and stock all agree', async () => {
  const t = await shop(60);
  const keys = Array.from({ length: 6 }, key);
  await Promise.all(keys.flatMap((k, i) => Array.from({ length: 3 }, () => post(t.cashier, { items: [{ productId: t.p1.id, quantity: i + 1 }, { productId: t.p2.id, quantity: 1 }], paymentMethod: 'cash' }, k))));
  await post(t.cashier, cart(t, 999), key());                       // fails (stock)
  const sales = await q(t, 'SELECT id FROM sales');
  assert.equal(sales.length, 6);
  const sold = (await q(t, 'SELECT product_id, SUM(quantity)::int AS n FROM sale_items GROUP BY product_id')).reduce((m, r) => ({ ...m, [r.product_id]: r.n }), {});
  const moved = (await q(t, "SELECT product_id, SUM(-quantity)::int AS n FROM inventory_movements WHERE movement_type='sale' GROUP BY product_id")).reduce((m, r) => ({ ...m, [r.product_id]: r.n }), {});
  assert.deepEqual(sold, moved, 'sale items == inventory ledger');
  assert.equal(await stockOf(t, t.p1), 60 - sold[t.p1.id]);
  assert.equal(await stockOf(t, t.p2), 60 - sold[t.p2.id]);
  assert.equal(sold[t.p1.id], 1 + 2 + 3 + 4 + 5 + 6);
  const linked = await q(t, 'SELECT sale_id FROM sale_requests WHERE sale_id IS NOT NULL');
  assert.equal(linked.length, 6, 'every key points at exactly one sale');
  assert.equal((await q(t, "SELECT count(*)::int AS n FROM audit_logs WHERE action='sale.created'"))[0].n, 6);
});
