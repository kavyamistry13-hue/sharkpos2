// Getting-started checklist for a new business. Everything is computed from real data, so it can never drift from reality.
const { query, sysQuery } = require('../db');
const { getSubscription } = require('./billing/subscription');
const { getSettings } = require('./settings');

const DISMISS_KEY = 'onboarding_dismissed';

async function getOnboarding(businessId) {
  const [settings, products, sales, team, sub, dismissed] = await Promise.all([
    getSettings(),
    query('SELECT COUNT(*)::int AS n FROM products WHERE is_active'),
    query("SELECT COUNT(*)::int AS n FROM sales WHERE status = 'completed'"),
    sysQuery('SELECT COUNT(*)::int AS n FROM memberships WHERE business_id = $1 AND deleted_at IS NULL AND is_active', [businessId]),
    getSubscription(businessId),
    query('SELECT value FROM settings WHERE key = $1', [DISMISS_KEY]),
  ]);
  const steps = [
    { id: 'shop', title: 'Add your shop address', hint: 'Shown on every invoice. Add your GSTIN too if you have one.', done: Boolean(String(settings.storeAddress || '').trim()), to: '/settings', required: true },
    { id: 'product', title: 'Add your first product', hint: 'Add items one by one with their price and stock.', done: products.rows[0].n > 0, to: '/products', required: true },
    { id: 'sale', title: 'Make your first sale', hint: 'Open the billing screen, tap a product and complete the sale.', done: sales.rows[0].n > 0, to: '/pos', required: true },
    { id: 'team', title: 'Invite a cashier', hint: 'Give your counter staff their own login.', done: team.rows[0].n > 1, to: '/employees', required: false },
    { id: 'plan', title: 'Choose your plan before the trial ends', hint: 'Your data is always kept; paying keeps billing switched on.', done: Boolean(sub && sub.effective === 'active'), to: '/billing', required: false },
  ];
  const required = steps.filter((s) => s.required);
  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    total: steps.length,
    complete: required.every((s) => s.done),
    dismissed: dismissed.rows[0] ? dismissed.rows[0].value === true : false,
  };
}

async function dismiss() {
  await query(`INSERT INTO settings (key, value) VALUES ($1, 'true'::jsonb) ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value`, [DISMISS_KEY]);
}

module.exports = { getOnboarding, dismiss };
