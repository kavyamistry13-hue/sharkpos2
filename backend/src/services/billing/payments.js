// Checkout, server-side verification and webhooks. A subscription is activated ONLY here, and only after a verified
// signature: the browser saying "payment succeeded" is never trusted.
const config = require('../../config');
const { sysQuery, withSystemTransaction } = require('../../db');
const { HttpError, badRequest, notFound, conflict } = require('../../utils/errors');
const { getGateway } = require('./gateway');
const { getPlanByCode } = require('./plans');
const { getSubscription, checkFits } = require('./subscription');
const { audit } = require('../audit');

const DAY = 86400000;

async function createCheckout(req, planCode) {
  const gw = getGateway();
  if (!gw.configured()) throw new HttpError(503, 'Online payments are not set up yet. Please contact support.', { code: 'PAYMENTS_NOT_CONFIGURED' });
  const businessId = req.user.businessId;
  const sub = await getSubscription(businessId);
  // Renewals use a scheduled downgrade if there is one; otherwise the requested plan, otherwise the current plan.
  const code = planCode || sub.pending_code || sub.plan_code;
  const plan = await getPlanByCode(code);
  if (!plan) throw notFound('Plan not found.');
  if (plan.pricePaise <= 0) throw badRequest('This plan has no charge.');
  await checkFits(businessId, plan);
  // The amount comes from the database, never from the browser.
  const order = await gw.createOrder({ amountPaise: plan.pricePaise, currency: plan.currency, receipt: `b${businessId}-${Date.now().toString(36)}`, notes: { businessId: String(businessId), plan: plan.code } });
  await sysQuery(
    `INSERT INTO payments (business_id, subscription_id, plan_id, amount_paise, currency, provider, provider_order_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [businessId, sub.id, plan.id, plan.pricePaise, plan.currency, gw.name, order.id, req.user.id]);
  await audit(req, 'payment.initiated', { entityType: 'payment', entityId: order.id, summary: `Checkout started for ${plan.name} (₹${plan.price})` });
  return {
    provider: gw.name, keyId: gw.publicKey(), orderId: order.id, amount: plan.pricePaise, currency: plan.currency,
    plan: { code: plan.code, name: plan.name, price: plan.price }, business: { name: req.user.businessName }, prefill: { name: req.user.name, email: req.user.email },
  };
}

/** Marks a payment paid and extends the subscription. Idempotent: safe to call from both the browser path and the webhook. */
async function applyPaid({ paymentRowId, providerPaymentId, via }) {
  return withSystemTransaction(async (c) => {
    const pay = (await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentRowId])).rows[0];
    if (!pay) throw notFound('Payment not found.');
    if (pay.status === 'paid') return { already: true, businessId: pay.business_id };
    await c.query("UPDATE payments SET status = 'paid', provider_payment_id = $1, verified_by = $2, paid_at = now(), failure_reason = NULL WHERE id = $3", [providerPaymentId, via, pay.id]);
    const sub = (await c.query('SELECT s.*, p.interval_days FROM subscriptions s JOIN plans p ON p.id = $2 WHERE s.business_id = $1 FOR UPDATE OF s', [pay.business_id, pay.plan_id])).rows[0];
    const now = Date.now();
    const stillRunning = sub.status === 'active' && sub.end_date && new Date(sub.end_date).getTime() > now && sub.plan_id === pay.plan_id;
    const base = stillRunning ? new Date(sub.end_date).getTime() : now; // early renewal extends, never loses paid days
    const end = new Date(base + sub.interval_days * DAY);
    await c.query(
      `UPDATE subscriptions SET plan_id = $1, pending_plan_id = NULL, status = 'active', start_date = $2, end_date = $3, cancel_at_period_end = FALSE WHERE id = $4`,
      [pay.plan_id, stillRunning ? sub.start_date : new Date(now), end, sub.id]);
    await c.query('INSERT INTO billing_events (business_id, type, payload) VALUES ($1, $2, $3)', [pay.business_id, 'subscription.activated', JSON.stringify({ paymentId: pay.id, planId: pay.plan_id, via, endsAt: end })]);
    return { already: false, businessId: pay.business_id, endsAt: end, planId: pay.plan_id, amountPaise: pay.amount_paise };
  });
}

async function verifyFromClient(req, { orderId, paymentId, signature }) {
  const gw = getGateway();
  if (!gw.configured()) throw new HttpError(503, 'Online payments are not set up yet.', { code: 'PAYMENTS_NOT_CONFIGURED' });
  // Only this business's own order can be verified (a foreign order id is simply "not found").
  const pay = (await sysQuery('SELECT * FROM payments WHERE provider_order_id = $1 AND business_id = $2', [orderId, req.user.businessId])).rows[0];
  if (!pay) throw notFound('Payment not found.');
  if (!gw.verifyPaymentSignature({ orderId, paymentId, signature })) {
    await sysQuery("UPDATE payments SET status = CASE WHEN status = 'paid' THEN status ELSE 'failed' END, failure_reason = 'Signature mismatch' WHERE id = $1", [pay.id]);
    require('../../utils/metrics').count('paymentFailures');
    require('../../utils/logger').error('payment_failure', { reason: 'signature_mismatch', businessId: req.user.businessId, orderId });
    await audit(req, 'payment.verification_failed', { entityType: 'payment', entityId: orderId, summary: 'Payment signature did not match' });
    throw badRequest('We could not verify this payment. If money was deducted it will be reconciled automatically; otherwise please try again.');
  }
  // Belt and braces: ask the provider what it actually captured.
  const remote = await gw.fetchPayment(paymentId);
  if (remote) {
    if (remote.order_id !== orderId || remote.amount !== pay.amount_paise || remote.currency !== pay.currency) throw badRequest('Payment details do not match this order.');
    if (remote.status !== 'captured') throw conflict('Your payment is still being processed. Your plan will activate automatically as soon as it completes.', { code: 'PAYMENT_PENDING' });
  }
  const out = await applyPaid({ paymentRowId: pay.id, providerPaymentId: paymentId, via: 'client' });
  if (!out.already) await audit(req, 'subscription.activated', { entityType: 'subscription', summary: `Payment of ₹${pay.amount_paise / 100} verified; plan activated`, newValue: { endsAt: out.endsAt } });
  return { ok: true, already: out.already };
}

/** Provider → us. Must be authenticated by signature over the RAW request body. */
async function handleWebhook(rawBody, signature, eventId) {
  const gw = getGateway();
  if (!gw.configured() || !gw.verifyWebhookSignature(rawBody, signature)) {
    require('../../utils/metrics').count('paymentFailures');
    require('../../utils/logger').error('payment_failure', { reason: 'webhook_bad_signature' });
    throw new HttpError(400, 'Invalid signature.');
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { throw badRequest('Malformed event.'); }
  const entity = event?.payload?.payment?.entity || {};
  const orderId = entity.order_id;
  const dedupeId = eventId || null;
  if (dedupeId) {
    const ins = await sysQuery('INSERT INTO billing_events (type, provider_event_id, payload) VALUES ($1,$2,$3) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id', [`webhook.${event.event}`, dedupeId, JSON.stringify({ event: event.event, orderId })]);
    if (!ins.rowCount) return { duplicate: true };
  }
  if (!orderId) return { ignored: true };
  const pay = (await sysQuery('SELECT * FROM payments WHERE provider_order_id = $1', [orderId])).rows[0];
  if (!pay) return { ignored: true };
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    if (entity.amount !== pay.amount_paise) { await audit(null, 'payment.webhook_amount_mismatch', { businessId: pay.business_id, summary: `Webhook amount ${entity.amount} != expected ${pay.amount_paise}` }); return { ignored: true }; }
    const out = await applyPaid({ paymentRowId: pay.id, providerPaymentId: entity.id, via: 'webhook' });
    if (!out.already) await audit(null, 'subscription.activated', { businessId: pay.business_id, actorName: 'Payment provider', entityType: 'subscription', summary: `Payment of ₹${pay.amount_paise / 100} confirmed by provider; plan activated` });
    return { applied: true };
  }
  if (event.event === 'payment.failed' && pay.status === 'created') {
    await sysQuery("UPDATE payments SET status = 'failed', failure_reason = $1 WHERE id = $2 AND status = 'created'", [String(entity.error_description || 'Payment failed').slice(0, 200), pay.id]);
    require('../../utils/metrics').count('paymentFailures');
    require('../../utils/logger').warn('payment_failure', { reason: 'provider_reported_failed', businessId: pay.business_id, orderId });
    await audit(null, 'payment.failed', { businessId: pay.business_id, actorName: 'Payment provider', entityType: 'payment', entityId: orderId, summary: 'Payment failed' });
    return { applied: true };
  }
  return { ignored: true };
}

module.exports = { createCheckout, verifyFromClient, handleWebhook, applyPaid };
