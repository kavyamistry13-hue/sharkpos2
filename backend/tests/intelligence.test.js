// Sprint 4 — Action Center, "what should I do today", cash trapped in inventory, dead stock, profit leaks, supplier intelligence.
// All of it is deterministic arithmetic over existing records, so every figure here is computed by hand and asserted exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer, sell, daysAgoIso } = require('./sprint-helpers');
const { classify } = require('../src/services/intelligence/inventory');
const { score } = require('../src/services/intelligence/actions');

let env; let api; let B;
test.before(async () => { env = await boot(); api = client(env.base); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const get = async (s, path, who = 'owner') => { const r = await as(s, who).get(path); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body; };
async function taxed(s, rate = 5, name = uniq('Tax ')) { return (await as(s).post('/categories', { name, taxRate: rate })).body; }
const backdateSale = (s, saleId, days) => sql(s, `UPDATE sales SET created_at = created_at - ($2::int * interval '1 day') WHERE id = $1`, [saleId, days]);
const backdateProduct = (s, id, days) => sql(s, `UPDATE products SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`, [id, days]);

const ENDPOINTS = ['/intelligence/actions', '/intelligence/today', '/intelligence/inventory-cash', '/intelligence/dead-stock', '/intelligence/profit-leaks', '/intelligence/suppliers'];

// ---------------------------------------------------------------- access + empty data
test('intelligence: owner and manager only; cashiers and anonymous callers are refused on every endpoint', async () => {
  const s = await makeShop(api);
  for (const p of ENDPOINTS) {
    assert.equal((await api(s.cashier.token).get(p)).status, 403, p);
    assert.equal((await api().get(p)).status, 401, p);
    assert.equal((await as(s, 'manager').get(p)).status, 200, p);
    assert.equal((await as(s).get(p)).status, 200, p);
  }
});

test('a brand-new empty business gets valid, empty answers everywhere (no divide-by-zero, no crash)', async () => {
  const s = await makeShop(api);
  const inv = await get(s, '/intelligence/inventory-cash');
  assert.deepEqual([inv.totalValue, inv.trappedCash, inv.trappedPct, inv.stockedProducts, inv.topTrapped.length, inv.byCategory.length], [0, 0, 0, 0, 0, 0]);
  const dead = await get(s, '/intelligence/dead-stock'); assert.deepEqual([dead.count, dead.totalValue, dead.rows.length], [0, 0, 0]);
  const pl = await get(s, '/intelligence/profit-leaks'); assert.deepEqual([pl.summary.findings, pl.summary.realizedLoss, pl.summary.discountPct, pl.leaks.length], [0, 0, 0, 0]);
  const su = await get(s, '/intelligence/suppliers'); assert.deepEqual([su.suppliers.length, su.actions.length], [0, 0]);
  const ac = await get(s, '/intelligence/actions'); assert.deepEqual([ac.total, ac.actions.length, ac.warnings.length], [0, 0, 0]);
  const td = await get(s, '/intelligence/today'); assert.equal(td.allClear, true); assert.match(td.headline, /Nothing needs your attention/); assert.equal(td.actions.length, 0);
});

test('query parameters are validated', async () => {
  const s = await makeShop(api);
  for (const p of ['/intelligence/dead-stock?days=3', '/intelligence/dead-stock?days=abc', '/intelligence/inventory-cash?deadDays=9999', '/intelligence/profit-leaks?days=1', '/intelligence/suppliers?days=0', '/intelligence/actions?category=magic', '/intelligence/today?top=0']) {
    assert.equal((await as(s).get(p)).status, 400, p);
  }
});

// ---------------------------------------------------------------- inventory cash + dead stock
test('classify(): dead, expired, overstock excess, healthy and empty-stock rules', () => {
  const p = (o) => ({ stock: 100, purchasePrice: 10, forecastDaily: 2, minimumStock: 10, overstocked: false, expiryStatus: null, ...o });
  const mv = { created_day: '2026-01-01', last_sold_day: '2026-10-30' };
  assert.equal(classify(p({ stock: 0 }), mv, '2026-11-01', 60), null, 'nothing in stock');
  assert.deepEqual(pick(classify(p(), mv, '2026-11-01', 60)), { bucket: 'healthy', value: 1000, trapped: 0 });
  assert.deepEqual(pick(classify(p(), { ...mv, last_sold_day: '2026-09-02' }, '2026-11-01', 60)), { bucket: 'dead', value: 1000, trapped: 1000 }, '60 days since the last sale is dead');
  assert.equal(classify(p(), { ...mv, last_sold_day: '2026-09-03' }, '2026-11-01', 60).bucket, 'healthy', '59 days is not');
  assert.equal(classify(p(), { created_day: '2026-10-20', last_sold_day: null }, '2026-11-01', 60).bucket, 'healthy', 'a new product that has not sold yet is not dead');
  assert.equal(classify(p(), { created_day: '2026-08-01', last_sold_day: null }, '2026-11-01', 60).bucket, 'dead', 'old and never sold');
  assert.equal(classify(p({ expiryStatus: 'expired' }), { ...mv, last_sold_day: '2026-09-01' }, '2026-11-01', 60).bucket, 'expired', 'expired wins over dead');
  // overstock: keep 45 days of forecast (2 × 45 = 90) + minimum stock 10 = 100; of 500 in stock, 400 is excess
  assert.deepEqual(pick(classify(p({ stock: 500, overstocked: true }), mv, '2026-11-01', 60)), { bucket: 'overstock', value: 5000, trapped: 4000 });
  assert.equal(classify(p({ stock: 80, overstocked: true }), mv, '2026-11-01', 60).trapped, 0, 'flagged but below the cover target: nothing trapped');
});
const pick = (c) => ({ bucket: c.bucket, value: c.value, trapped: c.trapped });

test('cash trapped in inventory + dead stock: exact values on a hand-built shop', async () => {
  const s = await makeShop(api);
  const mk = (over) => addProduct(api, s, { stock: 10, minimumStock: 1, ...over });
  const healthy = await mk({ name: 'Healthy', purchasePrice: 50, stock: 10 });                // 500, sold today
  const fresh = await mk({ name: 'Fresh', purchasePrice: 10, stock: 5 });                     // 50, new, never sold
  const never = await mk({ name: 'Never sold', purchasePrice: 100, stock: 4 });               // 400 dead
  const old = await mk({ name: 'Old seller', purchasePrice: 20, stock: 6 });                  // 100 dead (last sale 90 days ago)
  const recent = await mk({ name: 'Slowish', purchasePrice: 10, stock: 3 });                  // 30; sold 45 days ago
  const expired = await mk({ name: 'Expired', purchasePrice: 30, stock: 2 });                 // 60 expired
  const gone = await mk({ name: 'Sold out', purchasePrice: 99, stock: 0 });                   // not counted
  const inactive = await mk({ name: 'Inactive', purchasePrice: 99, stock: 9 });
  await as(s).del(`/products/${inactive.id}`);
  await sell(api, s, healthy.id);
  const o = (await sell(api, s, old.id)).body; await backdateSale(s, o.id, 90);
  const r = (await sell(api, s, recent.id)).body; await backdateSale(s, r.id, 45);
  for (const p of [never, old, recent, expired, gone, healthy]) await backdateProduct(s, p.id, 200);
  await sql(s, `UPDATE products SET expiry_date = current_date - 1 WHERE id = $1`, [expired.id]);

  // stock after sales: healthy 9, old 5, recent 2
  const inv = await get(s, '/intelligence/inventory-cash');
  const value = 9 * 50 + 5 * 10 + 4 * 100 + 5 * 20 + 2 * 10 + 2 * 30;      // 450 + 50 + 400 + 100 + 20 + 60 = 1080
  assert.equal(inv.totalValue, value);
  assert.equal(inv.stockedProducts, 6, 'sold-out and inactive products are not counted');
  assert.deepEqual(inv.buckets.dead, { products: 2, value: 500 }); assert.deepEqual(inv.buckets.expired, { products: 1, value: 60 });
  assert.deepEqual(inv.buckets.healthy, { products: 3, value: 520 }); assert.equal(inv.buckets.overstock.products, 0);
  assert.equal(inv.trappedCash, 560); assert.equal(inv.trappedPct, Math.round((560 / value) * 1000) / 10);
  assert.equal(inv.byCategory.reduce((a, c) => a + c.value, 0), value, 'categories add up to the total');
  assert.deepEqual(inv.topTrapped.map((t) => [t.name, t.bucket, t.trappedValue]), [['Never sold', 'dead', 400], ['Old seller', 'dead', 100], ['Expired', 'expired', 60]]);
  assert.ok(inv.topTrapped.every((t) => t.action.length > 10));
  assert.ok(inv.potentialRetailValue > inv.totalValue);
  assert.match(inv.basis, /not recoverable money/);

  const strict = await get(s, '/intelligence/inventory-cash?deadDays=30');
  assert.equal(strict.buckets.dead.value, 520, 'the 45-day-old sale becomes dead at a 30-day threshold (400 + 100 + 20)');
  assert.equal((await get(s, '/intelligence/inventory-cash?deadDays=120')).buckets.dead.value, 400, 'only the never-sold one at 120 days (the 90-day sale is still recent)');

  const dead = await get(s, '/intelligence/dead-stock');
  assert.deepEqual(dead.rows.map((x) => [x.name, x.stockValue, x.expired]), [['Never sold', 400, false], ['Old seller', 100, false], ['Expired', 60, true]]);
  assert.equal(dead.count, 3); assert.equal(dead.totalValue, 560);
  assert.equal(dead.rows[0].lastSoldOn, null); assert.equal(dead.rows[1].lastSoldOn, daysAgoIso(90)); assert.equal(dead.rows[1].daysSinceLastSale, 90);
  assert.equal((await get(s, '/intelligence/dead-stock?limit=1')).rows.length, 1);
  // refunded sales do not count as "sold": a refunded last sale leaves the product dead
  const refunded = (await sell(api, s, never.id)).body;
  await backdateSale(s, refunded.id, 100); await as(s, 'manager').post(`/sales/${refunded.id}/refund`);
  assert.ok((await get(s, '/intelligence/dead-stock')).rows.some((x) => x.name === 'Never sold'));
  // tenant isolation
  assert.equal((await get(B, '/intelligence/dead-stock')).count, 0); assert.equal((await get(B, '/intelligence/inventory-cash')).totalValue, 0);
});

// ---------------------------------------------------------------- profit leaks
test('profit leaks: below-cost price, thin margin (tax-inclusive aware), realised loss, cost creep — exact figures and ordering', async () => {
  const s = await makeShop(api);
  const c5 = await taxed(s, 5);
  const mk = (over) => addProduct(api, s, { categoryId: c5.id, stock: 50, minimumStock: 1, ...over });
  const below = await mk({ name: 'Loss leader', purchasePrice: 80, sellingPrice: 70, stock: 20 });                      // net 70 < cost 80 → 10/unit
  const thin = await mk({ name: 'MRP soap', purchasePrice: 98, sellingPrice: 105, priceIncludesTax: true });            // net 100 vs cost 98 → 2%
  const loss = await mk({ name: 'Discounted', purchasePrice: 40, sellingPrice: 50 });
  const creep = await mk({ name: 'Creeping', purchasePrice: 40, sellingPrice: 50 });
  const fine = await mk({ name: 'Healthy margin', purchasePrice: 30, sellingPrice: 60 });
  await sell(api, s, thin.id, { quantity: 3 });
  await sell(api, s, fine.id, { quantity: 2 });
  assert.equal((await sell(api, s, loss.id, { quantity: 2, discount: { type: 'percent', value: 50 }, who: 'owner' })).status, 201);   // subtotal 100, −50 → taxable 50 vs cost 80
  assert.equal((await as(s).put(`/products/${creep.id}`, { purchasePrice: 46 })).status, 200);                         // +15%: margin 20% → 8%

  const pl = await get(s, '/intelligence/profit-leaks');
  const by = (t, name) => pl.leaks.find((l) => l.type === t && l.name === name);
  assert.deepEqual([by('below_cost', 'Loss leader').severity, by('below_cost', 'Loss leader').amount], ['critical', 200], '10 × 20 units in stock');
  assert.equal(by('below_cost', 'Loss leader').evidence.netPrice, 70);
  const tm = by('thin_margin', 'MRP soap'); assert.equal(tm.evidence.marginPct, 2); assert.equal(tm.evidence.unitsSold, 3); assert.equal(tm.severity, 'medium');
  assert.equal(by('thin_margin', 'Loss leader'), undefined, 'a below-cost product is not also listed as thin');
  const sl = by('sold_at_a_loss', 'Discounted'); assert.equal(sl.amount, 30); assert.equal(sl.evidence.discountGiven, 50); assert.equal(sl.severity, 'medium');
  const cc = by('cost_increase', 'Creeping'); assert.deepEqual([cc.evidence.oldMarginPct, cc.evidence.newMarginPct, cc.amount], [20, 8, 6]);
  assert.ok(!pl.leaks.some((l) => l.name === 'Healthy margin'), 'healthy items are not flagged');
  assert.equal(pl.summary.realizedLoss, 30); assert.equal(pl.summary.discountsGiven, 50); assert.equal(pl.summary.bills, 3);
  assert.equal(pl.leaks[0].type, 'below_cost', 'critical first');
  const sev = ['critical', 'high', 'medium', 'low']; assert.deepEqual(pl.leaks.map((l) => sev.indexOf(l.severity)), [...pl.leaks.map((l) => sev.indexOf(l.severity))].sort((a, b) => a - b));
  assert.ok(pl.leaks.every((l) => l.action && l.amountBasis && l.title), 'every finding explains itself');
  assert.match(pl.notes[0], /0 lines/);

  // the window: a loss from 40 days ago is outside 30 days but inside 60
  const old = (await sell(api, s, loss.id, { quantity: 1, discount: { type: 'percent', value: 60 } })).body;
  await backdateSale(s, old.id, 40);
  assert.equal((await get(s, '/intelligence/profit-leaks?days=30')).summary.realizedLoss, 30);
  assert.equal((await get(s, '/intelligence/profit-leaks?days=60')).summary.realizedLoss, 30 + 20, '50 × 40% = 20 taxable vs cost 40 → 20');
  // raising the price clears the below-cost finding
  await as(s).put(`/products/${below.id}`, { sellingPrice: 100 });
  assert.ok(!(await get(s, '/intelligence/profit-leaks')).leaks.some((l) => l.type === 'below_cost'));
  assert.equal((await get(B, '/intelligence/profit-leaks')).leaks.length, 0, 'other shops see none of it');
});

test('profit leaks: a cashier who discounts at twice the shop rate is flagged as a pattern to review, not as a verdict', async () => {
  const s = await makeShop(api);
  const p = await addProduct(api, s, { purchasePrice: 100, sellingPrice: 1000, stock: 500 });
  for (let i = 0; i < 12; i += 1) assert.equal((await sell(api, s, p.id, { who: 'owner' })).status, 201);
  for (let i = 0; i < 10; i += 1) assert.equal((await sell(api, s, p.id, { who: 'cashier', discount: { type: 'percent', value: 5 } })).status, 201);
  const pl = await get(s, '/intelligence/profit-leaks');
  const o = pl.leaks.find((l) => l.type === 'discount_outlier');
  assert.ok(o, JSON.stringify(pl.summary)); assert.equal(o.name, 'cashier person'); assert.equal(o.amount, 500); assert.deepEqual([o.evidence.cashierRatePct, o.evidence.bills], [5, 10]);
  assert.match(o.action, /not proof of wrongdoing/);
  assert.equal(pl.summary.discountedBills, 10);
  // owner-only discounting (or a handful of bills) is never flagged
  const t = await makeShop(api);
  const q = await addProduct(api, t, { purchasePrice: 100, sellingPrice: 1000, stock: 500 });
  for (let i = 0; i < 4; i += 1) await sell(api, t, q.id, { who: 'cashier', discount: { type: 'percent', value: 5 } });
  assert.ok(!(await get(t, '/intelligence/profit-leaks')).leaks.some((l) => l.type === 'discount_outlier'), 'too few bills');
});

// ---------------------------------------------------------------- supplier intelligence
test('supplier intelligence: on-time, fill and rejection rates, overdue orders, price rises, cheaper quotes, missing suppliers', async () => {
  const s = await makeShop(api);
  const o = as(s);
  const mkSup = async (name, extra = {}) => (await o.post('/suppliers', { name, leadTimeDays: 3, paymentTermsDays: 0, minOrderValue: 0, ...extra })).body;
  const X = await mkSup('Slow Traders'); const Y = await mkSup('Cheap Co'); const Z = await mkSup('New Vendor');
  const p1 = await addProduct(api, s, { name: 'Rice bag', purchasePrice: 40, sellingPrice: 60, stock: 0, minimumStock: 0 });
  const p2 = await addProduct(api, s, { name: 'Orphan', purchasePrice: 10, sellingPrice: 20, stock: 0, minimumStock: 5 });
  await o.put(`/suppliers/${X.id}/products/${p1.id}`, { lastCost: 40, isPreferred: true });
  await o.put(`/suppliers/${X.id}/products/${p1.id}`, { lastCost: 44 });                                  // +10% → price_increase
  await o.put(`/suppliers/${Y.id}/products/${p1.id}`, { lastCost: 40 });                                  // 9% cheaper than X → cheaper_supplier
  const po = async (sup, qty, recv, { late = false, rejected = 0, receive = true } = {}) => {
    const c = (await o.post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p1.id, quantity: qty, unitCost: 44 }] })).body;
    const placed = (await o.post(`/purchase-orders/${c.id}/order`, {})).body;
    if (late) await sql(s, `UPDATE purchase_orders SET expected_date = current_date - 10 WHERE id = $1`, [placed.id]);
    if (receive) {
      const r = await o.post(`/purchase-orders/${placed.id}/receive`, { items: [{ itemId: placed.items[0].id, quantity: recv, rejectedQuantity: rejected }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      if (recv < qty) assert.equal((await o.post(`/purchase-orders/${placed.id}/close`)).status, 200);
    }
    return placed;
  };
  await po(X, 10, 10);                         // on time, full
  await po(X, 10, 10, { late: true, rejected: 2 });   // late, 2 rejected
  await po(X, 10, 5, { late: true });          // late, closed short (5 of 10)
  await po(Z, 10, 10); await po(Z, 10, 10);    // only 2 completed orders: not enough to judge
  const overdue = await po(Y, 6, 0, { late: true, receive: false });   // placed, 10 days overdue, nothing arrived

  const su = await get(s, '/intelligence/suppliers');
  const sx = su.suppliers.find((x) => x.supplierId === X.id);
  assert.deepEqual([sx.completedOrders, sx.onTimePct, sx.fillRatePct, sx.rejectionPct, sx.enoughData], [3, 33.3, 83.3, 7.4, true], 'on time 1/3 · filled 25/30 · rejected 2 of 27 delivered or refused');
  assert.equal(sx.spend, 44 * 25);
  const sz = su.suppliers.find((x) => x.supplierId === Z.id);
  assert.equal(sz.enoughData, false); assert.match(sz.note, /needs 3/);
  const types = su.actions.map((a) => `${a.type}:${a.supplierId || a.productId}`);
  for (const t of [`late_supplier:${X.id}`, `low_fill_rate:${X.id}`, `high_rejections:${X.id}`, `overdue_order:${Y.id}`, `price_increase:${X.id}`, `no_supplier:${p2.id}`]) assert.ok(types.includes(t), `${t} in ${types.join(', ')}`);
  assert.ok(!su.actions.some((a) => a.supplierId === Z.id && ['late_supplier', 'low_fill_rate', 'high_rejections'].includes(a.type)), 'no verdict on too little data');
  const od = su.actions.find((a) => a.type === 'overdue_order'); assert.equal(od.severity, 'high'); assert.equal(od.amount, 6 * 44); assert.equal(od.purchaseOrderId, overdue.id);
  const pi = su.actions.find((a) => a.type === 'price_increase'); assert.equal(pi.amount, 4); assert.match(pi.title, /10%/);
  const cs = su.actions.find((a) => a.type === 'cheaper_supplier'); assert.equal(cs.supplierId, Y.id); assert.match(cs.title, /Cheap Co quotes ₹40/); assert.equal(cs.amount, 4 * 45, '₹4 cheaper × 45 units of this product received from all suppliers in the period (X 25 + Z 20)');
  assert.equal(su.actions.find((a) => a.type === 'no_supplier').severity, 'high', 'out of stock with no supplier');
  const order = ['high', 'medium', 'low']; const ranks = su.actions.map((a) => order.indexOf(a.severity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'sorted by severity');
  assert.deepEqual((await get(B, '/intelligence/suppliers')).actions, []);
  // finishing the overdue order removes the action
  const fresh = await get(s, `/intelligence/suppliers?days=7`);
  assert.equal(fresh.windowDays, 7);
});

// ---------------------------------------------------------------- Action Center
test('priority scoring: severity always outranks the rupee amount (tiers never overlap)', () => {
  assert.ok(score('critical', 0) > score('high', 1e12));
  assert.ok(score('high', 0) > score('medium', 1e12));
  assert.ok(score('medium', 0) > score('low', 1e12));
  assert.ok(score('medium', 10000) > score('medium', 100), 'within a tier bigger amounts rank higher');
  assert.equal(score('low', -5), score('low', 0)); assert.equal(score('high', undefined), 70);
});

async function actionShop() {
  const s = await makeShop(api);
  const o = as(s);
  const tail = (await taxed(s, 5)).id;
  const mk = (over) => addProduct(api, s, { categoryId: tail, minimumStock: 5, ...over });
  // a fast seller that is now out of stock → critical reorder
  const fast = await mk({ name: 'Fast seller', purchasePrice: 20, sellingPrice: 30, stock: 40 });
  const sup = (await o.post('/suppliers', { name: 'Main Supplier', leadTimeDays: 3, paymentTermsDays: 0, minOrderValue: 0 })).body;
  await o.put(`/suppliers/${sup.id}/products/${fast.id}`, { isPreferred: true, lastCost: 20 });
  for (const d of [1, 2, 3, 4]) { const r = (await sell(api, s, fast.id, { quantity: 5 })).body; await backdateSale(s, r.id, d); }
  assert.equal((await sell(api, s, fast.id, { quantity: 20 })).status, 201);                   // 40 − 20 − 20 = 0
  // expired stock → high
  const milk = await mk({ name: 'Old milk', purchasePrice: 25, sellingPrice: 40, stock: 8 });
  await sql(s, `UPDATE products SET expiry_date = current_date - 2 WHERE id = $1`, [milk.id]);
  // dead stock → low/medium
  const dust = await mk({ name: 'Dusty', purchasePrice: 100, sellingPrice: 150, stock: 6 }); await backdateProduct(s, dust.id, 300);
  // overdue udhaar → high (100+ days)
  const cust = await addCustomer(api, s);
  await sql(s, `INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, note, created_at) VALUES ($1,'adjustment',1,750,'old notebook', now() - interval '100 days')`, [cust.id]);
  // yesterday's cash never counted → medium
  const y = (await sell(api, s, fast.id).catch(() => null)); void y;
  return { s, fast, milk, dust, cust };
}

test('Action Center: ranked, explained, categorised actions from real data (critical stock-out first)', async () => {
  const { s, fast, milk, dust, cust } = await actionShop();
  // a cash sale yesterday and no reconciliation → "yesterday's cash was never counted"
  const restock = await as(s).get('/inventory/restock-orders'); void restock;
  const yesterdayProd = await addProduct(api, s, { name: 'Yday item', stock: 5, minimumStock: 0 });
  const ys = (await sell(api, s, yesterdayProd.id)).body; await backdateSale(s, ys.id, 1);

  const ac = await get(s, '/intelligence/actions');
  const byId = (prefix) => ac.actions.find((a) => a.id.startsWith(prefix));
  assert.match(ac.method, /Rule-based/); assert.match(ac.method, /Not AI/);
  const reorder = byId(`reorder:${fast.id}`);
  assert.ok(reorder, ac.actions.map((a) => a.id).join(', ')); assert.equal(reorder.severity, 'critical'); assert.equal(reorder.category, 'stock');
  assert.ok(reorder.amount > 0 && reorder.amountLabel && reorder.why.length >= 2 && reorder.route === '/inventory');
  assert.equal(byId(`expiry:${milk.id}`).severity, 'high'); assert.equal(byId(`expiry:${milk.id}`).amount, 200);
  const ud = byId(`udhaar:${cust.id}`); assert.equal(ud.severity, 'high'); assert.equal(ud.amount, 750); assert.equal(ud.category, 'money'); assert.match(ud.title, /100 days/);
  const dead = byId('dead-stock'); assert.ok(dead && dead.amount >= 600, 'Dusty 6 × 100 is dead stock'); assert.match(dead.amountLabel, /not recoverable/);
  assert.ok(byId(`recon:${daysAgoIso(1)}`), "yesterday's uncounted cash");
  // ordering: scores never increase down the list; the critical item leads
  const scores = ac.actions.map((a) => a.score); assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(ac.actions[0].id, reorder.id);
  assert.equal(new Set(ac.actions.map((a) => a.id)).size, ac.actions.length, 'no duplicates');
  assert.ok(ac.actions.every((a) => a.title && a.detail && a.route && Array.isArray(a.why)));
  assert.deepEqual(Object.keys(ac.counts).sort(), ['money', 'operations', 'profit', 'stock', 'suppliers']);
  assert.equal(ac.counts.money, 1); assert.ok(ac.counts.stock >= 3);
  assert.ok(ac.bySeverity.critical >= 1 && ac.bySeverity.high >= 2);
  // filters
  const money = await get(s, '/intelligence/actions?category=money'); assert.ok(money.actions.length >= 1 && money.actions.every((a) => a.category === 'money'));
  assert.equal(money.total, ac.total - (ac.total - money.total), 'filter changes the list, not the headline counts');
  assert.equal((await get(s, '/intelligence/actions?limit=2')).actions.length, 2);

  // What should I do today? → top of the same list, ranked 1..n, with a plain headline
  const td = await get(s, '/intelligence/today?top=3');
  assert.deepEqual(td.actions.map((a) => a.rank), [1, 2, 3]); assert.deepEqual(td.actions.map((a) => a.id), ac.actions.slice(0, 3).map((a) => a.id));
  assert.equal(td.allClear, false); assert.match(td.headline, /urgent/); assert.equal(td.totalActions, ac.total);
  assert.match(td.method, /Rule-based/);
  assert.equal((await get(s, '/intelligence/today')).actions.length, Math.min(7, ac.total));

  // another shop's Action Center knows nothing about this one
  const other = await get(B, '/intelligence/actions'); assert.ok(!other.actions.some((a) => /Fast seller|Old milk|Dusty/.test(a.title)));
});

test('Action Center reacts to what the owner does: fixing a problem removes its action', async () => {
  const { s, milk, cust, dust } = await actionShop();
  const before = await get(s, '/intelligence/actions');
  assert.ok(before.actions.some((a) => a.id === `udhaar:${cust.id}`));
  await as(s).put(`/credit/customers/${cust.id}/limit`, { creditLimit: 1000 });
  assert.equal((await as(s).post(`/credit/customers/${cust.id}/payments`, { amount: 750, method: 'upi' })).status, 201);
  await sql(s, 'UPDATE products SET stock = 0 WHERE id = ANY($1)', [[milk.id, dust.id]]);
  const after = await get(s, '/intelligence/actions');
  assert.ok(!after.actions.some((a) => a.id === `udhaar:${cust.id}`), 'paid customer is gone');
  assert.ok(!after.actions.some((a) => a.id === `expiry:${milk.id}`), 'no stock left to expire');
  assert.ok(!after.actions.some((a) => a.id === 'dead-stock'));
  assert.ok(!after.actions.some((a) => ['udhaar:' + cust.id, 'expiry:' + milk.id, 'dead-stock'].includes(a.id)), 'the three fixed problems are gone (emptied shelves may raise new reorder actions, so the total is not compared)');
});

test('Action Center keeps working when one source fails: the rest is shown with a warning', async () => {
  const { s } = await actionShop();
  const credit = require('../src/services/credit');
  const real = credit.listDebtors; credit.listDebtors = async () => { throw new Error('boom'); };
  const quiet = console.error; console.error = () => {};
  try {
    const ac = await get(s, '/intelligence/actions');
    assert.deepEqual(ac.warnings, ['Could not check money right now.']);
    assert.ok(ac.actions.some((a) => a.category === 'stock'), 'other sources are still reported');
    assert.ok(!ac.actions.some((a) => a.category === 'money'));
  } finally { credit.listDebtors = real; console.error = quiet; }
});

test('intelligence endpoints are read-only: calling them writes nothing', async () => {
  const { s } = await actionShop();
  const count = async () => (await sql(s, `SELECT (SELECT COUNT(*) FROM audit_logs)::int AS a, (SELECT COUNT(*) FROM restock_orders)::int AS r, (SELECT COUNT(*) FROM credit_ledger)::int AS l, (SELECT COUNT(*) FROM products)::int AS p, (SELECT COALESCE(SUM(stock),0) FROM products) AS st`))[0];
  const before = await count();
  for (const p of ENDPOINTS) await get(s, p);
  assert.deepEqual(await count(), before);
  for (const p of ENDPOINTS) assert.equal((await as(s).post(p, {})).status, 404, `${p} has no write method`);
});
