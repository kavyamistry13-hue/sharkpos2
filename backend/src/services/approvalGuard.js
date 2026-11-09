// Brute-force protection for "manager approval" on a discount (a cashier types a manager's email + password into the sale).
// Without this the sale endpoint would be a password-guessing oracle that skips the login lockout.
//   • per requester: after MAX_FAILS wrong approvals in WINDOW_MS the cashier gets 429 for the rest of the window (they can still sell without a discount).
//   • per approver account: wrong guesses count toward the SAME lockout as login (accounts.failed_logins / locked_until); a locked account cannot approve.
// The account counters are written on a separate connection, so the sale transaction rolling back cannot erase a recorded failure.
const { sysQuery } = require('../db');
const { HttpError } = require('../utils/errors');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MINUTES = 15;
const byRequester = new Map();   // requesting user id -> { n, first }   (per process; the API runs as one instance)

function pruned(userId) {
  const e = byRequester.get(userId);
  if (e && Date.now() - e.first > WINDOW_MS) { byRequester.delete(userId); return null; }
  return e || null;
}
function assertRequesterAllowed(userId) {
  const e = pruned(userId);
  if (e && e.n >= MAX_FAILS) throw new HttpError(429, 'Too many failed approval attempts. Try again in a few minutes.');
}
async function accountLocked(approverId) {
  const a = (await sysQuery('SELECT locked_until FROM accounts WHERE id = $1', [approverId])).rows[0];
  return !!(a && a.locked_until && new Date(a.locked_until) > new Date());
}
async function recordFailure(requesterId, approverId, reason, req) {
  const e = pruned(requesterId) || { n: 0, first: Date.now() };
  e.n += 1; byRequester.set(requesterId, e);
  metrics.count('authFailures');
  logger.warn('auth_failure', { reason: `approval_${reason}`, userId: requesterId, ip: req && req.ip, requestId: req && req.id });
  if (approverId) {
    await sysQuery(
      `UPDATE accounts SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
      [approverId, MAX_FAILS, LOCK_MINUTES],
    );
  }
}
const recordSuccess = (requesterId) => { byRequester.delete(requesterId); };
const _reset = () => byRequester.clear();   // tests

module.exports = { assertRequesterAllowed, accountLocked, recordFailure, recordSuccess, _reset };
