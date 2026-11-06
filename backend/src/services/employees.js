const bcrypt = require('bcryptjs');
const config = require('../config');
const { query, sysQuery, currentBusinessId, withSystemTransaction } = require('../db');
const { getBaselines, employeeRisk } = require('./risk');
const { conflict, notFound, badRequest, forbidden } = require('../utils/errors');
const { BCRYPT_ROUNDS } = require('./authService');
const { assertWithinLimit } = require('./billing/subscription');

async function listEmployees(days = 30) {
  const baselines = await getBaselines(query);
  const res = await query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
            COUNT(s.id) FILTER (WHERE s.status <> 'cancelled')::int AS transactions,
            COALESCE(SUM(s.total) FILTER (WHERE s.status = 'completed'), 0) AS revenue,
            COALESCE(SUM(s.discount) FILTER (WHERE s.status <> 'cancelled'), 0) AS discounts,
            COUNT(s.id) FILTER (WHERE s.status = 'refunded')::int AS refunds,
            COUNT(s.id) FILTER (WHERE s.status = 'cancelled')::int AS cancellations,
            COUNT(a.id) FILTER (WHERE a.status = 'open')::int AS open_alerts
       FROM users u
       LEFT JOIN sales s ON s.employee_id = u.id AND s.created_at > now() - ($1::int * interval '1 day')
       LEFT JOIN anomaly_alerts a ON a.sale_id = s.id
      GROUP BY u.id, u.name, u.email, u.role, u.is_active, u.created_at ORDER BY revenue DESC, u.name`,
    [days],
  );
  return res.rows.map((r) => {
    const base = baselines.employees.get(r.id);
    const risk = base ? employeeRisk(base, baselines, r.open_alerts) : { score: 0, level: 'low', discountRatio: 1 };
    return {
      id: r.id, name: r.name, email: r.email, role: r.role, isActive: r.is_active, createdAt: r.created_at,
      transactions: r.transactions,
      revenue: Math.round(r.revenue * 100) / 100,
      avgTransaction: r.transactions ? Math.round((r.revenue / r.transactions) * 100) / 100 : 0,
      discounts: Math.round(r.discounts * 100) / 100,
      refunds: r.refunds,
      cancellations: r.cancellations,
      openAlerts: r.open_alerts,
      riskScore: risk.score,
      risk: risk.level,
      discountVsStore: risk.discountRatio,
    };
  });
}

const ROLE_RANK = { cashier: 1, manager: 2, business_owner: 3 };

/** Managers may only manage cashiers; owners manage everyone. */
function assertCanManage(actor, targetRole, newRole) {
  if (actor.role === 'business_owner') return;
  if (targetRole !== 'cashier' || (newRole && newRole !== 'cashier')) throw forbidden('Managers can only manage cashier accounts.');
}

async function createEmployee({ name, email, password, role }, actor) {
  assertCanManage(actor, 'cashier', role);
  const bid = currentBusinessId();
  await assertWithinLimit(bid, 'users');
  const dup = await sysQuery('SELECT 1 FROM accounts WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
  if (dup.rowCount) throw conflict('This email is already registered. Use a different email for this employee.');
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return withSystemTransaction(async (c) => {
    const a = await c.query('INSERT INTO accounts (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [name, email, hash]);
    await c.query('INSERT INTO memberships (business_id, account_id, role) VALUES ($1,$2,$3)', [bid, a.rows[0].id, role]);
    return a.rows[0].id;
  });
}

async function getMembership(id) {
  const bid = currentBusinessId();
  const m = await sysQuery(
    `SELECT m.id AS membership_id, m.role, m.is_active, a.id, a.name,
            (SELECT COUNT(*) FROM memberships x WHERE x.account_id = a.id AND x.deleted_at IS NULL)::int AS business_count
       FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.business_id = $1 AND a.id = $2 AND m.deleted_at IS NULL`, [bid, id]);
  if (!m.rowCount) throw notFound('Employee not found.');
  return m.rows[0];
}

async function assertNotLastOwner(excludeAccountId) {
  const r = await sysQuery("SELECT COUNT(*)::int AS n FROM memberships WHERE business_id = $1 AND role = 'business_owner' AND is_active AND deleted_at IS NULL AND account_id <> $2", [currentBusinessId(), excludeAccountId]);
  if (r.rows[0].n === 0) throw badRequest('A business must always have at least one active owner.');
}

async function updateEmployee(id, actor, { name, role, isActive, password }) {
  const cur = await getMembership(id);
  assertCanManage(actor, cur.role, role);
  if (id === actor.id && (isActive === false || (role && role !== cur.role))) throw badRequest('You cannot deactivate or change the role of your own account.');
  if (cur.role === 'business_owner' && (isActive === false || (role && role !== 'business_owner'))) await assertNotLastOwner(id);
  if ((name !== undefined || password) && cur.business_count > 1) throw forbidden('This person belongs to more than one business; they must change their own name or password.');
  if (!(name !== undefined || role !== undefined || isActive !== undefined || password)) throw badRequest('Nothing to update.');
  if (isActive === true && !cur.is_active) await assertWithinLimit(currentBusinessId(), 'users');
  await withSystemTransaction(async (c) => {
    if (name !== undefined) await c.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, id]);
    if (password) { await c.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, BCRYPT_ROUNDS), id]); await c.query('UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [id]); }
    if (role !== undefined) await c.query('UPDATE memberships SET role = $1 WHERE id = $2', [role, cur.membership_id]);
    if (isActive !== undefined) await c.query('UPDATE memberships SET is_active = $1 WHERE id = $2', [isActive, cur.membership_id]);
  });
  return { before: { name: cur.name, role: cur.role, isActive: cur.is_active }, after: { name: name ?? cur.name, role: role ?? cur.role, isActive: isActive ?? cur.is_active } };
}

/** Soft-removes the employee from this business. Their past sales stay in the records. */
async function removeEmployee(id, actor) {
  const cur = await getMembership(id);
  assertCanManage(actor, cur.role);
  if (id === actor.id) throw badRequest('You cannot remove your own account.');
  if (cur.role === 'business_owner') await assertNotLastOwner(id);
  await sysQuery('UPDATE memberships SET deleted_at = now(), is_active = FALSE WHERE id = $1', [cur.membership_id]);
  await sysQuery('UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND business_id = $2 AND revoked_at IS NULL', [id, currentBusinessId()]);
  return { name: cur.name, role: cur.role };
}

module.exports = { listEmployees, createEmployee, updateEmployee, removeEmployee, ROLE_RANK };
