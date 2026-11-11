// CSV product import (Phase 9), mounted on /api/products BEFORE the products router.
//   GET  /import/template   owner | manager   a ready-to-fill CSV
//   POST /import/preview    owner | manager   body = the CSV text (Content-Type: text/csv). Validates, never writes.
//   POST /import            owner | manager   same body. Re-validates, then imports everything in one transaction or nothing.
const express = require('express');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/productImport');
const { audit } = require('../services/audit');

const router = express.Router();
const mgr = authorize('business_owner', 'manager');
const body = express.text({ type: ['text/csv', 'text/plain'], limit: '6mb' });

router.get('/import/template', mgr, (_req, res) => res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sharkpos-products-template.csv"', 'cache-control': 'no-store' }).send(`﻿${svc.TEMPLATE}`));
router.post('/import/preview', mgr, body, asyncH(async (req, res) => res.json(await svc.preview(req.body))));
router.post('/import', mgr, body, asyncH(async (req, res) => {
  const r = await svc.importProducts(req.body, req.user.id);
  await audit(req, 'product.imported', { entityType: 'product', summary: `${r.imported} product(s) imported from CSV`, newValue: { count: r.imported, firstId: r.productIds[0], lastId: r.productIds[r.productIds.length - 1] } });
  res.status(201).json({ imported: r.imported });
}));

module.exports = router;
