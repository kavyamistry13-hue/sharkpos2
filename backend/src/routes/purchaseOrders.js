const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/purchaseOrders');
const { audit } = require('../services/audit');
const { quantitySchema, stockSchema } = require('../utils/units');
const { badRequest } = require('../utils/errors');

const router = express.Router();
const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30.');
const money = z.coerce.number().min(0).max(1e6);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const items = z.array(z.object({ productId: id, quantity: quantitySchema, unitCost: money.optional() })).min(1, 'Add at least one product.').max(200);
const notes = z.string().trim().max(500).nullable().optional();

router.use(authorize('business_owner', 'manager'));

router.get('/', validate({ query: z.object({
  status: z.enum(['open', 'draft', 'ordered', 'partially_received', 'received', 'cancelled']).optional(), supplierId: id.optional(), overdue: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
}) }), asyncH(async (req, res) => res.json(await svc.listPos({ ...req.query, overdue: req.query.overdue === 'true' }))));

router.get('/history', validate({ query: z.object({ productId: id.optional(), supplierId: id.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }), asyncH(async (req, res) => res.json({ rows: await svc.purchaseHistory(req.query) })));

router.post('/from-restock', validate({ body: z.object({ restockOrderIds: z.array(id).min(1).max(100) }) }), asyncH(async (req, res) => {
  const pos = await svc.fromRestock(req.user, req.body.restockOrderIds);
  for (const po of pos) await audit(req, 'purchase_order.created', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} drafted from restock orders for ${po.supplier}`, newValue: { supplier: po.supplier, lines: po.items.length, value: po.orderedValue } });
  res.status(201).json({ rows: pos });
}));

router.post('/', validate({ body: z.object({ supplierId: id, expectedDate: date.nullable().optional(), notes, items }) }), asyncH(async (req, res) => {
  const po = await svc.createPo(req.user, req.body);
  await audit(req, 'purchase_order.created', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} drafted for ${po.supplier}`, newValue: { supplier: po.supplier, lines: po.items.length, value: po.orderedValue } });
  res.status(201).json(po);
}));

router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getPo(req.params.id))));

router.put('/:id', validate({ params: z.object({ id }), body: z.object({ expectedDate: date.nullable().optional(), notes, items: items.optional() }) }), asyncH(async (req, res) => {
  const po = await svc.updateDraft(req.params.id, req.body);
  await audit(req, 'purchase_order.updated', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} edited`, newValue: { lines: po.items.length, value: po.orderedValue } });
  res.json(po);
}));

router.post('/:id/order', validate({ params: z.object({ id }), body: z.object({ expectedDate: date.optional() }).default({}) }), asyncH(async (req, res) => {
  const po = await svc.placeOrder(req.params.id, req.body);
  await audit(req, 'purchase_order.ordered', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} placed with ${po.supplier} · ₹${po.orderedValue} · due ${po.expectedDate}`, newValue: { expectedDate: po.expectedDate, value: po.orderedValue } });
  res.json(po);
}));

router.post('/:id/receive', validate({ params: z.object({ id }), body: z.object({
  items: z.array(z.object({ itemId: id, quantity: stockSchema.default(0), rejectedQuantity: stockSchema.default(0), unitCost: money.optional(), batchNo: z.string().trim().min(1).max(40).optional(), manufacturedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).min(1).max(200),
  invoiceNo: z.string().trim().max(40).nullable().optional(), notes,
}) }), asyncH(async (req, res) => {
  const raw = req.get('idempotency-key');
  const key = raw ? String(raw).trim().toLowerCase() : null;
  if (key && !UUID.test(key)) throw badRequest('Idempotency-Key must be a UUID.', { code: 'IDEMPOTENCY_KEY_INVALID' });
  const out = await svc.receive(req.params.id, req.user, req.body, key);
  if (out.replayed) return res.set('Idempotent-Replayed', 'true').json(out);
  const q = req.body.items.reduce((a, i) => a + (i.quantity || 0), 0);
  await audit(req, 'purchase_order.received', { entityType: 'purchase_order', entityId: req.params.id, summary: `${out.purchaseOrder.poNumber}: goods received (${out.purchaseOrder.status.replace('_', ' ')})`, newValue: { receiptId: out.receiptId, units: q, priceChanges: out.priceChanges.length } });
  res.status(201).json(out);
}));

router.post('/:id/close', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const po = await svc.closeShort(req.params.id);
  await audit(req, 'purchase_order.closed_short', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} closed short` });
  res.json(po);
}));

router.post('/:id/cancel', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const po = await svc.cancel(req.params.id);
  await audit(req, 'purchase_order.cancelled', { entityType: 'purchase_order', entityId: po.id, summary: `${po.poNumber} cancelled` });
  res.json(po);
}));

module.exports = router;
