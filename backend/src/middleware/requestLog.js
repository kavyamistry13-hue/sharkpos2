const crypto = require('crypto');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1500;

/** Request id + one log line per request (path only: never the query string, headers or body). */
module.exports = function requestLog(req, res, next) {
  req.id = String(req.headers['x-request-id'] || '').slice(0, 64).replace(/[^\w.-]/g, '') || crypto.randomBytes(8).toString('hex');
  res.setHeader('x-request-id', req.id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const path = (req.baseUrl || '') + (req.route ? req.route.path : req.path);
    if (req.originalUrl.startsWith('/api/health')) return;
    metrics.recordRequest(res.statusCode, ms);
    const f = { requestId: req.id, method: req.method, path, status: res.statusCode, ms: Math.round(ms), businessId: req.user ? req.user.businessId : undefined };
    if (ms >= SLOW_MS) logger.warn('slow_request', f);
    else if (res.statusCode >= 500) logger.error('request', f);
    else logger.info('request', f);
  });
  next();
};
