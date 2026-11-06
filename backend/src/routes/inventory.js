const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/inventory');

const router = express.Router();
const id = z.coerce.number().int().positive();
const { audit } = require('../services/audit');
const mgr = authorize('business_owner', 'manager');

router.get('/', mgr, validate({ query: z.object({ filter: z.enum(['low', 'out', 'over', 'fast', 'slow', 'expiring', 'atrisk']).optional() }) }), asyncH(async (req, res) => res.json(await svc.getInventory(req.query.filter))));
router.get('/alerts', mgr, asyncH(async (_req, res) => res.json(await svc.getAlerts())));
router.get('/restock-orders', mgr, asyncH(async (_req, res) => res.json({ rows: await svc.listRestockOrders() })));
router.post('/restock-orders/:id/receive', mgr, validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const out = await svc.receiveRestock(req.params.id);
  await audit(req, 'inventory.restock_received', { entityType: 'restock_order', entityId: req.params.id, summary: `Restock order #${req.params.id} received into stock` });
  res.json(out);
}));
router.get('/:productId/movements', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => res.json({ rows: await svc.getMovements(req.params.productId) })));

module.exports = router;
