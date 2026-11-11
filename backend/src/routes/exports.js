// CSV exports (Phase 9): GET /api/exports/:kind  — products | inventory | purchases | suppliers (owner, manager); sales | customers (owner only).
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const asyncH = require('../utils/async');
const svc = require('../services/exports');
const { audit } = require('../services/audit');
const { forbidden } = require('../utils/errors');

const router = express.Router();
router.get('/:kind', validate({ params: z.object({ kind: z.enum(Object.keys(svc.KINDS)) }) }), asyncH(async (req, res) => {
  const kind = req.params.kind;
  if (!svc.KINDS[kind].roles.includes(req.user.role)) throw forbidden();
  const out = await svc.build(kind);
  await audit(req, 'export.downloaded', { entityType: 'export', entityId: kind, summary: `${kind} exported to CSV (${out.count} rows)`, newValue: { kind, rows: out.count } });
  res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="sharkpos-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store', 'x-row-count': String(out.count) }).send(out.csv);
}));
module.exports = router;
