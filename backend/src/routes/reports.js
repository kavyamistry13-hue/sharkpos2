const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { audit } = require('../services/audit');
const svc = require('../services/dailyOps');

const router = express.Router();
const mgr = authorize('business_owner', 'manager');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cash = z.coerce.number().min(0).max(1e8).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimals');

router.get('/closing', mgr, validate({ query: z.object({ date: date.optional() }) }), asyncH(async (req, res) => res.json(await svc.closingReport(req.query.date))));

router.get('/cash-reconciliations', mgr, validate({ query: z.object({ from: date.optional(), to: date.optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }) }),
  asyncH(async (req, res) => res.json({ rows: await svc.listReconciliations(req.query) })));

router.post('/cash-reconciliations', mgr, validate({ body: z.object({ date: date.optional(), openingCash: cash.optional(), actualCash: cash, notes: z.string().trim().max(500).optional() }) }),
  asyncH(async (req, res) => {
    const r = await svc.recordReconciliation(req.user, req.body);
    await audit(req, 'cash.reconciled', { entityType: 'cash_reconciliation', entityId: r.id, summary: `${r.date}: expected ₹${r.expectedCash}, counted ₹${r.actualCash}, variance ₹${r.variance}`, newValue: { expectedCash: r.expectedCash, actualCash: r.actualCash, variance: r.variance, openingCash: r.openingCash } });
    res.status(201).json(r);
  }));

module.exports = router;
