const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/suppliers');
const { audit } = require('../services/audit');
const { quantitySchema } = require('../utils/units');

const router = express.Router();
const id = z.coerce.number().int().positive();
const mgr = authorize('business_owner', 'manager');
const optText = (n) => z.string().trim().max(n).nullable().optional().or(z.literal('').transform(() => null));

const body = z.object({
  name: z.string().trim().min(1).max(120),
  phone: optText(30), email: z.string().trim().email().max(190).nullable().optional().or(z.literal('').transform(() => null)),
  contactPerson: optText(120), address: optText(300), gstin: optText(20), notes: optText(500),
  leadTimeDays: z.coerce.number().int().min(0).max(120), paymentTermsDays: z.coerce.number().int().min(0).max(365), minOrderValue: z.coerce.number().min(0).max(1e8),
});
const money = z.coerce.number().min(0).max(1e6);

router.use(mgr);
router.get('/', validate({ query: z.object({ q: z.string().max(60).optional(), includeInactive: z.enum(['true', 'false']).default('false') }) }), asyncH(async (req, res) => res.json({ rows: await svc.listSuppliers({ q: req.query.q, includeInactive: req.query.includeInactive === 'true' }) })));
router.post('/', validate({ body }), asyncH(async (req, res) => {
  const s = await svc.createSupplier(req.body);
  await audit(req, 'supplier.created', { entityType: 'supplier', entityId: s.id, summary: `Supplier "${s.name}" created`, newValue: { name: s.name, leadTimeDays: s.leadTimeDays } });
  res.status(201).json(s);
}));
router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getSupplier(req.params.id))));
router.put('/:id', validate({ params: z.object({ id }), body: body.partial().extend({ isActive: z.boolean().optional() }) }), asyncH(async (req, res) => {
  const { before, after } = await svc.updateSupplier(req.params.id, req.body);
  const action = before.isActive && !after.isActive ? 'supplier.deactivated' : 'supplier.updated';
  await audit(req, action, { entityType: 'supplier', entityId: after.id, summary: `Supplier "${after.name}" ${action === 'supplier.deactivated' ? 'deactivated' : 'updated'}`, oldValue: { name: before.name, leadTimeDays: before.leadTimeDays, isActive: before.isActive }, newValue: { name: after.name, leadTimeDays: after.leadTimeDays, isActive: after.isActive } });
  res.json(after);
}));
router.put('/:id/products/:productId', validate({
  params: z.object({ id, productId: id }),
  body: z.object({ supplierSku: optText(40), packSize: quantitySchema.optional(), minOrderQty: quantitySchema.optional(), leadTimeDays: z.coerce.number().int().min(0).max(120).nullable().optional(), lastCost: money.nullable().optional(), isPreferred: z.boolean().optional() }),
}), asyncH(async (req, res) => {
  const out = await svc.setSupplierProduct(req.params.id, req.params.productId, req.body, req.user.id);
  await audit(req, 'supplier.product_set', { entityType: 'supplier', entityId: req.params.id, summary: `Supplier #${req.params.id} ↔ product #${req.params.productId} ${out.created ? 'linked' : 'updated'}`, newValue: req.body });
  res.status(out.created ? 201 : 200).json(await svc.getSupplier(req.params.id));
}));
router.delete('/:id/products/:productId', validate({ params: z.object({ id, productId: id }) }), asyncH(async (req, res) => {
  await svc.removeSupplierProduct(req.params.id, req.params.productId);
  await audit(req, 'supplier.product_removed', { entityType: 'supplier', entityId: req.params.id, summary: `Supplier #${req.params.id} no longer supplies product #${req.params.productId}` });
  res.json({ ok: true });
}));
router.get('/:id/price-history', validate({ params: z.object({ id }), query: z.object({ productId: id.optional() }) }), asyncH(async (req, res) => res.json({ rows: await svc.getPriceHistory(req.params.id, req.query.productId) })));

module.exports = router;
