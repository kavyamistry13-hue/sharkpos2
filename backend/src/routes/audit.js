const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { query } = require('../db');

const router = express.Router();
router.use(authorize('business_owner'));

// Read-only. RLS restricts rows to the caller's business; the explicit filter is a second guard.
router.get('/', validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), action: z.string().max(60).optional(), q: z.string().max(60).optional() }) }), asyncH(async (req, res) => {
  const { page, pageSize, action, q } = req.query;
  const where = ['business_id = $1']; const params = [req.user.businessId];
  if (action) { params.push(`${action}%`); where.push(`action LIKE $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(summary ILIKE $${params.length} OR actor_name ILIKE $${params.length})`); }
  const w = where.join(' AND ');
  const total = (await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE ${w}`, params)).rows[0].n;
  const rows = (await query(`SELECT id, actor_name, action, entity_type, entity_id, summary, old_value, new_value, created_at FROM audit_logs WHERE ${w} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;
  res.json({ page, pageSize, total, rows: rows.map((r) => ({ id: r.id, actor: r.actor_name, action: r.action, entityType: r.entity_type, entityId: r.entity_id, summary: r.summary, oldValue: r.old_value, newValue: r.new_value, createdAt: r.created_at })) });
}));

module.exports = router;
