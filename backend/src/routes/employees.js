const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/employees');
const { audit } = require('../services/audit');

const router = express.Router();
const id = z.coerce.number().int().positive();
const role = z.enum(['business_owner', 'manager', 'cashier']);
const pw = z.string().min(8).max(100).refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Use letters and numbers.');
router.use(authorize('business_owner', 'manager'));

router.get('/', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }), asyncH(async (req, res) => res.json({ days: req.query.days, rows: await svc.listEmployees(req.query.days) })));

router.post('/', validate({ body: z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(190), password: pw, role }) }), asyncH(async (req, res) => {
  const newId = await svc.createEmployee(req.body, req.user);
  await audit(req, 'employee.created', { entityType: 'employee', entityId: newId, summary: `Employee ${req.body.name} added as ${req.body.role}`, newValue: { name: req.body.name, email: req.body.email, role: req.body.role } });
  res.status(201).json({ ok: true, id: newId });
}));

router.put('/:id', validate({ params: z.object({ id }), body: z.object({ name: z.string().trim().min(1).max(120).optional(), role: role.optional(), isActive: z.boolean().optional(), password: pw.optional() }) }), asyncH(async (req, res) => {
  const { before, after } = await svc.updateEmployee(req.params.id, req.user, req.body);
  await audit(req, 'employee.updated', { entityType: 'employee', entityId: req.params.id, summary: `Employee ${after.name} updated${req.body.password ? ' (password reset)' : ''}`, oldValue: before, newValue: after });
  res.json({ ok: true });
}));

router.delete('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const gone = await svc.removeEmployee(req.params.id, req.user);
  await audit(req, 'employee.removed', { entityType: 'employee', entityId: req.params.id, summary: `Employee ${gone.name} removed`, oldValue: gone });
  res.json({ ok: true });
}));

module.exports = router;
