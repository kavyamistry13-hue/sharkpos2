// Held bills (parked carts). Any till role may use them; a cashier sees and touches only their own, managers/owners see all.
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const asyncH = require('../utils/async');
const holds = require('../services/holds');
const { audit } = require('../services/audit');
const { idempotencyKey } = require('../utils/idempotency');
const { quantitySchema } = require('../utils/units');
const sales = require('./sales');
const { badRequest } = require('../utils/errors');

const router = express.Router();
const id = z.coerce.number().int().positive();
const cartBody = {
  items: z.array(z.object({ productId: id, quantity: quantitySchema })).min(1, 'Add at least one product.').max(100),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.coerce.number().min(0).max(1e7) }).refine((d) => d.type !== 'percent' || d.value <= 100, { message: 'A percentage discount cannot be more than 100.', path: ['value'] }).nullable().optional(),
  customerId: id.nullable().optional(),
  label: z.string().trim().max(60).nullable().optional(),
};
const brief = (h) => `Held bill #${h.id}${h.label ? ` “${h.label}”` : ''} · ${h.itemCount} item(s)`;

router.get('/', validate({ query: z.object({ status: z.enum(['held', 'completed', 'discarded']).default('held') }) }), asyncH(async (req, res) => res.json({ holds: await holds.listHolds(req.user, req.query) })));

router.post('/', validate({ body: z.object(cartBody) }), asyncH(async (req, res) => {
  const { hold, replayed } = await holds.createHold(req.user, req.body, idempotencyKey(req, { optional: true, what: 'hold' }));
  if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json({ hold });
  await audit(req, 'hold.created', { entityType: 'held_bill', entityId: hold.id, summary: brief(hold), newValue: { items: hold.items.length, estimatedTotal: hold.estimatedTotal } });
  res.status(201).json({ hold });
}));

router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await holds.getHold(req.user, req.params.id))));

router.post('/:id/resume', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const out = await holds.resumeHold(req.user, req.params.id);
  await audit(req, 'hold.resumed', { entityType: 'held_bill', entityId: req.params.id, summary: brief(out.hold), newValue: { issues: out.issues.length } });
  res.json(out);
}));

router.put('/:id', validate({ params: z.object({ id }), body: z.object({ ...cartBody, version: z.coerce.number().int().positive().optional() }) }), asyncH(async (req, res) => {
  const out = await holds.updateHold(req.user, req.params.id, req.body);
  await audit(req, 'hold.updated', { entityType: 'held_bill', entityId: req.params.id, summary: brief(out.hold), newValue: { version: out.hold.version, items: out.hold.items.length } });
  res.json(out);
}));

router.post('/:id/discard', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const { hold, already } = await holds.discardHold(req.user, req.params.id);
  if (!already) await audit(req, 'hold.discarded', { entityType: 'held_bill', entityId: req.params.id, summary: brief(hold) });
  res.json({ hold });
}));

// Completes the parked cart AS IT IS ON THE SERVER (items, discount, customer), through the one normal sale path. Pay with paymentMethod or split payments.
router.post('/:id/complete', validate({ params: z.object({ id }), body: z.object({
  paymentMethod: z.enum(['cash', 'upi', 'card', 'credit']).optional(),
  payments: z.array(z.object({ method: z.enum(['cash', 'upi', 'card', 'credit']), amount: z.coerce.number().positive().max(1e7) })).min(1).max(4).optional(),
  approval: z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional(),
}).refine((b) => !(b.paymentMethod && b.payments), { message: 'Send either paymentMethod or payments, not both.', path: ['payments'] }) }), asyncH(async (req, res) => {
  const { hold } = await holds.getHold(req.user, req.params.id);
  // No status pre-check on purpose: a retry with the SAME key must replay the original sale; a NEW key on a completed/discarded hold is refused inside createSale (409).
  const body = { items: hold.items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity) })), discount: hold.discount, customerId: hold.customerId, heldBillId: hold.id, ...req.body };
  if (!body.paymentMethod && !body.payments) throw badRequest('Choose a payment method.', { code: 'PAYMENT_REQUIRED' });
  return sales.completeSale(req, res, body);
}));

module.exports = router;
