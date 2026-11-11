const config = require('../../config');
const { sysQuery, withSystemTransaction, query } = require('../../db');
const { HttpError, badRequest, conflict, notFound } = require('../../utils/errors');
const { effectiveStatus, canWrite } = require('./state');
const { getPlanByCode, getPlanById, listPlans } = require('./plans');
const { audit } = require('../audit');

const DAY = 86400000;
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Creates the trial at registration (inside the registration transaction). */
async function createTrial(client, businessId, planCode) {
  const code = planCode || config.billing.defaultPlan;
  const plan = (await client.query('SELECT id FROM plans WHERE code = $1 AND is_active', [code])).rows[0] || (await client.query('SELECT id FROM plans WHERE code = $1', [config.billing.defaultPlan])).rows[0];
  await client.query(
    `INSERT INTO subscriptions (business_id, plan_id, status, start_date, end_date, trial_start, trial_end)
     VALUES ($1, $2, 'trialing', now(), now() + ($3::int * interval '1 day'), now(), now() + ($3::int * interval '1 day'))`,
    [businessId, plan.id, config.billing.trialDays],
  );
}

async function loadRaw(businessId) {
  const r = await sysQuery(
    `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_paise, p.currency, p.interval_days, p.features,
            pp.code AS pending_code, pp.name AS pending_name
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans pp ON pp.id = s.pending_plan_id
      WHERE s.business_id = $1`, [businessId]);
  return r.rows[0] || null;
}

/** Subscription with its effective status; persists the transition (best effort) so the stored status catches up. */
async function getSubscription(businessId) {
  const s = await loadRaw(businessId);
  if (!s) return null;
  const eff = effectiveStatus(s, new Date(), config.billing.graceDays);
  if (eff !== s.status) {
    sysQuery('UPDATE subscriptions SET status = $1 WHERE id = $2 AND status = $3', [eff, s.id, s.status]).catch(() => {});
  }
  return { ...s, effective: eff };
}

const daysLeft = (s, now = Date.now()) => {
  const target = s.effective === 'trialing' ? s.trial_end : s.end_date;
  return target ? Math.max(0, Math.ceil((new Date(target).getTime() - now) / DAY)) : null;
};

/** Light status for every signed-in role (drives the banner and the plan-based UI). No money details. */
async function getStatus(businessId) {
  const s = await getSubscription(businessId);
  if (!s) return { status: 'expired', canWrite: false, features: {}, plan: null };
  return {
    status: s.effective, canWrite: canWrite(s.effective), plan: { code: s.plan_code, name: s.plan_name }, features: s.features,
    daysLeft: daysLeft(s), endsAt: iso(s.effective === 'trialing' ? s.trial_end : s.end_date), cancelAtPeriodEnd: s.cancel_at_period_end,
  };
}

async function getUsage(businessId) {
  const u = await sysQuery("SELECT COUNT(*)::int AS n FROM memberships WHERE business_id = $1 AND is_active AND deleted_at IS NULL", [businessId]);
  const p = await query('SELECT COUNT(*)::int AS n FROM products WHERE is_active');
  return { users: u.rows[0].n, products: p.rows[0].n, stores: 1 };
}

async function getBilling(businessId) {
  const s = await getSubscription(businessId);
  const plans = await listPlans();
  const usage = await getUsage(businessId);
  const pays = (await sysQuery(
    `SELECT pay.id, pay.amount_paise, pay.currency, pay.status, pay.provider, pay.created_at, pay.paid_at, p.name AS plan
       FROM payments pay JOIN plans p ON p.id = pay.plan_id WHERE pay.business_id = $1 ORDER BY pay.created_at DESC, pay.id DESC LIMIT 20`, [businessId])).rows;
  return {
    status: s.effective, canWrite: canWrite(s.effective),
    plan: { code: s.plan_code, name: s.plan_name, pricePaise: s.price_paise, price: s.price_paise / 100, currency: s.currency, features: s.features },
    pendingPlan: s.pending_code ? { code: s.pending_code, name: s.pending_name } : null,
    trialEnd: iso(s.trial_end), nextBillingDate: s.effective === 'active' && !s.cancel_at_period_end ? iso(s.end_date) : null,
    periodEnd: iso(s.end_date), daysLeft: daysLeft(s), cancelAtPeriodEnd: s.cancel_at_period_end,
    usage, plans,
    payments: pays.map((x) => ({ id: x.id, amount: x.amount_paise / 100, currency: x.currency, status: x.status, plan: x.plan, createdAt: iso(x.created_at), paidAt: iso(x.paid_at) })),
  };
}

/** Throws PLAN_LIMIT when adding one more `kind` would exceed the plan. Call inside a business context. */
async function assertWithinLimit(businessId, kind, adding = 1) {
  const s = await getSubscription(businessId);
  if (!s) throw new HttpError(402, 'No subscription found for this business.', { code: 'SUBSCRIPTION_REQUIRED' });
  const limit = kind === 'users' ? s.features.maxUsers : kind === 'products' ? s.features.maxProducts : null;
  if (limit == null) return;
  const usage = await getUsage(businessId);
  if (usage[kind] + adding > limit) {
    throw new HttpError(403, `Your ${s.plan_name} plan allows up to ${limit} ${kind}${adding > 1 ? ` (this would make ${usage[kind] + adding})` : ''}. Upgrade your plan to add more.`, { code: 'PLAN_LIMIT', limit, kind, plan: s.plan_code });
  }
}

/** Would `plan` fit the business's current usage? */
async function checkFits(businessId, plan) {
  const usage = await getUsage(businessId);
  const problems = [];
  if (plan.features.maxUsers != null && usage.users > plan.features.maxUsers) problems.push(`${usage.users} users (limit ${plan.features.maxUsers})`);
  if (plan.features.maxProducts != null && usage.products > plan.features.maxProducts) problems.push(`${usage.products} products (limit ${plan.features.maxProducts})`);
  if (problems.length) throw conflict(`You currently have ${problems.join(' and ')}, which is more than the ${plan.name} plan allows. Remove some first.`, { code: 'PLAN_LIMIT' });
}

/** Trial: switch plan freely. Paid: cheaper plan is scheduled for the next renewal; dearer plan needs checkout. */
async function changePlan(req, planCode) {
  const businessId = req.user.businessId;
  const s = await getSubscription(businessId);
  const target = await getPlanByCode(planCode);
  if (!target) throw notFound('Plan not found.');
  if (s.effective === 'trialing') {
    await checkFits(businessId, target);
    await sysQuery('UPDATE subscriptions SET plan_id = $1, pending_plan_id = NULL WHERE id = $2', [target.id, s.id]);
    await audit(req, 'subscription.plan_changed', { entityType: 'subscription', entityId: s.id, summary: `Trial plan changed from ${s.plan_name} to ${target.name}`, oldValue: { plan: s.plan_code }, newValue: { plan: target.code } });
    return { applied: 'now' };
  }
  if (target.code === s.plan_code) { await sysQuery('UPDATE subscriptions SET pending_plan_id = NULL WHERE id = $1', [s.id]); return { applied: 'none' }; }
  if (s.effective === 'active' && target.pricePaise < s.price_paise) {
    await checkFits(businessId, target);
    await sysQuery('UPDATE subscriptions SET pending_plan_id = $1 WHERE id = $2', [target.id, s.id]);
    await audit(req, 'subscription.downgrade_scheduled', { entityType: 'subscription', entityId: s.id, summary: `Downgrade to ${target.name} scheduled for the next renewal`, oldValue: { plan: s.plan_code }, newValue: { plan: target.code } });
    return { applied: 'at_renewal' };
  }
  return { applied: 'needs_payment' };
}

async function cancel(req) {
  const s = await getSubscription(req.user.businessId);
  if (!['trialing', 'active', 'past_due'].includes(s.effective)) throw badRequest('There is no active subscription to cancel.');
  await sysQuery('UPDATE subscriptions SET cancel_at_period_end = TRUE, pending_plan_id = NULL WHERE id = $1', [s.id]);
  await audit(req, 'subscription.cancelled', { entityType: 'subscription', entityId: s.id, summary: `Subscription set to end on ${iso(s.effective === 'trialing' ? s.trial_end : s.end_date).slice(0, 10)}` });
}

async function resume(req) {
  const s = await getSubscription(req.user.businessId);
  if (!s.cancel_at_period_end || !['trialing', 'active', 'past_due'].includes(s.effective)) throw badRequest('Nothing to resume.');
  await sysQuery('UPDATE subscriptions SET cancel_at_period_end = FALSE WHERE id = $1', [s.id]);
  await audit(req, 'subscription.resumed', { entityType: 'subscription', entityId: s.id, summary: 'Cancellation withdrawn' });
}

module.exports = { createTrial, getSubscription, getStatus, getBilling, getUsage, assertWithinLimit, checkFits, changePlan, cancel, resume, loadRaw };
