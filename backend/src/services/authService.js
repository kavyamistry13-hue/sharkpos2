const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { sysQuery, withSystemTransaction } = require('../db');
const { signAccessToken } = require('../middleware/auth');
const { HttpError, conflict } = require('../utils/errors');
const { audit } = require('./audit');
const { DEFAULTS } = require('./settings');
const { CATEGORIES } = require('../seed/catalog');
const { createTrial } = require('./billing/subscription');

const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'business';

const publicUser = (a, m) => ({ id: a.id, name: a.name, email: a.email, role: m ? m.role : 'platform_admin', businessId: m ? m.business_id : null, businessName: m ? m.business_name : null });

/** Creates a refresh session and returns { accessToken, refreshToken, user }. */
async function startSession(db, account, membership, req) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions (id, account_id, business_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7::int * interval '1 day'))`,
    [id, account.id, membership ? membership.business_id : null, hash(refreshToken), String(req.headers['user-agent'] || '').slice(0, 300), String(req.ip || '').slice(0, 64), config.refreshDays],
  );
  const accessToken = signAccessToken({ accountId: account.id, businessId: membership ? membership.business_id : null, role: membership ? membership.role : null, name: account.name, platformAdmin: !membership && account.is_platform_admin });
  return { accessToken, refreshToken, user: publicUser(account, membership) };
}

async function register({ businessName, ownerName, email, phone, password, address, plan }, req) {
  const result = await withSystemTransaction(async (c) => {
    const dup = await c.query('SELECT 1 FROM accounts WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
    if (dup.rowCount) throw conflict('An account with this email already exists. Try signing in.');
    // unique slug
    let slug = slugify(businessName);
    const taken = await c.query('SELECT 1 FROM businesses WHERE slug = $1', [slug]);
    if (taken.rowCount) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    const b = (await c.query('INSERT INTO businesses (name, slug, email, phone, address) VALUES ($1,$2,$3,$4,$5) RETURNING id', [businessName, slug, email, phone || null, address || null])).rows[0];
    const a = (await c.query('INSERT INTO accounts (name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, is_platform_admin', [ownerName, email, phone || null, await bcrypt.hash(password, BCRYPT_ROUNDS)])).rows[0];
    await c.query('INSERT INTO memberships (business_id, account_id, role) VALUES ($1,$2,$3)', [b.id, a.id, 'business_owner']);
    await c.query("SELECT set_config('app.business_id', $1, true)", [String(b.id)]);
    for (const [key, value] of Object.entries({ ...DEFAULTS, storeName: businessName, storeAddress: address || '', invoiceFooter: 'Thank you for shopping with us!' })) {
      await c.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
    }
    await createTrial(c, b.id, plan);
    // Starter categories (with GST rates) so a brand-new shop can add its first product straight away.
    for (const [catName, tax] of CATEGORIES) await c.query('INSERT INTO categories (name, tax_rate) VALUES ($1,$2)', [catName, tax]);
    const membership = { business_id: b.id, role: 'business_owner', business_name: businessName };
    const session = await startSession(c, a, membership, req);
    return { business: { id: b.id, name: businessName, slug }, session, account: a };
  });
  await audit(req, 'business.registered', { businessId: result.business.id, accountId: result.account.id, actorName: ownerName, entityType: 'business', entityId: result.business.id, summary: `Business "${businessName}" registered` });
  return { business: result.business, ...result.session };
}

async function login({ email, password, businessId }, req) {
  const r = await sysQuery('SELECT * FROM accounts WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
  const a = r.rows[0];
  if (a && a.locked_until && new Date(a.locked_until) > new Date()) {
    require('../utils/metrics').count('authFailures');
    require('../utils/logger').warn('auth_failure', { reason: 'locked', ip: req && req.ip, requestId: req && req.id });
    await audit(req, 'auth.login_blocked', { accountId: a.id, actorName: a.name, summary: 'Login attempt while locked' });
    throw new HttpError(429, 'Too many failed attempts. Please try again in a few minutes.');
  }
  const ok = await bcrypt.compare(password, a ? a.password_hash : DUMMY_HASH);
  if (!a || !ok || !a.is_active) {
    if (a) {
      const lock = a.failed_logins + 1 >= MAX_FAILS;
      await sysQuery(`UPDATE accounts SET failed_logins = $2, locked_until = ${lock ? `now() + interval '${LOCK_MINUTES} minutes'` : 'NULL'} WHERE id = $1`, [a.id, lock ? 0 : a.failed_logins + 1]);
    }
    require('../utils/metrics').count('authFailures');
    require('../utils/logger').warn('auth_failure', { reason: !a ? 'unknown_account' : !a.is_active ? 'inactive' : 'bad_password', ip: req && req.ip, requestId: req && req.id });
    await audit(req, 'auth.login_failed', { accountId: a ? a.id : null, actorName: a ? a.name : null, summary: `Failed login for ${String(email).slice(0, 80)}` });
    throw new HttpError(401, 'Invalid login credentials.');
  }
  const ms = (await sysQuery(
    `SELECT m.business_id, m.role, b.name AS business_name FROM memberships m JOIN businesses b ON b.id = m.business_id
      WHERE m.account_id = $1 AND m.is_active AND m.deleted_at IS NULL AND b.deleted_at IS NULL AND b.status = 'active' ORDER BY b.name`, [a.id])).rows;
  let membership = null;
  if (ms.length) {
    if (businessId) membership = ms.find((m) => m.business_id === businessId);
    else if (ms.length === 1) membership = ms[0];
    if (!membership) return { needsBusiness: true, businesses: ms.map((m) => ({ id: m.business_id, name: m.business_name, role: m.role })) };
  } else if (!a.is_platform_admin) {
    throw new HttpError(403, 'Your account is not linked to an active business. Please contact support.');
  }
  await sysQuery('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [a.id]);
  const session = await startSession({ query: sysQuery }, a, membership, req);
  await audit(req, 'auth.login', { businessId: membership ? membership.business_id : null, accountId: a.id, actorName: a.name, summary: 'Signed in' });
  return session;
}

/** Rotates the refresh token. A token presented twice means it was stolen: every session of that account is revoked. */
async function refresh(token, req) {
  const row = (await sysQuery('SELECT * FROM sessions WHERE token_hash = $1', [hash(token)])).rows[0];
  if (!row) throw new HttpError(401, 'Session expired. Please sign in again.');
  if (row.revoked_at) {
    await sysQuery('UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [row.account_id]);
    await audit(req, 'auth.refresh_reuse', { accountId: row.account_id, businessId: row.business_id, summary: 'Revoked refresh token was reused; all sessions revoked' });
    throw new HttpError(401, 'Session expired. Please sign in again.');
  }
  if (new Date(row.expires_at) < new Date()) throw new HttpError(401, 'Session expired. Please sign in again.');
  const a = (await sysQuery('SELECT * FROM accounts WHERE id = $1 AND deleted_at IS NULL AND is_active', [row.account_id])).rows[0];
  if (!a) throw new HttpError(401, 'Session expired. Please sign in again.');
  let membership = null;
  if (row.business_id != null) {
    membership = (await sysQuery(
      `SELECT m.business_id, m.role, b.name AS business_name FROM memberships m JOIN businesses b ON b.id = m.business_id
        WHERE m.account_id = $1 AND m.business_id = $2 AND m.is_active AND m.deleted_at IS NULL AND b.status = 'active' AND b.deleted_at IS NULL`, [a.id, row.business_id])).rows[0];
    if (!membership) throw new HttpError(401, 'Session expired. Please sign in again.');
  } else if (!a.is_platform_admin) throw new HttpError(401, 'Session expired. Please sign in again.');
  await sysQuery('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.id]);
  return startSession({ query: sysQuery }, a, membership, req);
}

async function logout(token, req) {
  if (!token) return;
  const r = await sysQuery('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING account_id, business_id', [hash(token)]);
  if (r.rowCount) await audit(req, 'auth.logout', { accountId: r.rows[0].account_id, businessId: r.rows[0].business_id, summary: 'Signed out' });
}

async function changePassword(req, currentPassword, newPassword) {
  const a = (await sysQuery('SELECT password_hash FROM accounts WHERE id = $1', [req.user.id])).rows[0];
  if (!a || !(await bcrypt.compare(currentPassword, a.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  await sysQuery('UPDATE accounts SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, BCRYPT_ROUNDS), req.user.id]);
  await sysQuery('UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [req.user.id]);
  await audit(req, 'auth.password_changed', { entityType: 'account', entityId: req.user.id, summary: 'Password changed; other sessions signed out' });
}

module.exports = { register, login, refresh, logout, changePassword, BCRYPT_ROUNDS };
