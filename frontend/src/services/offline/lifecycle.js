// Session lifecycle of the offline data (Phase 17B): sign-in, user switch, logout.
//   * The product catalog is business data: it is deleted on logout and whenever a DIFFERENT business/user signs in on this device.
//   * Unsynced SALES are money the shop is owed, so they are never silently destroyed: logout reports them first, they survive a logout,
//     and they are visible to — and can be synced by — only the same business + user. Discarding them takes an explicit confirmation.
import { assertScope, scopeKey } from './scope.js';
import { discardQueue, foreignCount, recoverInterrupted, unsyncedCount, countsByState } from './queue.js';

/** Call once after sign-in (or when the signed-in user changes). */
export async function onSessionStart(adapter, scope) {
  assertScope(scope);
  const own = `catalog:${scopeKey(scope)}`;
  let purgedCatalogs = 0;
  for (const [key] of await adapter.entries('catalog')) if (key !== own) { await adapter.del('catalog', key); purgedCatalogs += 1; }
  const recovered = await recoverInterrupted(adapter, scope);
  return { recovered, purgedCatalogs, foreignUnsynced: await foreignCount(adapter, scope) };
}

/** Call BEFORE logging out so the screen can warn. Changes nothing. */
export async function prepareLogout(adapter, scope) {
  assertScope(scope);
  const c = await countsByState(adapter, scope);
  return { unsynced: await unsyncedCount(adapter, scope), needsReview: c.needs_review, pending: c.pending + c.failed + c.syncing };
}

/** Call when logging out. Deletes every catalog; keeps the queue (see the file header). */
export async function completeLogout(adapter, scope) {
  assertScope(scope);
  await adapter.clear('catalog');
  return { unsynced: await unsyncedCount(adapter, scope) };
}

/** Explicit, confirmed removal of everything this user has stored offline, including unsynced sales. */
export async function wipeUserData(adapter, scope, { confirmDiscardUnsyncedSales = false } = {}) {
  const discarded = await discardQueue(adapter, scope, { confirmDiscardUnsyncedSales });
  await adapter.clear('catalog');
  await adapter.del('meta', `seq:${scopeKey(scope)}`);
  return { discarded };
}
