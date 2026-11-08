const { badRequest } = require('./errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads the Idempotency-Key header (a UUID the client generates once per money-moving action). Required unless `optional`. */
function idempotencyKey(req, { optional = false, what = 'action' } = {}) {
  const key = String(req.get('idempotency-key') || '').trim().toLowerCase();
  if (!key && optional) return null;
  if (!UUID.test(key)) throw badRequest(`Idempotency-Key header is required (a UUID generated once per ${what}).`, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  return key;
}

module.exports = { idempotencyKey, UUID };
