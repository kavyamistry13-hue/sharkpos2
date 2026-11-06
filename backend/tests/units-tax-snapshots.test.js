// Sprint 1 — decimal quantities, units, tax-inclusive pricing, and historical snapshots (cost / tax / discount) on sale lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');
const { computeBill } = require('../src/services/billing');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const paise = (n) => Math.round(n * 100);
const sumTaxable = (b) => b.items.reduce((a, i) => a + paise(i.taxableValue) + paise(i.tax), 0);

// ---------------------------------------------------------------- pure billing maths
test('billing: tax added on top is unchanged (regression)', () => {
  const b = computeBill([{ productId: 1, name: 'a', quantity: 2, unitPaise: 5000, taxRate: 5 }], null);
  assert.equal(b.subtotal, 100); assert.equal(b.tax, 5); assert.equal(b.total, 105); assert.equal(b.taxIncluded, 0); assert.equal(b.taxAdded, 5);
});

test('billing: tax-inclusive price (MRP) — the shelf price is the total, tax is carved out of it', () => {
  const b = computeBill([{ productId: 1, name: 'a', quantity: 1, unitPaise: 10500, taxRate: 5, priceIncludesTax: true }], null);
  assert.equal(b.total, 105); assert.equal(b.tax, 5); assert.equal(b.taxIncluded, 5); assert.equal(b.taxAdded, 0);
  assert.equal(b.items[0].taxableValue, 100);
  const b12 = computeBill([{ productId: 1, name: 'a', quantity: 1, unitPaise: 11200, taxRate: 12, priceIncludesTax: true }], null);
  assert.equal(b12.total, 112); assert.equal(b12.tax, 12); assert.equal(b12.items[0].taxableValue, 100);
});

test('billing: discount on a tax-inclusive line reduces the tax as well', () => {
  const b = computeBill([{ productId: 1, name: 'a', quantity: 1, unitPaise: 10500, taxRate: 5, priceIncludesTax: true }], { type: 'percent', value: 10 });
  assert.equal(b.discount, 10.5); assert.equal(b.total, 94.5); assert.equal(b.tax, 4.5); assert.equal(b.items[0].taxableValue, 90);
});

test('billing: fractional quantity (loose goods)', () => {
  const b = computeBill([{ productId: 1, name: 'rice', quantity: 0.75, unitPaise: 6000, taxRate: 5 }], null);
  assert.equal(b.subtotal, 45); assert.equal(b.tax, 2.25); assert.equal(b.total, 47.25); assert.equal(b.itemCount, 0.75);
});

test('billing: mixed inclusive/exclusive bills always add up to the paisa (property test)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 300; n += 1) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => ({
      productId: i, name: `p${i}`, quantity: Math.round((0.001 + rnd() * 9) * 1000) / 1000, unitPaise: 100 + Math.floor(rnd() * 99900),
      taxRate: [0, 5, 12, 18, 28][Math.floor(rnd() * 5)], priceIncludesTax: rnd() > 0.5,
    }));
    const disc = rnd() > 0.5 ? { type: rnd() > 0.5 ? 'percent' : 'amount', value: Math.round(rnd() * 3000) / 100 } : null;
    const b = computeBill(lines, disc);
    assert.equal(paise(b.total), sumTaxable(b), 'total = Σ(taxable + tax)');
    assert.equal(b.items.reduce((a, i) => a + paise(i.discountShare), 0), paise(b.discount), 'discount shares add up to the discount');
    assert.equal(paise(b.taxIncluded) + paise(b.taxAdded), paise(b.tax));
    assert.ok(b.total >= 0 && b.items.every((i) => i.taxableValue >= 0));
  }
});

// ---------------------------------------------------------------- decimal quantities and units
test('decimal product: sell 0.75 kg, stock goes down by 0.75, refund puts it back', async () => {
  const o = api(A.owner.token);
  const rice = await addProduct(api, A, { name: 'Loose rice', unit: 'kg', purchasePrice: 40, sellingPrice: 60, stock: 10.5, minimumStock: 2.5 });
  assert.equal(rice.unit, 'kg'); assert.equal(rice.stock, 10.5); assert.equal(rice.minimumStock, 2.5);
  const rate = A.category.taxRate;
  const tax = Math.round((4500 * Math.round(rate * 100)) / 10000);
  const sale = await o.post('/sales', { items: [{ productId: rice.id, quantity: 0.75 }], paymentMethod: 'cash' });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(sale.body.total, (4500 + tax) / 100);
  assert.equal(sale.body.items[0].quantity, 0.75); assert.equal(sale.body.items[0].unit, 'kg');
  assert.equal((await o.get(`/products/${rice.id}`)).body.stock, 9.75);
  const moves = await o.get(`/inventory/${rice.id}/movements`);
  assert.ok(moves.body.rows.some((m) => m.quantity === -0.75));
  const pos = await o.get('/products/pos-search?q=Loose');
  assert.equal(pos.body.rows[0].allowDecimal, true); assert.equal(pos.body.rows[0].unit, 'kg');
  const ref = await o.post(`/sales/${sale.body.id}/refund`);
  assert.equal(ref.status, 200);
  assert.equal((await o.get(`/products/${rice.id}`)).body.stock, 10.5);
});

test('decimal quantities are rejected for counted units, over-selling and >3 decimals', async () => {
  const o = api(A.owner.token);
  const pcs = await addProduct(api, A, { name: 'Biscuit', stock: 10 });
  const kg = await addProduct(api, A, { name: 'Sugar', unit: 'kg', stock: 2 });
  const bad = await o.post('/sales', { items: [{ productId: pcs.id, quantity: 1.5 }], paymentMethod: 'cash' });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message || bad.body.error, /whole number/);
  assert.equal((await o.post('/sales/preview', { items: [{ productId: pcs.id, quantity: 0.5 }] })).status, 400);
  assert.equal((await o.post('/sales', { items: [{ productId: kg.id, quantity: 2.5 }], paymentMethod: 'cash' })).status, 409);
  assert.equal((await o.post('/sales', { items: [{ productId: kg.id, quantity: 0.0001 }], paymentMethod: 'cash' })).status, 400);
  assert.equal((await o.post('/sales', { items: [{ productId: kg.id, quantity: 0 }], paymentMethod: 'cash' })).status, 400);
  assert.equal((await o.get(`/products/${kg.id}`)).body.stock, 2, 'nothing was sold');
  // two cart lines of the same product merge without float drift
  const two = await o.post('/sales', { items: [{ productId: kg.id, quantity: 0.1 }, { productId: kg.id, quantity: 0.2 }], paymentMethod: 'cash' });
  assert.equal(two.status, 201); assert.equal(two.body.items[0].quantity, 0.3);
  assert.equal((await o.get(`/products/${kg.id}`)).body.stock, 1.7);
});

test('products: fractional stock needs a measured unit; unit changes are validated', async () => {
  const o = api(A.owner.token);
  const r = await o.post('/products', { name: 'Bad', categoryId: A.category.id, purchasePrice: 1, sellingPrice: 2, stock: 1.5, unit: 'pcs' });
  assert.equal(r.status, 400);
  assert.equal((await o.post('/products', { name: 'Bad2', categoryId: A.category.id, purchasePrice: 1, sellingPrice: 2, unit: 'cubit' })).status, 400);
  const oil = await addProduct(api, A, { name: 'Oil', unit: 'l', stock: 4.25 });
  const toPcs = await o.put(`/products/${oil.id}`, { unit: 'pcs' });
  assert.equal(toPcs.status, 400);
  assert.equal((await o.put(`/products/${oil.id}`, { unit: 'ml', stock: 4250 })).status, 200);
});

test('database refuses fractional quantities for counted units even for raw SQL', async () => {
  const p = await addProduct(api, A, { name: 'Pen', stock: 5 });
  await env.db.runAsTenant(A.businessId, async () => {
    await assert.rejects(env.db.query('UPDATE products SET stock = 1.5 WHERE id = $1', [p.id]), /products_whole_units_chk/);
    await assert.rejects(env.db.query(`UPDATE products SET minimum_stock = 0.5 WHERE id = $1`, [p.id]), /products_whole_units_chk/);
    assert.equal((await env.db.query(`UPDATE products SET unit = 'kg', stock = 1.5 WHERE id = $1`, [p.id])).rowCount, 1);
  });
});

test('analytics keep fractional units (no integer truncation)', async () => {
  const o = api(B.owner.token);
  const dal = await addProduct(api, B, { name: 'Dal', unit: 'kg', purchasePrice: 80, sellingPrice: 100, stock: 20 });
  assert.equal((await o.post('/sales', { items: [{ productId: dal.id, quantity: 0.5 }], paymentMethod: 'upi' })).status, 201);
  const s = await o.get('/analytics/sales?range=today');
  assert.equal(s.body.topProducts.find((x) => x.id === dal.id).units, 0.5);
  const ov = await o.get('/analytics/overview');
  assert.equal(ov.body.topToday.find((x) => x.name === 'Dal').units, 0.5);
});

// ---------------------------------------------------------------- tax-inclusive selling
test('tax-inclusive product: MRP is the price, tax is stored per line, profit excludes tax', async () => {
  const s = await makeShop(api);
  const o = api(s.owner.token);
  const cat = await o.post('/categories', { name: 'MRP goods', taxRate: 5 });
  assert.equal(cat.status, 201);
  const p = await addProduct(api, s, { name: 'Soap', categoryId: cat.body.id, purchasePrice: 60, sellingPrice: 105, priceIncludesTax: true, stock: 50 });
  assert.equal(p.priceIncludesTax, true);
  const prev = await o.post('/sales/preview', { items: [{ productId: p.id, quantity: 2 }], discount: { type: 'percent', value: 10 } });
  assert.deepEqual([prev.body.subtotal, prev.body.discount, prev.body.tax, prev.body.taxIncluded, prev.body.taxAdded, prev.body.total], [210, 21, 9, 9, 0, 189]);
  const sale = await o.post('/sales', { items: [{ productId: p.id, quantity: 2 }], discount: { type: 'percent', value: 10 }, paymentMethod: 'cash' });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(sale.body.total, 189); assert.equal(sale.body.tax, 9); assert.equal(sale.body.taxIncluded, 9);
  assert.equal(sale.body.items[0].priceIncludesTax, true); assert.equal(sale.body.items[0].taxableValue, 180);
  const row = await env.db.runAsTenant(s.businessId, async () => (await env.db.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale.body.id])).rows[0]);
  assert.deepEqual([row.unit_cost, row.cost_source, row.tax_rate, row.price_includes_tax, row.discount_share, row.taxable_value, row.tax_amount, row.snapshot_backfilled], [60, 'snapshot', 5, true, 21, 180, 9, false]);
  // profit = taxable value 180 − cost 2 × 60 = 60  (tax is never profit)
  assert.equal((await o.get('/analytics/sales?range=today')).body.totals.profit, 60);
});

// ---------------------------------------------------------------- historical snapshots
test('editing price, cost and tax later never changes past sales or past profit', async () => {
  const s = await makeShop(api);
  const o = api(s.owner.token);
  const p = await addProduct(api, s, { name: 'Tea', purchasePrice: 40, sellingPrice: 50, stock: 30 });
  const sale1 = await o.post('/sales', { items: [{ productId: p.id, quantity: 2 }], paymentMethod: 'cash' });
  assert.equal(sale1.status, 201);
  const profitBefore = (await o.get('/analytics/sales?range=today')).body.totals.profit;
  assert.equal(profitBefore, 20, '100 taxable − 2 × 40 cost');
  const lineBefore = await env.db.runAsTenant(s.businessId, async () => (await env.db.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale1.body.id])).rows[0]);

  assert.equal((await o.put(`/products/${p.id}`, { purchasePrice: 45, sellingPrice: 80 })).status, 200);
  assert.equal((await o.put(`/categories/${s.category.id}`, { taxRate: 18 })).status, 200);
  const lineAfter = await env.db.runAsTenant(s.businessId, async () => (await env.db.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale1.body.id])).rows[0]);
  assert.deepEqual(lineAfter, lineBefore, 'the stored sale line is untouched');
  assert.equal((await o.get('/analytics/sales?range=today')).body.totals.profit, profitBefore, 'historical profit is stable');
  assert.equal((await o.get(`/sales/${sale1.body.id}`)).body.items[0].unitPrice, 50);

  const sale2 = await o.post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' });
  assert.equal(sale2.body.subtotal, 80); assert.equal(sale2.body.tax, 14.4);
  assert.equal((await o.get('/analytics/sales?range=today')).body.totals.profit, 55, '20 (old) + (80 − 45) (new)');
  const prod = await o.get('/analytics/products?range=30d');
  assert.equal(prod.body.topRevenue.find((x) => x.id === p.id).margin, 55);
});

test('sale discount is stored per line and profit accounts for it', async () => {
  const s = await makeShop(api);
  const o = api(s.owner.token);
  const a = await addProduct(api, s, { name: 'A', purchasePrice: 10, sellingPrice: 20, stock: 10 });
  const b = await addProduct(api, s, { name: 'B', purchasePrice: 10, sellingPrice: 30, stock: 10 });
  const sale = await o.post('/sales', { items: [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }], discount: { type: 'amount', value: 10 }, paymentMethod: 'cash' });
  assert.equal(sale.status, 201);
  const shares = sale.body.items.map((i) => i.discountShare);
  assert.equal(shares.reduce((x, y) => x + y, 0), 10);
  assert.equal((await o.get('/analytics/sales?range=today')).body.totals.profit, 20, '(20 + 30) − 10 discount − 20 cost');
});

test('cost history: initial value, manual changes, no row when unchanged; managers only', async () => {
  const s = await makeShop(api);
  const o = api(s.owner.token);
  const p = await addProduct(api, s, { name: 'Salt', purchasePrice: 18, sellingPrice: 25 });
  assert.equal((await o.put(`/products/${p.id}`, { purchasePrice: 20 })).status, 200);
  assert.equal((await o.put(`/products/${p.id}`, { purchasePrice: 20, name: 'Salt 1kg' })).status, 200);
  const h = await o.get(`/products/${p.id}/cost-history`);
  assert.deepEqual(h.body.rows.map((r) => [r.cost, r.source]), [[20, 'manual'], [18, 'initial']]);
  assert.equal((await api(s.manager.token).get(`/products/${p.id}/cost-history`)).status, 200);
  assert.equal((await api(s.cashier.token).get(`/products/${p.id}/cost-history`)).status, 403);
  assert.equal((await api(B.owner.token).get(`/products/${p.id}/cost-history`)).status, 404, 'other business');
  await env.db.runAsTenant(s.businessId, async () => {
    await assert.rejects(env.db.query('UPDATE product_cost_history SET cost = 1'), /permission denied/);
    assert.equal((await env.db.query('DELETE FROM product_cost_history')).rowCount, 0, 'history of a real business cannot be deleted');
  });
});
