const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/inventory');
const products = require('../services/products');
const stockOps = require('../services/stockOps');
const batchSvc = require('../services/batches');
const { quantitySchema } = require('../utils/units');

const router = express.Router();
const id = z.coerce.number().int().positive();
const { audit } = require('../services/audit');
const mgr = authorize('business_owner', 'manager');

router.get('/', mgr, validate({ query: z.object({
  filter: z.enum(['low', 'out', 'over', 'fast', 'slow', 'expiring', 'atrisk', 'reorder', 'expired', 'expiring7', 'expiring30', 'expiring90', 'batch', 'nobatch']).optional(),
  categoryId: z.coerce.number().int().positive().optional(), supplierId: z.coerce.number().int().positive().optional(),
}) }), asyncH(async (req, res) => res.json(await svc.getInventory(req.query.filter, { categoryId: req.query.categoryId, supplierId: req.query.supplierId }))));
router.get('/reorder', mgr, asyncH(async (_req, res) => res.json(await svc.getReorderList())));
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
// Phase 9: expiry report (batches + legacy product-level dates) and per-product batches. Expiry is optional: products without it never appear.
router.get('/expiry', mgr, validate({ query: z.object({ within: z.enum(['expired', '7', '30', '90', 'all']).default('all') }) }), asyncH(async (req, res) => res.json(await batchSvc.expiryReport(req.query.within))));
router.get('/batches', mgr, validate({ query: z.object({ q: z.string().max(80).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }) }), asyncH(async (req, res) => res.json(await batchSvc.listAll(req.query))));
router.get('/:productId/batches', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => res.json({ rows: await batchSvc.listForProduct(req.params.productId) })));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31.').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a valid date.');
router.post('/:productId/batches', mgr, validate({
  params: z.object({ productId: id }),
  body: z.object({ quantity: quantitySchema, batchNo: z.string().trim().min(1).max(40).optional(), manufacturedDate: dateStr.optional(), expiryDate: dateStr.optional(), unitCost: z.coerce.number().min(0).max(1e6).optional() }),
}), asyncH(async (req, res) => {
  const r = await stockOps.addBatchStock(req.params.productId, req.body, req.user.id);
  await audit(req, 'batch.created', { entityType: 'product', entityId: req.params.productId, summary: `Batch ${r.batchNo} of "${r.name}": +${req.body.quantity} ${r.unit}${req.body.expiryDate ? `, expires ${req.body.expiryDate}` : ''}`, newValue: { batchId: r.batchId, batchNo: r.batchNo, quantity: req.body.quantity, expiryDate: req.body.expiryDate || null } });
  res.status(201).json({ productId: req.params.productId, batchId: r.batchId, batchNo: r.batchNo, stockBefore: r.before, stock: r.after });
}));
// Phase 9: stock adjustment with a mandatory reason (owner/manager; a cashier gets 403 from `mgr`). delta is signed: + adds stock, − removes it.
router.post('/:productId/adjust', mgr, validate({
  params: z.object({ productId: id }),
  body: z.object({
    delta: z.coerce.number().refine((n) => n !== 0, 'The change in stock cannot be zero.').refine((n) => Math.abs(n) <= 1e6, 'Quantity looks too high.').refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, 'Use at most 3 decimal places.'),
    reason: z.enum(stockOps.REASONS),
    note: z.string().trim().max(200).optional(),
  }),
}), asyncH(async (req, res) => {
  const r = await stockOps.adjustStock(req.params.productId, req.body, req.user.id);
  await audit(req, 'inventory.adjusted', { entityType: 'product', entityId: req.params.productId, summary: `Stock of "${r.name}" ${r.delta > 0 ? '+' : ''}${r.delta} ${r.unit} (${req.body.reason}): ${r.before} → ${r.after}`, oldValue: { stock: r.before }, newValue: { stock: r.after, reason: req.body.reason, note: req.body.note || null, movementId: r.movementId } });
  if (r.delta > 0) await audit(req, 'inventory.stock_added', { entityType: 'product', entityId: req.params.productId, summary: `+${r.delta} ${r.unit} added to "${r.name}" (${req.body.reason})` });
  else await audit(req, 'inventory.stock_removed', { entityType: 'product', entityId: req.params.productId, summary: `${r.delta} ${r.unit} removed from "${r.name}" (${req.body.reason})` });
  res.status(201).json({ productId: req.params.productId, name: r.name, unit: r.unit, stockBefore: r.before, stock: r.after, delta: r.delta, movementId: r.movementId });
}));
router.get('/:productId/timeline', mgr, validate({ params: z.object({ productId: id }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: id.optional() }) }),
  asyncH(async (req, res) => res.json(await stockOps.getTimeline(req.params.productId, req.query))));
router.get('/:productId/movements', mgr, validate({ params: z.object({ productId: id }) }), asyncH(async (req, res) => res.json({ rows: await svc.getMovements(req.params.productId) })));

module.exports = router;
