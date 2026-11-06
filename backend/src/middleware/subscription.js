const { getSubscription } = require('../services/billing/subscription');
const { canWrite } = require('../services/billing/state');
const { HttpError } = require('../utils/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// POSTs that only read data (no writes), so an expired business can still use them.
const READ_ONLY_POSTS = new Set(['/sales/preview', '/ai/copilot']);

/** Expired / cancelled businesses keep read access to their data but cannot create or change anything. */
async function subscriptionGate(req, _res, next) {
  try {
    if (SAFE.has(req.method) || req.path.startsWith('/billing') || READ_ONLY_POSTS.has(req.path)) return next();
    const s = await getSubscription(req.user.businessId);
    if (s && canWrite(s.effective)) { req.subscription = s; return next(); }
    const cancelled = s && s.effective === 'cancelled';
    return next(new HttpError(402, cancelled ? 'Your subscription has ended. Your data is safe. Renew to continue.' : 'Your subscription has expired. Your data is safe. Renew to continue.', { code: 'SUBSCRIPTION_REQUIRED', status: s ? s.effective : 'expired' }));
  } catch (e) { return next(e); }
}

/** Blocks a route unless the business's plan includes the feature (limits live in the plans table). */
const requireFeature = (feature, label) => async (req, _res, next) => {
  try {
    const s = req.subscription || (await getSubscription(req.user.businessId));
    if (s && s.features && s.features[feature]) return next();
    return next(new HttpError(403, `${label || 'This feature'} is available on a higher plan. Upgrade to unlock it.`, { code: 'PLAN_FEATURE', feature, plan: s ? s.plan_code : null }));
  } catch (e) { return next(e); }
};

module.exports = { subscriptionGate, requireFeature };
