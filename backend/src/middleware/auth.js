const jwt = require('jsonwebtoken');
const config = require('../config');
const { sysQuery, runAsTenant } = require('../db');
const { unauthorized, forbidden } = require('../utils/errors');

/** Access token: short-lived, carries the account, the business it is scoped to and the role in that business. */
function signAccessToken({ accountId, businessId, role, name, platformAdmin }) {
  return jwt.sign({ sub: accountId, bid: businessId ?? null, role: role ?? null, name, pa: !!platformAdmin }, config.jwtSecret, {
    expiresIn: config.accessTtl,
    algorithm: 'HS256',
  });
}

/**
 * Verifies the Bearer token, then re-checks the account and membership in the database on EVERY request so that a
 * deactivated employee, a changed role or a suspended business takes effect immediately (not when the token expires).
 * Sets req.user and runs the rest of the request inside the tenant context.
 */
async function authenticate(req, _res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw unauthorized('Session expired. Please sign in again.');
    }
    const acc = await sysQuery('SELECT id, name, email, is_active, is_platform_admin FROM accounts WHERE id = $1 AND deleted_at IS NULL', [payload.sub]);
    if (!acc.rowCount || !acc.rows[0].is_active) throw unauthorized('Session expired. Please sign in again.');
    const a = acc.rows[0];
    if (payload.bid == null) {
      if (!a.is_platform_admin) throw unauthorized('Session expired. Please sign in again.');
      req.user = { id: a.id, name: a.name, email: a.email, role: 'platform_admin', businessId: null, platformAdmin: true };
      return next();
    }
    const m = await sysQuery(
      `SELECT m.role, m.is_active, b.status, b.name AS business_name
         FROM memberships m JOIN businesses b ON b.id = m.business_id
        WHERE m.account_id = $1 AND m.business_id = $2 AND m.deleted_at IS NULL AND b.deleted_at IS NULL`,
      [a.id, payload.bid],
    );
    if (!m.rowCount || !m.rows[0].is_active) throw unauthorized('Session expired. Please sign in again.');
    if (m.rows[0].status !== 'active') throw forbidden('This business account is suspended. Please contact support.');
    req.user = { id: a.id, name: a.name, email: a.email, role: m.rows[0].role, businessId: payload.bid, businessName: m.rows[0].business_name, platformAdmin: false };
    return runAsTenant(payload.bid, next);
  } catch (err) {
    return next(err);
  }
}

/** Role-based access control. Usage: authorize('business_owner', 'manager') */
const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  return next();
};

/** Routes that only make sense inside a business (everything except /api/platform). */
const requireBusiness = (req, _res, next) => (req.user && req.user.businessId != null ? next() : next(forbidden('Select a business first.')));

module.exports = { signAccessToken, authenticate, authorize, requireBusiness };
