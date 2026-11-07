const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const asyncH = require('../utils/async');
const { audit } = require('../services/audit');
const svc = require('../services/shifts');
const { notFound } = require('../utils/errors');

const router = express.Router();   // all roles; a cashier only ever sees and closes their own shift
const id = z.coerce.number().int().positive();
const cash = z.coerce.number().min(0).max(1e8).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimals');
const closeBody = z.object({ countedCash: cash, notes: z.string().trim().max(500).optional(), handoverTo: id.nullable().optional(), handoverNote: z.string().trim().max(500).optional() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

router.get('/current', asyncH(async (req, res) => res.json(await svc.currentShift(req.user))));

router.post('/open', validate({ body: z.object({ openingCash: cash }) }), asyncH(async (req, res) => {
  const s = await svc.openShift(req.user, req.body);
  await audit(req, 'shift.opened', { entityType: 'shift', entityId: s.id, summary: `Shift opened with ₹${s.openingCash}`, newValue: { openingCash: s.openingCash } });
  res.status(201).json(s);
}));

async function close(req, res, shiftId) {
  const s = await svc.closeShift(req.user, shiftId, req.body);
  await audit(req, 'shift.closed', { entityType: 'shift', entityId: s.id, summary: `Shift closed · expected ₹${s.expectedCash}, counted ₹${s.countedCash}, variance ₹${s.variance}`, newValue: { expectedCash: s.expectedCash, countedCash: s.countedCash, variance: s.variance, handoverTo: s.handoverTo && s.handoverTo.id } });
  res.json(s);
}
router.post('/close', validate({ body: closeBody }), asyncH(async (req, res) => {
  const cur = await svc.currentShift(req.user);
  if (!cur.shift) throw notFound('You do not have an open shift.');
  return close(req, res, cur.shift.id);
}));

router.get('/', validate({ query: z.object({ status: z.enum(['open', 'closed']).optional(), userId: id.optional(), from: date.optional(), to: date.optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  asyncH(async (req, res) => res.json(await svc.listShifts(req.user, req.query))));
router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getShift(req.params.id, req.user))));
router.post('/:id/close', validate({ params: z.object({ id }), body: closeBody }), asyncH((req, res) => close(req, res, req.params.id)));

module.exports = router;
