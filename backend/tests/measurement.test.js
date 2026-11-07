// Sprint 5 — measurement & value: decisions, outcomes, value ledger, accuracy, store health, ROI.
// Every figure is deterministic and computed by hand. Verified value must only ever come from the shop's own records.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer, sell, daysAgoIso } = require('./sprint-helpers');

let env; let api; let B;
test.before(async () => { env = await boot(); api = client(env.base); B = await makeShop(api); });
test.after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const get = async (s, path, who = 'owner') => { const r = await as(s, who).get(path); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body; };
const code = (r) => r.body && r.body.details && r.body.details.code;
async function taxed(s, rate = 5) { return (await as(s).post('/categories', { name: uniq('Tax '), taxRate: rate })).body; }
const backdateSale = (s, saleId, days) => sql(s, `UPDATE sales SET created_at = created_at - ($2::int * interval '1 day') WHERE id = $1`, [saleId, days]);
const backdateProduct = (s, id, days) => sql(s, `UPDATE products SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`, [id, days]);
/** Test-only: the table owner (never the app role) moves a decision back in time so the measurement windows can be exercised. */
async function ownerSql(table, text, params) {
  const c = new Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
  await c.connect();
  try { await c.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`); return (await c.query(text, params)).rows; } finally { await c.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`); await c.end(); }
}
const decide = (s, actionId, decision = 'accepted', reason, who = 'owner') => as(s, who).post('/measurement/decisions', { actionId, decision, ...(reason ? { reason } : {}) });
const evaluate = async (s) => { const r = await as(s).post('/measurement/evaluate'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const ledger = (s, q = '') => get(s, `/measurement/value-ledger${q}`);

/** A shop with a critical stock-out, 100-day-old udhaar, dead stock and expired stock — every kind of recommendation the measurement can track. */
async function actionShop() {
  const s = await makeShop(api);
  const o = as(s);
  const tail = (await taxed(s, 5)).id;
  const mk = (over) => addProduct(api, s, { categoryId: tail, minimumStock: 5, ...over });
  const fast = await mk({ name: 'Fast seller', purchasePrice: 20, sellingPrice: 30, stock: 40 });
  const sup = (await o.post('/suppliers', { name: 'Main Supplier', leadTimeDays: 3, paymentTermsDays: 0, minOrderValue: 0 })).body;
  await o.put(`/suppliers/${sup.id}/products/${fast.id}`, { isPreferred: true, lastCost: 20 });
  for (const d of [1, 2, 3, 4]) { const r = (await sell(api, s, fast.id, { quantity: 5 })).body; await backdateSale(s, r.id, d); }
  assert.equal((await sell(api, s, fast.id, { quantity: 20 })).status, 201);
  const milk = await mk({ name: 'Old milk', purchasePrice: 25, sellingPrice: 40, stock: 8 });
  await sql(s, `UPDATE products SET expiry_date = current_date - 2 WHERE id = $1`, [milk.id]);
  const dust = await mk({ name: 'Dusty', purchasePrice: 100, sellingPrice: 150, stock: 6 }); await backdateProduct(s, dust.id, 300);
  const cust = await addCustomer(api, s);
  await sql(s, `INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, note, created_at) VALUES ($1,'adjustment',1,750,'old notebook', now() - interval '100 days')`, [cust.id]);
  await as(s).put(`/credit/customers/${cust.id}/limit`, { creditLimit: 5000 });
  return { s, fast, milk, dust, cust, tail };
}
const pay = (s, custId, amount) => as(s).post(`/credit/customers/${custId}/payments`, { amount, method: 'cash' });

// ---------------------------------------------------------------- access, validation, isolation
test('measurement: owner and manager only; cashiers and anonymous callers are refused everywhere; corrections are owner-only', async () => {
  const s = await makeShop(api);
  for (const p of ['/measurement/decisions', '/measurement/accuracy', '/measurement/store-health', '/measurement/roi', '/measurement/value-ledger']) {
    assert.equal((await api(s.cashier.token).get(p)).status, 403, p);
    assert.equal((await api().get(p)).status, 401, p);
    assert.equal((await as(s, 'manager').get(p)).status, 200, p);
    assert.equal((await as(s).get(p)).status, 200, p);
  }
  assert.equal((await api(s.cashier.token).post('/measurement/decisions', { actionId: 'x', decision: 'accepted' })).status, 403);
  assert.equal((await api(s.cashier.token).post('/measurement/evaluate')).status, 403);
  assert.equal((await api(s.cashier.token).post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: 10, explanation: 'ten characters long' })).status, 403);
  assert.equal((await as(s, 'manager').post('/measurement/value-ledger/1/correct', { note: 'because' })).status, 403, 'manager cannot reverse value');
});

test('input validation: bad decisions, empty ids, bad ranges, unknown recommendations', async () => {
  const s = await makeShop(api);
  assert.equal((await decide(s, 'udhaar:1', 'maybe')).status, 400);
  assert.equal((await as(s).post('/measurement/decisions', { decision: 'accepted' })).status, 400);
  assert.equal((await as(s).post('/measurement/decisions', { actionId: '  ', decision: 'accepted' })).status, 400);
  assert.equal((await as(s).get('/measurement/roi?days=3')).status, 400);
  assert.equal((await as(s).get('/measurement/accuracy?days=9999')).status, 400);
  assert.equal((await as(s).get('/measurement/value-ledger?verification=fake')).status, 400);
  const r = await decide(s, 'udhaar:999999', 'accepted');
  assert.equal(r.status, 404); assert.equal(code(r), 'ACTION_NOT_FOUND', 'a client cannot invent a recommendation');
  assert.equal((await as(s).get('/measurement/decisions/abc')).status, 400);
  assert.equal((await as(s).get('/measurement/decisions/999999')).status, 404);
});

// ---------------------------------------------------------------- accept / reject / duplicates
test('accepting freezes the recommendation as shown; rejecting records the reason; neither claims any value', async () => {
  const { s, cust, milk } = await actionShop();
  const key = `udhaar:${cust.id}`;
  const live = (await get(s, '/intelligence/actions')).actions.find((a) => a.id === key);
  const a = await decide(s, key, 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.duplicate, false);
  const d = a.body.decision;
  assert.deepEqual([d.decision, d.actionKey, d.category, d.type, d.severity], ['accepted', key, 'money', 'overdue_credit', 'high']);
  assert.equal(d.recommendation.title, live.title); assert.equal(d.recommendation.amount, 750); assert.deepEqual(d.recommendation.why, live.why);
  assert.equal(d.baseline.balance, 750); assert.equal(d.baseline.kind, 'udhaar');
  assert.equal(d.decidedBy.name, 'Owner One');
  assert.equal(d.outcome.status, 'pending'); assert.equal(d.outcome.label, 'Pending measurement'); assert.equal(d.outcome.measuredAmount, null);
  // accepting is not saving: nothing in the ledger, no verified value anywhere
  assert.equal((await ledger(s)).total, 0);
  const roi = await get(s, '/measurement/roi');
  assert.equal(roi.value.verifiedTotal, 0); assert.equal(roi.answer.verdict, 'pending'); assert.match(roi.answer.text, /No value is claimed yet/);

  // a manager can reject, with a reason; a rejection is never measured
  const r = await decide(s, `expiry:${milk.id}`, 'rejected', 'Already returned to supplier', 'manager');
  assert.equal(r.status, 201); assert.equal(r.body.decision.reason, 'Already returned to supplier'); assert.equal(r.body.decision.outcome, null);
  assert.equal(r.body.decision.decidedBy.name, 'manager person');
  const dfr = await decide(s, 'dead-stock', 'deferred'); assert.equal(dfr.status, 201); assert.equal(dfr.body.decision.decision, 'deferred');
  await evaluate(s);
  assert.equal((await as(s).get(`/measurement/decisions/${r.body.decision.id}`)).body.outcomeHistory.length, 0);
  assert.equal((await ledger(s)).total, 0);
});

test('duplicate submissions return the existing decision; a changed mind adds a row and never edits the old one', async () => {
  const { s, cust } = await actionShop();
  const key = `udhaar:${cust.id}`;
  const a1 = await decide(s, key, 'accepted'); const a2 = await decide(s, key, 'accepted'); const a3 = await decide(s, key, 'accepted');
  assert.equal(a1.status, 201); assert.equal(a2.status, 200); assert.equal(a2.body.duplicate, true);
  assert.equal(a2.body.decision.id, a1.body.decision.id); assert.equal(a3.body.decision.id, a1.body.decision.id);
  // the same click twice at the same time still makes one row
  const [p, q] = await Promise.all([decide(s, `expiry:${(await get(s, '/intelligence/actions')).actions.find((x) => x.type === 'expiry').id.split(':')[1]}`, 'accepted'), null]);
  void p; void q;
  const race = (await get(s, '/intelligence/actions')).actions.find((x) => x.type === 'reorder').id;
  const rs = await Promise.all([decide(s, race, 'accepted'), decide(s, race, 'accepted'), decide(s, race, 'accepted')]);
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 200, 201]);
  assert.equal(new Set(rs.map((x) => x.body.decision.id)).size, 1);
  const rows = await sql(s, 'SELECT COUNT(*)::int AS n FROM action_decisions WHERE action_key = $1', [race]); assert.equal(rows[0].n, 1);

  // changed mind: a NEW row; the accepted one is untouched and still carries the original recommendation
  const rej = await decide(s, key, 'rejected', 'Customer is family');
  assert.equal(rej.status, 201); assert.notEqual(rej.body.decision.id, a1.body.decision.id);
  const all = await get(s, `/measurement/decisions?limit=100`);
  assert.equal(all.rows.filter((x) => x.actionKey === key).length, 2);
  const latest = await get(s, '/measurement/decisions?latest=true&limit=100');
  assert.equal(latest.rows.filter((x) => x.actionKey === key).length, 1); assert.equal(latest.rows.find((x) => x.actionKey === key).decision, 'rejected');
  const original = (await get(s, `/measurement/decisions/${a1.body.decision.id}`));
  assert.equal(original.decision, 'accepted'); assert.equal(original.recommendation.amount, 750); assert.equal(original.reason, null);
  // filters + paging
  assert.ok((await get(s, '/measurement/decisions?decision=rejected')).rows.every((x) => x.decision === 'rejected'));
  assert.ok((await get(s, '/measurement/decisions?category=money')).rows.every((x) => x.category === 'money'));
  assert.equal((await get(s, '/measurement/decisions?limit=1')).rows.length, 1);
});

// ---------------------------------------------------------------- outcomes + value
test('overdue credit: value is only what the udhaar ledger shows was collected AFTER accepting, capped at what was owed; re-running changes nothing', async () => {
  const { s, cust } = await actionShop();
  assert.equal((await pay(s, cust.id, 100)).status, 201);          // paid BEFORE accepting: must not count
  const key = `udhaar:${cust.id}`;
  const a = await decide(s, key, 'accepted');
  assert.equal(a.body.decision.baseline.balance, 650);
  assert.equal((await evaluate(s)).newLedgerEntries, 0); assert.equal((await ledger(s)).total, 0);

  assert.equal((await pay(s, cust.id, 300)).status, 201);
  const e1 = await evaluate(s);
  assert.deepEqual([e1.evaluated, e1.newOutcomes, e1.newLedgerEntries, e1.failed.length], [1, 1, 1, 0]);
  let L = await ledger(s); assert.equal(L.total, 1);
  const first = L.rows[0];
  assert.deepEqual([first.type, first.verification, first.effect, first.amount, first.valueType, first.date], ['measured', 'verified', 1, 300, 'recovered_credit', daysAgoIso(0)]);
  assert.equal(first.decisionId, a.body.decision.id); assert.ok(first.outcomeId); assert.equal(first.reference.type, 'credit_ledger'); assert.match(first.explanation, /collected/);
  const dec = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.deepEqual([dec.outcome.status, dec.outcome.label, dec.outcome.measuredAmount, dec.outcome.acted], ['verified', 'Verified outcome', 300, true]);

  const e2 = await evaluate(s);                                      // idempotent: nothing new
  assert.deepEqual([e2.newOutcomes, e2.newLedgerEntries], [0, 0]); assert.equal((await ledger(s)).total, 1);

  assert.equal((await pay(s, cust.id, 350)).status, 201);            // the rest of the 650 owed at decision time
  const e3 = await evaluate(s); assert.deepEqual([e3.newOutcomes, e3.newLedgerEntries], [1, 1]);
  L = await ledger(s); assert.equal(L.total, 2);
  assert.deepEqual(L.rows.map((r) => r.amount), [350, 300], 'a delta entry, not an edit');
  const roi = await get(s, '/measurement/roi');
  assert.equal(roi.value.verifiedTotal, 650, '₹100 paid before accepting is not counted'); assert.equal(roi.answer.verdict, 'value_measured'); assert.match(roi.answer.text, /₹650/);
  assert.equal(roi.value.byType[0].valueType, 'recovered_credit'); assert.deepEqual(roi.value.byCategory, [{ category: 'money', total: 650 }]);
  assert.equal(roi.value.byMonth.length, 1); assert.equal(roi.value.byMonth[0].cumulativeVerified, 650);
  assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcomeHistory.length, 3, 'pending → ₹300 verified → ₹650 verified: history is kept');
});

test('overdue credit with no payment stays pending, then becomes "no change" after 30 days — never value', async () => {
  const { s, cust } = await actionShop();
  const a = await decide(s, `udhaar:${cust.id}`, 'accepted');
  assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcome.status, 'pending');
  await ownerSql('action_decisions', `UPDATE action_decisions SET decided_at = now() - interval '31 days' WHERE id = $1`, [a.body.decision.id]);
  await evaluate(s);
  const d = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.deepEqual([d.outcome.status, d.outcome.label, d.outcome.measuredAmount], ['neutral', 'No measurable change', null]);
  assert.equal((await ledger(s)).total, 0);
});

test('dead stock: value is the cost of the listed products that actually sold afterwards (units capped at the stock held then)', async () => {
  const { s, dust } = await actionShop();
  const a = await decide(s, 'dead-stock', 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.ok(a.body.decision.baseline.products.some((p) => p.productId === dust.id && p.stock === 6 && p.cost === 100));
  assert.equal(a.body.decision.outcome.status, 'pending');
  assert.equal((await sell(api, s, dust.id, { quantity: 2 })).status, 201);
  const refunded = (await sell(api, s, dust.id, { quantity: 1 })).body;
  assert.equal((await as(s).post(`/sales/${refunded.id}/refund`, {})).status, 200, 'a refunded sale is not a sale');
  await evaluate(s);
  const L = await ledger(s); assert.equal(L.total, 1);
  assert.deepEqual([L.rows[0].valueType, L.rows[0].amount, L.rows[0].verification], ['inventory_released', 200, 'verified']);
  assert.match((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcome.explanation, /not profit/);
});

test('stock-out: a verified stock outcome with NO ₹ value (lost sales cannot be measured); not restocked in 14 days is "did not work out"', async () => {
  const { s, fast, tail } = await actionShop();
  const key = `reorder:${fast.id}`;
  const a = await decide(s, key, 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.decision.baseline.stock, 0);
  assert.equal(a.body.decision.outcome.status, 'pending');
  await sql(s, `UPDATE products SET stock = 30 WHERE id = $1`, [fast.id]);
  await sql(s, `INSERT INTO inventory_movements (product_id, movement_type, quantity) VALUES ($1,'restock',30)`, [fast.id]);
  await evaluate(s);
  const d = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.deepEqual([d.outcome.status, d.outcome.measuredAmount, d.outcome.acted], ['verified', null, true]); assert.match(d.outcome.headline, /back in stock/);
  assert.equal((await ledger(s)).total, 0, 'verified outcome, but no rupee value is claimed');
  assert.equal((await get(s, '/measurement/roi')).value.verifiedTotal, 0);

  // a second recommendation that is never followed up
  const lone = await addProduct(api, s, { name: 'Lone', categoryId: tail, purchasePrice: 20, sellingPrice: 30, stock: 40, minimumStock: 5 });
  for (const dd of [1, 2, 3, 4]) { const r = (await sell(api, s, lone.id, { quantity: 5 })).body; await backdateSale(s, r.id, dd); }
  assert.equal((await sell(api, s, lone.id, { quantity: 20 })).status, 201); require('../src/utils/cache').invalidateAll();
  const b = await decide(s, `reorder:${lone.id}`, 'accepted');
  assert.equal(b.status, 201, JSON.stringify(b.body));
  await ownerSql('action_decisions', `UPDATE action_decisions SET decided_at = now() - interval '20 days' WHERE id = $1`, [b.body.decision.id]);
  await evaluate(s);
  const bo = await get(s, `/measurement/decisions/${b.body.decision.id}`);
  assert.deepEqual([bo.outcome.status, bo.outcome.label], ['unsuccessful', 'Did not work out'], JSON.stringify(bo.outcome));
  assert.equal((await ledger(s)).total, 0);
});

test('margin: extra profit is the realised profit on units sold after the price fix minus what the old margin would have earned; no sales yet = pending', async () => {
  const s = await makeShop(api);
  const tail = (await taxed(s, 5)).id;
  const p = await addProduct(api, s, { name: 'Loss leader', categoryId: tail, purchasePrice: 40, sellingPrice: 30, stock: 50, minimumStock: 0 });
  const key = `leak:below_cost:${p.id}`;
  const live = (await get(s, '/intelligence/actions')).actions.find((a) => a.id === key);
  assert.ok(live, 'below-cost price is on the Action Center'); assert.equal(live.category, 'profit');
  const a = await decide(s, key, 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.decision.baseline.marginPerUnit, -10);
  await evaluate(s); assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcome.status, 'pending');
  assert.equal((await as(s).put(`/products/${p.id}`, { sellingPrice: 60 })).status, 200);
  await evaluate(s);
  let d = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.equal(d.outcome.status, 'pending'); assert.match(d.outcome.headline, /no sales yet/); assert.equal(d.outcome.acted, true);
  assert.equal((await ledger(s)).total, 0, 'a better price is not value until units sell at it');
  assert.equal((await sell(api, s, p.id, { quantity: 3 })).status, 201);
  await evaluate(s);
  d = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.deepEqual([d.outcome.status, d.outcome.measuredAmount], ['verified', 90], 'realised ₹180 − ₹120 cost = ₹60 profit; old margin −₹10 × 3 = −₹30; gain ₹90');
  const L = await ledger(s); assert.deepEqual([L.rows[0].valueType, L.rows[0].amount], ['margin_improvement', 90]);
});

test('supplier cost: only deliveries invoiced below the cost at acceptance count, units × the difference', async () => {
  const s = await makeShop(api);
  const o = as(s);
  const sup = (await o.post('/suppliers', { name: 'Slow Traders', leadTimeDays: 3, paymentTermsDays: 0, minOrderValue: 0 })).body;
  const p = await addProduct(api, s, { name: 'Rice bag', purchasePrice: 40, sellingPrice: 60, stock: 0, minimumStock: 0 });
  await o.put(`/suppliers/${sup.id}/products/${p.id}`, { lastCost: 40, isPreferred: true });
  await o.put(`/suppliers/${sup.id}/products/${p.id}`, { lastCost: 44 });
  const receive = async (qty, cost) => {
    const c = (await o.post('/purchase-orders', { supplierId: sup.id, items: [{ productId: p.id, quantity: qty, unitCost: cost }] })).body;
    const placed = (await o.post(`/purchase-orders/${c.id}/order`, {})).body;
    assert.equal((await o.post(`/purchase-orders/${placed.id}/receive`, { items: [{ itemId: placed.items[0].id, quantity: qty }] })).status, 201);
  };
  await receive(10, 44);
  const key = `supplier:price_increase:${p.id}`;
  const live = (await get(s, '/intelligence/actions')).actions.find((a) => a.id === key);
  assert.ok(live, (await get(s, '/intelligence/actions')).actions.map((a) => a.id).join(', '));
  const a = await decide(s, key, 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const base = a.body.decision.baseline.cost; assert.ok(base > 40, `baseline cost ${base}`);
  await evaluate(s); assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcome.status, 'pending');
  await receive(10, 40);
  await evaluate(s);
  const d = await get(s, `/measurement/decisions/${a.body.decision.id}`);
  assert.deepEqual([d.outcome.status, d.outcome.measuredAmount], ['verified', 10 * (base - 40)]);
  const L = await ledger(s); assert.deepEqual([L.rows[0].valueType, L.rows[0].amount, L.rows[0].reference.type], ['cost_saving', 10 * (base - 40), 'goods_receipt_item']);
});

test('things that cannot be measured say so and never create value', async () => {
  const { s, milk } = await actionShop();
  const a = await decide(s, `expiry:${milk.id}`, 'accepted');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual([a.body.decision.outcome.status, a.body.decision.outcome.label], ['not_measurable', 'Not measurable']);
  assert.match(a.body.decision.outcome.explanation, /no value is claimed/);
  const more = (await get(s, '/intelligence/actions')).actions.find((x) => x.type === 'unreconciled_day');
  if (more) { const r = await decide(s, more.id, 'accepted'); assert.equal(r.body.decision.outcome.status, 'pending'); }
  await evaluate(s);
  assert.equal((await ledger(s)).total, 0);
});

// ---------------------------------------------------------------- the value ledger itself
test('value ledger is append-only at the database level: the app role can neither UPDATE nor DELETE, and verified value cannot be forged by SQL', async () => {
  const { s, cust } = await actionShop();
  await decide(s, `udhaar:${cust.id}`, 'accepted'); await pay(s, cust.id, 200); await evaluate(s);
  for (const t of ['value_ledger', 'action_decisions', 'action_outcomes', 'recommendation_log']) {
    await assert.rejects(() => sql(s, `UPDATE ${t} SET business_id = business_id`), /permission denied/, `${t} UPDATE`);
    assert.equal((await sql(s, `DELETE FROM ${t} RETURNING id`)).length, 0, `${t}: delete removes nothing outside demo businesses`);
    await assert.rejects(() => sql(s, `TRUNCATE ${t}`), /permission denied/, `${t} TRUNCATE`);
  }
  assert.equal((await ledger(s)).total, 1, 'still there');
  // a "measured / verified" row must reference a decision and an outcome; a typed-in verified amount is rejected by the database
  await assert.rejects(() => sql(s, `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, explanation) VALUES (current_date,'measured','verified',1,50000,'avoided_loss','saved ₹50,000')`), /check constraint/);
  await assert.rejects(() => sql(s, `INSERT INTO value_ledger (entry_date, entry_type, verification, effect, amount, value_type, explanation, created_by) VALUES (current_date,'reported','verified',1,50000,'avoided_loss','x', 1)`), /check constraint/);
});

test('user-reported value is stored apart and is never added to verified value', async () => {
  const s = await makeShop(api);
  const ok = await as(s, 'manager').post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: 50000, explanation: 'Supplier credit note for damaged goods', verification: 'verified', entryType: 'measured' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.verification, ok.body.type, ok.body.amount, ok.body.effect], ['reported', 'reported', 50000, 1], 'the request cannot ask for "verified"');
  assert.equal(ok.body.by, 'manager person');
  assert.equal((await as(s).post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: 100, explanation: 'short' })).status, 400, 'needs a real explanation');
  assert.equal((await as(s).post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: -5, explanation: 'negative amount here' })).status, 400);
  assert.equal((await as(s).post('/measurement/value-ledger/reported', { valueType: 'magic', amount: 5, explanation: 'unknown value type' })).status, 400);
  assert.equal((await as(s).post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: 5, explanation: 'bad decision link', decisionId: 424242 })).status, 404);
  const roi = await get(s, '/measurement/roi');
  assert.equal(roi.value.verifiedTotal, 0); assert.equal(roi.value.reportedTotal, 50000); assert.equal(roi.answer.verdict, 'no_actions_yet');
  assert.deepEqual(roi.value.byType, [], 'by-type shows verified value only');
  assert.equal((await get(s, '/measurement/value-ledger?verification=verified')).total, 0);
  assert.equal((await get(s, '/measurement/value-ledger?verification=reported')).total, 1);
});

test('corrections are new ledger rows: the owner reverses once, with a reason; the engine does not quietly put it back', async () => {
  const { s, cust } = await actionShop();
  const a = await decide(s, `udhaar:${cust.id}`, 'accepted'); await pay(s, cust.id, 300); await evaluate(s);
  const entry = (await ledger(s)).rows[0];
  assert.equal((await as(s).post(`/measurement/value-ledger/${entry.id}/correct`, { note: 'x' })).status, 400, 'a reason is required');
  const c = await as(s).post(`/measurement/value-ledger/${entry.id}/correct`, { note: 'Customer paid by returning goods, not cash' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.type, c.body.effect, c.body.amount, c.body.reversesId, c.body.verification], ['correction', -1, 300, entry.id, 'verified']);
  assert.equal((await as(s).post(`/measurement/value-ledger/${entry.id}/correct`, { note: 'again' })).status, 409);
  assert.equal(code(await as(s).post(`/measurement/value-ledger/${entry.id}/correct`, { note: 'again' })), 'ALREADY_CORRECTED');
  assert.equal(code(await as(s).post(`/measurement/value-ledger/${c.body.id}/correct`, { note: 'again' })), 'CANNOT_CORRECT_CORRECTION');
  assert.equal((await as(s).post('/measurement/value-ledger/999999/correct', { note: 'nothing here' })).status, 404);
  const L = await ledger(s); assert.equal(L.total, 2, 'original row still exists'); assert.ok(L.rows.some((r) => r.id === entry.id && r.amount === 300));
  assert.equal((await get(s, '/measurement/roi')).value.verifiedTotal, 0);
  await pay(s, cust.id, 100); const e = await evaluate(s);
  assert.equal(e.newLedgerEntries, 0, 'a disputed value is not re-added'); assert.equal((await get(s, '/measurement/roi')).value.verifiedTotal, 0);
  assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).valueEntries.length, 2);
});

test('when records later support LESS than was counted, the engine adds a correction row rather than editing', async () => {
  const s = await makeShop(api);
  const tail = (await taxed(s, 5)).id;
  const p = await addProduct(api, s, { name: 'Dead tin', categoryId: tail, purchasePrice: 100, sellingPrice: 150, stock: 5, minimumStock: 0 }); await backdateProduct(s, p.id, 200);
  const a = await decide(s, 'dead-stock', 'accepted'); assert.equal(a.status, 201, JSON.stringify(a.body));
  const sale = (await sell(api, s, p.id, { quantity: 4 })).body;
  await evaluate(s); assert.equal((await get(s, '/measurement/roi')).value.verifiedTotal, 400);
  assert.equal((await as(s).post(`/sales/${sale.id}/refund`, {})).status, 200);
  const e = await evaluate(s); assert.equal(e.newLedgerEntries, 1);
  const L = await ledger(s); assert.equal(L.total, 2);
  assert.deepEqual([L.rows[0].type, L.rows[0].effect, L.rows[0].amount, L.rows[0].reversesId], ['correction', -1, 400, null]);
  assert.equal((await get(s, '/measurement/roi')).value.verifiedTotal, 0);
  void a;
});

// ---------------------------------------------------------------- accuracy
test('accuracy: counts are exact; rates appear only with enough data', async () => {
  const { s, fast, milk, cust } = await actionShop();
  const fresh = await get(s, '/measurement/accuracy');
  assert.deepEqual([fresh.generated, fresh.decided, fresh.acceptanceRate, fresh.successRate], [0, 0, null, null]);
  const list = (await get(s, '/intelligence/actions')).actions;        // viewing logs what was generated
  const again = (await get(s, '/intelligence/actions')).actions;
  const acc0 = await get(s, '/measurement/accuracy');
  assert.equal(acc0.generated, list.length); assert.equal(acc0.undecided, list.length); assert.equal(again.length, list.length, 'viewing twice does not double-count');
  assert.match(acc0.acceptanceInsufficient, /at least 5/); assert.match(acc0.successInsufficient, /at least 5/);

  const keys = [`udhaar:${cust.id}`, `reorder:${fast.id}`, `expiry:${milk.id}`, 'dead-stock', list.find((a) => a.type === 'unreconciled_day').id];
  assert.ok(keys.every((k) => list.some((a) => a.id === k)), list.map((a) => a.id).join(','));
  for (const k of keys.slice(0, 3)) assert.equal((await decide(s, k, 'accepted')).status, 201);
  for (const k of keys.slice(3)) assert.equal((await decide(s, k, 'rejected', 'not now')).status, 201);
  const acc = await get(s, '/measurement/accuracy');
  assert.deepEqual([acc.accepted, acc.rejected, acc.deferred, acc.decided, acc.undecided], [3, 2, 0, 5, list.length - 5]);
  assert.equal(acc.acceptanceRate, 60); assert.equal(acc.acceptanceInsufficient, null);
  assert.deepEqual([acc.outcomes.pending, acc.outcomes.notMeasurable, acc.outcomes.verified, acc.outcomes.resolved], [2, 1, 0, 0]);
  assert.equal(acc.successRate, null, 'no resolved outcomes: no percentage is invented'); assert.match(acc.successInsufficient, /have 0/);
  assert.equal(acc.byCategory.find((c) => c.category === 'money').accepted, 1);

  // success rate appears at 5 resolved outcomes: verified ÷ (verified + no change + did not work out)
  const more = [];
  for (let i = 0; i < 5; i += 1) { const p = await addProduct(api, s, { name: `Extra ${i}`, purchasePrice: 10, sellingPrice: 20, stock: 0, minimumStock: 5 }); more.push(p); }
  const ids = (await sql(s, 'SELECT id FROM action_decisions WHERE decision = $1 ORDER BY id', ['accepted'])).map((r) => r.id);
  const outcomes = ['verified', 'verified', 'verified', 'neutral', 'unsuccessful'];
  for (let i = 0; i < 3; i += 1) await ownerSql('action_outcomes', `INSERT INTO action_outcomes (business_id, decision_id, status, outcome_type, headline, explanation) VALUES ($1,$2,$3,'t','h','e')`, [s.businessId, ids[i], outcomes[i]]);
  assert.equal((await get(s, '/measurement/accuracy')).successRate, null, '3 resolved is still too few');
  const extra = [];
  for (let i = 3; i < 5; i += 1) { const r = await decide(s, (await get(s, '/intelligence/actions')).actions.find((a) => a.type === 'reorder' && !keys.includes(a.id) && !extra.includes(a.id)).id, 'accepted'); extra.push(r.body.decision.actionKey); await ownerSql('action_outcomes', `INSERT INTO action_outcomes (business_id, decision_id, status, outcome_type, headline, explanation) VALUES ($1,$2,$3,'t','h','e')`, [s.businessId, r.body.decision.id, outcomes[i]]); }
  const full = await get(s, '/measurement/accuracy');
  assert.equal(full.outcomes.resolved, 5); assert.equal(full.successRate, 60); assert.equal(full.successInsufficient, null);
  void more;
});

// ---------------------------------------------------------------- store health
test('store health: a new shop is "insufficient data", never a perfect score', async () => {
  const s = await makeShop(api);
  const h = await get(s, '/measurement/store-health');
  assert.equal(h.score, null); assert.equal(h.status, 'insufficient_data'); assert.match(h.summary, /at least 3/);
  assert.equal(h.dimensions.length, 6);
  assert.ok(h.excluded.length >= 5 && h.excluded.every((x) => x.reason));
  assert.match(h.method, /never scored as perfect/);
  const roi = await get(s, '/measurement/roi');
  assert.deepEqual([roi.answer.verdict, roi.funnel.generated, roi.funnel.accepted, roi.value.verifiedTotal, roi.value.byMonth.length, roi.rates.acceptanceRate, roi.rates.successRate], ['no_actions_yet', 0, 0, 0, 0, null, null]);
  assert.equal(roi.health.status, 'insufficient_data');
});

test('store health: every score is a weighted average of explained factors', async () => {
  const { s, cust } = await actionShop();
  const h = await get(s, '/measurement/store-health');
  assert.equal(typeof h.score, 'number'); assert.ok(['healthy', 'needs_attention', 'at_risk'].includes(h.status));
  const by = Object.fromEntries(h.dimensions.map((d) => [d.key, d]));
  const avail = h.dimensions.filter((d) => d.available);
  assert.equal(h.score, Math.round(avail.reduce((a, d) => a + d.score * d.weight, 0) / avail.reduce((a, d) => a + d.weight, 0)), 'overall = weighted average of available areas');
  for (const d of avail) { assert.ok(d.factors.length > 0, `${d.key} explains itself`); assert.equal(d.score, Math.max(0, 100 + d.factors.reduce((a, f) => a + f.impact, 0)) , `${d.key}: 100 minus the listed points`); }
  assert.equal(by.credit.score, 0); assert.match(by.credit.factors[0].label, /100% of udhaar owed/);
  assert.ok(by.inventory.factors.some((f) => /out of stock/.test(f.label) && f.impact === -5));
  assert.equal(by.followThrough.available, false); assert.match(by.followThrough.note, /at least 5/);
  assert.ok(h.excluded.some((x) => x.key === 'followThrough'));
  // fixing the problem moves the score up
  assert.equal((await pay(s, cust.id, 750)).status, 201);
  const after = await get(s, '/measurement/store-health');
  assert.equal(after.dimensions.find((d) => d.key === 'credit').available, false, 'no udhaar outstanding: left out, not scored 100');
});

test('partial failure: one broken data source is reported as a warning and the rest of the health view still works', async () => {
  const { s } = await actionShop();
  const credit = require('../src/services/credit'); const orig = credit.summary;
  credit.summary = async () => { throw new Error('boom'); };
  try {
    const h = await get(s, '/measurement/store-health');
    const c = h.dimensions.find((d) => d.key === 'credit');
    assert.deepEqual([c.available, c.score], [false, null]); assert.ok(h.warnings.some((w) => /overdue credit/i.test(w)));
    assert.equal(typeof h.score, 'number', 'other areas still produce a score');
    const roi = await get(s, '/measurement/roi'); assert.ok(roi.health);
  } finally { credit.summary = orig; }
});

test('partial failure: if one decision cannot be measured, the others still are and the failure is reported', async () => {
  const { s, cust, milk } = await actionShop();
  const a = await decide(s, `udhaar:${cust.id}`, 'accepted'); const b = await decide(s, 'dead-stock', 'accepted');
  void milk; await pay(s, cust.id, 100);
  const ev = require('../src/services/measurement/evaluators'); const orig = ev.evaluate;
  ev.evaluate = async (d) => { if (d.id === b.body.decision.id) throw new Error('boom'); return orig(d); };
  try {
    const r = await evaluate(s);
    assert.equal(r.failed.length, 1); assert.equal(r.failed[0].decisionId, b.body.decision.id); assert.equal(r.evaluated, 1);
    assert.equal((await get(s, `/measurement/decisions/${a.body.decision.id}`)).outcome.status, 'verified');
  } finally { ev.evaluate = orig; }
});

// ---------------------------------------------------------------- tenant isolation
test('tenant isolation: another business sees none of this and cannot touch it', async () => {
  const { s, cust } = await actionShop();
  const a = await decide(s, `udhaar:${cust.id}`, 'accepted'); await pay(s, cust.id, 200); await evaluate(s);
  const entry = (await ledger(s)).rows[0];
  for (const who of ['owner', 'manager']) {
    assert.equal((await get(B, '/measurement/decisions', who)).total, 0);
    assert.equal((await get(B, '/measurement/value-ledger', who)).total, 0);
    assert.equal((await as(B, who).get(`/measurement/decisions/${a.body.decision.id}`)).status, 404);
    assert.equal((await as(B, who).post(`/measurement/decisions/${a.body.decision.id}/evaluate`)).status, 404);
  }
  assert.equal((await as(B).post(`/measurement/value-ledger/${entry.id}/correct`, { note: 'not yours to touch' })).status, 404);
  assert.equal((await decide(B, `udhaar:${cust.id}`, 'accepted')).status, 404, 'cannot act on another business’s recommendation');
  assert.equal((await as(B).post('/measurement/value-ledger/reported', { valueType: 'avoided_loss', amount: 5, explanation: 'links to a foreign decision', decisionId: a.body.decision.id })).status, 404);
  const roiB = await get(B, '/measurement/roi'); assert.equal(roiB.value.verifiedTotal, 0); assert.equal(roiB.funnel.accepted, 0);
  assert.equal((await ledger(s)).rows[0].amount, 200, 'untouched');
  // and at the database level: B's tenant context sees zero rows in every new table
  for (const t of ['recommendation_log', 'action_decisions', 'action_outcomes', 'value_ledger']) assert.equal((await sql(B, `SELECT 1 FROM ${t} WHERE business_id <> current_business_id()`)).length, 0, t);
  await assert.rejects(() => sql(B, `INSERT INTO action_decisions (business_id, action_key, action_type, category, severity, decision, snapshot) VALUES ($1,'k','t','money','low','accepted','{}')`, [s.businessId]), /row-level security/);
});

test('the new tables are readable by the backup role and are covered by forced RLS', async () => {
  const rows = (await env.db.sysQuery(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT COUNT(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS n FROM pg_class c WHERE c.relname = ANY($1)`, [['recommendation_log', 'action_decisions', 'action_outcomes', 'value_ledger']])).rows;
  assert.equal(rows.length, 4); for (const r of rows) assert.ok(r.rls && r.forced && r.n >= 3, r.relname);
  const pol = (await env.db.sysQuery(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'backup_read' AND tablename = ANY($1)`, [['recommendation_log', 'action_decisions', 'action_outcomes', 'value_ledger']])).rows;
  assert.equal(pol.length, 4);
});
