// Owner/manager intelligence. Read-only: these endpoints never change data, and the figures are plain deterministic rules over existing records.
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const actions = require('../services/intelligence/actions');
const inv = require('../services/intelligence/inventory');
const leaks = require('../services/intelligence/profitLeaks');
const sup = require('../services/intelligence/suppliers');
const { recordSeen } = require('../services/measurement/decisions');

const router = express.Router();
router.use(authorize('business_owner', 'manager'));
const days = (def, max = 365) => z.coerce.number().int().min(7).max(max).default(def);

router.get('/actions', validate({ query: z.object({ category: z.enum(['stock', 'money', 'suppliers', 'profit', 'operations']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }), asyncH(async (req, res) => { const r = await actions.actionCenter(req.query); await recordSeen(r.actions); res.json(r); }));
router.get('/today', validate({ query: z.object({ top: z.coerce.number().int().min(1).max(20).default(7) }) }), asyncH(async (req, res) => { const r = await actions.todayList(req.query); await recordSeen(r.actions); res.json(r); }));
router.get('/inventory-cash', validate({ query: z.object({ deadDays: days(60) }) }), asyncH(async (req, res) => res.json(await inv.inventoryCash(req.query))));
router.get('/dead-stock', validate({ query: z.object({ days: days(60), limit: z.coerce.number().int().min(1).max(500).default(100) }) }), asyncH(async (req, res) => res.json(await inv.deadStock(req.query))));
router.get('/profit-leaks', validate({ query: z.object({ days: days(30, 180), thinMarginPct: z.coerce.number().min(1).max(50).default(8) }) }), asyncH(async (req, res) => res.json(await leaks.profitLeaks(req.query))));
router.get('/suppliers', validate({ query: z.object({ days: days(90) }) }), asyncH(async (req, res) => res.json(await sup.supplierIntelligence(req.query))));

module.exports = router;
