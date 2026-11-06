// Platform administration (SHARKPOS 2 owner only). Never reachable with a business token: app.js guards it with authorize('platform_admin').
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const asyncH = require('../utils/async');
const { sysQuery } = require('../db');
const { audit } = require('../services/audit');
const { notFound, badRequest, conflict } = require('../utils/errors');
const config = require('../config');
const { effectiveStatus } = require('../services/billing/state');
const plansSvc = require('../services/billing/plans');

const router = express.Router();
const id = z.coerce.number().int().positive();

router.get('/ops', (_req, res) => res.json(require('../utils/metrics').snapshot()));

const effOf = (r) => effectiveStatus({ status: r.sub_status, trial_end: r.trial_end, end_date: r.end_date, cancel_at_period_end: r.cancel_at_period_end }, new Date(), config.billing.graceDays);

/** Headline numbers for the platform owner. Counts real businesses only (demo businesses are excluded). */
router.get('/overview', asyncH(async (_req, res) => {
  const subs = (await sysQuery(
    `SELECT s.status AS sub_status, s.trial_end, s.end_date, s.cancel_at_period_end, p.code, p.name, p.price_paise, p.interval_days
       FROM businesses b JOIN subscriptions s ON s.business_id = b.id JOIN plans p ON p.id = s.plan_id
      WHERE b.deleted_at IS NULL AND NOT b.is_demo`)).rows;
  const byStatus = { trialing: 0, active: 0, past_due: 0, expired: 0, cancelled: 0 };
  const byPlan = {};
  let mrrPaise = 0;
  for (const r of subs) {
    const e = effOf(r);
    byStatus[e] = (byStatus[e] || 0) + 1;
    if (e === 'active' || e === 'past_due') {
      byPlan[r.name] = (byPlan[r.name] || 0) + 1;
      mrrPaise += Math.round((r.price_paise * 30) / r.interval_days);   // normalised to 30 days
    }
  }
  const biz = (await sysQuery(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7,
            COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended
       FROM businesses WHERE deleted_at IS NULL AND NOT is_demo`)).rows[0];
  const pay = (await sysQuery(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS total_paid,
            COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '30 days'), 0)::bigint AS paid30,
            COUNT(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '30 days')::int AS failed30
       FROM payments`)).rows[0];
  res.json({
    businesses: biz, subscriptions: byStatus, payingByPlan: byPlan,
    revenue: { mrrPaise, last30DaysPaise: Number(pay.paid30), allTimePaise: Number(pay.total_paid), failedPayments30Days: pay.failed30 },
  });
}));

router.get('/businesses', validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), q: z.string().trim().max(80).optional() }) }), asyncH(async (req, res) => {
  const { page, pageSize, q } = req.query;
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = `b.deleted_at IS NULL AND ($3::text IS NULL OR b.name ILIKE $3 OR EXISTS (
      SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.business_id = b.id AND m.role = 'business_owner' AND (a.email ILIKE $3 OR a.name ILIKE $3)))`;
  const total = (await sysQuery(`SELECT COUNT(*)::int AS n FROM businesses b WHERE ${where.replace(/\$3/g, '$1')}`, [like])).rows[0].n;
  const rows = (await sysQuery(
    `SELECT b.id, b.name, b.status, b.created_at, b.is_demo,
            (SELECT a.name FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.business_id = b.id AND m.role = 'business_owner' AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1) AS owner,
            (SELECT a.email FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.business_id = b.id AND m.role = 'business_owner' AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1) AS owner_email,
            (SELECT COUNT(*)::int FROM memberships m WHERE m.business_id = b.id AND m.deleted_at IS NULL) AS users,
            (SELECT MAX(s.created_at) FROM sessions s WHERE s.business_id = b.id) AS last_active,
            sub.status AS sub_status, sub.trial_end, sub.end_date, sub.cancel_at_period_end, p.name AS plan_name, p.code AS plan_code
       FROM businesses b LEFT JOIN subscriptions sub ON sub.business_id = b.id LEFT JOIN plans p ON p.id = sub.plan_id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize, like])).rows;
  res.json({ page, pageSize, total, rows: rows.map((r) => ({
    id: r.id, name: r.name, owner: r.owner, ownerEmail: r.owner_email, status: r.status, users: r.users, isDemo: r.is_demo, createdAt: r.created_at, lastActive: r.last_active,
    plan: r.plan_name, planCode: r.plan_code, subscription: r.sub_status ? effOf(r) : null, trialEnd: r.trial_end, paidUntil: r.end_date,
  })) });
}));

/** Gives a trialing or lapsed business more trial days. Never touches a business that is paying. */
router.post('/businesses/:id/extend-trial', validate({ params: z.object({ id }), body: z.object({ days: z.number().int().min(1).max(60) }) }), asyncH(async (req, res) => {
  const { days } = req.body;
  const s = (await sysQuery('SELECT * FROM subscriptions WHERE business_id = $1', [req.params.id])).rows[0];
  if (!s) throw notFound('Business not found.');
  const eff = effectiveStatus(s, new Date(), config.billing.graceDays);
  if (eff === 'active' || eff === 'past_due') throw conflict('This business has a paid subscription; a trial cannot be extended.');
  const r = await sysQuery(
    `UPDATE subscriptions SET status = 'trialing', cancel_at_period_end = FALSE,
            trial_end = GREATEST(now(), COALESCE(trial_end, now())) + ($2::int * interval '1 day'),
            end_date  = GREATEST(now(), COALESCE(trial_end, now())) + ($2::int * interval '1 day')
      WHERE business_id = $1 RETURNING trial_end`, [req.params.id, days]);
  await audit(req, 'platform.trial_extended', { businessId: req.params.id, entityType: 'subscription', entityId: s.id, summary: `Trial extended by ${days} day(s)`, oldValue: { status: eff, trialEnd: s.trial_end }, newValue: { trialEnd: r.rows[0].trial_end } });
  res.json({ ok: true, trialEnd: r.rows[0].trial_end });
}));

// ---- Plans: every price, limit and feature lives in the plans table and is edited here, never in code.
const limit = z.number().int().min(0).max(100000).nullable();   // null = unlimited
const features = z.object({
  maxUsers: limit, maxProducts: limit, maxStores: limit,
  aiInsights: z.boolean(), advancedReports: z.boolean(), advancedAi: z.boolean(),
}).strict();
const planBody = z.object({
  name: z.string().trim().min(2).max(60),
  pricePaise: z.number().int().min(0).max(10000000),
  intervalDays: z.number().int().min(1).max(366).default(30),
  features,
  highlights: z.array(z.string().trim().min(1).max(80)).max(10),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});
const planShape = (r) => ({ id: r.id, code: r.code, name: r.name, pricePaise: r.price_paise, intervalDays: r.interval_days, features: r.features, highlights: r.highlights, sortOrder: r.sort_order, isActive: r.is_active, subscribers: r.subscribers });
const PLAN_SELECT = 'SELECT p.*, (SELECT COUNT(*)::int FROM subscriptions s WHERE s.plan_id = p.id) AS subscribers FROM plans p';

router.get('/plans', asyncH(async (_req, res) => res.json({ plans: (await sysQuery(`${PLAN_SELECT} ORDER BY p.sort_order, p.id`)).rows.map(planShape) })));

router.post('/plans', validate({ body: planBody.extend({ code: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/, 'Use lower-case letters, digits and underscores.') }) }), asyncH(async (req, res) => {
  const b = req.body;
  if ((await sysQuery('SELECT 1 FROM plans WHERE code = $1', [b.code])).rowCount) throw conflict('A plan with this code already exists.');
  const r = await sysQuery(
    `INSERT INTO plans (code, name, price_paise, interval_days, features, highlights, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [b.code, b.name, b.pricePaise, b.intervalDays, JSON.stringify(b.features), JSON.stringify(b.highlights), b.sortOrder, b.isActive]);
  await audit(req, 'platform.plan_created', { businessId: null, entityType: 'plan', entityId: r.rows[0].id, summary: `Plan "${b.name}" created`, newValue: b });
  res.status(201).json({ id: r.rows[0].id });
}));

router.put('/plans/:id', validate({ params: z.object({ id }), body: planBody }), asyncH(async (req, res) => {
  const b = req.body;
  const old = (await sysQuery('SELECT * FROM plans WHERE id = $1', [req.params.id])).rows[0];
  if (!old) throw notFound('Plan not found.');
  if (!b.isActive && old.code === config.billing.defaultPlan) throw badRequest('This is the default plan for new sign-ups and cannot be switched off. Change DEFAULT_PLAN first.');
  await sysQuery(
    `UPDATE plans SET name=$2, price_paise=$3, interval_days=$4, features=$5, highlights=$6, sort_order=$7, is_active=$8 WHERE id=$1`,
    [req.params.id, b.name, b.pricePaise, b.intervalDays, JSON.stringify(b.features), JSON.stringify(b.highlights), b.sortOrder, b.isActive]);
  await audit(req, 'platform.plan_updated', { businessId: null, entityType: 'plan', entityId: old.id, summary: `Plan "${old.name}" updated`,
    oldValue: { name: old.name, pricePaise: old.price_paise, features: old.features, isActive: old.is_active }, newValue: { name: b.name, pricePaise: b.pricePaise, features: b.features, isActive: b.isActive } });
  res.json({ ok: true });
}));

router.post('/businesses/:id/status', validate({ params: z.object({ id }), body: z.object({ status: z.enum(['active', 'suspended']) }) }), asyncH(async (req, res) => {
  const r = await sysQuery('UPDATE businesses SET status = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING name', [req.body.status, req.params.id]);
  if (!r.rowCount) throw notFound('Business not found.');
  await audit(req, `platform.business_${req.body.status}`, { businessId: req.params.id, entityType: 'business', entityId: req.params.id, summary: `Business "${r.rows[0].name}" set to ${req.body.status}` });
  res.json({ ok: true });
}));

module.exports = router;
