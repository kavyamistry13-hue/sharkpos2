const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/settings');

const { audit } = require('../services/audit');
const router = express.Router();

router.get('/', asyncH(async (_req, res) => res.json(await svc.getSettings())));
router.put('/', authorize('business_owner'), validate({ body: z.object({ storeName: z.string().trim().min(1).max(80).optional(), storeAddress: z.string().trim().max(200).optional(), gstin: z.string().trim().max(20).optional(), invoiceFooter: z.string().trim().max(200).optional(), cashierMaxDiscountPct: z.coerce.number().min(0).max(30).optional() }) }), asyncH(async (req, res) => {
  const before = await svc.getSettings();
  const after = await svc.updateSettings(req.body);
  const was = {}; const now = {};
  for (const k of Object.keys(req.body)) if (before[k] !== after[k]) { was[k] = before[k]; now[k] = after[k]; }
  await audit(req, 'settings.changed', { entityType: 'settings', summary: `Business settings changed: ${Object.keys(now).join(', ') || 'no change'}`, oldValue: was, newValue: now });
  res.json(after);
}));

module.exports = router;
