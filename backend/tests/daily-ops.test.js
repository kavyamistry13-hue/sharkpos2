// Sprint 3 — udhaar (credit), aging, WhatsApp reminder links, cashier shifts, closing report, cash reconciliation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer, sell, todayIso, daysAgoIso } = require('./sprint-helpers');
const { computeAging, waPhone } = require('../src/services/credit');

let env; let api; let A; let B;
test.before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const audits = async (s, like) => (await sql(s, `SELECT action, summary FROM audit_logs WHERE action LIKE $1 ORDER BY id`, [like]));

/** A shop with one 5%-GST, tax-on-top product at ₹100 (cost ₹40) so every single-unit bill is ₹105. */
async function taxedShop() {
  const s = await makeShop(api);
  const cat = (await as(s).post('/categories', { name: 'Five percent', taxRate: 5 })).body;
  s.p = await addProduct(api, s, { name: 'Widget', categoryId: cat.id, purchasePrice: 40, sellingPrice: 100, stock: 500 });
  return s;
}
async function creditCustomer(s, limit = 1000) {
  const c = await addCustomer(api, s);
  assert.equal((await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: limit })).status, 200);
  return c;
}

// ---------------------------------------------------------------- aging (pure)
test('aging: payments clear the OLDEST charge first and what is left is bucketed by its age', () => {
  const e = (effect, amount, localDate, extra = {}) => ({ effect, amount, localDate, entryType: effect === 1 ? 'sale' : 'payment', ...extra });
  const a = computeAging([e(1, 100, '2026-06-01', { saleId: 1 }), e(1, 200, '2026-08-20', { saleId: 2 }), e(1, 50, '2026-10-25', { saleId: 3 }), e(-1, 120, '2026-10-26')], '2026-11-01');
  assert.equal(a.outstanding, 230);
  assert.deepEqual(a.buckets, { '0-30': 50, '31-60': 0, '61-90': 180, '90+': 0 }, '100 (June) fully paid, 20 of the August bill paid');
  assert.equal(a.oldestDays, 73); assert.equal(a.openCharges.length, 2); assert.equal(a.advance, 0);
});
test('aging: bucket edges, fully paid, advance (overpaid) and refunds that cancel their own sale', () => {
  const sale = (amount, d, id) => ({ effect: 1, amount, localDate: d, entryType: 'sale', saleId: id });
  const edge = computeAging([sale(10, '2026-10-02', 1), sale(10, '2026-10-01', 2), sale(10, '2026-08-02', 3), sale(10, '2026-08-01', 4), sale(10, '2026-07-02', 5), sale(10, '2026-07-01', 6)], '2026-11-01');
  // ages: 30, 31, 91?  compute explicitly
  assert.deepEqual(edge.openCharges.map((c) => c.ageDays), [30, 31, 91, 92, 122, 123]);
  assert.deepEqual(edge.buckets, { '0-30': 10, '31-60': 10, '61-90': 0, '90+': 40 }, '30 days is still current, 31 is the next bucket');
  const paid = computeAging([sale(80, '2026-01-01', 1), { effect: -1, amount: 80, localDate: '2026-02-01', entryType: 'payment' }], '2026-11-01');
  assert.deepEqual([paid.outstanding, paid.oldestDays, paid.openCharges.length], [0, null, 0]);
  const over = computeAging([sale(80, '2026-10-01', 1), { effect: -1, amount: 100, localDate: '2026-10-02', entryType: 'payment' }], '2026-11-01');
  assert.deepEqual([over.outstanding, over.advance], [0, 20]);
  // a refund removes the sale it belongs to, not the oldest bill
  const ref = computeAging([sale(100, '2026-05-01', 1), sale(60, '2026-10-20', 2), { effect: -1, amount: 60, localDate: '2026-10-21', entryType: 'refund', saleId: 2 }], '2026-11-01');
  assert.deepEqual([ref.outstanding, ref.buckets['90+'], ref.buckets['0-30']], [100, 100, 0]);
  assert.deepEqual(computeAging([], '2026-11-01'), { outstanding: 0, advance: 0, buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }, oldestDays: null, openCharges: [] });
});
test('aging: paise arithmetic has no floating-point drift', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ effect: 1, amount: 0.1 + i * 0.01, localDate: '2026-10-30', entryType: 'sale', saleId: i }));
  const total = entries.reduce((a, x) => a + Math.round(x.amount * 100), 0) / 100;
  assert.equal(computeAging(entries, '2026-11-01').outstanding, total);
});

// ---------------------------------------------------------------- credit sales and payments
test('credit sale: needs a customer, an enabled limit, and respects the limit; failures change nothing', async () => {
  const s = await taxedShop();
  const c = await addCustomer(api, s);
  const stock = async () => (await as(s).get(`/products/${s.p.id}`)).body.stock;
  assert.equal((await sell(api, s, s.p.id, { paymentMethod: 'credit' })).status, 400, 'no customer');
  const off = await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  assert.equal(off.status, 409); assert.equal(off.body.details.code, 'CREDIT_NOT_ENABLED');
  assert.equal((await api(s.cashier.token).put(`/credit/customers/${c.id}/limit`, { creditLimit: 500 })).status, 403, 'cashiers cannot grant credit');
  assert.equal((await as(s, 'manager').put(`/credit/customers/${c.id}/limit`, { creditLimit: 250 })).status, 200);
  assert.equal(await stock(), 500, 'refused sales did not touch stock');

  const ok = await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id, who: 'cashier' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.paymentMethod, 'credit'); assert.equal(ok.body.total, 105);
  assert.equal((await api(s.cashier.token).get(`/credit/customers/${c.id}/balance`)).body.balance, 105);
  const two = await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  assert.equal(two.status, 201); // 210 ≤ 250
  const over = await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  assert.equal(over.status, 409); assert.equal(over.body.details.code, 'CREDIT_LIMIT_EXCEEDED'); assert.equal(over.body.details.available, 40);
  assert.equal(await stock(), 498, 'the refused third sale left no stock movement');
  assert.equal((await sql(s, 'SELECT COUNT(*)::int AS n FROM credit_ledger WHERE customer_id = $1', [c.id]))[0].n, 2);
  // a replayed credit sale (same idempotency key) does not charge the customer twice
  const key = '3f2b8c1e-5a5d-4c5e-9d57-0a1b2c3d4e5f';
  const c2 = await creditCustomer(s, 1000);
  const body = { items: [{ productId: s.p.id, quantity: 1 }], paymentMethod: 'credit', customerId: c2.id };
  assert.equal((await as(s).post('/sales', body, { 'Idempotency-Key': key })).status, 201);
  assert.equal((await as(s).post('/sales', body, { 'Idempotency-Key': key })).status, 200);
  assert.equal((await as(s).get(`/credit/customers/${c2.id}`)).body.balance, 105);
});

test('credit payments: partial, full, overpayment refused, cashier may collect, balance and history are exact', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s, 1000);
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id, quantity: 2 });          // 105 + 210 = 315
  const pay = (body, who = 'cashier') => as(s, who).post(`/credit/customers/${c.id}/payments`, body);
  assert.equal((await pay({ amount: 0, method: 'cash' })).status, 400);
  assert.equal((await pay({ amount: 10.123, method: 'cash' })).status, 400, 'paise only');
  assert.equal((await pay({ amount: 5, method: 'barter' })).status, 400);
  assert.equal((await pay({ amount: 316, method: 'cash' })).status, 409, 'cannot pay more than owed');
  const p1 = await pay({ amount: 100, method: 'upi', note: 'GPay' });
  assert.equal(p1.status, 201); assert.deepEqual([p1.body.balanceBefore, p1.body.balanceAfter], [315, 215]);
  assert.equal((await pay({ amount: 215.5, method: 'cash' })).status, 409);
  assert.equal((await pay({ amount: 215, method: 'cash' }, 'manager')).body.balanceAfter, 0);
  assert.equal((await pay({ amount: 1, method: 'cash' })).status, 409, 'nothing outstanding');
  const acct = (await as(s, 'manager').get(`/credit/customers/${c.id}`)).body;
  assert.equal(acct.balance, 0); assert.deepEqual(acct.history.map((h) => [h.type, h.amount]), [['payment', 215], ['payment', 100], ['sale', 210], ['sale', 105]]);
  assert.equal(acct.history[0].invoiceNo, null); assert.ok(acct.history[3].invoiceNo.startsWith('INV-'));
  assert.equal(acct.aging.outstanding, 0);
  assert.equal((await api(s.cashier.token).get(`/credit/customers/${c.id}`)).status, 403, 'full ledger is manager+');
  const a = await audits(s, 'credit.%');
  assert.deepEqual(a.map((x) => x.action), ['credit.limit_changed', 'credit.payment_received', 'credit.payment_received']);
});

test('refunding a credit sale reverses it on the ledger (even after part-payment → customer is in credit)', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  const sale = (await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id })).body;
  await as(s).post(`/credit/customers/${c.id}/payments`, { amount: 50, method: 'cash' });
  assert.equal((await as(s, 'manager').post(`/sales/${sale.id}/refund`)).status, 200);
  const acct = (await as(s).get(`/credit/customers/${c.id}`)).body;
  assert.equal(acct.balance, -50, 'customer paid 50 on a bill that was then refunded'); assert.equal(acct.available, 1050, 'their ₹50 credit adds to the limit');
  assert.equal(acct.aging.advance, 50); assert.equal(acct.aging.outstanding, 0);
  assert.equal((await as(s, 'manager').post(`/sales/${sale.id}/refund`)).status, 409, 'cannot refund twice');
  assert.equal((await sql(s, `SELECT COUNT(*)::int AS n FROM credit_ledger WHERE entry_type = 'refund'`))[0].n, 1);
  assert.equal((await as(s).get(`/credit/customers/${c.id}`)).body.history[0].type, 'refund');
  const dec = await as(s, 'manager').post(`/credit/customers/${c.id}/payments`, { amount: 10, method: 'cash' });
  assert.equal(dec.status, 409, 'no payment against a negative balance');
});

test('owner adjustments need a reason, are owner-only, cannot exceed the balance, and are audited', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  const adj = (b, who = 'owner') => as(s, who).post(`/credit/customers/${c.id}/adjustments`, b);
  assert.equal((await adj({ amount: 5, direction: 'decrease', note: 'write-off' }, 'manager')).status, 403);
  assert.equal((await adj({ amount: 5, direction: 'decrease' })).status, 400, 'reason is mandatory');
  assert.equal((await adj({ amount: 500, direction: 'decrease', note: 'too much' })).status, 409);
  const w = await adj({ amount: 5, direction: 'decrease', note: 'Rounded off at the till' });
  assert.deepEqual([w.status, w.body.balanceBefore, w.body.balanceAfter], [201, 105, 100]);
  assert.equal((await adj({ amount: 20, direction: 'increase', note: 'Missed bill from the notebook' })).body.balanceAfter, 120);
  assert.deepEqual((await audits(s, 'credit.adjusted')).length, 2);
});

test('ledger is tamper-proof at the database level and keeps its own rules', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  await env.db.runAsTenant(s.businessId, async () => {
    await assert.rejects(env.db.query('UPDATE credit_ledger SET amount = 1'), /permission denied/);
    assert.equal((await env.db.query('DELETE FROM credit_ledger')).rowCount, 0, 'a real business cannot delete ledger rows');
    await assert.rejects(env.db.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount) VALUES ($1,'sale',1,5)`, [c.id]), /check/i);
    await assert.rejects(env.db.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, payment_method) VALUES ($1,'payment',1,5,'cash')`, [c.id]), /check/i);
    await assert.rejects(env.db.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, note) VALUES ($1,'adjustment',1,-5,'x')`, [c.id]), /check/i);
    await assert.rejects(env.db.query(`INSERT INTO sales (employee_id, subtotal, discount, tax, total, payment_method) VALUES ($1,1,0,0,1,'credit')`, [s.owner.id]), /sales_credit_needs_customer_chk/);
    await assert.rejects(env.db.query(`INSERT INTO sales (employee_id, subtotal, discount, tax, total, payment_method) VALUES ($1,1,0,0,1,'cheque')`, [s.owner.id]), /sales_payment_method_chk/);
    await assert.rejects(env.db.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, sale_id) SELECT $1,'sale',1,5,sale_id FROM credit_ledger WHERE entry_type = 'sale' LIMIT 1`, [c.id]), /uq_credit_ledger_sale/, 'one ledger entry per sale');
  });
});

test('credit: tenant isolation (ids, balances, lists) and roles', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  for (const [m, path, body] of [['get', `/credit/customers/${c.id}`], ['get', `/credit/customers/${c.id}/balance`], ['get', `/credit/customers/${c.id}/reminder`], ['put', `/credit/customers/${c.id}/limit`, { creditLimit: 5 }], ['post', `/credit/customers/${c.id}/payments`, { amount: 1, method: 'cash' }], ['post', `/credit/customers/${c.id}/adjustments`, { amount: 1, direction: 'increase', note: 'xyz' }]]) {
    assert.equal((await as(B)[m](path, body)).status, 404, `${m} ${path}`);
  }
  assert.equal((await sell(api, B, (await addProduct(api, B, { stock: 5 })).id, { paymentMethod: 'credit', customerId: c.id })).status, 404, "cannot put a sale on another shop's customer");
  assert.ok(!(await as(B).get('/credit/customers')).body.rows.some((r) => r.customerId === c.id));
  assert.equal((await as(B).get('/credit/summary')).body.outstanding, 0);
  assert.equal((await as(s).get('/credit/summary')).body.outstanding, 105);
  for (const p of ['/credit/summary', '/credit/customers']) assert.equal((await api(s.cashier.token).get(p)).status, 403);
  assert.equal((await api().get('/credit/summary')).status, 401);
});

test('credit summary and aging from backdated ledger entries (integration)', async () => {
  const s = await taxedShop();
  const [c1, c2] = [await creditCustomer(s), await creditCustomer(s)];
  const add = (cid, effect, amount, daysAgo, type = 'adjustment', method = null) => sql(s,
    `INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, note, payment_method, created_at) VALUES ($1,$2,$3,$4,$5,$6, now() - ($7::int * interval '1 day'))`,
    [cid, type, effect, amount, type === 'adjustment' ? 'opening balance' : null, method, daysAgo]);
  await add(c1.id, 1, 100, 100); await add(c1.id, 1, 200, 45); await add(c1.id, 1, 50, 10); await add(c1.id, -1, 120, 5, 'payment', 'cash');
  await add(c2.id, 1, 80, 3);
  const sum = (await as(s).get('/credit/summary')).body;
  assert.equal(sum.outstanding, 310); assert.equal(sum.debtors, 2);
  assert.deepEqual(sum.aging, { '0-30': 130, '31-60': 180, '61-90': 0, '90+': 0 }, '100 (100 days) and 20 of the 45-day bill were paid');
  assert.deepEqual([sum.overdueCustomers, sum.overdueAmount], [1, 230]);
  assert.equal(sum.top[0].customerId, c1.id);
  const list = (await as(s).get('/credit/customers')).body.rows;
  assert.deepEqual(list.map((r) => r.customerId), [c1.id, c2.id], 'largest balance first');
  assert.equal(list[0].oldestDays, 45); assert.equal(list[0].overdue, false);
  const od = (await as(s).get('/credit/customers?overdueDays=30')).body.rows;
  assert.deepEqual(od.map((r) => r.customerId), [c1.id]); assert.equal(od[0].overdue, true);
  assert.equal((await as(s).get('/credit/customers?overdueDays=60')).body.rows.length, 0);
  assert.equal((await as(s).get(`/credit/customers?q=${encodeURIComponent(c2.name)}`)).body.rows.length, 1);
});

// ---------------------------------------------------------------- WhatsApp click-to-chat (free, nothing is sent)
test('WhatsApp reminder: builds a wa.me link and message, normalises phones, refuses bad cases, is audited', async () => {
  assert.equal(waPhone('98765 43210'), '919876543210'); assert.equal(waPhone('+91-98765-43210'), '919876543210'); assert.equal(waPhone('09876543210'), '919876543210'); assert.equal(waPhone('1234567'), null);
  const s = await taxedShop();
  const c = await creditCustomer(s);
  assert.equal((await as(s).get(`/credit/customers/${c.id}/reminder`)).status, 409, 'nothing outstanding yet');
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  const r = await as(s, 'manager').get(`/credit/customers/${c.id}/reminder`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, false); assert.equal(r.body.balance, 105);
  assert.match(r.body.link, /^https:\/\/wa\.me\/91\d{10}\?text=/);
  assert.ok(r.body.message.includes('₹105') && r.body.message.includes(c.name));
  assert.equal(decodeURIComponent(r.body.link.split('?text=')[1]), r.body.message);
  const hi = (await as(s).get(`/credit/customers/${c.id}/reminder?lang=hi`)).body;
  assert.ok(hi.message.includes('बकाया') && hi.message.includes('₹105'));
  assert.equal((await api(s.cashier.token).get(`/credit/customers/${c.id}/reminder`)).status, 403);
  assert.equal((await as(s).get(`/credit/customers/${c.id}/reminder?lang=fr`)).status, 400);
  const bad = await addCustomer(api, s, { phone: '1234567' });
  await as(s).put(`/credit/customers/${bad.id}/limit`, { creditLimit: 500 });
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: bad.id });
  assert.equal((await as(s).get(`/credit/customers/${bad.id}/reminder`)).body.details.code, 'INVALID_PHONE');
  assert.ok((await audits(s, 'credit.reminder_prepared')).length >= 2);
});

// ---------------------------------------------------------------- shifts
test('shift: opens with a float, tracks cash from sales, credit collections and refunds, closes with a variance, and the record is frozen', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  const cur0 = (await api(s.cashier.token).get('/shifts/current')).body;
  assert.equal(cur0.shift, null);
  assert.equal((await api(s.cashier.token).post('/shifts/open', { openingCash: -5 })).status, 400);
  const open = await api(s.cashier.token).post('/shifts/open', { openingCash: 500 });
  assert.equal(open.status, 201); assert.equal(open.body.status, 'open');
  assert.equal((await api(s.cashier.token).post('/shifts/open', { openingCash: 1 })).status, 409, 'one open shift per cashier');

  await sell(api, s, s.p.id, { who: 'cashier' });                                       // cash 105
  await sell(api, s, s.p.id, { who: 'cashier', quantity: 2, paymentMethod: 'upi' });    // upi 210
  await sell(api, s, s.p.id, { who: 'cashier', paymentMethod: 'credit', customerId: c.id });   // credit 105
  await sell(api, s, s.p.id, { who: 'owner' });                                         // somebody else's sale: not this cashier's drawer
  await api(s.cashier.token).post(`/credit/customers/${c.id}/payments`, { amount: 40, method: 'cash' });

  const cur = (await api(s.cashier.token).get('/shifts/current')).body.shift.summary;
  assert.deepEqual([cur.cashSales, cur.cashCreditPayments, cur.cashRefunds, cur.expectedCash], [105, 40, 0, 645]);
  assert.deepEqual([cur.sales.count, cur.sales.billedTotal, cur.creditGiven, cur.creditCollected], [3, 420, 105, 40]);
  assert.deepEqual(cur.payments.map((p) => [p.method, p.amount]), [['cash', 105], ['upi', 210], ['card', 0], ['credit', 105]]);

  const short = await api(s.cashier.token).post('/shifts/close', { countedCash: 640 });
  assert.equal(short.status, 400); assert.equal(short.body.details.code, 'VARIANCE_NEEDS_NOTE'); assert.equal(short.body.details.variance, -5);
  assert.equal((await api(s.cashier.token).post('/shifts/close', { countedCash: 640, notes: 'Gave ₹5 change from own pocket', handoverTo: s.cashier.id })).status, 400, 'cannot hand over to yourself');
  assert.equal((await api(s.cashier.token).post('/shifts/close', { countedCash: 640, notes: 'x', handoverTo: B.manager.id })).status, 400, "cannot hand over to another business's user");
  const closed = await api(s.cashier.token).post('/shifts/close', { countedCash: 640, notes: 'Gave ₹5 change from own pocket', handoverTo: s.manager.id, handoverNote: '₹200 float left in the drawer' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual([closed.body.status, closed.body.expectedCash, closed.body.countedCash, closed.body.variance], ['closed', 645, 640, -5]);
  assert.equal(closed.body.handoverTo.id, s.manager.id); assert.equal(closed.body.handoverNote, '₹200 float left in the drawer');
  assert.equal(closed.body.summary.sales.count, 3, 'summary frozen at close');

  await sell(api, s, s.p.id, { who: 'cashier' });   // later sales do not change the closed record
  assert.equal((await api(s.cashier.token).get(`/shifts/${open.body.id}`)).body.summary.sales.count, 3);
  assert.equal((await api(s.cashier.token).post('/shifts/close', { countedCash: 1 })).status, 404, 'no open shift any more');
  assert.equal((await as(s, 'manager').post(`/shifts/${open.body.id}/close`, { countedCash: 1, notes: 'x' })).status, 409, 'already closed');
  const rec = await sql(s, 'SELECT * FROM cash_reconciliations WHERE shift_id = $1', [open.body.id]);
  assert.equal(rec.length, 1); assert.deepEqual([rec[0].expected_cash, rec[0].actual_cash, rec[0].variance, rec[0].business_date], [645, 640, -5, todayIso()]);
  await env.db.runAsTenant(s.businessId, async () => {
    await assert.rejects(env.db.query(`UPDATE shifts SET counted_cash = 1000 WHERE id = $1`, [open.body.id]), /closed shift cannot be changed/);
    await assert.rejects(env.db.query(`UPDATE cash_reconciliations SET actual_cash = 1`), /permission denied/);
  });
  const next = (await api(s.cashier.token).get('/shifts/current')).body;
  assert.equal(next.suggestedOpeningCash, 640, 'next float defaults to what was counted');
  const a = (await audits(s, 'shift.%')).map((x) => x.action);
  assert.deepEqual(a, ['shift.opened', 'shift.closed']);
});

test('shift: refunds the cashier processes come out of their drawer; managers see everyone, cashiers only themselves', async () => {
  const s = await taxedShop();
  assert.equal((await as(s, 'manager').post('/shifts/open', { openingCash: 100 })).status, 201);
  await api(s.cashier.token).post('/shifts/open', { openingCash: 50 });
  const sale = (await sell(api, s, s.p.id, { who: 'manager' })).body;                     // +105 cash
  const sale2 = (await sell(api, s, s.p.id, { who: 'manager', paymentMethod: 'upi' })).body;
  assert.equal((await as(s, 'manager').post(`/sales/${sale.id}/refund`)).status, 200);        // −105 cash
  assert.equal((await as(s, 'manager').post(`/sales/${sale2.id}/refund`)).status, 200);       // upi refund: no cash movement
  const m = (await as(s, 'manager').get('/shifts/current')).body.shift.summary;
  assert.deepEqual([m.cashSales, m.cashRefunds, m.expectedCash, m.sales.refunds, m.sales.netSales], [105, 105, 100, 210, 0]);
  const list = (await as(s, 'manager').get('/shifts?status=open')).body;
  assert.equal(list.total, 2);
  const mine = (await api(s.cashier.token).get('/shifts')).body;
  assert.equal(mine.total, 1); assert.equal(mine.rows[0].cashierId, s.cashier.id);
  const managersShift = list.rows.find((r) => r.cashierId === s.manager.id);
  assert.equal((await api(s.cashier.token).get(`/shifts/${managersShift.id}`)).status, 404);
  assert.equal((await api(s.cashier.token).post(`/shifts/${managersShift.id}/close`, { countedCash: 0, notes: 'x' })).status, 404);
  assert.equal((await as(B).get(`/shifts/${managersShift.id}`)).status, 404, 'other business');
  assert.equal((await as(B, 'manager').get('/shifts')).body.total, 0);
  const closed = await as(s, 'owner').post(`/shifts/${managersShift.id}/close`, { countedCash: 100 });
  assert.equal(closed.status, 200); assert.equal(closed.body.closedBy, 'Owner One');
  assert.equal(closed.body.cashierId, s.manager.id);
});

// ---------------------------------------------------------------- closing report + reconciliation
test('closing report: every figure for a mixed day adds up (gross/net, discounts, tax, payment methods, refunds, credit, cash)', async () => {
  const s = await taxedShop();
  const c = await creditCustomer(s);
  const s1 = (await sell(api, s, s.p.id)).body;                                         // cash 105 (refunded below)
  await sell(api, s, s.p.id, { paymentMethod: 'upi' });                                 // 105
  await sell(api, s, s.p.id, { paymentMethod: 'card' });                                // 105
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });            // 105 on udhaar
  await sell(api, s, s.p.id, { discount: { type: 'amount', value: 10 } });              // cash: 100 − 10 + 4.50 tax = 94.50
  await as(s).post(`/credit/customers/${c.id}/payments`, { amount: 30, method: 'cash' });
  await as(s, 'manager').post(`/sales/${s1.id}/refund`);

  const r = (await as(s, 'manager').get('/reports/closing')).body;
  assert.equal(r.date, todayIso()); assert.equal(r.isToday, true);
  assert.deepEqual([r.sales.count, r.sales.grossSales, r.sales.discounts, r.sales.tax, r.sales.billedTotal], [5, 500, 10, 24.5, 514.5]);
  assert.deepEqual([r.sales.refunds, r.sales.refundCount, r.sales.netSales, r.sales.avgBill], [105, 1, 409.5, 102.9]);
  assert.deepEqual(r.payments.map((p) => [p.method, p.count, p.amount]), [['cash', 2, 199.5], ['upi', 1, 105], ['card', 1, 105], ['credit', 1, 105]]);
  assert.equal(r.payments.reduce((a, p) => a + p.amount, 0), r.sales.billedTotal);
  assert.deepEqual(r.refunds.byMethod, [{ method: 'cash', count: 1, amount: 105 }]);
  assert.deepEqual([r.credit.given, r.credit.collected, r.credit.outstandingTotal], [105, 30, 75]);
  assert.deepEqual([r.cash.openingCash, r.cash.cashSales, r.cash.cashCreditPayments, r.cash.cashRefunds, r.cash.netCashMovement, r.cash.expectedCash], [0, 199.5, 30, 105, 124.5, 124.5]);
  assert.equal(r.cash.reconciliation, null);
  assert.deepEqual([r.sales.unitsSold, r.sales.productsSold, r.sales.grossProfit], [4, 1, 230], 'refunded sale excluded; profit = taxable − snapshot cost');
  assert.equal(r.inventory.unitsSold, 4); assert.equal(r.inventory.stockValueNow, 40 * (500 - 4));
  assert.equal(r.topProducts[0].name, 'Widget'); assert.equal(r.cashiers[0].bills, 5);
  assert.equal((await api(s.cashier.token).get('/reports/closing')).status, 403);
  // the same day seen from another shop is empty
  const other = (await as(B).get('/reports/closing')).body;
  assert.deepEqual([other.sales.count, other.sales.billedTotal, other.credit.outstandingTotal], [0, 0, 0]);
});

test('cash reconciliation: expected is computed by the server; variance needs a note; corrections are new records; audited', async () => {
  const s = await taxedShop();
  await sell(api, s, s.p.id); await sell(api, s, s.p.id, { paymentMethod: 'upi' });       // cash 105 only
  const rec = (body, who = 'manager') => as(s, who).post('/reports/cash-reconciliations', body);
  assert.equal((await rec({ actualCash: 105 }, 'cashier')).status, 403);
  assert.equal((await rec({ actualCash: -1 })).status, 400);
  assert.equal((await rec({ actualCash: 100, expectedCash: 100 })).status, 400, 'a client-supplied expected cash is ignored');
  const needNote = await rec({ actualCash: 100 });
  assert.equal(needNote.status, 400); assert.equal(needNote.body.details.code, 'VARIANCE_NEEDS_NOTE'); assert.equal(needNote.body.details.expectedCash, 105);
  const exact = await rec({ actualCash: 105 });
  assert.equal(exact.status, 201); assert.deepEqual([exact.body.openingCash, exact.body.expectedCash, exact.body.variance, exact.body.breakdown.cashSales], [0, 105, 0, 105]);
  const short = await rec({ actualCash: 100, notes: 'Counted again: ₹5 short, customer short-changed' });
  assert.equal(short.body.variance, -5);
  const withOpening = await rec({ openingCash: 200, actualCash: 305 });
  assert.deepEqual([withOpening.body.openingCash, withOpening.body.expectedCash, withOpening.body.variance], [200, 305, 0]);
  const rep = (await as(s).get('/reports/closing')).body.cash;
  assert.equal(rep.reconciliation.id, withOpening.body.id, 'the latest record for the day wins'); assert.equal(rep.openingCash, 200); assert.equal(rep.openingIsSuggested, false);
  const list = (await as(s).get('/reports/cash-reconciliations')).body.rows;
  assert.equal(list.length, 3); assert.equal(list[2].id, exact.body.id, 'history is kept, newest first');
  assert.equal(list[0].reconciledBy, 'manager person');
  assert.equal((await rec({ date: '2999-01-01', actualCash: 1 })).status, 400, 'future date');
  assert.equal((await rec({ date: '2026-02-30', actualCash: 1 })).status, 400, 'impossible date');
  assert.equal((await as(s).get('/reports/closing?date=not-a-date')).status, 400);
  const a = await audits(s, 'cash.reconciled');
  assert.equal(a.length, 3); assert.ok(a[1].summary.includes('variance ₹-5'));
  assert.equal((await as(B).get('/reports/cash-reconciliations')).body.rows.length, 0);
});

test('closing report: a past day, an empty day, and the suggested opening cash carried from the previous count', async () => {
  const s = await taxedShop();
  const y = daysAgoIso(1);
  const r0 = (await as(s).get('/reports/closing')).body;            // brand-new day, nothing happened
  assert.deepEqual([r0.sales.count, r0.sales.netSales, r0.sales.avgBill, r0.cash.expectedCash, r0.topProducts.length, r0.shifts.length], [0, 0, 0, 0, 0, 0]);
  assert.equal(r0.payments.length, 4);
  const past = await as(s).post('/reports/cash-reconciliations', { date: y, actualCash: 750, notes: 'Opening float counted from the old notebook' });
  assert.equal(past.status, 201); assert.equal(past.body.date, y);
  const today = (await as(s).get('/reports/closing')).body.cash;
  assert.deepEqual([today.openingCash, today.openingIsSuggested, today.expectedCash], [750, true, 750]);
  await sell(api, s, s.p.id);
  assert.equal((await as(s).get('/reports/closing')).body.cash.expectedCash, 855);
  const yd = (await as(s).get(`/reports/closing?date=${y}`)).body;
  assert.deepEqual([yd.sales.count, yd.isToday, yd.cash.reconciliation.actualCash], [0, false, 750]);
});

test('daily-ops tables: forced RLS, tenant policies, backup role can read', async () => {
  const rows = (await env.db.sysQuery(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c WHERE c.relname = ANY($1)`, [['credit_ledger', 'shifts', 'cash_reconciliations']])).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.rls && r.forced));
  const pol = (await env.db.sysQuery(`SELECT tablename, policyname FROM pg_policies WHERE tablename = ANY($1)`, [['credit_ledger', 'shifts', 'cash_reconciliations']])).rows;
  for (const t of ['credit_ledger', 'shifts', 'cash_reconciliations']) assert.ok(pol.some((p) => p.tablename === t && p.policyname === 'backup_read'), t);
  const s = await taxedShop();
  const c = await creditCustomer(s);
  await sell(api, s, s.p.id, { paymentMethod: 'credit', customerId: c.id });
  await api(s.cashier.token).post('/shifts/open', { openingCash: 1 });
  await env.db.runAsTenant(B.businessId, async () => {
    for (const t of ['credit_ledger', 'shifts', 'cash_reconciliations']) assert.equal((await env.db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE business_id = $1`, [s.businessId])).rows[0].n, 0, `${t} leaks`);
    await assert.rejects(env.db.query(`INSERT INTO credit_ledger (business_id, customer_id, entry_type, effect, amount, note) VALUES ($1,$2,'adjustment',1,1,'x')`, [s.businessId, c.id]), /row-level security/);
  });
});
