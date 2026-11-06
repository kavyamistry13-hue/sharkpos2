const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/sales');
const { quantitySchema } = require('../utils/units');

const { audit } = require('../services/audit');
const { badRequest } = require('../utils/errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const router = express.Router();
const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const cart = {
  items: z.array(z.object({ productId: id, quantity: quantitySchema })).min(1, 'Add at least one product.').max(100),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.coerce.number().min(0).max(1e7) }).nullable().optional(),
};

router.post('/preview', validate({ body: z.object(cart) }), asyncH(async (req, res) => res.json(await svc.previewBill(req.body))));

router.post(
  '/',
  validate({
    body: z.object({
      ...cart,
      customerId: id.nullable().optional(),
      paymentMethod: z.enum(['cash', 'upi', 'card']),
      approval: z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional(),
    }),
  }),
  asyncH(async (req, res) => {
    // Every submission must carry a client-generated key so a retry (lost response, timeout, server restart) can never sell twice.
    const key = String(req.get('idempotency-key') || '').trim().toLowerCase();
    if (!UUID.test(key)) throw badRequest('Idempotency-Key header is required (a UUID generated once per sale).', { code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const { sale, replayed } = await svc.createSale(req.user, req.body, key);
    if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json(sale);   // same sale as the first time; nothing was processed again
    await audit(req, 'sale.created', { entityType: 'sale', entityId: sale.id, summary: `Sale ${sale.invoiceNo} · ₹${sale.total} · ${req.body.paymentMethod}`, newValue: { total: sale.total, discount: sale.discount, items: req.body.items.length } });
    res.status(201).json(sale);
  }),
);

router.get('/limits', asyncH(async (req, res) => res.json(await svc.discountLimits())));

router.get(
  '/',
  validate({
    query: z.object({
      from: date.optional(), to: date.optional(), employeeId: id.optional(), q: z.string().max(60).optional(),
      payment: z.enum(['cash', 'upi', 'card']).optional(), status: z.enum(['completed', 'refunded', 'cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  asyncH(async (req, res) => res.json(await svc.listSales(req.user, req.query))),
);

router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getSale(req.params.id, req.user))));

router.post('/:id/refund', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const out = await svc.refundSale(req.params.id, req.user);
  await audit(req, 'sale.refunded', { entityType: 'sale', entityId: req.params.id, summary: `Sale #${req.params.id} refunded` });
  res.json(out);
}));

module.exports = router;
