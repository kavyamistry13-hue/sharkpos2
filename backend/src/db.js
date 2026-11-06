// Database access with tenant context.
//   query()           — tenant-scoped: runs on a connection whose app.business_id is set to the caller's business,
//                       so PostgreSQL row-level security restricts every statement to that business.
//   sysQuery()        — NOT tenant-scoped: only for platform tables (accounts, memberships, businesses, sessions, audit_logs).
//   withTransaction() — tenant-scoped transaction.
// With no tenant context a tenant table returns no rows and rejects writes (fail closed).
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, idleTimeoutMillis: 30000, connectionTimeoutMillis: config.dbConnectTimeoutMs });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

const als = new AsyncLocalStorage();
const currentBusinessId = () => (als.getStore() || {}).businessId ?? null;
const runAsTenant = (businessId, fn) => als.run({ businessId: Number(businessId) }, fn);

async function query(text, params) {
  const bid = currentBusinessId();
  if (bid == null) return pool.query(text, params); // no tenant: RLS yields nothing / rejects writes
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("SELECT set_config('app.business_id', $1, false)", [String(bid)]);
    return await client.query(text, params);
  } catch (err) {
    if (err.code && String(err.code).startsWith('08')) broken = true;
    throw err;
  } finally {
    try { if (!broken) await client.query("SELECT set_config('app.business_id', '', false)"); } catch { broken = true; }
    client.release(broken);
  }
}

const sysQuery = (text, params) => pool.query(text, params);

async function runTx(fn, businessId) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    if (businessId != null) await client.query("SELECT set_config('app.business_id', $1, true)", [String(businessId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Tenant-scoped transaction (uses the caller's business). Rolls back on any thrown error. */
function withTransaction(fn) {
  const bid = currentBusinessId();
  if (bid == null) throw new Error('withTransaction requires a tenant context.');
  return runTx(fn, bid);
}

/** Transaction that touches platform tables; pass businessId to also set the tenant for tenant tables. */
const withSystemTransaction = (fn, businessId = null) => runTx(fn, businessId);

module.exports = { pool, query, sysQuery, withTransaction, withSystemTransaction, runAsTenant, currentBusinessId };
