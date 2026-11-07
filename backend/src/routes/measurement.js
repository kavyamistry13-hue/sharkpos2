// Sprint 5 — measurement & value. Everything is deterministic and tenant-scoped. Verified value is written only by the measurement engine;
// there is deliberately no endpoint that accepts a verified figure.
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { audit } = require('../services/audit');
const decisions = require('../services/measurement/decisions');
const outcomes = require('../services/measurement/outcomes');
const ledger = require('../services/measurement/ledger');
const metrics = require('../services/measurement/metrics');

const router = express.Router();
const id = z.coerce.number().int().positive();
const params = z.object({ id });
const mgr = authorize('business_owner', 'manager');
const owner = authorize('business_owner');
const days = z.coerce.number().int().min(7).max(365).default(90);
const VALUE_TYPES = ['recovered_credit', 'inventory_released', 'margin_improvement', 'cost_saving', 'avoided_loss', 'recovered_cash', 'stockout_impact'];
router.use(mgr);

router.post('/decisions', validate({ body: z.object({ actionId: z.string().trim().min(1).max(120), decision: z.enum(['accepted', 'rejected', 'deferred']), reason: z.string().trim().max(500).optional() }) }),
  asyncH(async (req, res) => {
    const out = await decisions.recordDecision(req.user, req.body);
    if (!out.duplicate) await audit(req, `action.${req.body.decision}`, { entityType: 'action_decision', entityId: out.decision.id, summary: `${req.body.decision}: ${out.decision.recommendation.title}`, newValue: { actionKey: req.body.actionId, decision: req.body.decision, reason: req.body.reason || null } });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));
router.get('/decisions', validate({ query: z.object({ latest: z.enum(['true', 'false']).default('false'), decision: z.enum(['accepted', 'rejected', 'deferred']).optional(), category: z.enum(['stock', 'money', 'suppliers', 'profit', 'operations']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(25) }) }),
  asyncH(async (req, res) => res.json(await decisions.listDecisions({ ...req.query, latest: req.query.latest === 'true' }))));
router.get('/decisions/:id', validate({ params }), asyncH(async (req, res) => res.json(await decisions.getDecision(req.params.id))));
router.post('/decisions/:id/evaluate', validate({ params }), asyncH(async (req, res) => {
  await decisions.getDecision(req.params.id);   // 404 for anything outside this business
  const r = await outcomes.evaluateDecision(req.user, req.params.id);
  if (!r) return res.json({ evaluated: false, message: 'Only accepted decisions are measured.' });
  res.json({ evaluated: true, changed: r.changed, newLedgerEntries: r.ledgerEntries, decision: await decisions.getDecision(req.params.id) });
}));
router.post('/evaluate', asyncH(async (req, res) => res.json(await outcomes.evaluateAll(req.user))));

router.get('/accuracy', validate({ query: z.object({ days }) }), asyncH(async (req, res) => res.json(await metrics.accuracy(req.query))));
router.get('/store-health', asyncH(async (req, res) => res.json(await metrics.storeHealth())));
router.get('/roi', validate({ query: z.object({ days }) }), asyncH(async (req, res) => res.json(await metrics.roi(req.query))));

router.get('/value-ledger', validate({ query: z.object({ verification: z.enum(['verified', 'reported']).optional(), valueType: z.enum(VALUE_TYPES).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
  asyncH(async (req, res) => res.json(await ledger.listEntries(req.query))));
router.post('/value-ledger/reported', validate({ body: z.object({ valueType: z.enum(VALUE_TYPES), amount: z.coerce.number().positive().max(1e7).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimals'), explanation: z.string().trim().min(10, 'Explain what this figure is based on (at least 10 characters)').max(500), decisionId: id.optional() }) }),
  asyncH(async (req, res) => {
    const e = await ledger.recordReported(req.user, req.body);
    await audit(req, 'value.reported', { entityType: 'value_ledger', entityId: e.id, summary: `User-reported ₹${e.amount} (${e.valueType}) — not verified`, newValue: { amount: e.amount, valueType: e.valueType } });
    res.status(201).json(e);
  }));
router.post('/value-ledger/:id/correct', owner, validate({ params, body: z.object({ note: z.string().trim().min(3, 'Write the reason').max(300) }) }),
  asyncH(async (req, res) => {
    const e = await ledger.correct(req.user, req.params.id, req.body);
    await audit(req, 'value.corrected', { entityType: 'value_ledger', entityId: e.id, summary: `Reversed ledger entry #${req.params.id} (₹${e.amount})`, newValue: { reverses: Number(req.params.id), note: req.body.note } });
    res.status(201).json(e);
  }));

module.exports = router;
