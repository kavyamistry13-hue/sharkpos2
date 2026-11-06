const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/customers');

const router = express.Router();
const id = z.coerce.number().int().positive();
const mgr = authorize('business_owner', 'manager');

// Cashiers need to look up / add a customer at the till; they get the lightweight search only.
router.get('/search', validate({ query: z.object({ q: z.string().max(40).optional() }) }), asyncH(async (req, res) => res.json({ rows: await svc.searchCustomers(req.query.q) })));

router.post('/', validate({ body: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().regex(/^[0-9+\-\s]{7,15}$/, 'Enter a valid phone number'), email: z.string().trim().email().max(190).nullable().optional().or(z.literal('').transform(() => null)) }) }), asyncH(async (req, res) => res.status(201).json(await svc.createCustomer(req.body))));

router.get('/', mgr, validate({ query: z.object({ q: z.string().max(60).optional(), segment: z.enum(['all', 'new', 'regular', 'vip', 'inactive']).optional(), sort: z.enum(['spending', 'orders', 'recent', 'name']).default('spending'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }) }), asyncH(async (req, res) => res.json(await svc.listCustomers(req.query))));

router.get('/:id', mgr, validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getCustomer(req.params.id))));

module.exports = router;
