// Roadmap Phase 9.1 — weighted-average costing, through the real HTTP API as real tenants (and the database where exact numbers matter).
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client } = require('./helpers');
const { makeShop, addProduct } = require('./sprint-helpers');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const j = (r) => JSON.stringify(r.body);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const avgOf = async (s, id) => Number((await sql(s, 'SELECT avg_cost::text AS a FROM products WHERE id = $1', [id]))[0].a);
const stockOf = async (s, id) => (await as(s).get(`/products/${id}`)).body.stock;
const history = async (s, id) => (await as(s).get(`/products/${id}/cost-history`)).body.rows;
let n = 0;
let supplier;
async function sup(s) { if (!supplier || supplier.s !== s) supplier = { s, v: (await as(s).post('/suppliers', { name: `Cost Supp ${++n}`, leadTimeDays: 2, paymentTermsDays: 0, minOrderValue: 0 })).body }; return supplier.v; }
/** Order `qty` of the product at `cost`, place it, and receive `recv` (default all) at `recvCost` (default the ordered cost). Returns the receive response. */
async function buy(s, p, qty, cost, { recv = qty, recvCost = cost, po } = {}) {
  const order = po || (await (async () => {
    const c = await as(s).post('/purchase-orders', { supplierId: (await sup(s)).id, items: [{ productId: p.id, quantity: qty, unitCost: cost }] });
    assert.equal(c.status, 201, j(c));
    const o = await as(s).post(`/purchase-orders/${c.body.id}/order`, {});
    assert.equal(o.status, 200, j(o));
    return o.body;
  })());
  const r = await as(s).post(`/purchase-orders/${order.id}/receive`, { items: [{ itemId: order.items[0].id, quantity: recv, unitCost: recvCost }] });
  assert.equal(r.status, 201, j(r));
  r.po = order;
  return r;
}
const newProduct = (s, over = {}) => addProduct(api, s, { categoryId: s.category.id, stock: 0, purchasePrice: 50, sellingPrice: 100, minimumStock: 0, ...over });

test('basic: 100 @ ₹50 then 100 @ ₹60 -> 200 units at ₹55, with a full history row', async () => {
  const p = await newProduct(A, { stock: 100, purchasePrice: 50 });
  assert.equal(await avgOf(A, p.id), 50, 'a new product starts at its cost price');
  await buy(A, p, 100, 60);
  assert.equal(await avgOf(A, p.id), 55); assert.equal(await stockOf(A, p.id), 200);
  const prod = (await as(A).get(`/products/${p.id}`)).body;
  assert.equal(prod.avgCost, 55); assert.equal(prod.purchasePrice, 60, 'purchase_price stays the latest purchase cost');
  assert.equal(prod.stockValue, 11000, '200 × ₹55');
  const [h] = await history(A, p.id);
  assert.deepEqual([h.source, h.cost, h.prevAvgCost, h.newAvgCost, h.qtyBefore, h.qtyReceived, h.qtyAfter, h.refType], ['purchase', 60, 50, 55, 100, 100, 200, 'goods_receipt']);
  assert.ok(h.refId && h.createdBy);
});

test('sequential purchases: 50 @ 40, 100 @ 50, 50 @ 60 — every recalculation is exact', async () => {
  const p = await newProduct(A, { stock: 0, purchasePrice: 40 });
  await buy(A, p, 50, 40); assert.equal(await avgOf(A, p.id), 40);
  await buy(A, p, 100, 50); assert.equal(await avgOf(A, p.id), 46.6667, '(50×40 + 100×50) / 150');
  await buy(A, p, 50, 60); assert.equal(await avgOf(A, p.id), 50, '(150 × 46.6667 + 50 × 60) / 200 rounds to 50.0000');
  assert.equal(await stockOf(A, p.id), 200);
  const rows = await history(A, p.id);
  const chain = rows.filter((r) => r.source === 'purchase').reverse().map((r) => [r.qtyBefore, r.qtyReceived, r.qtyAfter, r.prevAvgCost, r.newAvgCost]);
  assert.deepEqual(chain.slice(-2), [[50, 100, 150, 40, 46.6667], [150, 50, 200, 46.6667, 50]]);
});

test('sale: COGS uses the weighted average at the time of sale — 3 @ ₹70 with average ₹55 gives COGS 165 and profit 45', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 100, purchasePrice: 50, sellingPrice: 70, minimumStock: 0 });
  await buy(s, p, 100, 60);
  const sale = await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'cash' });
  assert.equal(sale.status, 201, j(sale));
  const [li] = await sql(s, 'SELECT unit_cost, taxable_value, quantity FROM sale_items WHERE sale_id = $1', [sale.body.id]);
  assert.equal(li.unit_cost, 55, 'snapshot is the average (not the latest purchase cost 60, not the old 50)');
  assert.equal(li.taxable_value, 210);
  assert.equal(li.taxable_value - li.unit_cost * li.quantity, 45, 'gross profit');
  assert.equal(Math.round((45 / 210) * 10000) / 100, 21.43, 'gross margin %');
  // a later purchase moves the average but never rewrites the earlier sale
  await buy(s, p, 100, 100);
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [sale.body.id]))[0].unit_cost, 55);
  const rep = (await as(s, 'manager').get('/reports/closing')).body;
  assert.ok(rep.sales, 'closing report still renders');
  // inventory valuation: 197 units on the shelf at the new average
  const avg = await avgOf(s, p.id);
  const inv = (await as(s).get('/inventory')).body.summary;
  assert.equal(Math.round(inv.costValue * 100) / 100, Math.round((await stockOf(s, p.id)) * avg * 100) / 100, 'inventory value = quantity × average');
});

test('the sale snapshot keeps four decimals: 3 units at an average of ₹46.6667 cost ₹140.00, not ₹140.01', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 0, purchasePrice: 40, sellingPrice: 80, minimumStock: 0 });
  await buy(s, p, 50, 40); await buy(s, p, 100, 50);
  const sale = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'cash' })).body;
  const [li] = await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [sale.id]);
  assert.equal(li.unit_cost, 46.6667);
  assert.equal(Math.round(li.unit_cost * 3 * 100) / 100, 140);
});

test('partial receiving: PO for 100, receive 40 then 60 — average correct after each receipt', async () => {
  const p = await newProduct(A, { stock: 100, purchasePrice: 40 });
  const r1 = await buy(A, p, 100, 60, { recv: 40 });
  assert.equal(await avgOf(A, p.id), 45.7143, '(100×40 + 40×60) / 140');
  await buy(A, p, 100, 60, { recv: 60, po: r1.po });
  assert.equal(await avgOf(A, p.id), 50, '(4000 + 6000) / 200');
  assert.equal(await stockOf(A, p.id), 200);
  const po = (await as(A).get(`/purchase-orders/${r1.po.id}`)).body;
  assert.equal(po.status, 'received');
});

test('receiving at different costs, including a receipt priced below the average and a received price that differs from the ordered one', async () => {
  const p = await newProduct(A, { stock: 10, purchasePrice: 100 });
  await buy(A, p, 10, 100, { recvCost: 80 });                         // invoiced cheaper than ordered: the ACTUAL unit cost is used
  assert.equal(await avgOf(A, p.id), 90, '(10×100 + 10×80) / 20');
  await buy(A, p, 20, 120);
  assert.equal(await avgOf(A, p.id), 105, '(20×90 + 20×120) / 40');
  await buy(A, p, 40, 30);
  assert.equal(await avgOf(A, p.id), 67.5, '(40×105 + 40×30) / 80');
  const expected = [[90, 100], [105, 90], [67.5, 105]];
  const rows = (await history(A, p.id)).filter((r) => r.source === 'purchase').reverse();
  assert.deepEqual(rows.map((r) => [r.newAvgCost, r.prevAvgCost]), expected);
  assert.equal(rows[0].cost, 80, 'the history keeps the actual received unit cost');
});

test('a receipt at the same cost leaves the average alone and writes no cost event; zero stock restarts the average at the received cost', async () => {
  const p = await newProduct(A, { stock: 10, purchasePrice: 50 });
  const before = (await history(A, p.id)).length;
  await buy(A, p, 5, 50);
  assert.equal(await avgOf(A, p.id), 50); assert.equal((await history(A, p.id)).length, before);
  await as(A).post(`/inventory/${p.id}/adjust`, { delta: -15, reason: 'lost' });
  assert.equal(await stockOf(A, p.id), 0);
  await buy(A, p, 4, 72);
  assert.equal(await avgOf(A, p.id), 72, 'nothing left on the shelf: the new cost is the whole inventory');
});

test('returns: restocked units re-enter at their ORIGINAL sale cost, historic COGS never changes, a non-restocked return leaves quantity and average alone', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 100, purchasePrice: 50, sellingPrice: 70, minimumStock: 0 });
  await buy(s, p, 100, 60);                                                   // avg 55, 200 units
  const sale = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], paymentMethod: 'cash' })).body;   // COGS 165, 197 left
  await buy(s, p, 100, 70);                                                   // avg moves on
  const avg1 = await avgOf(s, p.id);
  assert.equal(avg1, 60.0505, '(197×55 + 100×70) / 297');
  const line = sale.items.find((i) => i.productId === p.id);
  const r1 = await as(s).post(`/sales/${sale.id}/returns`, { items: [{ saleItemId: line.id, quantity: 2, restock: true }], reason: 'changed_mind' });
  assert.equal(r1.status, 201, j(r1));
  assert.equal(await stockOf(s, p.id), 299);
  const exp = Math.round(((297 * avg1 + 2 * 55) / 299) * 10000) / 10000;
  assert.equal(await avgOf(s, p.id), exp, 'returned units come back at ₹55, the cost they were sold at');
  const [h] = await history(s, p.id);
  assert.deepEqual([h.source, h.refType, h.cost, h.qtyBefore, h.qtyReceived, h.qtyAfter, h.prevAvgCost], ['return', 'sale_return', 55, 297, 2, 299, avg1]);
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE id = $1', [line.id]))[0].unit_cost, 55, 'the sale line keeps its snapshot');
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_return_items WHERE return_id = $1', [r1.body.return.id]))[0].unit_cost, 55);
  // not restocked (damaged): no stock, no average change
  const before = await avgOf(s, p.id);
  const r2 = await as(s).post(`/sales/${sale.id}/returns`, { items: [{ saleItemId: line.id, quantity: 1, restock: false }], reason: 'damaged' });
  assert.equal(r2.status, 201, j(r2));
  assert.equal(await stockOf(s, p.id), 299); assert.equal(await avgOf(s, p.id), before);
  // returning at the same cost the average already has is not a cost event
  const hLen = (await history(s, p.id)).length;
  const sale2 = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' })).body;
  const l2 = sale2.items.find((i) => i.productId === p.id);
  await as(s).post(`/sales/${sale2.id}/returns`, { items: [{ saleItemId: l2.id, quantity: 1, restock: true }], reason: 'changed_mind' });
  assert.equal(await avgOf(s, p.id), before); assert.equal((await history(s, p.id)).length, hLen);
});

test('full refund puts everything back at the sale cost and the average stays consistent', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 20, purchasePrice: 10, sellingPrice: 30, minimumStock: 0 });
  const sale = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 5 }], paymentMethod: 'cash' })).body;
  const ref = await as(s).post(`/sales/${sale.id}/refund`, {});
  assert.equal(ref.status, 200, j(ref));
  assert.equal(await stockOf(s, p.id), 20); assert.equal(await avgOf(s, p.id), 10);
});

test('adjustments, damage, loss and stock counts change quantity only: the average is untouched and the value follows quantity × average', async () => {
  const p = await newProduct(A, { stock: 100, purchasePrice: 50 });
  await buy(A, p, 100, 60);                                                                  // avg 55, 200 units
  for (const [delta, reason] of [[-10, 'damaged'], [-5, 'lost'], [-2, 'theft'], [7, 'found_stock'], [3, 'manual_correction']]) {
    const r = await as(A).post(`/inventory/${p.id}/adjust`, { delta, reason });
    assert.equal(r.status, 201, j(r));
    assert.equal(await avgOf(A, p.id), 55, `${reason} must not move the average`);
  }
  assert.equal(await stockOf(A, p.id), 193);
  assert.equal((await as(A).get(`/products/${p.id}`)).body.stockValue, 193 * 55);
  // physical count approval: shortage of 3 is valued at the average and applied as an adjustment
  const c = (await as(A, 'manager').post('/stock-counts', { title: 'Cost check' })).body;
  await as(A).put(`/stock-counts/${c.id}/items/${p.id}`, { counted: 190 });
  const items = (await sql(A, 'SELECT unit_cost FROM stock_count_items WHERE stock_count_id = $1', [c.id]));
  assert.equal(items[0].unit_cost, 55, 'count variance is valued at the weighted average');
  await as(A).post(`/stock-counts/${c.id}/submit`);
  assert.equal((await as(A).post(`/stock-counts/${c.id}/approve`)).status, 200);
  assert.equal(await stockOf(A, p.id), 190); assert.equal(await avgOf(A, p.id), 55);
  // every one of those is still on the audited movement trail
  const tl = (await as(A).get(`/inventory/${p.id}/timeline`)).body.rows;
  assert.ok(tl.filter((r) => r.type === 'adjustment').length >= 6);
});

test('editing purchase_price changes ONLY purchase_price: avg_cost, stock and inventory value stay put; the next receipt then blends in the new cost', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 100, purchasePrice: 50, sellingPrice: 90, minimumStock: 0 });
  const sold = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 4 }], paymentMethod: 'cash' })).body;     // before the edit: COGS at ₹50
  const invBefore = (await as(s).get('/inventory')).body.summary;
  const valueBefore = (await as(s).get(`/products/${p.id}`)).body.stockValue;
  assert.equal(valueBefore, 96 * 50);

  const r = await as(s).put(`/products/${p.id}`, { purchasePrice: 60 });                                                    // the supplier's NEXT price
  assert.equal(r.status, 200, j(r));
  const after = (await as(s).get(`/products/${p.id}`)).body;
  assert.equal(after.purchasePrice, 60);
  assert.equal(await avgOf(s, p.id), 50, 'avg_cost is NOT touched by a purchase-price edit');
  assert.equal(after.avgCost, 50); assert.equal(after.stock, 96);
  assert.equal(after.stockValue, valueBefore, 'inventory valuation is unchanged');
  const invAfter = (await as(s).get('/inventory')).body.summary;
  assert.equal(invAfter.costValue, invBefore.costValue); assert.equal(invAfter.stockValue, invBefore.stockValue);

  // the edit is audited as before (a price-change entry in the cost history) but it is not an average-cost event
  const [h] = await history(s, p.id);
  assert.deepEqual([h.source, h.cost, h.prevAvgCost, h.newAvgCost, h.qtyBefore, h.qtyReceived, h.qtyAfter], ['manual', 60, null, null, null, null, null]);
  assert.ok((await sql(s, `SELECT 1 FROM audit_logs WHERE entity_type = 'product' AND entity_id = $1 AND action LIKE 'product.%'`, [String(p.id)])).length >= 1, 'the product edit is in the audit log');

  // a sale AFTER the edit and BEFORE any new purchase still costs ₹50 (not the new ₹60)
  const mid = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' })).body;
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [mid.id]))[0].unit_cost, 50);

  // next real receipt: 95 on hand now at ₹50, receive 95 at the new ₹60 -> (95×50 + 95×60) / 190 = ₹55
  await buy(s, p, 95, 60);
  assert.equal(await avgOf(s, p.id), 55);
  const [rc] = await history(s, p.id);
  assert.deepEqual([rc.source, rc.cost, rc.prevAvgCost, rc.newAvgCost, rc.qtyBefore, rc.qtyReceived, rc.qtyAfter], ['purchase', 60, 50, 55, 95, 95, 190]);

  // earlier sales never changed: COGS snapshots are still the cost that applied when they were sold
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [sold.id]))[0].unit_cost, 50);
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [mid.id]))[0].unit_cost, 50);
  // and a sale from now on uses the new average
  const late = (await as(s).post('/sales', { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'cash' })).body;
  assert.equal((await sql(s, 'SELECT unit_cost FROM sale_items WHERE sale_id = $1', [late.id]))[0].unit_cost, 55);
});

test('the headline example: 100 @ ₹50, price edited to ₹60, then 100 @ ₹60 received -> ₹55; managers get the same behaviour; other edits never touch avg_cost', async () => {
  const p = await newProduct(A, { stock: 100, purchasePrice: 50 });
  assert.equal((await as(A, 'manager').put(`/products/${p.id}`, { purchasePrice: 60 })).status, 200);
  assert.equal(await avgOf(A, p.id), 50); assert.equal((await as(A).get(`/products/${p.id}`)).body.stockValue, 5000);
  assert.equal((await as(A).put(`/products/${p.id}`, { name: 'Renamed Cost Test', sellingPrice: 120 })).status, 200);
  assert.equal(await avgOf(A, p.id), 50);
  await buy(A, p, 100, 60);                                                                    // ordered at the product's new price
  assert.equal(await avgOf(A, p.id), 55); assert.equal(await stockOf(A, p.id), 200);
  assert.equal((await as(A).get(`/products/${p.id}`)).body.stockValue, 11000);
});

test('tenant isolation: another business cannot edit a product\'s purchase price, and its own edits never reach this business\'s costs', async () => {
  const p = await newProduct(A, { stock: 10, purchasePrice: 50 });
  assert.equal((await as(B).put(`/products/${p.id}`, { purchasePrice: 99 })).status, 404);
  const before = (await as(A).get(`/products/${p.id}`)).body;
  assert.equal(before.purchasePrice, 50); assert.equal(before.avgCost, 50);
  const bp = await newProduct(B, { stock: 10, purchasePrice: 5 });
  await as(B).put(`/products/${bp.id}`, { purchasePrice: 8 });
  assert.equal(await avgOf(B, bp.id), 5);
  const bHist = await sql(B, 'SELECT product_id FROM product_cost_history WHERE product_id = $1', [p.id]);
  assert.equal(bHist.length, 0, 'B cannot see A\'s cost history');
  assert.equal(await avgOf(A, p.id), 50);
});

test('multi-unit: all cost is per the product\'s base unit — 10 cartons @ ₹240 of 24 pcs is 240 pcs @ ₹10, then 240 pcs @ ₹11 gives ₹10.50', async () => {
  const p = await newProduct(A, { unit: 'pcs', stock: 0, purchasePrice: 10 });
  await buy(A, p, 240, 10);                                                                  // 10 cartons × 24 pcs, ₹240/carton = ₹10/pc
  await buy(A, p, 240, 11);                                                                  // ₹264/carton = ₹11/pc
  assert.equal(await avgOf(A, p.id), 10.5); assert.equal(await stockOf(A, p.id), 480);
  assert.equal((await as(A).get(`/products/${p.id}`)).body.stockValue, 5040);
  // counted units reject a fractional receipt (the existing unit rule still guards costing)
  const c = await as(A).post('/purchase-orders', { supplierId: (await sup(A)).id, items: [{ productId: p.id, quantity: 5, unitCost: 10 }] });
  const o = (await as(A).post(`/purchase-orders/${c.body.id}/order`, {})).body;
  const bad = await as(A).post(`/purchase-orders/${o.id}/receive`, { items: [{ itemId: o.items[0].id, quantity: 2.5, unitCost: 10 }] });
  assert.equal(bad.status, 400); assert.equal(await avgOf(A, p.id), 10.5);
});

test('decimal safety: ₹0.01 and ₹99.99 costs, fractional kg, no floating-point drift', async () => {
  const p = await newProduct(A, { unit: 'kg', stock: 0, purchasePrice: 99.99 });
  await buy(A, p, 0.125, 99.99);
  await buy(A, p, 0.375, 0.01);
  assert.equal(await avgOf(A, p.id), 25.005, '(0.125×99.99 + 0.375×0.01) / 0.5');
  assert.equal(await stockOf(A, p.id), 0.5);
  const cheap = await newProduct(A, { stock: 0, purchasePrice: 0.01 });
  await buy(A, cheap, 1000, 0.01);
  assert.equal(await avgOf(A, cheap.id), 0.01);
  await buy(A, cheap, 1, 99.99);
  assert.equal(await avgOf(A, cheap.id), 0.1099, '(1000×0.01 + 99.99) / 1001 = 109.99 / 1001');
});

test('concurrent receipts of the same product are serialised: the average equals the sequential result', async () => {
  const p = await newProduct(A, { stock: 100, purchasePrice: 50 });
  const mk = async (qty, cost) => {
    const c = await as(A).post('/purchase-orders', { supplierId: (await sup(A)).id, items: [{ productId: p.id, quantity: qty, unitCost: cost }] });
    return (await as(A).post(`/purchase-orders/${c.body.id}/order`, {})).body;
  };
  const [p1, p2, p3] = [await mk(100, 60), await mk(100, 70), await mk(100, 80)];
  const rs = await Promise.all([p1, p2, p3].map((po, i) => as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: po.items[0].id, quantity: 100, unitCost: [60, 70, 80][i] }] })));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201], rs.map(j).join(' '));
  assert.equal(await stockOf(A, p.id), 400);
  assert.equal(await avgOf(A, p.id), 65, '(5000 + 6000 + 7000 + 8000) / 400');
  const chain = (await history(A, p.id)).filter((r) => r.source === 'purchase').reverse();
  // A receipt that lands on exactly the current average (e.g. ₹60 stock + ₹60 purchase) writes no cost event, so depending on the order the
  // locks were won there are 2 or 3 rows. Either way each row must start from the result of the one before it.
  assert.ok(chain.length >= 2 && chain.length <= 3, `${chain.length} cost events`);
  assert.equal(chain[0].prevAvgCost, 50); assert.equal(chain[chain.length - 1].newAvgCost, 65);
  for (let i = 1; i < chain.length; i++) { assert.equal(chain[i].prevAvgCost, chain[i - 1].newAvgCost, 'each receipt started from the previous receipt\'s result'); assert.ok(chain[i].qtyBefore >= chain[i - 1].qtyAfter); }
});

test('concurrent sale + receipt: the receipt never corrupts stock or the average', async () => {
  const p = await newProduct(A, { stock: 50, purchasePrice: 50, sellingPrice: 100 });
  const c = await as(A).post('/purchase-orders', { supplierId: (await sup(A)).id, items: [{ productId: p.id, quantity: 50, unitCost: 70 }] });
  const po = (await as(A).post(`/purchase-orders/${c.body.id}/order`, {})).body;
  const [r, s1, s2] = await Promise.all([
    as(A).post(`/purchase-orders/${po.id}/receive`, { items: [{ itemId: po.items[0].id, quantity: 50, unitCost: 70 }] }),
    as(A).post('/sales', { items: [{ productId: p.id, quantity: 5 }], paymentMethod: 'cash' }),
    as(A).post('/sales', { items: [{ productId: p.id, quantity: 5 }], paymentMethod: 'cash' }),
  ]);
  assert.deepEqual([r.status, s1.status, s2.status], [201, 201, 201]);
  assert.equal(await stockOf(A, p.id), 90);
  // The average legitimately depends on how many units were still on the shelf when the receipt landed (50, 45 or 40): check it against that row.
  const rc = (await history(A, p.id)).find((x) => x.source === 'purchase');
  assert.ok([50, 45, 40].includes(rc.qtyBefore), `receipt saw ${rc.qtyBefore} units`);
  assert.equal(await avgOf(A, p.id), Math.round(((rc.qtyBefore * 50 + 50 * 70) / (rc.qtyBefore + 50)) * 10000) / 10000);
  const finalAvg = await avgOf(A, p.id);
  const costs = (await sql(A, 'SELECT unit_cost FROM sale_items WHERE product_id = $1 ORDER BY id', [p.id])).map((x) => x.unit_cost);
  assert.ok(costs.every((c2) => c2 === 50 || c2 === finalAvg), `each sale used the average that applied at that moment (${costs})`);
});

test('batch opening stock with a cost joins the average; without a cost it enters at the current average', async () => {
  const p = await newProduct(A, { stock: 10, purchasePrice: 50 });
  const b1 = await as(A).post(`/inventory/${p.id}/batches`, { quantity: 10, batchNo: 'W1', expiryDate: '2099-01-01', unitCost: 60 });
  assert.equal(b1.status, 201, j(b1));
  assert.equal(await avgOf(A, p.id), 55);
  const b2 = await as(A).post(`/inventory/${p.id}/batches`, { quantity: 5, batchNo: 'W2', expiryDate: '2099-02-01' });
  assert.equal(b2.status, 201, j(b2));
  assert.equal(await avgOf(A, p.id), 55); assert.equal(await stockOf(A, p.id), 25);
  const h = (await history(A, p.id)).find((r) => r.source === 'batch');
  assert.deepEqual([h.refType, h.qtyBefore, h.qtyReceived, h.qtyAfter], ['stock_batch', 10, 10, 20]);
  // FEFO selling still works and still snapshots the average
  const sale = await as(A).post('/sales', { items: [{ productId: p.id, quantity: 2 }], paymentMethod: 'cash' });
  assert.equal(sale.status, 201, j(sale));
});

test('database: a product written without an average (old code, seed, import) starts at its purchase price; cost history is append-only', async () => {
  const p = await newProduct(A, { stock: 0, purchasePrice: 33.5 });
  assert.equal(await avgOf(A, p.id), 33.5);
  await assert.rejects(() => env.db.runAsTenant(A.businessId, () => env.db.query('UPDATE product_cost_history SET cost = 1')), /permission denied/);
  const del = await env.db.runAsTenant(A.businessId, () => env.db.query('DELETE FROM product_cost_history'));
  assert.equal(del.rowCount, 0, 'real businesses cannot delete cost history (the policy hides every row from DELETE)');
  assert.ok((await history(A, p.id)).length >= 1);
});

test('tenant isolation: another business cannot read or influence cost data; history is invisible across tenants at the SQL level', async () => {
  const p = await newProduct(A, { stock: 10, purchasePrice: 50 });
  await buy(A, p, 10, 90);
  assert.equal((await as(B).get(`/products/${p.id}/cost-history`)).status, 404);
  assert.equal((await as(B).get(`/products/${p.id}`)).status, 404);
  assert.equal((await as(B).put(`/products/${p.id}`, { purchasePrice: 1 })).status, 404);
  assert.equal(await avgOf(A, p.id), 70);
  const seenByB = await sql(B, 'SELECT id FROM product_cost_history WHERE product_id = $1', [p.id]);
  assert.equal(seenByB.length, 0);
  const bp = await newProduct(B, { stock: 10, purchasePrice: 5 });
  await buy(B, bp, 10, 15);
  assert.equal(await avgOf(B, bp.id), 10); assert.equal(await avgOf(A, p.id), 70, 'B\'s receipts never touch A');
});

test('authorization: cashiers cannot read cost history or change a cost; owners and managers can', async () => {
  const p = await newProduct(A, { stock: 5, purchasePrice: 50 });
  assert.equal((await as(A, 'cashier').get(`/products/${p.id}/cost-history`)).status, 403);
  assert.equal((await as(A, 'cashier').put(`/products/${p.id}`, { purchasePrice: 1 })).status, 403);
  assert.equal((await as(A, 'manager').get(`/products/${p.id}/cost-history`)).status, 200);
  assert.equal(await avgOf(A, p.id), 50);
});

test('profit leaks and owner intelligence use the average: priced between the last cost and the average is judged against the average', async () => {
  const s = await makeShop(api); const cat = (await as(s).post('/categories', { name: 'NoTax', taxRate: 0 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, stock: 100, purchasePrice: 50, sellingPrice: 58, minimumStock: 0 });
  await buy(s, p, 100, 60);                                                                  // last cost 60 (> price 58), average 55 (< price 58)
  const leaks = (await as(s).get('/intelligence/profit-leaks')).body;
  const below = (leaks.leaks || leaks.rows || []).filter((l) => l.type === 'below_cost' && l.productId === p.id);
  assert.equal(below.length, 0, 'it is not below its weighted-average cost');
  await buy(s, p, 200, 100);                                                                 // average now (200×55 + 200×100)/400 = 77.5 > 58
  const leaks2 = (await as(s).get('/intelligence/profit-leaks')).body;
  assert.equal((leaks2.leaks || leaks2.rows || []).filter((l) => l.type === 'below_cost' && l.productId === p.id).length, 1);
});
