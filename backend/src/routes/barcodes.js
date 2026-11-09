// Manufacturer-barcode API (Phase 8), mounted on /api/products BEFORE the products router so /scan is not read as /:id.
//   GET    /scan?code=…                       every signed-in role (the cashier's scanner)   → found product (shop price/stock) or found:false
//   POST   /quick-create                      owner | manager   first-time registration: new product + barcode, atomically
//   GET    /:id/barcodes                      owner | manager
//   POST   /:id/barcodes                      owner | manager   link another manufacturer barcode to an existing product
//   PUT    /:id/barcodes/:barcodeId           owner | manager   replace the code and/or make it primary
//   DELETE /:id/barcodes/:barcodeId           owner | manager
// Tenant scope comes only from the authenticated context + forced RLS; a barcode/product id of another shop is simply "not found".
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/barcodes');
const products = require('../services/products');
const { audit } = require('../services/audit');
const { UNITS, stockSchema } = require('../utils/units');

const router = express.Router();
const id = z.coerce.number().int().positive();
const mgr = authorize('business_owner', 'manager');
const code = z.string().trim().min(1).max(64);        // detailed validation (and the friendly message) lives in the service

router.get('/scan', validate({ query: z.object({ code }) }), asyncH(async (req, res) => {
  const r = await svc.lookup(req.query.code);
  res.json({ ...r, canRegister: ['business_owner', 'manager'].includes(req.user.role) });
}));

router.post('/quick-create', mgr, validate({
  body: z.object({
    barcode: code,
    name: z.string().trim().min(1).max(160),
    sellingPrice: z.coerce.number().min(0).max(1e6),
    unit: z.enum(UNITS).default('pcs'),
    stock: stockSchema.default(0),
    categoryId: id.optional(),
    purchasePrice: z.coerce.number().min(0).max(1e6).optional(),
    priceIncludesTax: z.boolean().optional(),
  }),
}), asyncH(async (req, res) => {
  const r = await products.quickCreate(req.body, req.user.id);
  await audit(req, 'product.created', { entityType: 'product', entityId: r.product.id, summary: `Product "${r.product.name}" registered from barcode ${req.body.barcode} at ₹${r.product.sellingPrice}`, newValue: { name: r.product.name, sellingPrice: r.product.sellingPrice, stock: r.product.stock, barcode: req.body.barcode } });
  res.status(201).json(r.scan);
}));

router.get('/:id/barcodes', mgr, validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  await products.getProduct(req.params.id);   // 404 unless it is this shop's product
  res.json({ rows: await svc.listForProduct(req.params.id) });
}));

router.post('/:id/barcodes', mgr, validate({ params: z.object({ id }), body: z.object({ barcode: code, isPrimary: z.boolean().optional() }) }), asyncH(async (req, res) => {
  const r = await svc.addBarcode(req.params.id, req.body.barcode, req.user.id, { primary: req.body.isPrimary });
  await audit(req, 'product.barcode_added', { entityType: 'product', entityId: req.params.id, summary: `Barcode ${r.barcode.barcode} linked to "${r.product.name}"`, newValue: { barcode: r.barcode.barcode } });
  res.status(201).json({ barcode: r.barcode, scan: await svc.lookup(r.barcode.barcode) });
}));

router.put('/:id/barcodes/:barcodeId', mgr, validate({
  params: z.object({ id, barcodeId: id }),
  body: z.object({ barcode: code.optional(), isPrimary: z.boolean().optional() }).refine((b) => b.barcode !== undefined || b.isPrimary !== undefined, { message: 'Nothing to update.' }),
}), asyncH(async (req, res) => {
  const r = await svc.updateBarcode(req.params.id, req.params.barcodeId, req.body, req.user.id);
  const replaced = r.before !== r.barcode.barcode;
  await audit(req, replaced ? 'product.barcode_replaced' : 'product.barcode_primary', {
    entityType: 'product', entityId: req.params.id,
    summary: replaced ? `Barcode ${r.before} replaced by ${r.barcode.barcode} on "${r.product.name}"` : `Barcode ${r.barcode.barcode} made primary for "${r.product.name}"`,
    oldValue: replaced ? { barcode: r.before } : undefined, newValue: { barcode: r.barcode.barcode },
  });
  res.json({ barcode: r.barcode });
}));

router.delete('/:id/barcodes/:barcodeId', mgr, validate({ params: z.object({ id, barcodeId: id }) }), asyncH(async (req, res) => {
  const r = await svc.removeBarcode(req.params.id, req.params.barcodeId);
  await audit(req, 'product.barcode_removed', { entityType: 'product', entityId: req.params.id, summary: `Barcode ${r.barcode} removed from "${r.product.name}"`, oldValue: { barcode: r.barcode } });
  res.json({ ok: true });
}));

module.exports = router;
