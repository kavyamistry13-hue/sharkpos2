// Physical stock counts (Phase 9), mounted on /api/stock-counts. Owner / manager only (a cashier gets 403).
// Counting and review never change stock; only POST /:id/approve does, through audited adjustment movements.
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/stockOps');
const { audit } = require('../services/audit');
const { stockSchema } = require('../utils/units');

const router = express.Router();
const id = z.coerce.number().int().positive();
const mgr = authorize('business_owner', 'manager');
router.use(mgr);

router.get('/', asyncH(async (_req, res) => res.json({ rows: await svc.listCounts() })));
router.post('/', validate({ body: z.object({ title: z.string().trim().min(1).max(120).optional(), note: z.string().trim().max(200).optional() }) }), asyncH(async (req, res) => {
  const r = await svc.startCount(req.body, req.user.id);
  await audit(req, 'inventory.count_started', { entityType: 'stock_count', entityId: r.id, summary: `Stock count #${r.id} started` });
  res.status(201).json(await svc.getCount(r.id));
}));
router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getCount(req.params.id))));
router.put('/:id/items/:productId', validate({ params: z.object({ id, productId: id }), body: z.object({ counted: stockSchema }) }), asyncH(async (req, res) => res.json(await svc.recordItem(req.params.id, req.params.productId, req.body.counted, req.user.id))));
router.delete('/:id/items/:productId', validate({ params: z.object({ id, productId: id }) }), asyncH(async (req, res) => res.json(await svc.removeItem(req.params.id, req.params.productId))));
router.post('/:id/submit', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const d = await svc.submitCount(req.params.id, req.user.id);
  await audit(req, 'inventory.count_submitted', { entityType: 'stock_count', entityId: d.id, summary: `Stock count #${d.id} sent for review (${d.summary.counted} counted, ${d.summary.short} short, ${d.summary.over} over)` });
  res.json(d);
}));
router.post('/:id/cancel', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const d = await svc.cancelCount(req.params.id);
  await audit(req, 'inventory.count_cancelled', { entityType: 'stock_count', entityId: d.id, summary: `Stock count #${d.id} cancelled (no stock changed)` });
  res.json(d);
}));
router.post('/:id/approve', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const r = await svc.approveCount(req.params.id, req.user.id);
  await audit(req, 'inventory.count_approved', { entityType: 'stock_count', entityId: req.params.id, summary: `Stock count #${req.params.id} approved: ${r.applied.length} product(s) adjusted, variance ₹${r.detail.summary.varianceValue}`, newValue: { adjusted: r.applied.length, summary: r.detail.summary } });
  for (const a of r.applied) await audit(req, 'inventory.adjusted', { entityType: 'product', entityId: a.productId, summary: `Stock count #${req.params.id}: "${a.name}" ${a.before} → ${a.after}`, oldValue: { stock: a.before }, newValue: { stock: a.after, reason: 'stock_count' } });
  res.json(r.detail);
}));

module.exports = router;
