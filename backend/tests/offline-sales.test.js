// SHARKPOS 2 — Phase 17A: the backend foundation of the offline POS.
//   * ONE billing implementation (shared/billing.mjs) used by the API and the offline browser, proven identical to the pre-extraction code
//     and to what the server itself prices
//   * GET /products/offline-catalog (minimum data, no costs, tenant-scoped)
//   * expectedTotal: a price change is refused (OFFLINE_PRICE_CHANGED), never silently accepted
//   * X-Offline-Sale: audit metadata + a business-id TRIPWIRE (never an authority)
//   * POST /sales/sync-issues: audit-only
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, todayIso } = require('./sprint-helpers');

let env; let api; let sharedBilling;
const key = () => crypto.randomUUID();
const hdr = (k, extra = {}) => ({ 'idempotency-key': k, ...extra });
const offlineHeader = (shop, over = {}) => ({ 'x-offline-sale': JSON.stringify({ capturedAt: new Date(Date.now() - 3600e3).toISOString(), businessId: shop.businessId, localRef: 'OFF-0007', ...over }) });
const tq = (shop, text, params) => env.db.runAsTenant(shop.businessId, () => env.db.query(text, params)).then((r) => r.rows);
const stockOf = async (shop, p) => Number((await tq(shop, 'SELECT stock FROM products WHERE id = $1', [p.id]))[0].stock);
const countOf = async (shop, table) => (await tq(shop, `SELECT count(*)::int AS n FROM ${table}`))[0].n;
const auditRows = (shop, action) => tq(shop, 'SELECT summary, new_value, account_id FROM audit_logs WHERE business_id = $1 AND action = $2 ORDER BY id', [shop.businessId, action]);
const previewTotalPaise = async (shop, items) => Math.round((await api(shop.owner.token).post('/sales/preview', { items })).body.total * 100);
// An offline submission must carry expectedTotal (paise). Unless a test sets it, take what the server itself would charge right now.
const sale = async (shop, productId, quantity, k, { who = 'cashier', extra = {}, headers = {}, discount } = {}) => {
  const body = { items: [{ productId, quantity }], paymentMethod: 'cash', ...(discount ? { discount } : {}), ...extra };
  if (headers['x-offline-sale'] && body.expectedTotal === undefined) {
    const pv = await api(shop[who].token).post('/sales/preview', { items: body.items, ...(discount ? { discount } : {}) });
    body.expectedTotal = pv.status === 200 ? Math.round(Number(pv.body.total) * 100) : 0;
  }
  return api(shop[who].token).post('/sales', body, hdr(k, headers));
};

test.before(async () => {
  env = await boot(); api = client(env.base);
  sharedBilling = await import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'billing.mjs')).href);
});
test.after(async () => { await env.close(); });

// ---------------------------------------------------------------- shared computeBill
test('computeBill: the shared module is exactly the pre-extraction implementation (2,000 random bills incl. tax-inclusive, fractions, discounts)', () => {
  const legacy = require('./fixtures/legacy-compute-bill').computeBill;
  const shared = sharedBilling.computeBill;
  const rates = [0, 5, 12, 12.5, 18, 28];
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 2000; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ({
      productId: i + 1, name: `P${i}`, quantity: Math.round(rnd() * 20000) / 1000 + 0.001, unitPaise: Math.round(rnd() * 500000) + 1,
      taxRate: rates[Math.floor(rnd() * rates.length)], priceIncludesTax: rnd() < 0.4, unit: 'kg',
    }));
    const r = rnd();
    const discount = r < 0.4 ? null : r < 0.7 ? { type: 'percent', value: Math.round(rnd() * 10000) / 100 } : { type: 'amount', value: Math.round(rnd() * 90000) / 100 };
    assert.deepEqual(shared(lines, discount), legacy(lines, discount), `mismatch on bill #${n}`);
  }
  assert.deepEqual(shared([], null).total, legacy([], null).total);
});

test('computeBill: the backend module IS the shared function, and the shared file has no imports (so a browser can load it)', () => {
  assert.equal(require('../src/services/billing').computeBill, sharedBilling.computeBill);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'billing.mjs'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\s|\brequire\s*\(|\bimport\s*\(/m, 'shared/billing.mjs must be dependency-free');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'), /COPY shared shared/, 'the API image must ship ./shared');
});

test('computeBill: a bill priced in the browser from the OFFLINE CATALOG equals the server\'s own /sales/preview (parity on real data)', async () => {
  const shop = await makeShop(api); const o = api(shop.owner.token);
  const cat18 = (await o.post('/categories', { name: uniq('Tax18 '), taxRate: 18 })).body;
  const cat5 = (await o.post('/categories', { name: uniq('Tax5 '), taxRate: 5 })).body;
  const prods = [
    await addProduct(api, shop, { categoryId: cat18.id, sellingPrice: 99.99, stock: 500 }),
    await addProduct(api, shop, { categoryId: cat5.id, sellingPrice: 120, priceIncludesTax: true, stock: 500 }),
    await addProduct(api, shop, { categoryId: cat18.id, sellingPrice: 63.5, unit: 'kg', stock: 500, priceIncludesTax: true }),
    await addProduct(api, shop, { categoryId: cat5.id, sellingPrice: 7.33, unit: 'kg', stock: 500 }),
  ];
  const cat = (await api(shop.cashier.token).get('/products/offline-catalog')).body.rows;
  const byId = new Map(cat.map((p) => [p.id, p]));
  let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 25; n++) {
    const picks = prods.filter(() => rnd() < 0.6); if (!picks.length) continue;
    const items = picks.map((p) => ({ productId: p.id, quantity: p.unit === 'kg' ? Math.round((rnd() * 9 + 0.1) * 1000) / 1000 : 1 + Math.floor(rnd() * 5) }));
    const discount = rnd() < 0.5 ? null : rnd() < 0.5 ? { type: 'percent', value: Math.round(rnd() * 3000) / 100 } : { type: 'amount', value: Math.round(rnd() * 5000) / 100 };
    const server = (await api(shop.cashier.token).post('/sales/preview', { items, ...(discount ? { discount } : {}) })).body;
    const local = sharedBilling.computeBill(items.map((i) => { const p = byId.get(i.productId); return { productId: p.id, name: p.name, quantity: i.quantity, unitPaise: sharedBilling.toPaise(p.price), taxRate: p.taxRate, priceIncludesTax: p.priceIncludesTax, unit: p.unit }; }), discount);
    assert.deepEqual({ ...local, items: local.items }, server, `offline bill differs from server bill (#${n})`);
  }
});

// ---------------------------------------------------------------- offline catalog
test('offline-catalog: minimum fields only, sellable products only, barcodes included, NO cost/supplier data', async () => {
  const shop = await makeShop(api); const o = api(shop.owner.token);
  const sup = (await o.post('/suppliers', { name: uniq('Sup '), phone: '9000000001' })).body;
  const ok = await addProduct(api, shop, { sellingPrice: 25, purchasePrice: 11, stock: 8, supplierId: sup && sup.id, barcode: '8901234567890' });
  await o.post(`/products/${ok.id}/barcodes`, { barcode: '036000291452' });
  const out = await addProduct(api, shop, { stock: 0 });
  const expired = await addProduct(api, shop, { expiryDate: '2020-01-01' });
  const gone = await addProduct(api, shop, {}); await o.del(`/products/${gone.id}`);
  const r = await api(shop.cashier.token).get('/products/offline-catalog');
  assert.equal(r.status, 200);
  assert.equal(r.body.nextAfter, null);
  assert.ok(Date.parse(r.body.generatedAt));
  const ids = r.body.rows.map((p) => p.id);
  assert.ok(ids.includes(ok.id)); for (const bad of [out, expired, gone]) assert.ok(!ids.includes(bad.id), `${bad.name} must not be offered offline`);
  const p = r.body.rows.find((x) => x.id === ok.id);
  assert.deepEqual(Object.keys(p).sort(), ['allowDecimal', 'barcodes', 'category', 'expiryDate', 'id', 'name', 'price', 'priceIncludesTax', 'sku', 'stock', 'taxRate', 'unit']);
  assert.equal(p.price, 25); assert.equal(p.stock, 8); assert.deepEqual([...p.barcodes].sort(), ['036000291452', '8901234567890']);
  const text = JSON.stringify(r.body).toLowerCase();
  for (const secret of ['purchase', 'avg_cost', 'avgcost', 'supplier', 'margin', 'cost']) assert.ok(!text.includes(secret), `catalog must not contain "${secret}"`);
});

test('offline-catalog: pages by id without gaps or repeats; cashier allowed; unauthenticated refused', async () => {
  const shop = await makeShop(api);
  const made = []; for (let i = 0; i < 5; i++) made.push(await addProduct(api, shop, {}));
  const seen = []; let after = 0;
  for (let guard = 0; guard < 10; guard++) {
    const r = await api(shop.cashier.token).get(`/products/offline-catalog?after=${after}&limit=2`);
    assert.equal(r.status, 200); seen.push(...r.body.rows.map((p) => p.id));
    if (r.body.nextAfter == null) break; after = r.body.nextAfter;
  }
  assert.deepEqual(seen, made.map((p) => p.id).sort((a, b) => a - b));
  assert.equal((await api().get('/products/offline-catalog')).status, 401);
  assert.equal((await api(shop.cashier.token).get('/products/offline-catalog?limit=5000')).status, 400);
});

test('offline-catalog: tenant isolation — another business\'s products never appear', async () => {
  const a = await makeShop(api); const b = await makeShop(api);
  const pa = await addProduct(api, a, { name: uniq('AonlyItem ') }); const pb = await addProduct(api, b, { name: uniq('BonlyItem ') });
  const ra = (await api(a.cashier.token).get('/products/offline-catalog')).body.rows.map((p) => p.id);
  const rb = (await api(b.cashier.token).get('/products/offline-catalog')).body.rows.map((p) => p.id);
  assert.ok(ra.includes(pa.id) && !ra.includes(pb.id)); assert.ok(rb.includes(pb.id) && !rb.includes(pa.id));
});

// ---------------------------------------------------------------- expectedTotal
test('expectedTotal: matching total → sale created exactly as a normal sale', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const expected = await previewTotalPaise(shop, [{ productId: p.id, quantity: 2 }]);   // what the till would have shown (price + the category's tax)
  const r = await sale(shop, p.id, 2, key(), { extra: { expectedTotal: expected } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Math.round(r.body.total * 100), expected); assert.equal(await stockOf(shop, p), 8);
});

test('expectedTotal: a different server total → 409 OFFLINE_PRICE_CHANGED and NOTHING is written; same key can then be retried with an explicit decision', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const k = key(); const before = { sales: await countOf(shop, 'sales'), mv: await countOf(shop, 'inventory_movements'), req: await countOf(shop, 'sale_requests') };
  const items = [{ productId: p.id, quantity: 2 }];
  const old = await previewTotalPaise(shop, items);                                      // what the customer was shown and charged offline
  await api(shop.owner.token).put(`/products/${p.id}`, { sellingPrice: 60 });          // price changed while the till was offline
  const now = await previewTotalPaise(shop, items); assert.ok(now > old);
  const r = await sale(shop, p.id, 2, k, { extra: { expectedTotal: old } });
  assert.equal(r.status, 409); assert.equal(r.body.details.code, 'OFFLINE_PRICE_CHANGED');
  assert.equal(r.body.details.expectedTotal, old / 100); assert.equal(r.body.details.currentTotal, now / 100); assert.equal(r.body.details.difference, (now - old) / 100);
  assert.equal(await stockOf(shop, p), 10);
  assert.deepEqual({ sales: await countOf(shop, 'sales'), mv: await countOf(shop, 'inventory_movements'), req: await countOf(shop, 'sale_requests') }, before, 'no sale, movement or key claim may remain');
  // Explicit decision: accept the new price, SAME key (expectedTotal is not part of the request hash).
  const ok = await sale(shop, p.id, 2, k, { extra: { expectedTotal: now } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(Math.round(ok.body.total * 100), now);
  // And a retry with the OLD expected total after success is a replay of the original sale, not an error and not a second sale.
  const again = await sale(shop, p.id, 2, k, { extra: { expectedTotal: old } });
  assert.equal(again.status, 200); assert.equal(again.headers.get('idempotent-replayed'), 'true'); assert.equal(again.body.id, ok.body.id);
  assert.equal(await stockOf(shop, p), 8); assert.equal(await countOf(shop, 'sales'), before.sales + 1);
});

test('expectedTotal: insufficient stock still wins (existing 409, no partial sale) and invalid values are rejected', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 3 });
  const r = await sale(shop, p.id, 5, key(), { extra: { expectedTotal: 5000 } });
  assert.equal(r.status, 409); assert.match(r.body.error, /Insufficient stock/); assert.notEqual(r.body.details && r.body.details.code, 'OFFLINE_PRICE_CHANGED');
  assert.equal(await stockOf(shop, p), 3); assert.equal(await countOf(shop, 'sales'), 0);
  for (const bad of [-1, 1.5, 'abc']) assert.equal((await sale(shop, p.id, 1, key(), { extra: { expectedTotal: bad } })).status, 400);
});

// ---------------------------------------------------------------- X-Offline-Sale
test('X-Offline-Sale: sale succeeds through the normal path; captured time is in the AUDIT only; sales.created_at stays server time', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 10 });
  const captured = new Date(Date.now() - 6 * 3600e3).toISOString();
  const r = await sale(shop, p.id, 1, key(), { headers: offlineHeader(shop, { capturedAt: captured }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = (await tq(shop, 'SELECT created_at FROM sales WHERE id = $1', [r.body.id]))[0];
  assert.ok(Math.abs(row.created_at.getTime() - Date.now()) < 60e3, 'created_at is the sync/server time');
  const a = (await auditRows(shop, 'sale.created')).pop();
  assert.equal(a.new_value.offline.capturedAt, captured); assert.equal(a.new_value.offline.localRef, 'OFF-0007'); assert.ok(Date.parse(a.new_value.offline.syncedAt));
  assert.match(a.summary, /offline sale captured/);
});

test('X-Offline-Sale: a normal online sale has no offline metadata; a replay writes no second audit row', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { stock: 10 });
  assert.equal((await sale(shop, p.id, 1, key())).status, 201);
  assert.equal((await auditRows(shop, 'sale.created')).pop().new_value.offline, undefined);
  const k = key(); const h = offlineHeader(shop);
  assert.equal((await sale(shop, p.id, 1, k, { headers: h })).status, 201);
  assert.equal((await sale(shop, p.id, 1, k, { headers: h })).status, 200);
  assert.equal((await auditRows(shop, 'sale.created')).length, 2);
  assert.equal(await stockOf(shop, p), 8);
});

test('X-Offline-Sale TRIPWIRE: a queue built under another business is refused (409), nothing is created and the key stays unused', async () => {
  const a = await makeShop(api); const b = await makeShop(api);
  const pa = await addProduct(api, a, { stock: 10 }); const pb = await addProduct(api, b, { stock: 10 });
  const k = key();
  // Business B's cashier tries to submit a sale that was queued while signed in to business A.
  const r = await sale(b, pa.id, 1, k, { headers: offlineHeader(a) });
  assert.equal(r.status, 409); assert.equal(r.body.details.code, 'OFFLINE_TENANT_MISMATCH');
  assert.equal(await countOf(b, 'sales'), 0); assert.equal(await stockOf(a, pa), 10); assert.equal(await stockOf(b, pb), 10);
  assert.equal(await countOf(b, 'sale_requests'), 0, 'the key was never claimed');
  // The browser claiming a business id is NOT authority: A's id with B's token is a mismatch, and B's id with A's token is a mismatch.
  const rev = await sale(a, pa.id, 1, key(), { headers: offlineHeader(b) });
  assert.equal(rev.status, 409); assert.equal(rev.body.details.code, 'OFFLINE_TENANT_MISMATCH');
  assert.equal(await countOf(a, 'sales'), 0);
  // Even a matching header cannot reach another tenant's product: the server still prices from the JWT's tenant (RLS) → 404.
  const cross = await sale(b, pa.id, 1, key(), { headers: offlineHeader(b) });
  assert.equal(cross.status, 404); assert.equal(await stockOf(a, pa), 10);
  // After the mismatch the legitimate owner of that key can still use it.
  assert.equal((await sale(a, pa.id, 1, k, { headers: offlineHeader(a) })).status, 201);
});

test('X-Offline-Sale: malformed header → 400 and nothing happens; header is not required', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { stock: 10 });
  for (const bad of ['not json', '{}', JSON.stringify({ capturedAt: 'yesterday-ish', businessId: shop.businessId }), JSON.stringify({ capturedAt: new Date().toISOString(), businessId: 'x' }), JSON.stringify({ capturedAt: new Date().toISOString(), businessId: -3 })]) {
    const r = await sale(shop, p.id, 1, key(), { headers: { 'x-offline-sale': bad } });
    assert.equal(r.status, 400, bad); assert.equal(r.body.details.code, 'OFFLINE_HEADER_INVALID');
  }
  assert.equal(await countOf(shop, 'sales'), 0); assert.equal(await stockOf(shop, p), 10);
  assert.equal((await sale(shop, p.id, 1, key())).status, 201);
});

test('offline sale: exactly one movement, stock deducted once, snapshot cost = avg_cost, avg_cost untouched, duplicate/concurrent submits are one sale', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, purchasePrice: 40, stock: 10 });
  const avgBefore = (await tq(shop, 'SELECT avg_cost FROM products WHERE id = $1', [p.id]))[0].avg_cost;
  const k = key(); const h = offlineHeader(shop);
  const expected = await previewTotalPaise(shop, [{ productId: p.id, quantity: 3 }]);
  const rs = await Promise.all([1, 2, 3, 4].map(() => sale(shop, p.id, 3, k, { headers: h, extra: { expectedTotal: expected } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 201]);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal(await stockOf(shop, p), 7);
  assert.equal((await tq(shop, `SELECT count(*)::int AS n FROM inventory_movements WHERE product_id = $1 AND movement_type = 'sale'`, [p.id]))[0].n, 1);
  assert.equal((await tq(shop, 'SELECT avg_cost FROM products WHERE id = $1', [p.id]))[0].avg_cost, avgBefore);
  const it = (await tq(shop, 'SELECT unit_cost, cost_source FROM sale_items WHERE sale_id = $1', [rs[0].body.id]))[0];
  assert.equal(Number(it.unit_cost), Number(avgBefore)); assert.equal(it.cost_source, 'snapshot');
});

test('offline sale vs online sale racing for the last stock: exactly one wins, the other is a clean 409, stock never negative', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 10, stock: 10 });
  const [off, on] = await Promise.all([sale(shop, p.id, 7, key(), { headers: offlineHeader(shop) }), sale(shop, p.id, 6, key(), { who: 'owner' })]);
  assert.deepEqual([off.status, on.status].sort(), [201, 409]);
  const left = await stockOf(shop, p); assert.ok(left === 3 || left === 4, `stock ${left}`);
  assert.equal(await countOf(shop, 'sales'), 1);
  assert.equal((await tq(shop, `SELECT count(*)::int AS n FROM inventory_movements WHERE product_id = $1 AND movement_type = 'sale'`, [p.id]))[0].n, 1);
});

// ---------------------------------------------------------------- sync-issues
test('sync-issues: a cashier can report a needs-review sale; it is audit-only, deduplicated, tenant-stamped from the JWT', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { stock: 5 });
  const k = key();
  const body = { issues: [{ key: k, code: 'INSUFFICIENT_STOCK', message: 'Only 1 left', localRef: 'OFF-0003', capturedAt: new Date().toISOString(), total: 120 }] };
  const before = { sales: await countOf(shop, 'sales'), mv: await countOf(shop, 'inventory_movements'), stock: await stockOf(shop, p) };
  const r1 = await api(shop.cashier.token).post('/sales/sync-issues', body);
  assert.equal(r1.status, 201); assert.equal(r1.body.recorded, 1);
  const again = await api(shop.cashier.token).post('/sales/sync-issues', body);
  assert.equal(again.status, 201); assert.equal(again.body.recorded, 0, 'same key + code is recorded once');
  const other = await api(shop.cashier.token).post('/sales/sync-issues', { issues: [{ ...body.issues[0], code: 'OFFLINE_PRICE_CHANGED' }] });
  assert.equal(other.body.recorded, 1);
  const rows = await auditRows(shop, 'sale.offline_sync_issue');
  assert.equal(rows.length, 2); assert.equal(rows[0].new_value.key, k); assert.equal(rows[0].account_id, shop.cashier.id);
  assert.deepEqual({ sales: await countOf(shop, 'sales'), mv: await countOf(shop, 'inventory_movements'), stock: await stockOf(shop, p) }, before, 'reporting an issue changes no sale, stock or ledger');
  const other2 = await makeShop(api);
  assert.equal((await auditRows(other2, 'sale.offline_sync_issue')).length, 0, 'another business sees nothing');
});

test('sync-issues: validation and authentication', async () => {
  const shop = await makeShop(api);
  assert.equal((await api().post('/sales/sync-issues', { issues: [{ key: key(), code: 'X' }] })).status, 401);
  assert.equal((await api(shop.cashier.token).post('/sales/sync-issues', { issues: [] })).status, 400);
  assert.equal((await api(shop.cashier.token).post('/sales/sync-issues', { issues: [{ key: 'nope', code: 'X' }] })).status, 400);
  assert.equal((await api(shop.cashier.token).post('/sales/sync-issues', { issues: Array.from({ length: 21 }, () => ({ key: key(), code: 'X' })) })).status, 400);
});

test('regression: a normal sale (no offline header, no expectedTotal) behaves exactly as before; todayIso sanity', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 5 });
  const r = await sale(shop, p.id, 1, key(), { who: 'owner' });
  assert.equal(r.status, 201); assert.match(r.body.invoiceNo, /^INV-\d{8}-\d{5}$/); assert.ok(todayIso());
});

// ---------------------------------------------------------------- Owner/Manager authorisation, enforced on the server
const fullBody = (p, q, extra = {}) => ({ items: [{ productId: p.id, quantity: q }], paymentMethod: 'cash', ...extra });
const cashierEmail = async (shop) => (await tq(shop, 'SELECT email FROM users WHERE id = $1', [shop.cashier.id]))[0].email;

test('accept-price: refused for a cashier on their own (403), refused for a cashier\'s or wrong credentials, allowed for a manager SESSION or a verified manager; only for the reviewed total', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 20 });
  await api(shop.owner.token).put(`/products/${p.id}`, { sellingPrice: 60 });          // customer was shown ₹105 (2 × 50 + 5% tax); it is now ₹126
  const base = (extra) => fullBody(p, 2, { expectedTotal: 10500, ...extra });
  const post = (who, body, k, hs = {}) => api(shop[who].token).post('/sales', body, hdr(k, { ...offlineHeader(shop), ...hs }));
  // plain refusal still works, for everyone
  const k1 = key(); const plain = await post('manager', base(), k1); assert.equal(plain.status, 409); assert.equal(plain.body.details.code, 'OFFLINE_PRICE_CHANGED');
  // acceptPriceTotal alone is not an authority for a cashier
  const r1 = await post('cashier', base({ acceptPriceTotal: 12600 }), k1); assert.equal(r1.status, 403); assert.equal(r1.body.details.code, 'OFFLINE_PRICE_APPROVAL_REQUIRED');
  const r2 = await post('cashier', base({ acceptPriceTotal: 12600, approval: { email: shop.manager.email, password: 'wrong-password' } }), k1); assert.equal(r2.status, 403);
  const r3 = await post('cashier', base({ acceptPriceTotal: 12600, approval: { email: await cashierEmail(shop), password: 'Passw0rdOK' } }), k1);
  assert.equal(r3.status, 403); assert.equal(r3.body.details.code, 'OFFLINE_PRICE_APPROVAL_REQUIRED');
  assert.equal(await stockOf(shop, p), 20); assert.equal((await tq(shop, 'SELECT 1 FROM sales')).length, 0); assert.equal((await tq(shop, 'SELECT 1 FROM sale_requests WHERE idempotency_key = $1', [k1])).length, 0, 'a refused decision leaves no claim behind');
  // a different reviewed total than the live price: decide again
  const stale = await post('manager', base({ acceptPriceTotal: 11000 }), k1); assert.equal(stale.status, 409); assert.equal(stale.body.details.code, 'OFFLINE_PRICE_CHANGED');
  // verified manager credentials with a cashier session: accepted, audited with BOTH people
  const ok = await post('cashier', base({ acceptPriceTotal: 12600, approval: { email: shop.manager.email, password: 'Passw0rdOK' } }), k1);
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(Number(ok.body.total), 126); assert.equal(await stockOf(shop, p), 18);
  const au = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.offline_price_accepted'`);
  assert.equal(au.length, 1); assert.deepEqual([au[0].new_value.approvedBy, au[0].new_value.requestedBy, au[0].new_value.difference], [shop.manager.id, shop.cashier.id, 21]);
  // a manager SESSION is its own authority; the owner too
  for (const who of ['manager', 'owner']) {
    const k = key(); const r = await post(who, base({ acceptPriceTotal: 12600 }), k); assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // the same key replays the original sale; the decision fields are not part of the idempotency hash
  const replay = await post('cashier', base({ acceptPriceTotal: 12600, approval: { email: shop.manager.email, password: 'Passw0rdOK' } }), k1);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, ok.body.id); assert.equal((await tq(shop, 'SELECT 1 FROM sales')).length, 3);
});

test('an offline sale cannot skip the price check by omitting expectedTotal; acceptPriceTotal without a price change changes nothing', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 20 });
  const missing = await api(shop.cashier.token).post('/sales', fullBody(p, 1), hdr(key(), offlineHeader(shop)));
  assert.equal(missing.status, 400); assert.equal(missing.body.details.code, 'OFFLINE_EXPECTED_TOTAL_REQUIRED'); assert.equal(await stockOf(shop, p), 20);
  const same = await api(shop.cashier.token).post('/sales', fullBody(p, 1, { expectedTotal: 5250, acceptPriceTotal: 5250 }), hdr(key(), offlineHeader(shop)));
  assert.equal(same.status, 201); assert.equal((await tq(shop, `SELECT 1 FROM audit_logs WHERE action = 'sale.offline_price_accepted'`)).length, 0, 'no price change, so no price decision');
});

test('offline-dismissals: owner/manager only, enforced on the server; audited with approver and reason; a recorded sale cannot be dismissed', async () => {
  const shop = await makeShop(api); const p = await addProduct(api, shop, { sellingPrice: 50, stock: 20 });
  const post = (who, body) => api(shop[who].token).post('/sales/offline-dismissals', body);
  const k = key(); const body = { key: k, reason: 'Customer left without paying', localRef: 'OFF-0003', total: 105 };
  assert.equal((await api().post('/sales/offline-dismissals', body)).status, 401);
  const none = await post('cashier', body); assert.equal(none.status, 403); assert.equal(none.body.details.code, 'OFFLINE_DISMISS_APPROVAL_REQUIRED');
  assert.equal((await post('cashier', { ...body, approval: { email: shop.manager.email, password: 'nope' } })).status, 403);
  assert.equal((await post('cashier', { ...body, approval: { email: await cashierEmail(shop), password: 'Passw0rdOK' } })).status, 403);
  assert.equal((await tq(shop, `SELECT 1 FROM audit_logs WHERE action = 'sale.offline_dismissed'`)).length, 0);
  assert.equal((await post('manager', { ...body, reason: 'ab' })).status, 400, 'a reason is mandatory');
  assert.equal((await post('manager', { ...body, key: 'not-a-uuid' })).status, 400);
  assert.equal((await post('cashier', { ...body, approval: { email: shop.manager.email, password: 'Passw0rdOK' } })).status, 201);
  assert.equal((await post('manager', { ...body, key: key() })).status, 201); assert.equal((await post('owner', { ...body, key: key() })).status, 201);
  const rows = await tq(shop, `SELECT new_value FROM audit_logs WHERE action = 'sale.offline_dismissed' ORDER BY id`);
  assert.equal(rows.length, 3); assert.deepEqual([rows[0].new_value.approvedBy, rows[0].new_value.requestedBy, rows[0].new_value.reason], [shop.manager.id, shop.cashier.id, 'Customer left without paying']);
  // a sale the server already recorded under that key is never "dismissed"
  const used = key(); assert.equal((await api(shop.owner.token).post('/sales', fullBody(p, 1), hdr(used))).status, 201);
  const late = await post('owner', { ...body, key: used }); assert.equal(late.status, 409); assert.equal(late.body.details.code, 'OFFLINE_SALE_ALREADY_RECORDED');
  // another business's manager credentials are not accepted (users are tenant-scoped)
  const other = await makeShop(api);
  const x = await post('cashier', { ...body, key: key(), approval: { email: other.manager.email, password: 'Passw0rdOK' } }); assert.equal(x.status, 403);
});
