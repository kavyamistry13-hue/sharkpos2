const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/products');
const { audit } = require('../services/audit');
const { UNITS, stockSchema } = require('../utils/units');

const router = express.Router();
const id = z.coerce.number().int().positive();
const optId = z.coerce.number().int().positive().optional();

const base = z.object({
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: z.string().trim().min(1).max(64).optional(),   // optional manufacturer barcode, saved with the product
  name: z.string().trim().min(1).max(160),
  categoryId: id,
  purchasePrice: z.coerce.number().min(0).max(1e6),
  sellingPrice: z.coerce.number().min(0).max(1e6),
  stock: stockSchema.default(0),
  minimumStock: stockSchema.default(0),
  maxStock: stockSchema.nullable().optional(),        // Phase 9: optional; NULL = no upper target
  reorderLevel: stockSchema.nullable().optional(),    // Phase 9: optional; NULL = reorder at the minimum stock
  unit: z.enum(UNITS).default('pcs'),
  priceIncludesTax: z.boolean().default(false),
  supplierId: z.coerce.number().int().positive().nullable().optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(120).default(3),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
});

// A partial update must not re-apply the create-time defaults (Zod 4 would otherwise reset stock, unit, etc. when they are omitted).
const update = z.object(Object.fromEntries(Object.entries(base.shape).filter(([k]) => k !== 'barcode').map(([k, v]) => [k, v instanceof z.ZodDefault ? v.def.innerType : v]))).partial();

router.get('/lookups', asyncH(async (_req, res) => res.json(await svc.getLookups())));

// POS search is open to every signed-in role; management list needs manager+
router.get('/pos-search', validate({ query: z.object({ q: z.string().max(80).optional() }) }), asyncH(async (req, res) => res.json({ rows: await svc.searchForPos(req.query.q) })));
// Offline POS (Phase 17): the minimum a till needs to keep selling without the server. Prices, tax, stock, unit and barcodes only: never cost, supplier or margin.
router.get('/offline-catalog', validate({ query: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }) }), asyncH(async (req, res) => res.json(await svc.offlineCatalog(req.query))));

router.get(
  '/',
  authorize('business_owner', 'manager'),
  validate({
    query: z.object({
      q: z.string().max(80).optional(), categoryId: optId, supplierId: optId,
      status: z.enum(['in_stock', 'low_stock', 'out_of_stock', 'expired']).optional(),
      reorder: z.enum(['true']).transform(() => true).optional(), batch: z.enum(['yes', 'no']).optional(), expiry: z.enum(['expired', '7', '30', '90']).optional(), active: z.enum(['active', 'inactive']).optional(),
      sort: z.enum(['name', 'price', 'stock', 'category', 'sku', 'risk', 'margin']).default('name'),
      dir: z.enum(['asc', 'desc']).default('asc'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(25),
    }),
  }),
  asyncH(async (req, res) => res.json(await svc.listProducts(req.query))),
);

router.get('/:id', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getProduct(req.params.id))));

router.post('/', authorize('business_owner', 'manager'), validate({ body: base }), asyncH(async (req, res) => {
  const p = await svc.createProduct(req.body, req.user.id);
  await audit(req, 'product.created', { entityType: 'product', entityId: p.id, summary: `Product "${p.name}" created at ₹${p.sellingPrice}`, newValue: { name: p.name, sellingPrice: p.sellingPrice, stock: p.stock } });
  res.status(201).json(p);
}));

router.put('/:id', authorize('business_owner', 'manager'), validate({ params: z.object({ id }), body: update }), asyncH(async (req, res) => {
  const before = await svc.getProduct(req.params.id);
  const after = await svc.updateProduct(req.params.id, req.body, req.user.id);
  const changed = {}; const was = {};
  for (const k of ['name', 'sellingPrice', 'purchasePrice', 'minimumStock', 'sku', 'unit', 'priceIncludesTax']) if (before[k] !== after[k]) { was[k] = before[k]; changed[k] = after[k]; }
  const priceChanged = 'sellingPrice' in changed;
  await audit(req, priceChanged ? 'product.price_changed' : 'product.updated', { entityType: 'product', entityId: req.params.id, summary: priceChanged ? `Changed price of "${after.name}" from ₹${was.sellingPrice} to ₹${changed.sellingPrice}` : `Product "${after.name}" edited`, oldValue: was, newValue: changed });
  res.json(after);
}));

// Purchase-cost history (newest first) and the suppliers that sell this product, with their last known cost.
router.get('/:id/cost-history', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json({ rows: await svc.getCostHistory(req.params.id) })));
router.get('/:id/suppliers', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json({ rows: await svc.getProductSuppliers(req.params.id) })));

router.delete('/:id', authorize('business_owner'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const before = await svc.getProduct(req.params.id);
  await svc.deleteProduct(req.params.id);
  await audit(req, 'product.deleted', { entityType: 'product', entityId: req.params.id, summary: `Product "${before.name}" deleted (archived)`, oldValue: { name: before.name, stock: before.stock } });
  res.json({ ok: true });
}));

module.exports = router;
