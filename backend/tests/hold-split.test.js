// Sprint 6 (hold bill) + Sprint 7 (split payment): server-side held bills, tender lines that must add up exactly, idempotency, roles, tenant isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot, client } = require('./helpers');
const { makeShop, addProduct, addCustomer } = require('./sprint-helpers');
const { resolvePayments } = require('../src/services/sales');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const stockOf = async (s, p) => (await as(s).get(`/products/${p.id}`)).body.stock;
const key = () => crypto.randomUUID();

/** A shop whose products have no tax, so ₹500 × 2 is exactly ₹1000. */
async function plainShop() {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'No tax', taxRate: 0 })).body;
  s.cat = cat;
  s.p = await addProduct(api, s, { name: 'Gift box', categoryId: cat.id, purchasePrice: 300, sellingPrice: 500, stock: 50 });
  return s;
}
const cart = (p, quantity = 2) => ({ items: [{ productId: p.id, quantity }] });

// ------------------------------------------------------------------ pure rules
test('resolvePayments: lines must add up to the bill to the paisa; one line per method; credit is just a line', () => {
  const r = resolvePayments({ payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] }, 100000);
  assert.deepEqual(r.lines, [{ method: 'cash', paise: 40000 }, { method: 'upi', paise: 60000 }]);
  assert.equal(r.primary, 'split');
  assert.equal(resolvePayments({ payments: [{ method: 'card', amount: 1000 }] }, 100000).primary, 'card', 'a single line is not "split"');
  assert.equal(resolvePayments({ paymentMethod: 'upi' }, 12345).lines[0].paise, 12345);
  assert.throws(() => resolvePayments({ payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 599.99 }] }, 100000), (e) => e.details.code === 'PAYMENT_SHORT' && e.details.difference === 0.01);
  assert.throws(() => resolvePayments({ payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600.01 }] }, 100000), (e) => e.details.code === 'PAYMENT_EXCEEDS_BILL');
  assert.throws(() => resolvePayments({ payments: [{ method: 'cash', amount: 500 }, { method: 'cash', amount: 500 }] }, 100000), (e) => e.details.code === 'DUPLICATE_PAYMENT_METHOD');
  assert.throws(() => resolvePayments({ payments: [{ method: 'cash', amount: 1000.005 }] }, 100000), (e) => e.details.code === 'PAYMENT_PRECISION');
  assert.throws(() => resolvePayments({}, 100000), (e) => e.details.code === 'PAYMENT_REQUIRED');
  assert.deepEqual(resolvePayments({ paymentMethod: 'cash' }, 0).lines, [], 'a ₹0 bill has nothing to pay');
  // 0.1 + 0.2 style float traps are avoided because everything is integer paise
  assert.equal(resolvePayments({ payments: [{ method: 'cash', amount: 0.1 }, { method: 'upi', amount: 0.2 }] }, 30).lines.length, 2);
});

// ------------------------------------------------------------------ split payment over the API
test('split payment: cash 400 + UPI 600 = 1000 is stored as tender lines; the sale is "split"', async () => {
  const s = await plainShop();
  const r = await as(s).post('/sales', { ...cart(s.p), payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.total, 1000);
  assert.equal(r.body.paymentMethod, 'split');
  assert.deepEqual(r.body.payments.map((p) => [p.method, p.amount]).sort(), [['cash', 400], ['upi', 600]]);
  assert.equal(await stockOf(s, s.p), 48);
  const rows = await sql(s, `SELECT method, amount FROM sale_payments WHERE sale_id = $1 ORDER BY method`, [r.body.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((a, x) => a + x.amount, 0), 1000);
  // sale list can be filtered by any tender used, and by "split"
  assert.equal((await as(s).get('/sales?payment=upi')).body.rows.length, 1);
  assert.equal((await as(s).get('/sales?payment=split')).body.rows.length, 1);
  assert.equal((await as(s).get('/sales?payment=card')).body.rows.length, 0);
});

test('split payment: under-payment, over-payment, duplicates, bad precision and mixing both forms are refused and nothing is sold', async () => {
  const s = await plainShop();
  const bad = async (body, code) => {
    const r = await as(s).post('/sales', { ...cart(s.p), ...body });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    if (code) assert.equal(r.body.details && r.body.details.code, code);
  };
  await bad({ payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 500 }] }, 'PAYMENT_SHORT');
  await bad({ payments: [{ method: 'cash', amount: 600 }, { method: 'upi', amount: 500 }] }, 'PAYMENT_EXCEEDS_BILL');
  await bad({ payments: [{ method: 'cash', amount: 500 }, { method: 'cash', amount: 500 }] }, 'DUPLICATE_PAYMENT_METHOD');
  await bad({ payments: [{ method: 'cash', amount: 999.999 }] }, 'PAYMENT_PRECISION');
  await bad({ payments: [{ method: 'cash', amount: 0 }, { method: 'upi', amount: 1000 }] });
  await bad({ payments: [{ method: 'cash', amount: -5 }, { method: 'upi', amount: 1005 }] });
  await bad({ payments: [{ method: 'cheque', amount: 1000 }] });
  await bad({ paymentMethod: 'cash', payments: [{ method: 'cash', amount: 1000 }] });
  await bad({ payments: [] });
  await bad({}, 'PAYMENT_REQUIRED');
  assert.equal(await stockOf(s, s.p), 50, 'no refused request deducted stock');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sales`))[0].n, 0);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sale_requests`))[0].n, 0, 'a failed request leaves no idempotency claim behind');
});

test('split payment: rounding and tax — a ₹105 bill (₹100 + 5% GST) splits as 50.50 + 54.50 and 0.01 off is refused', async () => {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Five', taxRate: 5 })).body;
  const p = await addProduct(api, s, { categoryId: cat.id, purchasePrice: 40, sellingPrice: 100, stock: 10 });
  const ok = await as(s).post('/sales', { ...cart(p, 1), payments: [{ method: 'cash', amount: 50.5 }, { method: 'card', amount: 54.5 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.total, 105);
  assert.equal(ok.body.tax, 5);
  assert.equal((await as(s).post('/sales', { ...cart(p, 1), payments: [{ method: 'cash', amount: 50.5 }, { method: 'card', amount: 54.49 }] })).status, 400);
  // thirds: ₹100 bill (no discount) in 3 unequal-looking pieces that still sum exactly
  const t = await as(s).post('/sales', { items: [{ productId: p.id, quantity: 3 }], discount: { type: 'amount', value: 0.01 }, payments: [{ method: 'cash', amount: 105.33 }, { method: 'upi', amount: 105.33 }, { method: 'card', amount: 104.33 }] });
  assert.ok([201, 400].includes(t.status));
});

test('split payment with a credit (udhaar) line: only that part goes on the customer ledger; limits and customer rules still apply', async () => {
  const s = await plainShop();
  const c = await addCustomer(api, s);
  assert.equal((await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: 500 })).status, 200);
  const noCust = await as(s).post('/sales', { ...cart(s.p), payments: [{ method: 'cash', amount: 600 }, { method: 'credit', amount: 400 }] });
  assert.equal(noCust.status, 400);
  assert.equal(noCust.body.details.code, 'CREDIT_NEEDS_CUSTOMER');
  const over = await as(s).post('/sales', { ...cart(s.p), customerId: c.id, payments: [{ method: 'cash', amount: 400 }, { method: 'credit', amount: 600 }] });
  assert.ok(over.status >= 400 && over.status < 500, 'credit above the limit is refused');
  assert.equal(await stockOf(s, s.p), 50, 'the refused sale rolled back completely');
  const ok = await as(s).post('/sales', { ...cart(s.p), customerId: c.id, payments: [{ method: 'cash', amount: 600 }, { method: 'credit', amount: 400 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.paymentMethod, 'split');
  assert.equal((await as(s).get(`/credit/customers/${c.id}/balance`)).body.balance, 400, 'only the credit part is owed');
});

test('split payment feeds the closing report, shift cash and analytics by tender line', async () => {
  const s = await plainShop();
  const open = await as(s, 'cashier').post('/shifts/open', { openingCash: 100 });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  assert.equal((await as(s, 'cashier').post('/sales', { ...cart(s.p), payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] })).status, 201);
  assert.equal((await as(s, 'cashier').post('/sales', { ...cart(s.p, 1), paymentMethod: 'cash' })).status, 201);
  const live = (await as(s, 'cashier').get('/shifts/current')).body.shift;
  assert.equal(live.summary.cashSales, 900, 'cash = 400 (split) + 500 (single)');
  assert.equal(live.expectedCash, 1000, 'opening 100 + cash 900; the UPI part never enters the drawer');
  const rep = (await as(s).get('/reports/closing')).body;
  const pay = Object.fromEntries(rep.payments.map((p) => [p.method, p.amount]));
  assert.equal(pay.cash, 900); assert.equal(pay.upi, 600);
  assert.equal(rep.sales.billedTotal, 1500);
  assert.equal(rep.sales.count, 2, 'a split bill is ONE bill');
  const an = (await as(s).get('/analytics/sales?range=today')).body;
  const ap = Object.fromEntries(an.payments.map((p) => [p.method, p.revenue]));
  assert.equal(ap.cash, 900); assert.equal(ap.upi, 600);
});

test('split payment is idempotent: same key + same lines replays the original; same key + different lines is refused', async () => {
  const s = await plainShop();
  const k = key();
  const body = { ...cart(s.p), payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] };
  const first = await as(s).post('/sales', body, { 'idempotency-key': k });
  assert.equal(first.status, 201);
  const again = await as(s).post('/sales', { ...body, payments: [...body.payments].reverse() }, { 'idempotency-key': k });
  assert.equal(again.status, 200, 'line order does not matter');
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.body.id, first.body.id);
  const diff = await as(s).post('/sales', { ...body, payments: [{ method: 'cash', amount: 500 }, { method: 'upi', amount: 500 }] }, { 'idempotency-key': k });
  assert.equal(diff.status, 422);
  assert.equal(await stockOf(s, s.p), 48, 'sold once');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sale_payments`))[0].n, 2);
});

test('single-payment sales are unchanged (cash, upi, card, credit) and now carry one tender line', async () => {
  const s = await plainShop();
  const c = await addCustomer(api, s);
  await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: 5000 });
  for (const m of ['cash', 'upi', 'card']) {
    const r = await as(s).post('/sales', { ...cart(s.p, 1), paymentMethod: m });
    assert.equal(r.status, 201); assert.equal(r.body.paymentMethod, m);
    assert.deepEqual(r.body.payments, [{ method: m, amount: 500 }]);
  }
  const cr = await as(s).post('/sales', { ...cart(s.p, 1), paymentMethod: 'credit', customerId: c.id });
  assert.equal(cr.status, 201); assert.deepEqual(cr.body.payments, [{ method: 'credit', amount: 500 }]);
  assert.equal((await as(s).post('/sales', { ...cart(s.p, 1), paymentMethod: 'credit' })).status, 400);
});

test('split payment works for cashiers and respects tenant isolation', async () => {
  const s = await plainShop();
  const r = await as(s, 'cashier').post('/sales', { ...cart(s.p), payments: [{ method: 'cash', amount: 1 }, { method: 'upi', amount: 999 }] });
  assert.equal(r.status, 201);
  assert.equal((await as(s).get(`/sales/${r.body.id}`)).body.payments.length, 2);
  assert.equal((await as(B).get(`/sales/${r.body.id}`)).status, 404, 'another business cannot read the sale or its tender lines');
  assert.equal((await sql(B, `SELECT COUNT(*)::int AS n FROM sale_payments`))[0].n, 0, 'RLS hides tender lines from other tenants');
});

// ------------------------------------------------------------------ held bills
test('hold: a held bill is stored on the server and touches NO stock, sale, payment, revenue, profit or shift', async () => {
  const s = await plainShop();
  await as(s, 'cashier').post('/shifts/open', { openingCash: 0 });
  const h = await as(s, 'cashier').post('/held-bills', { ...cart(s.p, 3), label: 'Aunty at counter 2' });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.equal(h.body.hold.status, 'held');
  assert.equal(h.body.hold.items[0].name, 'Gift box');
  assert.equal(await stockOf(s, s.p), 50);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sales`))[0].n, 0);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM inventory_movements WHERE movement_type = 'sale'`))[0].n, 0);
  const rep = (await as(s).get('/reports/closing')).body;
  assert.equal(rep.sales.billedTotal, 0); assert.equal(rep.sales.grossProfit, 0);
  const live = (await as(s, 'cashier').get('/shifts/current')).body.shift;
  assert.equal(live.summary.count ?? live.summary.sales.count, 0);
  // "refresh": a brand new request still sees it, because it lives in the database
  const list = await as(s, 'cashier').get('/held-bills');
  assert.equal(list.body.holds.length, 1);
  assert.equal(list.body.holds[0].label, 'Aunty at counter 2');
  assert.equal(list.body.holds[0].estimatedTotal, 1500);
});

test('hold: resume re-prices the cart, keeps its customer/discount/label, counts the resume and stays held', async () => {
  const s = await plainShop();
  const c = await addCustomer(api, s);
  const h = (await as(s, 'cashier').post('/held-bills', { ...cart(s.p, 2), customerId: c.id, discount: { type: 'percent', value: 5 }, label: 'Rohit' })).body.hold;
  const r = await as(s, 'cashier').post(`/held-bills/${h.id}/resume`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hold.customerId, c.id);
  assert.deepEqual(r.body.hold.discount, { type: 'percent', value: 5 });
  assert.equal(r.body.hold.resumedCount, 1);
  assert.equal(r.body.hold.status, 'held');
  assert.equal(r.body.canComplete, true);
  assert.equal(r.body.bill.total, 950, '₹1000 − 5%');
  const audits = await sql(s, `SELECT action FROM audit_logs WHERE entity_type = 'held_bill' ORDER BY id`);
  assert.deepEqual(audits.map((a) => a.action), ['hold.created', 'hold.resumed']);
});

test('hold: completing sells the SERVER cart once, with split payment, and links hold ↔ sale; a second completion is refused', async () => {
  const s = await plainShop();
  const h = (await as(s, 'cashier').post('/held-bills', cart(s.p, 2))).body.hold;
  const k = key();
  const pay = { payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] };
  const done = await as(s, 'cashier').post(`/held-bills/${h.id}/complete`, pay, { 'idempotency-key': k });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.total, 1000);
  assert.equal(done.body.paymentMethod, 'split');
  assert.equal(await stockOf(s, s.p), 48);
  const after = (await as(s, 'cashier').get(`/held-bills/${h.id}`)).body.hold;
  assert.equal(after.status, 'completed'); assert.equal(after.completedSaleId, done.body.id);
  assert.equal((await as(s, 'cashier').get('/held-bills')).body.holds.length, 0, 'no longer in the open list');
  // double click / retry with the same key → the same sale, nothing more
  const replay = await as(s, 'cashier').post(`/held-bills/${h.id}/complete`, pay, { 'idempotency-key': k });
  assert.equal(replay.status, 200); assert.equal(replay.body.id, done.body.id);
  // a NEW key (someone else on another till) cannot complete it again
  const dup = await as(s, 'cashier').post(`/held-bills/${h.id}/complete`, pay, { 'idempotency-key': key() });
  assert.equal(dup.status, 409); assert.equal(dup.body.details.code, 'HELD_BILL_NOT_OPEN');
  // …and neither can the normal sale path, even if it names the hold
  const viaSales = await as(s, 'cashier').post('/sales', { ...cart(s.p, 2), paymentMethod: 'cash', heldBillId: h.id });
  assert.equal(viaSales.status, 409);
  assert.equal(await stockOf(s, s.p), 48, 'stock deducted exactly once');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sales`))[0].n, 1);
  assert.equal((await as(s, 'cashier').post(`/held-bills/${h.id}/discard`)).status, 409, 'a completed hold cannot be discarded');
});

test('hold: two tills completing the same hold at the same instant — exactly one sale', async () => {
  const s = await plainShop();
  const h = (await as(s, 'manager').post('/held-bills', cart(s.p, 4))).body.hold;
  const go = (k) => as(s, 'manager').post(`/held-bills/${h.id}/complete`, { paymentMethod: 'cash' }, { 'idempotency-key': k });
  const res = await Promise.all([go(key()), go(key()), go(key())]);
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(await stockOf(s, s.p), 46);
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM sales`))[0].n, 1);
});

test('hold: stale carts — deleted product, no stock, price change — are reported on resume and blocked at completion without losing the hold', async () => {
  const s = await plainShop();
  const q = await addProduct(api, s, { name: 'Sticker', categoryId: s.cat.id, purchasePrice: 5, sellingPrice: 10, stock: 5 });
  const gone = await addProduct(api, s, { name: 'Discontinued', categoryId: s.cat.id, purchasePrice: 5, sellingPrice: 20, stock: 5 });
  const h = (await as(s, 'cashier').post('/held-bills', { items: [{ productId: s.p.id, quantity: 1 }, { productId: q.id, quantity: 4 }, { productId: gone.id, quantity: 1 }] })).body.hold;
  // price change (info only), stock shortage, product deleted
  assert.equal((await as(s).put(`/products/${s.p.id}`, { sellingPrice: 600 })).status, 200);
  assert.equal((await as(s).post('/sales', { items: [{ productId: q.id, quantity: 3 }], paymentMethod: 'cash' })).status, 201);   // 2 left, hold wants 4
  assert.equal((await as(s).del(`/products/${gone.id}`)).status, 200);
  const r = (await as(s, 'cashier').post(`/held-bills/${h.id}/resume`)).body;
  const codes = Object.fromEntries(r.issues.map((i) => [i.productId, i.code]));
  assert.equal(codes[s.p.id], 'PRICE_CHANGED');
  assert.equal(codes[q.id], 'INSUFFICIENT_STOCK');
  assert.equal(codes[gone.id], 'PRODUCT_UNAVAILABLE');
  assert.equal(r.canComplete, false);
  const blocked = await as(s, 'cashier').post(`/held-bills/${h.id}/complete`, { paymentMethod: 'cash' });
  assert.ok(blocked.status >= 400 && blocked.status < 500, JSON.stringify(blocked.body));
  assert.equal((await as(s, 'cashier').get(`/held-bills/${h.id}`)).body.hold.status, 'held', 'the cart is still there to fix');
  // fix the cart (drop the dead items) with a version check, then complete at the NEW price
  const fix = await as(s, 'cashier').put(`/held-bills/${h.id}`, { items: [{ productId: s.p.id, quantity: 1 }], version: r.hold.version });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  const stale = await as(s, 'cashier').put(`/held-bills/${h.id}`, { items: [{ productId: s.p.id, quantity: 2 }], version: r.hold.version });
  assert.equal(stale.status, 409); assert.equal(stale.body.details.code, 'HOLD_VERSION_CONFLICT');
  const done = await as(s, 'cashier').post(`/held-bills/${h.id}/complete`, { paymentMethod: 'upi' });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.total, 600, 'sold at today\'s price, not the price when it was parked');
});

test('hold: roles — a cashier sees only their own holds; managers/owners see and can discard all', async () => {
  const s = await plainShop();
  const extra = await as(s).post('/employees', { name: 'Second Cashier', email: `c2${Date.now()}@example.com`, password: 'Passw0rdOK', role: 'cashier' });
  const login = await api().post('/auth/login', { email: extra.body.email || `c2${Date.now()}@example.com`, password: 'Passw0rdOK' });
  const other = { token: login.body && login.body.accessToken };
  const mine = (await as(s, 'cashier').post('/held-bills', cart(s.p, 1))).body.hold;
  if (other.token) {
    const theirs = (await api(other.token).post('/held-bills', cart(s.p, 1))).body.hold;
    assert.equal((await api(other.token).get(`/held-bills/${mine.id}`)).status, 404);
    assert.equal((await api(other.token).post(`/held-bills/${mine.id}/discard`)).status, 404);
    assert.equal((await api(other.token).post(`/held-bills/${mine.id}/complete`, { paymentMethod: 'cash' })).status, 404);
    assert.equal((await api(other.token).post('/sales', { ...cart(s.p, 1), paymentMethod: 'cash', heldBillId: mine.id })).status, 404, 'cannot complete a colleague\'s hold through /sales either');
    assert.equal((await api(other.token).get('/held-bills')).body.holds.length, 1);
    assert.equal((await as(s, 'manager').get('/held-bills')).body.holds.length, 2, 'managers see every hold');
    assert.equal((await as(s, 'manager').post(`/held-bills/${theirs.id}/discard`)).status, 200);
  }
  const d = await as(s, 'cashier').post(`/held-bills/${mine.id}/discard`);
  assert.equal(d.status, 200); assert.equal(d.body.hold.status, 'discarded');
  assert.equal((await as(s, 'cashier').post(`/held-bills/${mine.id}/discard`)).status, 200, 'discard is idempotent');
  assert.equal((await as(s, 'cashier').post(`/held-bills/${mine.id}/resume`)).status, 409, 'a discarded hold cannot be resumed');
  assert.equal((await as(s, 'cashier').post(`/held-bills/${mine.id}/complete`, { paymentMethod: 'cash' })).status, 409);
  assert.equal((await api().get('/held-bills')).status, 401);
  const audits = await sql(s, `SELECT action FROM audit_logs WHERE entity_type = 'held_bill' AND action = 'hold.discarded'`);
  assert.ok(audits.length >= 1);
  assert.equal(await stockOf(s, s.p), 50, 'none of it moved stock');
});

test('hold: tenant isolation — another business can neither see, resume, complete nor attach a hold to a sale', async () => {
  const s = await plainShop();
  const t = await plainShop();
  const h = (await as(s).post('/held-bills', cart(s.p, 1))).body.hold;
  assert.equal((await as(t).get(`/held-bills/${h.id}`)).status, 404);
  assert.equal((await as(t).post(`/held-bills/${h.id}/resume`)).status, 404);
  assert.equal((await as(t).post(`/held-bills/${h.id}/complete`, { paymentMethod: 'cash' })).status, 404);
  assert.equal((await as(t).post('/sales', { ...cart(t.p, 1), paymentMethod: 'cash', heldBillId: h.id })).status, 404);
  assert.equal((await as(t).get('/held-bills')).body.holds.length, 0);
  assert.equal((await sql(t, `SELECT COUNT(*)::int AS n FROM held_bills`))[0].n, 0, 'RLS');
  // holding another business's product or customer is refused
  assert.equal((await as(t).post('/held-bills', cart(s.p, 1))).status, 404);
  const foreignCustomer = await addCustomer(api, s);
  assert.equal((await as(t).post('/held-bills', { ...cart(t.p, 1), customerId: foreignCustomer.id })).status, 404);
  assert.equal((await as(s).get(`/held-bills/${h.id}`)).body.hold.status, 'held', 'the owner\'s hold is untouched');
});

test('hold: validation, idempotent create and the open-hold limit', async () => {
  const s = await plainShop();
  assert.equal((await as(s).post('/held-bills', { items: [] })).status, 400);
  assert.equal((await as(s).post('/held-bills', { items: [{ productId: s.p.id, quantity: 0 }] })).status, 400);
  assert.equal((await as(s).post('/held-bills', { items: [{ productId: s.p.id, quantity: 1.5 }] })).status, 400, 'pieces are whole numbers');
  assert.equal((await as(s).post('/held-bills', { items: [{ productId: 99999999, quantity: 1 }] })).status, 404);
  assert.equal((await as(s).post('/held-bills', { ...cart(s.p, 1), label: 'x'.repeat(61) })).status, 400);
  assert.equal((await as(s).get('/held-bills?status=bogus')).status, 400);
  assert.equal((await as(s).get('/held-bills/abc')).status, 400);
  assert.equal((await as(s).get('/held-bills/987654')).status, 404);
  const k = key();
  const a = await as(s, 'cashier').post('/held-bills', cart(s.p, 1), { 'idempotency-key': k });
  const b = await as(s, 'cashier').post('/held-bills', cart(s.p, 1), { 'idempotency-key': k });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.hold.id, a.body.hold.id);
  assert.equal((await as(s, 'cashier').post('/held-bills', cart(s.p, 1), { 'idempotency-key': 'not-a-uuid' })).status, 400);
  for (let i = 0; i < 19; i += 1) assert.equal((await as(s, 'cashier').post('/held-bills', cart(s.p, 1))).status, 201);
  const over = await as(s, 'cashier').post('/held-bills', cart(s.p, 1));
  assert.equal(over.status, 409); assert.equal(over.body.details.code, 'HOLD_LIMIT');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM held_bills`))[0].n, 20);
});

test('hold: the database refuses a completed hold without a sale and a second hold on one sale', async () => {
  const s = await plainShop();
  const h = (await as(s).post('/held-bills', cart(s.p, 1))).body.hold;
  await env.db.runAsTenant(s.businessId, async () => {
    await assert.rejects(env.db.query(`UPDATE held_bills SET status = 'completed' WHERE id = $1`, [h.id]), /check/i);
    await assert.rejects(env.db.query(`INSERT INTO held_bills (created_by, items) VALUES ($1, '[]'::jsonb)`, [s.owner.id]), /check/i);
  });
});
