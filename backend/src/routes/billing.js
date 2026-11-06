const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { notFound } = require('../utils/errors');
const sub = require('../services/billing/subscription');
const pay = require('../services/billing/payments');
const { listPlans } = require('../services/billing/plans');
const { getGateway } = require('../services/billing/gateway');

const router = express.Router();
const owner = authorize('business_owner');
const planCode = z.string().trim().min(1).max(30);

// Every signed-in role: just enough to show the banner and hide/lock features.
router.get('/status', asyncH(async (req, res) => res.json(await sub.getStatus(req.user.businessId))));
router.get('/plans', asyncH(async (_req, res) => res.json({ plans: await listPlans() })));

// Owner only: money, usage, history.
router.get('/', owner, asyncH(async (req, res) => res.json({ ...(await sub.getBilling(req.user.businessId)), gateway: { provider: getGateway().name, configured: getGateway().configured() } })));
router.post('/checkout', owner, validate({ body: z.object({ planCode: planCode.optional() }) }), asyncH(async (req, res) => res.status(201).json(await pay.createCheckout(req, req.body.planCode))));
router.post('/verify', owner, validate({ body: z.object({ orderId: z.string().min(5).max(80), paymentId: z.string().min(5).max(80), signature: z.string().min(10).max(200) }) }), asyncH(async (req, res) => res.json(await pay.verifyFromClient(req, req.body))));
router.post('/change-plan', owner, validate({ body: z.object({ planCode }) }), asyncH(async (req, res) => res.json(await sub.changePlan(req, req.body.planCode))));
router.post('/cancel', owner, asyncH(async (req, res) => { await sub.cancel(req); res.json({ ok: true }); }));
router.post('/resume', owner, asyncH(async (req, res) => { await sub.resume(req); res.json({ ok: true }); }));

// Development / tests only (the mock provider cannot be enabled in production): stands in for the Razorpay checkout window.
router.post('/dev/simulate-payment', owner, validate({ body: z.object({ orderId: z.string().min(5).max(80) }) }), asyncH(async (req, res) => {
  const gw = getGateway();
  if (gw.name !== 'mock') throw notFound('Not found');
  res.json(gw.simulatePayment(req.body.orderId));
}));

module.exports = router;
