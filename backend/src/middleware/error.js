const { HttpError } = require('../utils/errors');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body.' });
  }
  // Postgres: unique violation / FK violation / check violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with this value already exists.' });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'This record is referenced by other data and cannot be changed this way.' });
  }
  if (err.code === '23514') {
    return res.status(400).json({ error: 'A value is outside the allowed range.' });
  }
  // Unexpected failure. Log what an operator needs (no body, no query string); show the user nothing internal.
  const isDb = typeof err.code === 'string' && (/^(08|53|57|58|XX|40|28)/.test(err.code) || ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code));
  if (isDb) { metrics.count('dbErrors'); logger.error('db_error', { requestId: req.id, code: err.code, message: err.message }); }
  logger.error('api_error', { requestId: req.id, method: req.method, path: (req.baseUrl || '') + (req.route ? req.route.path : req.path), message: err.message, stack: String(err.stack || '').split('\n').slice(0, 6).join(' | ') });
  return res.status(500).json({ error: 'Something went wrong on our side. Please try again.', requestId: req.id });
}

const notFoundHandler = (req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });

module.exports = { errorHandler, notFoundHandler };
