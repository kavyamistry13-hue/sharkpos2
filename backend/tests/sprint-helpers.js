// Shared setup for the Sprint 1–2 test files: a registered shop with an owner, a manager and a cashier.
const assert = require('node:assert/strict');
const { uniq } = require('./helpers');

async function makeShop(api) {
  const reg = await api().post('/auth/register', { businessName: uniq('S12 Mart '), ownerName: 'Owner One', email: `${uniq('owner')}@example.com`, phone: '9876543210', password: 'Passw0rdOK' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const shop = { owner: { token: reg.body.accessToken, id: reg.body.user.id }, businessId: reg.body.business.id };
  const o = api(shop.owner.token);
  for (const role of ['manager', 'cashier']) {
    const email = `${uniq(role)}@example.com`;
    const c = await o.post('/employees', { name: `${role} person`, email, password: 'Passw0rdOK', role });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const login = await api().post('/auth/login', { email, password: 'Passw0rdOK' });
    shop[role] = { token: login.body.accessToken, id: c.body.id };
  }
  const lk = await o.get('/products/lookups');
  shop.category = lk.body.categories[0];
  return shop;
}

/** Creates a product as the owner and returns the API body. */
async function addProduct(api, shop, over = {}) {
  const r = await api(shop.owner.token).post('/products', { name: uniq('Item '), categoryId: shop.category.id, purchasePrice: 40, sellingPrice: 50, stock: 20, minimumStock: 2, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // store time is Asia/Kolkata (UTC+5:30)

module.exports = { makeShop, addProduct, todayIso };
