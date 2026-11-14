// Who the offline data belongs to. The scope comes ONLY from the authenticated session (the /auth response), never from anything typed or
// stored in the browser, and it is only ever a label for filtering local data: the server still takes the tenant from the JWT.
import { OfflineError } from './db.js';

const posInt = (n) => Number.isInteger(n) && n > 0;

export function assertScope(scope) {
  if (!scope || !posInt(scope.businessId) || !posInt(scope.userId)) throw new OfflineError('OFFLINE_NO_SCOPE', 'Offline data needs a signed-in business and user.');
  return scope;
}
export const scopeKey = (scope) => { assertScope(scope); return `${scope.businessId}:${scope.userId}`; };
export const sameScope = (a, b) => !!a && !!b && a.businessId === b.businessId && a.userId === b.userId;
/** Builds a scope from the /auth user object, or null when it cannot be trusted (no business, e.g. a platform admin). */
export function scopeOf(user) {
  if (!user) return null;
  const businessId = Number(user.businessId ?? (user.business && user.business.id));
  const userId = Number(user.id);
  return posInt(businessId) && posInt(userId) ? { businessId, userId } : null;
}
