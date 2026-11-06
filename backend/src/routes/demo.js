const express = require('express');
const { z } = require('zod');
const config = require('../config');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { forbidden, conflict } = require('../utils/errors');
const { loadDemoData } = require('../seed/demo');
const { query, sysQuery } = require('../db');
const { audit } = require('../services/audit');

const router = express.Router();
const running = new Set();

const isDemoBusiness = async (businessId) => (await sysQuery('SELECT is_demo FROM businesses WHERE id = $1', [businessId])).rows[0]?.is_demo === true;

router.get('/status', asyncH(async (req, res) => {
  const r = await query('SELECT (SELECT COUNT(*)::int FROM sales) AS sales, (SELECT COUNT(*)::int FROM products) AS products');
  res.json({ enabled: config.allowDemo && (await isDemoBusiness(req.user.businessId)), ...r.rows[0] });
}));

// Wipes THIS business's data and reloads the prepared demo dataset. Only for businesses flagged as demo — a real
// customer's business can never be reset from here.
router.post('/load', authorize('business_owner'), validate({ body: z.object({ confirm: z.literal(true, { errorMap: () => ({ message: 'Confirmation required' }) }) }) }), asyncH(async (req, res) => {
  if (!config.allowDemo || !(await isDemoBusiness(req.user.businessId))) throw forbidden('Demo reset is only available for demo businesses.');
  if (running.has(req.user.businessId)) throw conflict('Demo data is already being loaded. Please wait.');
  running.add(req.user.businessId);
  try {
    const summary = await loadDemoData({ businessId: req.user.businessId });
    await audit(req, 'demo.reset', { summary: 'Demo data reloaded' });
    res.json({ ok: true, summary });
  } finally {
    running.delete(req.user.businessId);
  }
}));

module.exports = router;
