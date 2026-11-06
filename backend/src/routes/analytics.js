const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/analytics');

const router = express.Router();
const range = z.object({ range: z.enum(['today', '7d', '30d', '3m']).default('7d') });

router.use(authorize('business_owner', 'manager'));
router.get('/overview', asyncH(async (_req, res) => res.json(await svc.getOverview())));
router.get('/sales', validate({ query: range }), asyncH(async (req, res) => res.json(await svc.getSalesAnalytics(req.query.range))));
router.get('/products', validate({ query: range }), asyncH(async (req, res) => res.json(await svc.getProductAnalytics(req.query.range))));

module.exports = router;
