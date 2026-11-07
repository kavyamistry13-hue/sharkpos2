// Locks the validation behaviour that must survive the Zod 3 → Zod 4 upgrade: partial updates must not apply create-time defaults,
// and the API's error wording must stay the same, because the web app shows these messages to people.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let S;
test.before(async () => { env = await boot(); api = client(env.base); S = await makeShop(api); });
test.after(async () => { await env.close(); });
const o = () => api(S.owner.token);
const msg = (r) => r.body.error;

test('PUT /products/:id with a partial body never resets fields that have create-time defaults', async () => {
  const p = await addProduct(api, S, { name: uniq('Rice '), stock: 25, minimumStock: 4, unit: 'kg', priceIncludesTax: true, leadTimeDays: 9 });
  const r = await o().put(`/products/${p.id}`, { name: 'Renamed rice' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await o().get(`/products/${p.id}`)).body;
  assert.equal(after.name, 'Renamed rice');
  assert.deepEqual([after.stock, after.minimumStock, after.unit, after.priceIncludesTax, after.leadTimeDays], [25, 4, 'kg', true, 9]);
  const r2 = await o().put(`/products/${p.id}`, { sellingPrice: 77 });
  assert.equal(r2.status, 200);
  const a2 = (await o().get(`/products/${p.id}`)).body;
  assert.deepEqual([a2.sellingPrice, a2.stock, a2.unit, a2.priceIncludesTax], [77, 25, 'kg', true]);
});

test('create still applies the documented defaults', async () => {
  const lk = (await o().get('/products/lookups')).body;
  const r = await o().post('/products', { name: uniq('Plain '), categoryId: lk.categories[0].id, purchasePrice: 5, sellingPrice: 8 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.stock, r.body.minimumStock, r.body.unit, r.body.priceIncludesTax, r.body.leadTimeDays], [0, 0, 'pcs', false, 3]);
});

test('validation error wording is unchanged (field — message)', async () => {
  const lk = (await o().get('/products/lookups')).body;
  const ok = { name: 'X', categoryId: lk.categories[0].id, purchasePrice: 1, sellingPrice: 2 };
  assert.equal(msg(await o().post('/products', { ...ok, name: '' })), 'Invalid input: name — String must contain at least 1 character(s)');
  assert.equal(msg(await o().post('/products', { ...ok, name: 'x'.repeat(161) })), 'Invalid input: name — String must contain at most 160 character(s)');
  assert.equal(msg(await o().post('/products', { ...ok, categoryId: undefined })), 'Invalid input: categoryId — Expected number, received nan');
  assert.equal(msg(await o().post('/products', { ...ok, sellingPrice: -1 })), 'Invalid input: sellingPrice — Number must be greater than or equal to 0');
  assert.equal(msg(await o().post('/products', { ...ok, unit: 'bag' })), "Invalid input: unit — Invalid enum value. Expected 'pcs' | 'kg' | 'g' | 'l' | 'ml' | 'm' | 'pack' | 'box' | 'dozen', received 'bag'");
  assert.equal(msg(await o().post('/products', { ...ok, priceIncludesTax: 'yes' })), 'Invalid input: priceIncludesTax — Expected boolean, received string');
  assert.equal(msg(await o().post('/products', { ...ok, expiryDate: '2026/01/01' })), 'Invalid input: expiryDate — Invalid');
  assert.equal(msg(await o().post('/products', { ...ok, sellingPrice: 'abc' })), 'Invalid input: sellingPrice — Expected number, received nan');
  const e = await api().post('/auth/login', { email: 'not-an-email', password: 'x' });
  assert.equal(e.status, 400); assert.equal(msg(e), 'Invalid input: email — Invalid email');
  const d = await o().post('/demo/load', { confirm: false });
  assert.equal(d.status, 400); assert.equal(msg(d), 'Invalid input: confirm — Confirmation required');
  assert.equal(msg(await o().post('/auth/login', { password: 'x' })), 'Invalid input: email — Required');
  const det = (await o().post('/products', { ...ok, name: '' })).body.details;
  assert.deepEqual(det, [{ field: 'name', message: 'String must contain at least 1 character(s)' }], 'details array shape is unchanged');
});

test('query-string coercion and defaults still work', async () => {
  const r = await o().get('/products?page=2&limit=5');
  assert.equal(r.status, 200);
  assert.equal((await o().get('/products?limit=500')).status, 400);
  assert.equal((await o().get('/products?page=abc')).status, 400);
});
