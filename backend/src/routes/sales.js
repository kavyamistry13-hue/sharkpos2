const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/sales');
const { quantitySchema } = require('../utils/units');

const { audit } = require('../services/audit');
const { idempotencyKey } = require('../utils/idempotency');
const returns = require('../services/returns');
const router = express.Router();
const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const cart = {
  items: z.array(z.object({ productId: id, quantity: quantitySchema })).min(1, 'Add at least one product.').max(100),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.coerce.number().min(0).max(1e7) }).nullable().optional(),
};

router.post('/preview', validate({ body: z.object(cart) }), asyncH(async (req, res) => res.json(await svc.previewBill(req.body))));

const payMethod = z.enum(['cash', 'upi', 'card', 'credit']);
const payLine = z.object({ method: payMethod, amount: z.coerce.number().positive('Enter an amount above zero.').max(1e7) });

/** Body of a sale. Exactly one of paymentMethod (one tender) or payments (split tender) — the server checks the lines add up to the bill. */
const saleBody = z.object({
  ...cart,
  customerId: id.nullable().optional(),
  paymentMethod: payMethod.optional(),
  payments: z.array(payLine).min(1).max(4).optional(),
  heldBillId: id.optional(),
  approval: z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional(),
}).refine((b) => !(b.paymentMethod && b.payments), { message: 'Send either paymentMethod or payments, not both.', path: ['payments'] });

/** Shared by POST /sales and POST /held-bills/:id/complete so there is ONE sale path. */
async function completeSale(req, res, body) {
  // Every submission must carry a client-generated key so a retry (lost response, timeout, server restart) can never sell twice.
  const key = idempotencyKey(req, { what: 'sale' });
  const { sale, replayed } = await svc.createSale(req.user, body, key);
  if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json(sale);   // same sale as the first time; nothing was processed again
  await audit(req, 'sale.created', { entityType: 'sale', entityId: sale.id, summary: `Sale ${sale.invoiceNo} · ₹${sale.total} · ${sale.paymentMethod}${body.heldBillId ? ` · from held bill #${body.heldBillId}` : ''}`, newValue: { total: sale.total, discount: sale.discount, payments: sale.payments, heldBillId: body.heldBillId || null, items: body.items.length } });
  return res.status(201).json(sale);
}

router.post('/', validate({ body: saleBody }), asyncH(async (req, res) => completeSale(req, res, req.body)));

router.get('/limits', asyncH(async (req, res) => res.json(await svc.discountLimits())));

router.get(
  '/',
  validate({
    query: z.object({
      from: date.optional(), to: date.optional(), employeeId: id.optional(), q: z.string().max(60).optional(),
      payment: z.enum(['cash', 'upi', 'card', 'credit', 'split']).optional(), status: z.enum(['completed', 'refunded', 'cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  asyncH(async (req, res) => res.json(await svc.listSales(req.user, req.query))),
);

router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getSale(req.params.id, req.user))));

const returnBody = z.object({
  items: z.array(z.object({ saleItemId: id, quantity: quantitySchema, restock: z.boolean().optional() })).min(1, 'Choose at least one item to return.').max(100),
  reason: z.enum(returns.REASONS).default('other'),
  note: z.string().trim().max(300).optional(),
  refunds: z.array(payLine).min(1).max(4).optional(),
});
// Line-level (partial) return. Cashiers: only their own recent bills (the service enforces it). Needs an Idempotency-Key so a retry never refunds twice.
router.post('/:id/returns', validate({ params: z.object({ id }), body: returnBody }), asyncH(async (req, res) => {
  const key = idempotencyKey(req, { what: 'return' });
  const { return: ret, replayed } = await returns.processReturn(req.user, req.params.id, req.body, key);
  const sale = await svc.getSale(req.params.id, req.user);
  if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json({ return: ret, sale });
  await audit(req, 'sale.returned', { entityType: 'sale', entityId: req.params.id, summary: `Return on sale #${req.params.id} · ₹${ret.total} · ${ret.reason}${ret.completesSale ? ' · whole bill' : ''}`, newValue: { returnId: ret.id, total: ret.total, reason: ret.reason, items: ret.items.map((i) => [i.saleItemId, i.quantity, i.restocked]), refunds: ret.refunds } });
  return res.status(201).json({ return: ret, sale });
}));

router.post('/:id/refund', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const out = await svc.refundSale(req.params.id, req.user);
  await audit(req, 'sale.refunded', { entityType: 'sale', entityId: req.params.id, summary: `Sale #${req.params.id} refunded` });
  res.json(out);
}));

module.exports = router;
module.exports.completeSale = completeSale;
module.exports.saleBody = saleBody;
