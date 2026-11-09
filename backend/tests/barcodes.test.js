// Phase 8 — manufacturer barcodes. Everything goes through the real HTTP API as real tenants (never the UI).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');

// Valid GS1 codes (check digit verified): EAN-13 as printed on the DOMS example, a UPC-A and its EAN-13/GTIN-14 forms, EAN-8, and a code with a leading zero.
const EAN13 = '8906073778537';
const UPCA = '036000291452';
const UPCA_AS_EAN13 = '0036000291452';
const EAN8 = '96385074';
const LEADING_ZERO = '0891234567890';           // not a valid GS1 check digit on purpose: must still be stored byte-for-byte
const OTHER = '8901030865275';

let env; let api; let A; let B;
const ok = (r) => r.status >= 200 && r.status < 300;
const j = (r) => JSON.stringify(r.body ?? {});
const scan = (who, code, shop = A) => api(shop[who].token).get('/products/scan', { code });
const quick = (shop, over = {}) => api(shop.owner.token).post('/products/quick-create', { barcode: uniq('9').replace(/\D/g, '').padEnd(13, '1').slice(0, 13), name: uniq('Quick '), sellingPrice: 20, unit: 'pcs', stock: 10, ...over });

// The shared client's GET takes headers as its 2nd argument; here a params object becomes the query string (properly encoded).
const withParams = (raw) => (token, h) => { const c = raw(token, h); const g = c.get; return { ...c, get: (p, params) => g(params ? `${p}?${new URLSearchParams(params)}` : p) }; };
before(async () => { env = await boot(); api = withParams(client(env.base)); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

describe('barcode data model and lookup', () => {
  test('first-time registration: unknown barcode → quick-create → immediately scannable with this shop\'s price/stock', async () => {
    const before = await scan('owner', EAN13);
    assert.equal(before.status, 200); assert.equal(before.body.found, false); assert.equal(before.body.barcode, EAN13);
    assert.equal(before.body.canRegister, true);
    const r = await api(A.owner.token).post('/products/quick-create', { barcode: EAN13, name: 'DOMS Notebook', sellingPrice: 20, unit: 'pcs', stock: 12 });
    assert.equal(r.status, 201, j(r));
    assert.equal(r.body.found, true); assert.equal(r.body.matchedBy, 'barcode');
    assert.equal(r.body.product.name, 'DOMS Notebook'); assert.equal(r.body.product.price, 20); assert.equal(r.body.product.stock, 12);
    for (const who of ['owner', 'manager', 'cashier']) {
      const s = await scan(who, EAN13);
      assert.equal(s.body.found, true, who); assert.equal(s.body.product.name, 'DOMS Notebook'); assert.equal(s.body.product.price, 20);
    }
  });

  test('the barcode is stored as text: leading zeros survive exactly', async () => {
    const r = await quick(A, { barcode: LEADING_ZERO, name: 'Zero Lead' });
    assert.equal(r.status, 201, j(r));
    const s = await scan('cashier', LEADING_ZERO);
    assert.equal(s.body.product.barcode, LEADING_ZERO);
    const p = (await api(A.owner.token).get('/products', { q: 'Zero Lead' })).body.rows[0];
    assert.deepEqual(p.barcodes.map((b) => b.barcode), [LEADING_ZERO]);
    assert.equal(p.barcodes[0].type, 'other');   // bad check digit → kept, but not claimed to be an EAN-13
    // a DB-level proof it is not a number
    const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }); await c.connect();
    assert.equal((await c.query("SELECT data_type FROM information_schema.columns WHERE table_name='product_barcodes' AND column_name='barcode'")).rows[0].data_type, 'character varying');
    await c.end();
  });

  test('barcode type is derived from the check digit (EAN-13, EAN-8, UPC-A)', async () => {
    const p = await addProduct(api, A);
    for (const [code, type] of [[OTHER, 'ean13'], [EAN8, 'ean8'], [UPCA, 'upca']]) {
      const r = await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: code });
      assert.equal(r.status, 201, j(r)); assert.equal(r.body.barcode.type, type);
    }
  });

  test('a UPC-A read as EAN-13 (leading 0) finds the same product, and the stored value is not rewritten', async () => {
    const p = await addProduct(api, A, { name: 'UPC item' });
    assert.equal((await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '614141000036' })).status, 201);
    const viaEan = await scan('cashier', '0614141000036');
    assert.equal(viaEan.body.found, true); assert.equal(viaEan.body.product.id, p.id);
    assert.equal(viaEan.body.product.barcode, '614141000036');
    assert.equal((await scan('cashier', '000614141000036')).body.found, false, 'a 15-digit string is not a GTIN');
    assert.equal((await scan('cashier', '00614141000036')).body.product.id, p.id, 'GTIN-14 form');
  });

  test('multiple barcodes for one product: scanning either adds the same product; first is primary', async () => {
    const p = await addProduct(api, A, { name: 'Cola 750ml' });
    const c1 = '8901764012273'; const c2 = '8901764032059';
    const a = await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: c1 });
    const b = await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: c2 });
    assert.equal(a.body.barcode.isPrimary, true); assert.equal(b.body.barcode.isPrimary, false);
    assert.equal((await scan('cashier', c1)).body.product.id, p.id);
    assert.equal((await scan('cashier', c2)).body.product.id, p.id);
    const list = await api(A.owner.token).get(`/products/${p.id}/barcodes`);
    assert.deepEqual(list.body.rows.map((r) => r.barcode), [c1, c2]);
  });

  test('duplicate barcode in the same shop is refused (409) and names the owning product; equivalent widths count as duplicates', async () => {
    const p1 = await addProduct(api, A, { name: 'First owner' }); const p2 = await addProduct(api, A, { name: 'Second try' });
    const code = '8901234567897';
    assert.equal((await api(A.owner.token).post(`/products/${p1.id}/barcodes`, { barcode: code })).status, 201);
    const dup = await api(A.owner.token).post(`/products/${p2.id}/barcodes`, { barcode: code });
    assert.equal(dup.status, 409); assert.equal(dup.body.details.code, 'BARCODE_TAKEN'); assert.equal(dup.body.details.productName, 'First owner');
    const again = await api(A.owner.token).post(`/products/${p1.id}/barcodes`, { barcode: code });
    assert.equal(again.status, 409, 'same product, same code');
    const upc = await api(A.owner.token).post(`/products/${p1.id}/barcodes`, { barcode: '012345678905' });
    assert.equal(upc.status, 201);
    assert.equal((await api(A.owner.token).post(`/products/${p2.id}/barcodes`, { barcode: '0012345678905' })).status, 409, 'EAN-13 form of an existing UPC-A');
  });

  test('creating a product with a duplicate barcode rolls the whole product back', async () => {
    const code = '8901111111113';
    assert.equal((await quick(A, { barcode: code })).status, 201);
    const before = (await api(A.owner.token).get('/products', { limit: 200 })).body.total;
    const r = await quick(A, { barcode: code, name: 'Ghost product' });
    assert.equal(r.status, 409);
    const after = (await api(A.owner.token).get('/products', { limit: 200 })).body.total;
    assert.equal(after, before);
    assert.equal((await api(A.owner.token).get('/products', { q: 'Ghost product' })).body.rows.length, 0);
  });

  test('POST /products accepts an optional barcode, atomically', async () => {
    const r = await api(A.owner.token).post('/products', { name: uniq('WithCode '), categoryId: A.category.id, purchasePrice: 5, sellingPrice: 9, stock: 3, minimumStock: 1, barcode: '8902222222226' });
    assert.equal(r.status, 201, j(r)); assert.equal(r.body.barcodes[0].barcode, '8902222222226');
    assert.equal((await scan('cashier', '8902222222226')).body.product.id, r.body.id);
  });

  test('SKU still works as a scan fallback (shops that typed their code into SKU)', async () => {
    const sku = `SKU${Date.now()}`;
    const p = await addProduct(api, A, { sku });
    const s = await scan('cashier', sku);
    assert.equal(s.body.found, true); assert.equal(s.body.matchedBy, 'sku'); assert.equal(s.body.product.id, p.id);
  });

  test('searching products by (part of) a barcode finds them, in the manager list and the POS search', async () => {
    const p = await addProduct(api, A, { name: 'Findable', stock: 5 });
    await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '8903333333335' });
    assert.equal((await api(A.owner.token).get('/products', { q: '33333333' })).body.rows[0].id, p.id);
    assert.ok((await api(A.cashier.token).get('/products/pos-search', { q: '8903333333335' })).body.rows.some((r) => r.id === p.id));
  });
});

describe('barcode management and RBAC', () => {
  test('replace, make primary, and remove (primary is promoted)', async () => {
    const p = await addProduct(api, A);
    const b1 = (await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '8904444444444' })).body.barcode;
    const b2 = (await api(A.manager.token).post(`/products/${p.id}/barcodes`, { barcode: '8904444444451' })).body.barcode;
    const rep = await api(A.owner.token).put(`/products/${p.id}/barcodes/${b1.id}`, { barcode: '8904444444468' });
    assert.equal(rep.status, 200, j(rep)); assert.equal(rep.body.barcode.barcode, '8904444444468');
    assert.equal((await scan('cashier', '8904444444444')).body.found, false, 'the old code no longer scans');
    assert.equal((await scan('cashier', '8904444444468')).body.product.id, p.id);
    const prim = await api(A.manager.token).put(`/products/${p.id}/barcodes/${b2.id}`, { isPrimary: true });
    assert.equal(prim.body.barcode.isPrimary, true);
    const rows = (await api(A.owner.token).get(`/products/${p.id}/barcodes`)).body.rows;
    assert.equal(rows.filter((r) => r.isPrimary).length, 1); assert.equal(rows[0].id, b2.id);
    assert.equal((await api(A.owner.token).del(`/products/${p.id}/barcodes/${b2.id}`)).status, 200);
    const left = (await api(A.owner.token).get(`/products/${p.id}/barcodes`)).body.rows;
    assert.equal(left.length, 1); assert.equal(left[0].isPrimary, true, 'the remaining barcode became primary');
    assert.equal((await scan('cashier', '8904444444451')).body.found, false, 'a removed barcode no longer scans');
    assert.equal((await api(A.owner.token).del(`/products/${p.id}/barcodes/${b2.id}`)).status, 404);
  });
  test('replacing with a code another product owns is refused', async () => {
    const p1 = await addProduct(api, A); const p2 = await addProduct(api, A);
    await api(A.owner.token).post(`/products/${p1.id}/barcodes`, { barcode: '8905555555552' });
    const b = (await api(A.owner.token).post(`/products/${p2.id}/barcodes`, { barcode: '8905555555569' })).body.barcode;
    assert.equal((await api(A.owner.token).put(`/products/${p2.id}/barcodes/${b.id}`, { barcode: '8905555555552' })).status, 409);
    assert.equal((await api(A.owner.token).put(`/products/${p2.id}/barcodes/${b.id}`, {})).status, 400);
    assert.equal((await api(A.owner.token).put(`/products/${p1.id}/barcodes/${b.id}`, { barcode: '8905555555576' })).status, 404, 'barcode id belongs to another product');
  });
  test('a deleted (archived) product frees its barcodes', async () => {
    const code = '8906666666668';
    const p = await addProduct(api, A);
    await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: code });
    assert.equal((await api(A.owner.token).del(`/products/${p.id}`)).status, 200);
    assert.equal((await scan('cashier', code)).body.found, false);
    assert.equal((await quick(A, { barcode: code })).status, 201, 'the code can be registered again');
  });
  test('cashier cannot register, link, replace, remove or list barcodes — but can scan', async () => {
    const p = await addProduct(api, A); const c = api(A.cashier.token);
    const b = (await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '8907777777771' })).body.barcode;
    assert.equal((await c.post('/products/quick-create', { barcode: '8907777777788', name: 'x', sellingPrice: 1 })).status, 403);
    assert.equal((await c.post(`/products/${p.id}/barcodes`, { barcode: '8907777777788' })).status, 403);
    assert.equal((await c.put(`/products/${p.id}/barcodes/${b.id}`, { barcode: '8907777777788' })).status, 403);
    assert.equal((await c.del(`/products/${p.id}/barcodes/${b.id}`)).status, 403);
    assert.equal((await c.get(`/products/${p.id}/barcodes`)).status, 403);
    assert.equal((await c.post('/products', { name: 'x', categoryId: A.category.id, purchasePrice: 1, sellingPrice: 2, barcode: '8907777777795' })).status, 403);
    const s = await scan('cashier', '8907777777788'); assert.equal(s.status, 200); assert.equal(s.body.found, false); assert.equal(s.body.canRegister, false);
    assert.equal((await scan('cashier', '8907777777771')).body.found, true);
    assert.equal((await scan('cashier', '8907777777788')).body.found, false, 'nothing was created by the refused calls');
  });
  test('manager can manage barcodes; unauthenticated calls are 401', async () => {
    const p = await addProduct(api, A); const m = api(A.manager.token);
    assert.equal((await m.post(`/products/${p.id}/barcodes`, { barcode: '8908888888881' })).status, 201);
    assert.equal((await m.post('/products/quick-create', { barcode: '8908888888898', name: 'Mgr made', sellingPrice: 5, stock: 1 })).status, 201);
    assert.equal((await api().get('/products/scan', { code: EAN13 })).status, 401);
    assert.equal((await api().post('/products/quick-create', {})).status, 401);
  });
  test('every barcode change is audited, without secrets', async () => {
    const p = await addProduct(api, A, { name: 'Audited' });
    const b = (await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '8909999999995' })).body.barcode;
    await api(A.owner.token).put(`/products/${p.id}/barcodes/${b.id}`, { barcode: '8909999999902' });
    await api(A.owner.token).del(`/products/${p.id}/barcodes/${b.id}`);
    const rows = (await api(A.owner.token).get('/audit', { pageSize: 100 })).body.rows;
    for (const a of ['product.barcode_added', 'product.barcode_replaced', 'product.barcode_removed']) assert.ok(rows.some((r) => r.action === a), a);
    assert.ok(!/passw|token|secret/i.test(JSON.stringify(rows.filter((r) => /barcode/.test(r.action)))));
  });
});

describe('multi-tenant isolation of barcodes', () => {
  test('two shops use the same manufacturer barcode with their own product, price and stock', async () => {
    const code = '8906073778537';
    const a = await api(A.owner.token).get('/products/scan', { code });   // registered earlier in this file for A
    assert.equal(a.body.found, true);
    const rb = await api(B.owner.token).post('/products/quick-create', { barcode: code, name: 'DOMS Notebook B', sellingPrice: 25, unit: 'pcs', stock: 3 });
    assert.equal(rb.status, 201, j(rb));
    const sa = (await scan('cashier', code, A)).body.product; const sb = (await scan('cashier', code, B)).body.product;
    assert.deepEqual([sa.name, sa.price, sa.stock], ['DOMS Notebook', 20, 12]);
    assert.deepEqual([sb.name, sb.price, sb.stock], ['DOMS Notebook B', 25, 3]);
    assert.notEqual(sa.id, sb.id);
    assert.ok(!j(await scan('manager', code, B)).includes('DOMS Notebook"'), 'B never sees A\'s product name');
  });
  test('B cannot see, link to, change or remove A\'s barcodes or products', async () => {
    const p = await addProduct(api, A); const only = '8900000000014';
    const bc = (await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: only })).body.barcode;
    for (const who of ['owner', 'manager', 'cashier']) assert.equal((await scan(who, only, B)).body.found, false, `${who} sees A's barcode`);
    const o = api(B.owner.token);
    assert.equal((await o.get(`/products/${p.id}/barcodes`)).status, 404);
    assert.equal((await o.post(`/products/${p.id}/barcodes`, { barcode: '8900000000021' })).status, 404, 'cannot link a barcode to A\'s product');
    assert.equal((await o.put(`/products/${p.id}/barcodes/${bc.id}`, { barcode: '8900000000038' })).status, 404);
    assert.equal((await o.del(`/products/${p.id}/barcodes/${bc.id}`)).status, 404);
    assert.equal((await scan('cashier', only, A)).body.product.id, p.id, 'A is untouched');
    assert.equal((await o.post('/products/quick-create', { barcode: only, name: 'B uses it too', sellingPrice: 7, stock: 1 })).status, 201, 'the same code is fine in B');
    assert.equal((await scan('cashier', only, A)).body.product.id, p.id);
  });
  test('the database itself hides and protects other shops\' mappings (RLS)', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    assert.equal(Number((await c.query('SELECT count(*) FROM product_barcodes')).rows[0].count), 0, 'no tenant → nothing visible');
    await assert.rejects(c.query("INSERT INTO product_barcodes (business_id, product_id, barcode) VALUES (1, 1, 'X-NO-TENANT')"));
    await c.query('BEGIN'); await c.query("SELECT set_config('app.business_id', $1, true)", [String(B.businessId)]);
    const aProduct = (await api(A.owner.token).get('/products', { limit: 1 })).body.rows[0].id;
    assert.equal(Number((await c.query('SELECT count(*) FROM product_barcodes WHERE business_id = $1', [A.businessId])).rows[0].count), 0);
    await c.query('SAVEPOINT s');
    await assert.rejects(c.query("INSERT INTO product_barcodes (business_id, product_id, barcode) VALUES ($1, $2, 'X-CROSS-1234')", [A.businessId, aProduct]));   // RLS check
    await c.query('ROLLBACK TO s');
    await assert.rejects(c.query("INSERT INTO product_barcodes (business_id, product_id, barcode) VALUES ($1, $2, 'X-CROSS-5678')", [B.businessId, aProduct]));  // composite FK: A's product
    await c.query('ROLLBACK'); await c.end();
  });
  test('product_barcodes has forced RLS and the backup role can read it', async () => {
    const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL }); await c.connect();
    const t = (await c.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='product_barcodes'")).rows[0];
    assert.deepEqual(t, { relrowsecurity: true, relforcerowsecurity: true });
    assert.ok((await c.query("SELECT 1 FROM pg_policies WHERE tablename='product_barcodes' AND policyname='backup_read'")).rowCount === 1);
    await c.end();
  });
});

describe('malformed and hostile barcode input', () => {
  const bad = ['', ' ', 'abc', 'a b c d e', '../../etc/passwd', "8906073778537'; DROP TABLE products;--", '<script>alert(1)</script>', 'x'.repeat(49), '８９０６０７３７７８５３７', '8906073778537\u0000', '%00%00%00%00'];
  test('scan rejects every malformed code with 400 (never 500, never a leak)', async () => {
    for (const code of bad) {
      const r = await scan('cashier', code);
      assert.ok(r.status === 400, `${JSON.stringify(code)} → ${r.status}`);
      assert.ok(!/at .*\.js:\d+/.test(j(r)));
    }
    assert.equal((await api(A.cashier.token).get('/products/scan')).status, 400, 'missing code');
    const r = await fetch(`${env.base}/products/scan?code[]=1&code[]=2`, { headers: { authorization: `Bearer ${A.cashier.token}` } });
    assert.equal(r.status, 400);
  });
  test('registration rejects malformed codes and absurd input; nothing is created', async () => {
    for (const barcode of bad.filter((b) => b.trim())) {
      assert.equal((await quick(A, { barcode, name: 'Bad one' })).status, 400, JSON.stringify(barcode));
    }
    assert.equal((await quick(A, { barcode: '8900000000045', name: '' })).status, 400);
    assert.equal((await quick(A, { barcode: '8900000000045', name: 'Neg', sellingPrice: -1 })).status, 400);
    assert.equal((await quick(A, { barcode: '8900000000045', name: 'Huge', sellingPrice: 1e9 })).status, 400);
    assert.equal((await quick(A, { barcode: '8900000000045', name: 'BadUnit', unit: 'bucket' })).status, 400);
    assert.equal((await quick(A, { barcode: '8900000000045', name: 'Frac', unit: 'pcs', stock: 1.5 })).status, 400, 'whole units reject fractions');
    assert.equal((await api(A.owner.token).get('/products', { q: 'Bad one' })).body.rows.length, 0);
  });
  test('scanner noise (surrounding whitespace / CR / LF) is trimmed; SQL-looking text is only ever data', async () => {
    assert.equal((await scan('cashier', ` ${EAN13}\r\n`)).body.found, true);
    const r = await scan('cashier', "8906073778537' OR '1'='1");
    assert.equal(r.status, 400);
    assert.equal((await api(A.owner.token).get('/products', { q: "' OR 1=1 --" })).status, 200);
  });
  test('mass assignment: tenant/business fields in a barcode body are ignored', async () => {
    const p = await addProduct(api, A);
    const r = await api(A.owner.token).post(`/products/${p.id}/barcodes`, { barcode: '8900000000052', businessId: B.businessId, business_id: B.businessId, productId: 1 });
    assert.equal(r.status, 201);
    assert.equal((await scan('cashier', '8900000000052', A)).body.product.id, p.id);
    assert.equal((await scan('cashier', '8900000000052', B)).body.found, false);
  });
});

describe('Counter flows: a scanned product goes through the EXISTING sales engine', () => {
  let p; let code; const pay = (shop, body, who = 'cashier') => api(shop[who].token).post('/sales', body, { 'idempotency-key': crypto.randomUUID() });
  before(async () => {
    code = '8901058842348';
    const r = await api(A.owner.token).post('/products/quick-create', { barcode: code, name: 'Scan Cart Item', sellingPrice: 100, unit: 'pcs', stock: 20, purchasePrice: 60 });
    assert.equal(r.status, 201, j(r)); p = r.body.product;
  });
  const lineFor = async (sale) => (await api(A.owner.token).get(`/sales/${sale.id}`)).body.items;

  test('scan 5 times → ONE cart line with quantity 5 (the cart is productId + quantity; the preview prices it)', async () => {
    const lines = new Map();
    for (let i = 0; i < 5; i += 1) { const s = (await scan('cashier', code)).body; lines.set(s.product.id, (lines.get(s.product.id) || 0) + 1); }
    assert.equal(lines.size, 1); assert.equal(lines.get(p.id), 5);
    const prev = await api(A.cashier.token).post('/sales/preview', { items: [{ productId: p.id, quantity: 5 }] });
    assert.equal(prev.status, 200, j(prev)); assert.equal(prev.body.items.length, 1); assert.equal(prev.body.items[0].quantity, 5);
    assert.equal(Number(prev.body.items[0].unitPrice ?? prev.body.items[0].price ?? 100), 100);
  });
  test('scan several different products, pay cash: stock drops, inventory movement and audit exist', async () => {
    const q = await addProduct(api, A, { stock: 9, sellingPrice: 30 });
    await api(A.owner.token).post(`/products/${q.id}/barcodes`, { barcode: '8901207005032' });
    const x = (await scan('cashier', code)).body.product; const y = (await scan('cashier', '8901207005032')).body.product;
    const sale = await pay(A, { items: [{ productId: x.id, quantity: 2 }, { productId: y.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.equal(sale.status, 201, j(sale));
    assert.equal((await scan('owner', code)).body.product.stock, 18);
    assert.equal((await scan('owner', '8901207005032')).body.product.stock, 8);
    const mv = (await api(A.owner.token).get(`/inventory/${x.id}/movements`)).body;
    assert.ok(JSON.stringify(mv).includes('sale'));
  });
  test('split payment after scanning', async () => {
    const x = (await scan('cashier', code)).body.product;
    const total = Number((await api(A.cashier.token).post('/sales/preview', { items: [{ productId: x.id, quantity: 1 }] })).body.total);
    const sale = await pay(A, { items: [{ productId: x.id, quantity: 1 }], payments: [{ method: 'cash', amount: 40 }, { method: 'upi', amount: +(total - 40).toFixed(2) }] });
    assert.equal(sale.status, 201, j(sale)); assert.equal(sale.body.payments.length, 2);
  });
  test('Udhaar (credit) after scanning needs a customer', async () => {
    const x = (await scan('cashier', code)).body.product; const cust = await addCustomer(api, A);
    await api(A.owner.token).put(`/credit/customers/${cust.id}/limit`, { creditLimit: 5000 });
    assert.equal((await pay(A, { items: [{ productId: x.id, quantity: 1 }], paymentMethod: 'credit' })).status, 400);
    const ok1 = await pay(A, { items: [{ productId: x.id, quantity: 1 }], paymentMethod: 'credit', customerId: cust.id });
    assert.equal(ok1.status, 201, j(ok1));
    const bal = (await api(A.owner.token).get(`/credit/customers/${cust.id}/balance`)).body;
    assert.ok(Number(bal.balance ?? bal.outstanding ?? 0) > 0);
  });
  test('hold after scanning, then resume and complete', async () => {
    const x = (await scan('cashier', code)).body.product;
    const h = await api(A.cashier.token).post('/held-bills', { items: [{ productId: x.id, quantity: 2 }] }, { 'idempotency-key': crypto.randomUUID() });
    assert.equal(h.status, 201, j(h));
    const stockBefore = (await scan('owner', code)).body.product.stock;
    const r = await api(A.cashier.token).post(`/held-bills/${h.body.hold.id}/resume`);
    assert.equal(r.status, 200);
    const done = await api(A.cashier.token).post(`/held-bills/${h.body.hold.id}/complete`, { paymentMethod: 'cash' }, { 'idempotency-key': crypto.randomUUID() });
    assert.equal(done.status, 201, j(done));
    assert.equal((await scan('owner', code)).body.product.stock, stockBefore - 2);
  });
  test('out-of-stock: the barcode IS recognised (flagged), and the sale engine refuses to sell it — no negative stock', async () => {
    const z = await addProduct(api, A, { stock: 1, sellingPrice: 10, name: 'Last one' });
    await api(A.owner.token).post(`/products/${z.id}/barcodes`, { barcode: '8901491101837' });
    assert.equal((await pay(A, { items: [{ productId: z.id, quantity: 1 }], paymentMethod: 'cash' })).status, 201);
    const s = (await scan('cashier', '8901491101837')).body;
    assert.equal(s.found, true); assert.equal(s.product.outOfStock, true); assert.equal(s.product.stock, 0);
    const again = await pay(A, { items: [{ productId: z.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.equal(again.status, 409); assert.match(again.body.error, /Insufficient stock/);
    assert.equal((await scan('owner', '8901491101837')).body.product.stock, 0);
  });
  test('expired products are recognised but flagged expired (and the sale engine refuses them)', async () => {
    const e = await addProduct(api, A, { stock: 4, expiryDate: '2020-01-01', name: 'Old milk' });
    await api(A.owner.token).post(`/products/${e.id}/barcodes`, { barcode: '8901262150439' });
    const s = (await scan('cashier', '8901262150439')).body;
    assert.equal(s.found, true); assert.equal(s.product.expired, true);
    assert.equal((await pay(A, { items: [{ productId: e.id, quantity: 1 }], paymentMethod: 'cash' })).status, 400);
  });
  test('the price comes from the shop, never from the barcode or the client', async () => {
    const x = (await scan('cashier', code)).body.product;
    const sale = await pay(A, { items: [{ productId: x.id, quantity: 1, price: 0.01 }], paymentMethod: 'cash', barcode: code, total: 0.01 });
    assert.equal(sale.status, 201); assert.ok(Number(sale.body.total) >= 100);
  });
  test('a scanned barcode of another shop cannot be sold here (cross-tenant product id)', async () => {
    const bProduct = (await scan('owner', EAN13, B)).body.product || (await api(B.owner.token).post('/products/quick-create', { barcode: '8901030895262', name: 'B only', sellingPrice: 5, stock: 5 })).body.product;
    const r = await pay(A, { items: [{ productId: bProduct.id, quantity: 1 }], paymentMethod: 'cash' });
    assert.ok(!ok(r), `cross-tenant sale -> ${r.status}`);
  });
  test('a replayed sale (same Idempotency-Key) after scanning never double-sells', async () => {
    const x = (await scan('cashier', code)).body.product; const key = crypto.randomUUID(); const body = { items: [{ productId: x.id, quantity: 1 }], paymentMethod: 'cash' };
    const before = (await scan('owner', code)).body.product.stock;
    const r1 = await api(A.cashier.token).post('/sales', body, { 'idempotency-key': key }); const r2 = await api(A.cashier.token).post('/sales', body, { 'idempotency-key': key });
    assert.equal(r1.status, 201); assert.equal(r2.status, 200); assert.equal(r1.body.id, r2.body.id);
    assert.equal((await scan('owner', code)).body.product.stock, before - 1);
    void lineFor;
  });
});
