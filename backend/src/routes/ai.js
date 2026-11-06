const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const copilot = require('../ai/copilot');
const { getDailyBrief } = require('../ai/brief');
const { isConfigured } = require('../ai/llm');
const config = require('../config');
const inventory = require('../services/inventory');
const { getProductStats, restockReasons } = require('../services/forecast');
const { notFound } = require('../utils/errors');

const router = express.Router();
const id = z.coerce.number().int().positive();
const { audit } = require('../services/audit');
const mgr = authorize('business_owner', 'manager');
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'You are asking too fast. Please wait a moment.' } });

router.get('/status', mgr, (_req, res) => res.json({ llmConfigured: isConfigured(), provider: isConfigured() ? config.llm.provider : null, model: isConfigured() ? config.llm.model : null }));

router.post('/copilot', mgr, aiLimiter, validate({ body: z.object({ question: z.string().trim().min(2, 'Please type a question.').max(300) }) }), asyncH(async (req, res) => res.json(await copilot.ask(req.body.question))));

router.get('/brief', mgr, asyncH(async (_req, res) => res.json(await getDailyBrief())));

router.get('/restock', mgr, asyncH(async (_req, res) => {
  const rows = await inventory.getRestockRecommendations();
  res.json({ count: rows.length, totalCost: Math.round(rows.reduce((a, r) => a + r.estimatedCost, 0)), rows });
}));
router.post('/restock/:productId/approve', mgr, validate({ params: z.object({ productId: id }), body: z.object({ quantity: z.coerce.number().int().min(1).max(100000).optional() }).default({}) }), asyncH(async (req, res) => {
  const out = await inventory.approveRestock(req.params.productId, req.body.quantity, req.user);
  await audit(req, 'inventory.restock_approved', { entityType: 'product', entityId: req.params.productId, summary: `Restock approved: ${out.quantity ?? req.body.quantity ?? ''} units`, newValue: out });
  res.status(201).json(out);
}));
router.post('/restock/:productId/dismiss', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => res.json(await inventory.dismissRestock(req.params.productId, req.user))));

router.get('/forecast/:productId', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => {
  const p = (await getProductStats()).find((x) => x.id === req.params.productId);
  if (!p) throw notFound('Product not found.');
  res.json({
    method: 'Weighted moving average (14 days) adjusted by week-on-week trend; stockout probability from a normal demand model over the supplier lead time. Statistical, not machine learning.',
    product: { id: p.id, name: p.name, stock: p.stock, leadTimeDays: p.leadTimeDays, supplier: p.supplier },
    avgDailySales: p.avgDailySales, recentAvg7: p.avg7, trendPct: p.trendPct, forecastDaily: p.forecastDaily, projected7: p.projected7,
    demandLeadTime: p.demandLeadTime, safetyStock: p.safetyStock, daysToStockout: p.daysToStockout,
    stockoutRisk: p.stockoutRisk, riskLevel: p.riskLevel, recommendedQty: p.recommendedQty, reasons: p.recommendedQty > 0 ? restockReasons(p) : [],
    message: p.riskLevel === 'high' ? `HIGH STOCKOUT RISK — ${p.name} may run out soon.` : p.riskLevel === 'medium' ? `Medium stockout risk for ${p.name}.` : `${p.name} has enough stock for its lead time.`,
  });
}));

module.exports = router;
