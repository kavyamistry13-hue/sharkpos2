// Structured (one JSON object per line) logging to stdout. Hosting platforms collect stdout, and alerts can filter on `event`.
// Events: request, slow_request, api_error, db_error, auth_failure, payment_failure. Never log passwords, tokens, secrets or request bodies.
const config = require('../config');

function log(level, event, fields = {}) {
  if (config.isTest) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  info: (event, f) => log('info', event, f),
  warn: (event, f) => log('warn', event, f),
  error: (event, f) => log('error', event, f),
};
