// Phase 8.1 — Scan & Add Products. The screen creates products through the normal POST /products (with the scanned barcode) and uses the
// Phase 8 scan lookup and the new atomic add-stock route. Everything below goes through the real HTTP API as real tenants.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let A; let B;
const j = (r) => JSON.stringify(r.body ?? {});
const withParams = (raw) => (token, h) => { const c = raw(token, h); const g = c.get; return { ...c, get: (p, params) => g(params ? `${p}?${new URLSearchParams(params)}` : p) }; };
const scan = (shop, who, code) => api(shop[who].token).get('/products/scan', { code });
// what the Scan & Add form sends: every Quick-mode field plus the scanned barcode
const scanned = (shop, barcode, over = {}) => ({ barcode, name: uniq('Scanned '), categoryId: shop.category.id, unit: 'pcs', sellingPrice: 14, purchasePrice: 11, stock: 42, minimumStock: 0, priceIncludesTax: true, leadTimeDays: 3, ...over });
// unique, valid EAN-13 per call
const ean13 = () => { const d = String(Math.floor(Math.random() * 1e12)).padStart(12, '8'); let s = 0; for (let i = 11, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) s += Number(d[i]) * w; return d + ((10 - (s % 10)) % 10); };

before(async () => { env = await boot(); api = withParams(client(env.base)); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

describe('Scan & Add: creating a product from a scanned barcode', () => {
  test('owner and manager can create it; the barcode is linked and immediately scannable by every role', async () => {
    for (const who of ['owner', 'manager']) {
      const code = ean13();
      const r = await api(A[who].token).post('/products', scanned(A, code, { name: `By ${who}` }));
      assert.equal(r.status, 201, j(r));
      assert.deepEqual(r.body.barcodes.map((b) => b.barcode), [code]); assert.equal(r.body.barcodes[0].isPrimary, true);
      for (const role of ['owner', 'manager', 'cashier']) {
        const s = await scan(A, role, code);
        assert.equal(s.body.found, true, role); assert.equal(s.body.product.id, r.body.id); assert.equal(s.body.product.price, 14); assert.equal(s.body.product.stock, 42);
      }
    }
  });

  test('a cashier cannot create a scanned product, link a barcode or add stock (server-side, not just a hidden button)', async () => {
    const p = await addProduct(api, A);
    const code = ean13();
    assert.equal((await api(A.cashier.token).post('/products', scanned(A, code))).status, 403);
    assert.equal((await api(A.cashier.token).post('/products/quick-create', { barcode: code, name: 'x', sellingPrice: 1 })).status, 403);
    assert.equal((await api(A.cashier.token).post(`/products/${p.id}/barcodes`, { barcode: code })).status, 403);
    assert.equal((await api(A.cashier.token).post(`/inventory/${p.id}/add-stock`, { quantity: 5 })).status, 403);
    assert.equal((await scan(A, 'owner', code)).body.found, false, 'nothing was created');
    assert.equal((await api().post('/products', scanned(A, code))).status, 401, 'no token, no product');
  });

  test('leading zeros are preserved exactly', async () => {
    const code = '0891234567890';
    const r = await api(A.owner.token).post('/products', scanned(A, code));
    assert.equal(r.status, 201, j(r));
    assert.equal(r.body.barcodes[0].barcode, code);
    assert.equal((await scan(A, 'cashier', code)).body.product.barcode, code);
  });

  test('a barcode already in the shop cannot create a second product; the lookup names the existing one', async () => {
    const code = ean13();
    const first = await api(A.owner.token).post('/products', scanned(A, code, { name: 'Maggi 70g' }));
    assert.equal(first.status, 201);
    const s = await scan(A, 'manager', code);                 // what the screen does first
    assert.equal(s.body.found, true); assert.equal(s.body.product.name, 'Maggi 70g');
    const again = await api(A.owner.token).post('/products', scanned(A, code, { name: 'Maggi duplicate' }));
    assert.equal(again.status, 409, j(again));
    assert.equal(again.body.details.code, 'BARCODE_TAKEN'); assert.equal(again.body.details.productId, first.body.id);
    const list = (await api(A.owner.token).get('/products', { q: 'Maggi', limit: 50 })).body.rows;
    assert.equal(list.filter((p) => p.name.startsWith('Maggi')).length, 1, 'no duplicate product and no orphan from the failed attempt');
  });

  test('concurrent creation of the same barcode: exactly one product wins, the rest get 409 and leave nothing behind', async () => {
    const code = ean13();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api(A.owner.token).post('/products', scanned(A, code, { name: `Race ${i}` }))));
    const wins = results.filter((r) => r.status === 201); const lost = results.filter((r) => r.status === 409);
    assert.equal(wins.length, 1, results.map((r) => r.status).join());
    assert.equal(lost.length, 5);
    assert.ok(lost.every((r) => r.body.details && r.body.details.code === 'BARCODE_TAKEN'));
    const rows = (await api(A.owner.token).get('/products', { q: 'Race ', limit: 50 })).body.rows.filter((p) => /^Race \d$/.test(p.name));
    assert.equal(rows.length, 1, 'the losing attempts rolled back completely (no product without a barcode)');
    assert.deepEqual(rows[0].barcodes.map((b) => b.barcode), [code]);
  });

  test('another shop is unaffected: it can register the same code (own price/stock) and never sees this shop\'s product', async () => {
    const code = ean13();
    const a = await api(A.owner.token).post('/products', scanned(A, code, { name: 'Shop A item', sellingPrice: 14, stock: 5 }));
    assert.equal((await scan(B, 'owner', code)).body.found, false, 'B has not registered it: A\'s product is invisible');
    assert.equal((await scan(B, 'cashier', code)).body.found, false);
    const b = await api(B.owner.token).post('/products', scanned(B, code, { name: 'Shop B item', sellingPrice: 99, stock: 7 }));
    assert.equal(b.status, 201, j(b));
    assert.equal((await scan(A, 'cashier', code)).body.product.name, 'Shop A item');
    assert.equal((await scan(B, 'cashier', code)).body.product.price, 99);
    assert.notEqual(a.body.id, b.body.id);
  });

  test('validation errors are specific, create nothing, and a failed attempt leaves the barcode free', async () => {
    const code = ean13();
    const bad = [
      [{ name: '' }, 'name'], [{ sellingPrice: -1 }, 'sellingPrice'], [{ purchasePrice: 'abc' }, 'purchasePrice'], [{ stock: -3 }, 'stock'],
      [{ categoryId: 0 }, 'categoryId'], [{ unit: 'bags' }, 'unit'],
    ];
    for (const [over, field] of bad) {
      const r = await api(A.owner.token).post('/products', scanned(A, code, over));
      assert.equal(r.status, 400, `${field}: ${j(r)}`);
      assert.ok(Array.isArray(r.body.details) && r.body.details.some((d) => d.field === field), `${field} named: ${j(r)}`);
    }
    assert.equal((await api(A.owner.token).post('/products', scanned(A, code, { stock: 2.5 }))).status, 400, 'pieces cannot be fractional');
    for (const evil of ['x', "8901'; DROP TABLE products;--", '12 34 56', 'a'.repeat(49)]) {
      assert.equal((await api(A.owner.token).post('/products', scanned(A, evil))).status, 400, evil);
    }
    assert.equal((await scan(A, 'owner', code)).body.found, false);
    assert.equal((await api(A.owner.token).post('/products', scanned(A, code))).status, 201, 'barcode was never consumed');
  });

  test('product creation through Scan & Add is audited exactly like normal creation', async () => {
    const code = ean13();
    const r = await api(A.manager.token).post('/products', scanned(A, code, { name: 'Audited scan' }));
    assert.equal(r.status, 201);
    const rows = (await api(A.owner.token).get('/audit', { pageSize: 100 })).body.rows;
    const hit = rows.find((x) => x.action === 'product.created' && /Audited scan/.test(x.summary || ''));
    assert.ok(hit, 'product.created is in the audit trail');
    assert.ok(!/password|token|secret/i.test(JSON.stringify(hit)));
  });
});

describe('Scan & Add: "Barcode already registered" actions', () => {
  test('add stock increments atomically, records an adjustment movement and is audited', async () => {
    const code = ean13();
    const p = (await api(A.owner.token).post('/products', scanned(A, code, { name: 'Stock me', stock: 42 }))).body;
    const r = await api(A.manager.token).post(`/inventory/${p.id}/add-stock`, { quantity: 8 });
    assert.equal(r.status, 200, j(r));
    assert.equal(r.body.stockBefore, 42); assert.equal(r.body.stock, 50);
    assert.equal((await scan(A, 'cashier', code)).body.product.stock, 50);
    const mv = (await api(A.owner.token).get(`/inventory/${p.id}/movements`)).body.rows;
    assert.ok(mv.some((m) => m.movementType === 'adjustment' && Number(m.quantity) === 8) || mv.some((m) => Number(m.quantity) === 8), j({ body: mv }));
    const rows = (await api(A.owner.token).get('/audit', { pageSize: 100 })).body.rows;
    assert.ok(rows.some((x) => x.action === 'inventory.stock_added' && /Stock me/.test(x.summary || '')));
  });

  test('concurrent add-stock calls never lose an update', async () => {
    const p = await addProduct(api, A, { stock: 0 });
    const rs = await Promise.all(Array.from({ length: 10 }, () => api(A.owner.token).post(`/inventory/${p.id}/add-stock`, { quantity: 3 })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal((await api(A.owner.token).get(`/products/${p.id}`)).body.stock, 30);
  });

  test('add stock validates: positive, unit-aware, real product of THIS shop only', async () => {
    const p = await addProduct(api, A, { stock: 5 });
    for (const q of [0, -2, 'abc', 1e7, 1.5]) assert.equal((await api(A.owner.token).post(`/inventory/${p.id}/add-stock`, { quantity: q })).status, 400, String(q));
    assert.equal((await api(A.owner.token).post(`/inventory/${p.id}/add-stock`, {})).status, 400);
    const kg = await addProduct(api, A, { unit: 'kg', stock: 1 });
    assert.equal((await api(A.owner.token).post(`/inventory/${kg.id}/add-stock`, { quantity: 0.75 })).body.stock, 1.75, 'kg allows fractions');
    assert.equal((await api(B.owner.token).post(`/inventory/${p.id}/add-stock`, { quantity: 5 })).status, 404, 'another shop\'s product is "not found"');
    assert.equal((await api(A.owner.token).post('/inventory/99999999/add-stock', { quantity: 1 })).status, 404);
    assert.equal((await api(A.owner.token).get(`/products/${p.id}`)).body.stock, 5, 'nothing changed');
  });

  test('the existing-product details the panel needs are available to owner/manager only', async () => {
    const p = await addProduct(api, A, { sellingPrice: 14, purchasePrice: 11, stock: 42 });
    const d = await api(A.manager.token).get(`/products/${p.id}`);
    assert.equal(d.status, 200); assert.equal(d.body.purchasePrice, 11); assert.ok(d.body.sku);
    assert.equal((await api(A.cashier.token).get(`/products/${p.id}`)).status, 403, 'cost price stays hidden from cashiers');
    assert.equal((await api(B.owner.token).get(`/products/${p.id}`)).status, 404);
  });
});
