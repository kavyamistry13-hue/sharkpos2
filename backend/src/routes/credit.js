const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { audit } = require('../services/audit');
const svc = require('../services/credit');

const router = express.Router();
const id = z.coerce.number().int().positive();
const money = z.coerce.number().positive().max(1e7).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimals');
const mgr = authorize('business_owner', 'manager');
const owner = authorize('business_owner');
const params = z.object({ id });

router.get('/summary', mgr, validate({ query: z.object({ overdueDays: z.coerce.number().int().min(0).max(365).default(30) }) }), asyncH(async (req, res) => res.json(await svc.summary(req.query))));

router.get('/customers', mgr, validate({ query: z.object({ overdueDays: z.coerce.number().int().min(0).max(365).optional(), q: z.string().max(60).optional() }) }),
  asyncH(async (req, res) => res.json({ rows: await svc.listDebtors({ overdueDays: req.query.overdueDays ?? null, q: req.query.q || null }) })));

// Everyone at the till may see a customer's limit and balance (needed to take a credit sale); the full ledger is manager+.
router.get('/customers/:id/balance', validate({ params }), asyncH(async (req, res) => res.json(await svc.getBalance(req.params.id))));
router.get('/customers/:id', mgr, validate({ params }), asyncH(async (req, res) => res.json(await svc.getAccount(req.params.id))));

router.post('/customers/:id/payments', validate({ params, body: z.object({ amount: money, method: z.enum(['cash', 'upi', 'card']), note: z.string().trim().max(300).optional() }) }),
  asyncH(async (req, res) => {
    const out = await svc.recordPayment(req.user, req.params.id, req.body);
    await audit(req, 'credit.payment_received', { entityType: 'customer', entityId: req.params.id, summary: `₹${out.amount} ${out.method} from ${out.customer}`, oldValue: { balance: out.balanceBefore }, newValue: { balance: out.balanceAfter } });
    res.status(201).json(out);
  }));

router.post('/customers/:id/adjustments', owner, validate({ params, body: z.object({ amount: money, direction: z.enum(['increase', 'decrease']), note: z.string().trim().min(3, 'Write the reason').max(300) }) }),
  asyncH(async (req, res) => {
    const out = await svc.adjust(req.user, req.params.id, req.body);
    await audit(req, 'credit.adjusted', { entityType: 'customer', entityId: req.params.id, summary: `${req.body.direction} ₹${req.body.amount} · ${req.body.note}`, oldValue: { balance: out.balanceBefore }, newValue: { balance: out.balanceAfter } });
    res.status(201).json(out);
  }));

router.put('/customers/:id/limit', mgr, validate({ params, body: z.object({ creditLimit: z.coerce.number().min(0).max(1e7) }) }),
  asyncH(async (req, res) => {
    const out = await svc.setCreditLimit(req.params.id, req.body.creditLimit);
    await audit(req, 'credit.limit_changed', { entityType: 'customer', entityId: req.params.id, summary: `${out.name}: ₹${out.before} → ₹${out.after}`, oldValue: { creditLimit: out.before }, newValue: { creditLimit: out.after } });
    res.json(out);
  }));

// Free WhatsApp "click to chat" link. Nothing is sent from here; the owner taps the link and presses send in their own WhatsApp.
router.get('/customers/:id/reminder', mgr, validate({ params, query: z.object({ lang: z.enum(['en', 'hi']).default('en') }) }),
  asyncH(async (req, res) => {
    const out = await svc.buildReminder(req.params.id, { lang: req.query.lang });
    await audit(req, 'credit.reminder_prepared', { entityType: 'customer', entityId: req.params.id, summary: `WhatsApp reminder prepared for ${out.name} (₹${out.balance})` });
    res.json(out);
  }));

module.exports = router;
