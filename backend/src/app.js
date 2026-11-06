const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { authenticate, requireBusiness, authorize } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { subscriptionGate, requireFeature } = require('./middleware/subscription');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.use(require('./middleware/proxyIp'));
  app.use(require('./middleware/requestLog'));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  // The webhook signature is computed over the exact bytes the provider sent, so keep the raw body for that one route.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/billing/webhook')) req.rawBody = buf.toString('utf8'); } }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }));

  // Cheap liveness probe for keep-alive pings: touches nothing else, so a sleeping free-tier database is not woken by it.
  app.get('/api/health/live', (_req, res) => res.set('cache-control', 'no-store').json({ status: 'ok' }));
  // Uptime monitors call this: 200 only when the API can really reach the database.
  app.get('/api/health', async (_req, res) => {
    const t0 = Date.now();
    try {
      await Promise.race([require('./db').sysQuery('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      res.set('cache-control', 'no-store').json({ status: 'ok', db: 'ok', dbMs: Date.now() - t0, version: config.version, uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
    } catch (e) {
      require('./utils/logger').error('db_error', { where: 'health', message: e.message });
      require('./utils/metrics').count('dbErrors');
      res.set('cache-control', 'no-store').status(503).json({ status: 'degraded', db: 'error', time: new Date().toISOString() });
    }
  });
  app.use('/api/auth', require('./routes/auth'));
  app.get('/api/plans', require('./utils/async')(async (_req, res) => res.json({ plans: await require('./services/billing/plans').listPlans() })));
  app.post('/api/billing/webhook', rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 10000 : 120, standardHeaders: true, legacyHeaders: false }), require('./utils/async')(async (req, res) => {
    const out = await require('./services/billing/payments').handleWebhook(req.rawBody || '', req.headers['x-razorpay-signature'], req.headers['x-razorpay-event-id']);
    res.json({ ok: true, ...out });
  }));

  // Everything below needs a valid token; role checks live inside each router.
  app.use('/api', authenticate);
  app.use('/api/platform', authorize('platform_admin'), require('./routes/platform'));
  app.use('/api', requireBusiness); // business routes: platform admins have no business context
  app.use('/api/audit', require('./routes/audit'));
  app.use('/api', subscriptionGate);
  app.use('/api/billing', require('./routes/billing'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/sales', require('./routes/sales'));
  app.use('/api/inventory', require('./routes/inventory'));
  app.use('/api/analytics/products', requireFeature('advancedReports', 'Advanced reports'));
  app.use('/api/analytics', require('./routes/analytics'));
  app.use('/api/ai', requireFeature('aiInsights', 'AI insights'), require('./routes/ai'));
  app.use('/api/risk', requireFeature('aiInsights', 'The Risk Center'), require('./routes/risk'));
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/employees', require('./routes/employees'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/onboarding', require('./routes/onboarding'));
  app.use('/api/demo', require('./routes/demo'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
