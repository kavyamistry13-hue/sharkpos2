const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/inventory');
const products = require('../services/products');
const { quantitySchema } = require('../utils/units');

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
// Phase 8.1: "Add stock" from the Scan & Add screen when a scanned barcode already belongs to a product. Atomic increment, owner/manager only.
router.post('/:productId/add-stock', mgr, validate({ params: z.object({ productId: id }), body: z.object({ quantity: quantitySchema }) }), asyncH(async (req, res) => {
  const r = await products.addStock(req.params.productId, req.body.quantity, req.user.id);
  await audit(req, 'inventory.stock_added', { entityType: 'product', entityId: req.params.productId, summary: `+${req.body.quantity} ${r.unit} added to "${r.name}" (stock ${r.before} → ${r.after})`, oldValue: { stock: r.before }, newValue: { stock: r.after } });
  res.json({ productId: req.params.productId, name: r.name, unit: r.unit, stockBefore: r.before, stock: r.after });
}));
router.get('/:productId/movements', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => res.json({ rows: await svc.getMovements(req.params.productId) })));

module.exports = router;
