const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const risk = require('../services/risk');
const sales = require('../services/sales');
const { query } = require('../db');

const router = express.Router();
const id = z.coerce.number().int().positive();
router.use(authorize('business_owner', 'manager'));

router.get('/alerts', validate({ query: z.object({ status: z.enum(['open', 'reviewed', 'dismissed']).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) }), asyncH(async (req, res) => {
  const [rows, summary] = await Promise.all([risk.listAlerts(req.query), risk.getRiskSummary()]);
  res.json({ summary, rows });
}));

// Recent transactions with their risk score (flagged or not)
router.get('/transactions', asyncH(async (_req, res) => {
  const r = await query(
    `SELECT s.id, s.invoice_no, s.total, s.discount, s.status, s.created_at, u.name AS employee, a.risk_score, a.severity
       FROM sales s JOIN users u ON u.id = s.employee_id LEFT JOIN anomaly_alerts a ON a.sale_id = s.id
      ORDER BY s.created_at DESC LIMIT 50`);
  res.json({ rows: r.rows.map((x) => ({ id: x.id, invoiceNo: x.invoice_no, total: x.total, discount: x.discount, status: x.status, createdAt: x.created_at, employee: x.employee, riskScore: x.risk_score, severity: x.severity })) });
}));

router.get('/alerts/:id/sale', validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const a = await query('SELECT sale_id FROM anomaly_alerts WHERE id = $1', [req.params.id]);
  if (!a.rowCount) return res.status(404).json({ error: 'Alert not found.' });
  res.json(await sales.getSale(a.rows[0].sale_id, req.user));
}));

router.post('/alerts/:id/status', validate({ params: z.object({ id }), body: z.object({ status: z.enum(['open', 'reviewed', 'dismissed']) }) }), asyncH(async (req, res) => {
  await risk.setAlertStatus(req.params.id, req.body.status, req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
