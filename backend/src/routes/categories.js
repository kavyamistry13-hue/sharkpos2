const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/categories');
const { audit } = require('../services/audit');

const router = express.Router();
const id = z.coerce.number().int().positive();
const mgr = authorize('business_owner', 'manager');
const body = { name: z.string().trim().min(1).max(80), taxRate: z.coerce.number().min(0).max(40) };

router.use(mgr);
router.get('/', asyncH(async (_req, res) => res.json({ rows: await svc.listCategories() })));
router.post('/', validate({ body: z.object(body) }), asyncH(async (req, res) => {
  const c = await svc.createCategory(req.body);
  await audit(req, 'category.created', { entityType: 'category', entityId: c.id, summary: `Category "${c.name}" created (${c.taxRate}% tax)`, newValue: { name: c.name, taxRate: c.taxRate } });
  res.status(201).json(c);
}));
router.put('/:id', validate({ params: z.object({ id }), body: z.object(body).partial() }), asyncH(async (req, res) => {
  const { before, after } = await svc.updateCategory(req.params.id, req.body);
  await audit(req, 'category.updated', { entityType: 'category', entityId: after.id, summary: `Category "${after.name}" updated`, oldValue: { name: before.name, taxRate: before.taxRate }, newValue: { name: after.name, taxRate: after.taxRate } });
  res.json(after);
}));
router.delete('/:id', authorize('business_owner'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const c = await svc.deleteCategory(req.params.id);
  await audit(req, 'category.deleted', { entityType: 'category', entityId: c.id, summary: `Category "${c.name}" deleted`, oldValue: { name: c.name } });
  res.json({ ok: true });
}));

module.exports = router;
