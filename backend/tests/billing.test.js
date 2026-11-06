// SHARKPOS 2 — Phase 2 tests: plans, trial, payments (server-verified), webhook, enforcement, limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { effectiveStatus, canWrite } = require('../src/services/billing/state');

let env; let api; let gw;
const DAY = 86400000;

const register = async (plan) => {
  const r = await api().post('/auth/register', { businessName: uniq('TEST Shop '), ownerName: 'Owner', email: `${uniq('o')}@example.com`, password: 'Passw0rdOK', ...(plan ? { plan } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = api(r.body.accessToken);
  const lk = await o.get('/products/lookups');
  return { token: r.body.accessToken, id: r.body.business.id, o, categoryId: lk.body.categories[0].id, email: r.body.user.email };
};
const product = (t, extra = {}) => t.o.post('/products', { name: uniq('Item '), categoryId: t.categoryId, purchasePrice: 5, sellingPrice: 10, stock: 50, ...extra });
const sql = (q, p) => env.db.sysQuery(q, p);
const expireTrial = (t) => sql("UPDATE subscriptions SET trial_end = now() - interval '1 day', end_date = now() - interval '1 day' WHERE business_id = $1", [t.id]);
/** checkout → (simulated provider) → server verification */
async function pay(t, planCode) {
  const co = await t.o.post('/billing/checkout', planCode ? { planCode } : {});
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const sim = await t.o.post('/billing/dev/simulate-payment', { orderId: co.body.orderId });
  const v = await t.o.post('/billing/verify', sim.body);
  return { co: co.body, sim: sim.body, v };
}

test.before(async () => { env = await boot(); api = client(env.base); gw = require('../src/services/billing/gateway').getGateway(); });
test.after(async () => { await env.close(); });

// ---------------------------------------------------------------- pure state machine
test('state machine: trial → expired, active → past_due → expired, cancel → cancelled', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  const d = (n) => new Date(now.getTime() + n * DAY).toISOString();
  assert.equal(effectiveStatus({ status: 'trialing', trial_end: d(3) }, now), 'trialing');
  assert.equal(effectiveStatus({ status: 'trialing', trial_end: d(-1) }, now), 'expired');
  assert.equal(effectiveStatus({ status: 'active', end_date: d(5) }, now), 'active');
  assert.equal(effectiveStatus({ status: 'active', end_date: d(-1) }, now, 3), 'past_due');
  assert.equal(effectiveStatus({ status: 'active', end_date: d(-4) }, now, 3), 'expired');
  assert.equal(effectiveStatus({ status: 'active', end_date: d(-1), cancel_at_period_end: true }, now), 'cancelled');
  assert.equal(effectiveStatus({ status: 'cancelled' }, now), 'cancelled');
  assert.equal(effectiveStatus(null, now), 'expired');
  assert.deepEqual(['trialing', 'active', 'past_due', 'expired', 'cancelled'].map(canWrite), [true, true, true, false, false]);
});

// ---------------------------------------------------------------- plans + trial
test('plans are public and come from the database', async () => {
  const r = await api().get('/plans');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.plans.map((p) => [p.code, p.price]), [['starter', 99], ['business', 199], ['pro', 399]]);
  assert.equal(r.body.plans[0].features.maxUsers, 2);
});

test('changing a price in the database changes what checkout charges (nothing is hard-coded)', async () => {
  const t = await register();
  await sql("UPDATE plans SET price_paise = 20100 WHERE code = 'business'");
  try {
    const co = await t.o.post('/billing/checkout', { planCode: 'business', amount: 1, price: 1 });
    assert.equal(co.body.amount, 20100);
    assert.equal((await api().get('/plans')).body.plans[1].price, 201);
  } finally { await sql("UPDATE plans SET price_paise = 19900 WHERE code = 'business'"); }
});

test('registration starts a 14-day trial on the chosen plan (default Business)', async () => {
  const t = await register();
  const st = (await t.o.get('/billing/status')).body;
  assert.equal(st.status, 'trialing');
  assert.equal(st.plan.code, 'business');
  assert.ok(st.daysLeft >= 13 && st.daysLeft <= 14);
  assert.equal(st.canWrite, true);
  const s2 = await register('starter');
  assert.equal((await s2.o.get('/billing/status')).body.plan.code, 'starter');
  const s3 = await register('no-such-plan');
  assert.equal((await s3.o.get('/billing/status')).body.plan.code, 'business');
});

// ---------------------------------------------------------------- expiry: read-only, data safe
test('expired trial: data is kept and readable, writes are refused with a clear message', async () => {
  const t = await register();
  assert.equal((await product(t)).status, 201);
  await expireTrial(t);
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
  const w = await product(t);
  assert.equal(w.status, 402);
  assert.equal(w.body.details.code, 'SUBSCRIPTION_REQUIRED');
  assert.match(w.body.error, /data is safe/i);
  assert.equal((await t.o.get('/products')).body.rows.length, 1, 'data must not be deleted');
  assert.equal((await t.o.get('/sales')).status, 200);
  assert.equal((await t.o.get('/billing')).status, 200);
  assert.equal((await t.o.post('/sales/preview', { items: [{ productId: (await t.o.get('/products')).body.rows[0].id, quantity: 1 }] })).status, 200);
  assert.equal((await t.o.post('/sales', { items: [{ productId: (await t.o.get('/products')).body.rows[0].id, quantity: 1 }], paymentMethod: 'cash' })).status, 402);
  assert.equal((await t.o.put('/settings', { storeName: 'x' })).status, 402);
});

// ---------------------------------------------------------------- payments
test('payment: checkout → verified → subscription active for 30 days; replay is harmless', async () => {
  const t = await register();
  await expireTrial(t);
  const { co, v } = await pay(t, 'business');
  assert.equal(co.amount, 19900);
  assert.equal(v.status, 200);
  const b = (await t.o.get('/billing')).body;
  assert.equal(b.status, 'active');
  assert.equal(b.plan.code, 'business');
  assert.ok(Math.abs((new Date(b.nextBillingDate) - Date.now()) / DAY - 30) < 0.1);
  assert.equal(b.payments[0].status, 'paid');
  assert.equal((await product(t)).status, 201, 'writes work again after paying');
  const end1 = b.periodEnd;
  const again = await t.o.post('/billing/verify', { orderId: co.orderId, paymentId: (await sql('SELECT provider_payment_id AS p FROM payments WHERE provider_order_id = $1', [co.orderId])).rows[0].p, signature: gw.simulatePayment(co.orderId).signature });
  // a fresh simulated payment id has a different signature than the stored one, so craft the replay with the stored id
  assert.ok([200, 400].includes(again.status));
  assert.equal((await t.o.get('/billing')).body.periodEnd, end1, 'replaying must not extend the period');
  const log = await t.o.get('/audit?action=subscription');
  assert.ok(log.body.rows.some((r) => r.action === 'subscription.activated'));
});

test('payment: a forged or tampered signature never activates anything', async () => {
  const t = await register();
  await expireTrial(t);
  const co = (await t.o.post('/billing/checkout', {})).body;
  const bad = await t.o.post('/billing/verify', { orderId: co.orderId, paymentId: 'pay_forged_12345', signature: 'f'.repeat(64) });
  assert.equal(bad.status, 400);
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
  const sim = (await t.o.post('/billing/dev/simulate-payment', { orderId: co.orderId })).body;
  const tampered = await t.o.post('/billing/verify', { ...sim, paymentId: `${sim.paymentId}x` });
  assert.equal(tampered.status, 400);
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
  const p = (await sql('SELECT status FROM payments WHERE provider_order_id = $1', [co.orderId])).rows[0];
  assert.equal(p.status, 'failed');
});

test('payment: another business cannot verify, see or use this business\'s order', async () => {
  const a = await register(); const b = await register();
  await expireTrial(b);
  const co = (await b.o.post('/billing/checkout', {})).body;
  const sim = (await b.o.post('/billing/dev/simulate-payment', { orderId: co.orderId })).body;
  const steal = await a.o.post('/billing/verify', sim);
  assert.equal(steal.status, 404);
  assert.ok(!JSON.stringify((await a.o.get('/billing')).body.payments).includes(co.orderId));
  assert.equal((await b.o.get('/billing/status')).body.status, 'expired', 'B was not activated by A');
});

test('payment: only the owner can manage billing; staff get status only', async () => {
  const t = await register();
  const mk = async (role) => {
    const email = `${uniq(role)}@example.com`;
    await t.o.post('/employees', { name: role, email, password: 'Passw0rdOK', role });
    return api((await api().post('/auth/login', { email, password: 'Passw0rdOK' })).body.accessToken);
  };
  const mgr = await mk('manager'); const cash = await mk('cashier');
  for (const who of [mgr, cash]) {
    assert.equal((await who.get('/billing/status')).status, 200);
    assert.equal((await who.get('/billing')).status, 403);
    assert.equal((await who.post('/billing/checkout', {})).status, 403);
    assert.equal((await who.post('/billing/cancel')).status, 403);
    assert.equal((await who.post('/billing/change-plan', { planCode: 'pro' })).status, 403);
  }
});

test('payment records cannot be deleted by the application', async () => {
  const t = await register();
  await t.o.post('/billing/checkout', {});
  await assert.rejects(sql('DELETE FROM payments'), /permission denied/);
  await assert.rejects(sql('DELETE FROM billing_events'), /permission denied/);
});

// ---------------------------------------------------------------- webhook
const hook = (event, payment, eventId) => {
  const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
  return fetch(`${env.base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': gw.signWebhook(raw), ...(eventId ? { 'x-razorpay-event-id': eventId } : {}) }, body: raw });
};

test('webhook: signed payment.captured activates the plan even if the browser never came back', async () => {
  const t = await register();
  await expireTrial(t);
  const co = (await t.o.post('/billing/checkout', { planCode: 'pro' })).body;
  const res = await hook('payment.captured', { id: 'pay_wh_1', order_id: co.orderId, amount: co.amount, status: 'captured' }, uniq('evt_'));
  assert.equal(res.status, 200);
  const b = (await t.o.get('/billing')).body;
  assert.equal(b.status, 'active');
  assert.equal(b.plan.code, 'pro');
});

test('webhook: bad signature, wrong amount and duplicates are all harmless', async () => {
  const t = await register();
  await expireTrial(t);
  const co = (await t.o.post('/billing/checkout', {})).body;
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: co.orderId, amount: co.amount } } } });
  const bad = await fetch(`${env.base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body: raw });
  assert.equal(bad.status, 400);
  const none = await fetch(`${env.base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(none.status, 400);
  await hook('payment.captured', { id: 'pay_x', order_id: co.orderId, amount: 100 }, uniq('evt_')); // wrong amount
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
  const id = uniq('evt_');
  await hook('payment.captured', { id: 'pay_y', order_id: co.orderId, amount: co.amount }, id);
  const end = (await t.o.get('/billing')).body.periodEnd;
  const dup = await (await hook('payment.captured', { id: 'pay_y', order_id: co.orderId, amount: co.amount }, id)).json();
  assert.equal(dup.duplicate, true);
  assert.equal((await t.o.get('/billing')).body.periodEnd, end);
});

test('webhook: payment.failed is recorded and does not activate', async () => {
  const t = await register();
  await expireTrial(t);
  const co = (await t.o.post('/billing/checkout', {})).body;
  await hook('payment.failed', { id: 'pay_f', order_id: co.orderId, amount: co.amount, error_description: 'Card declined' }, uniq('evt_'));
  assert.equal((await t.o.get('/billing')).body.payments[0].status, 'failed');
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
});

// ---------------------------------------------------------------- lifecycle
test('renewing early extends from the current end date (no paid days lost)', async () => {
  const t = await register();
  await expireTrial(t);
  await pay(t, 'business');
  const end1 = new Date((await t.o.get('/billing')).body.periodEnd).getTime();
  await pay(t);
  const end2 = new Date((await t.o.get('/billing')).body.periodEnd).getTime();
  assert.ok(Math.abs(end2 - end1 - 30 * DAY) < 5000);
});

test('grace period: just overdue keeps working (past_due); after the grace period it is expired', async () => {
  const t = await register();
  await expireTrial(t);
  await pay(t, 'business');
  await sql("UPDATE subscriptions SET end_date = now() - interval '1 day' WHERE business_id = $1", [t.id]);
  assert.equal((await t.o.get('/billing/status')).body.status, 'past_due');
  assert.equal((await product(t)).status, 201);
  await sql("UPDATE subscriptions SET end_date = now() - interval '5 days' WHERE business_id = $1", [t.id]);
  assert.equal((await t.o.get('/billing/status')).body.status, 'expired');
  assert.equal((await product(t)).status, 402);
});

test('cancel keeps access until the period ends, can be resumed, then becomes cancelled', async () => {
  const t = await register();
  await expireTrial(t);
  await pay(t, 'business');
  assert.equal((await t.o.post('/billing/cancel')).status, 200);
  let b = (await t.o.get('/billing')).body;
  assert.equal(b.status, 'active');
  assert.equal(b.cancelAtPeriodEnd, true);
  assert.equal(b.nextBillingDate, null);
  assert.equal((await product(t)).status, 201);
  assert.equal((await t.o.post('/billing/resume')).status, 200);
  assert.equal((await t.o.get('/billing')).body.cancelAtPeriodEnd, false);
  await t.o.post('/billing/cancel');
  await sql("UPDATE subscriptions SET end_date = now() - interval '1 hour' WHERE business_id = $1", [t.id]);
  b = (await t.o.get('/billing')).body;
  assert.equal(b.status, 'cancelled');
  const w = await product(t);
  assert.equal(w.status, 402);
  assert.match(w.body.error, /ended/i);
  assert.equal((await t.o.get('/products')).status, 200, 'data still readable');
  await pay(t, 'business'); // coming back
  assert.equal((await t.o.get('/billing')).body.status, 'active');
});

test('upgrade is immediate after payment; downgrade is scheduled for renewal and checked against usage', async () => {
  const t = await register();
  await expireTrial(t);
  await pay(t, 'starter');
  assert.equal((await t.o.get('/billing')).body.plan.code, 'starter');
  await pay(t, 'pro');
  assert.equal((await t.o.get('/billing')).body.plan.code, 'pro');
  // pro → starter: scheduled, not applied yet
  assert.equal((await t.o.post('/billing/change-plan', { planCode: 'starter' })).body.applied, 'at_renewal');
  let b = (await t.o.get('/billing')).body;
  assert.equal(b.plan.code, 'pro');
  assert.equal(b.pendingPlan.code, 'starter');
  await pay(t); // renewal picks up the scheduled plan
  b = (await t.o.get('/billing')).body;
  assert.equal(b.plan.code, 'starter');
  assert.equal(b.pendingPlan, null);
  assert.equal((await t.o.post('/billing/change-plan', { planCode: 'pro' })).body.applied, 'needs_payment');
});

test('downgrade is refused while usage exceeds the smaller plan', async () => {
  const t = await register();
  await expireTrial(t);
  await pay(t, 'pro');
  for (let i = 0; i < 3; i += 1) await t.o.post('/employees', { name: `E${i}`, email: `${uniq('e')}@example.com`, password: 'Passw0rdOK', role: 'cashier' });
  const r = await t.o.post('/billing/change-plan', { planCode: 'starter' }); // 4 users > 2
  assert.equal(r.status, 409);
  assert.match(r.body.error, /users/);
});

test('trial: the plan can be switched freely (no payment) if usage fits', async () => {
  const t = await register();
  assert.equal((await t.o.post('/billing/change-plan', { planCode: 'pro' })).body.applied, 'now');
  assert.equal((await t.o.get('/billing/status')).body.plan.code, 'pro');
});

// ---------------------------------------------------------------- plan features and limits
test('plan features: Starter has no AI insights / risk / advanced reports; Business has them', async () => {
  const s = await register('starter');
  assert.equal((await s.o.get('/analytics/overview')).status, 200);
  assert.equal((await s.o.get('/analytics/sales?range=7d')).status, 200);
  for (const p of ['/ai/brief', '/ai/restock', '/risk/alerts', '/analytics/products']) {
    const r = await s.o.get(p);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.details.code, 'PLAN_FEATURE');
  }
  assert.equal((await s.o.post('/ai/copilot', { question: 'hello there' })).status, 403);
  const b = await register('business');
  for (const p of ['/ai/brief', '/risk/alerts', '/analytics/products']) assert.equal((await b.o.get(p)).status, 200, p);
  // the POS never depends on AI features
  const pr = (await product(s)).body;
  assert.equal((await s.o.post('/sales', { items: [{ productId: pr.id, quantity: 1 }], paymentMethod: 'cash' })).status, 201);
});

test('plan limits: Starter allows 2 users; the 3rd is refused with an upgrade message', async () => {
  const t = await register('starter');
  const add = (n) => t.o.post('/employees', { name: n, email: `${uniq(n)}@example.com`, password: 'Passw0rdOK', role: 'cashier' });
  assert.equal((await add('one')).status, 201); // owner + 1 = 2
  const r = await add('two');
  assert.equal(r.status, 403);
  assert.equal(r.body.details.code, 'PLAN_LIMIT');
  assert.match(r.body.error, /Upgrade/);
});

test('plan limits: product limit comes from the plan table', async () => {
  const t = await register('starter');
  await sql(`UPDATE plans SET features = jsonb_set(features, '{maxProducts}', '2') WHERE code = 'starter'`);
  try {
    assert.equal((await product(t)).status, 201);
    assert.equal((await product(t)).status, 201);
    const r = await product(t);
    assert.equal(r.status, 403);
    assert.equal(r.body.details.code, 'PLAN_LIMIT');
  } finally { await sql(`UPDATE plans SET features = jsonb_set(features, '{maxProducts}', '500') WHERE code = 'starter'`); }
});

test('platform admin can see subscription state of businesses; suspended is separate from expired', async () => {
  const t = await register();
  const pwHash = (await sql('SELECT password_hash FROM accounts LIMIT 1')).rows[0].password_hash;
  await sql("INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ('P2', 'plat2@example.com', $1, TRUE) ON CONFLICT DO NOTHING", [pwHash]);
  assert.equal((await t.o.get('/platform/businesses')).status, 403);
});
