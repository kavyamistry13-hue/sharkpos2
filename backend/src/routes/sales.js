const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/sales');
const { quantitySchema } = require('../utils/units');

const { audit } = require('../services/audit');
const { idempotencyKey } = require('../utils/idempotency');
const { HttpError, badRequest } = require('../utils/errors');
const { query, withTransaction } = require('../db');
const returns = require('../services/returns');
const router = express.Router();
const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const cart = {
  items: z.array(z.object({ productId: id, quantity: quantitySchema })).min(1, 'Add at least one product.').max(100),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.coerce.number().min(0).max(1e7) }).refine((d) => d.type !== 'percent' || d.value <= 100, { message: 'A percentage discount cannot be more than 100.', path: ['value'] }).nullable().optional(),
};

router.post('/preview', validate({ body: z.object(cart) }), asyncH(async (req, res) => res.json(await svc.previewBill(req.body))));

const payMethod = z.enum(['cash', 'upi', 'card', 'credit']);
const payLine = z.object({ method: payMethod, amount: z.coerce.number().positive('Enter an amount above zero.').max(1e7) });

/** Body of a sale. Exactly one of paymentMethod (one tender) or payments (split tender) — the server checks the lines add up to the bill. */
const saleBody = z.object({
  ...cart,
  customerId: id.nullable().optional(),
  paymentMethod: payMethod.optional(),
  payments: z.array(payLine).min(1).max(4).optional(),
  heldBillId: id.optional(),
  approval: z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional(),
  // Offline POS (Phase 17): the total, in paise, the customer was shown offline. If the server's price now differs the sale is refused (OFFLINE_PRICE_CHANGED), never silently re-priced.
  expectedTotal: z.coerce.number().int().min(0).max(1e10).optional(),
  // Offline POS: the sale was reviewed and a NEW price (this total, in paise) is accepted. Owner/Manager only — enforced in the sales service (a cashier session
  // must also send a verified owner/manager in `approval`). Not part of the idempotency hash, so the same key is reused.
  acceptPriceTotal: z.coerce.number().int().min(0).max(1e10).optional(),
}).refine((b) => !(b.paymentMethod && b.payments), { message: 'Send either paymentMethod or payments, not both.', path: ['payments'] });

// Offline POS (Phase 17): a queued sale is replayed through the SAME POST /sales path with its original Idempotency-Key, plus an
// X-Offline-Sale header {capturedAt, businessId, localRef}. The header is metadata for the audit trail and a TRIPWIRE only:
// the business id is never used to authorise or scope anything (the JWT and RLS do that); it only lets us refuse a queue that was
// built under another business, because product ids are small integers that exist in every tenant.
const offlineHeader = z.object({
  capturedAt: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'not a date'),
  businessId: z.number().int().positive(),
  localRef: z.string().max(40).optional(),
});
function offlineMeta(req) {
  const raw = req.get('x-offline-sale');
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* handled below */ }
  const r = offlineHeader.safeParse(parsed);
  if (!r.success) throw badRequest('The X-Offline-Sale header is not valid.', { code: 'OFFLINE_HEADER_INVALID' });
  if (r.data.businessId !== req.user.businessId) {
    throw new HttpError(409, 'This offline sale was made under a different business than the one you are signed in to, so it was NOT submitted.', { code: 'OFFLINE_TENANT_MISMATCH' });
  }
  return { capturedAt: new Date(r.data.capturedAt).toISOString(), localRef: r.data.localRef || null };
}

/** Shared by POST /sales and POST /held-bills/:id/complete so there is ONE sale path. */
async function completeSale(req, res, body) {
  const offline = offlineMeta(req);
  // Every submission must carry a client-generated key so a retry (lost response, timeout, server restart) can never sell twice.
  const key = idempotencyKey(req, { what: 'sale' });
  // An offline sale must state what the customer was shown: without it the price check could be skipped by simply omitting the field.
  if (offline && body.expectedTotal == null) throw badRequest('An offline sale must include expectedTotal.', { code: 'OFFLINE_EXPECTED_TOTAL_REQUIRED' });
  const { sale, replayed, priceChange } = await svc.createSale(req.user, body, key, { expectedTotal: body.expectedTotal, acceptPriceTotal: body.acceptPriceTotal });
  if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json(sale);   // same sale as the first time; nothing was processed again
  await audit(req, 'sale.created', { entityType: 'sale', entityId: sale.id, summary: `Sale ${sale.invoiceNo} · ₹${sale.total} · ${sale.paymentMethod}${body.heldBillId ? ` · from held bill #${body.heldBillId}` : ''}${offline ? ` · offline sale captured ${offline.capturedAt}` : ''}`, newValue: { total: sale.total, discount: sale.discount, payments: sale.payments, heldBillId: body.heldBillId || null, items: body.items.length, ...(offline ? { offline: { ...offline, syncedAt: new Date().toISOString() } } : {}) } });
  if (priceChange) {
    await audit(req, 'sale.offline_price_accepted', { entityType: 'sale', entityId: sale.id, summary: `Offline sale ${offline && offline.localRef ? offline.localRef : ''} price change accepted: ₹${priceChange.expectedTotal} charged, ₹${priceChange.currentTotal} now (${priceChange.difference >= 0 ? '+' : ''}${priceChange.difference}) · approved by user #${priceChange.approvedBy}`, newValue: { expectedTotal: priceChange.expectedTotal, currentTotal: priceChange.currentTotal, difference: priceChange.difference, approvedBy: priceChange.approvedBy, requestedBy: req.user.id } });
  }
  return res.status(201).json(sale);
}

router.post('/', validate({ body: saleBody }), asyncH(async (req, res) => completeSale(req, res, req.body)));

/**
 * A device reports an offline sale it could not sync (needs review). Audit-only: it creates no sale, no stock or ledger change, and the
 * sale itself stays on the device. It exists so a manager can see in the Audit page that a sale is waiting for a decision.
 * Deduplicated per (sale key, code), so a device that keeps retrying cannot flood the log.
 */
const issueBody = z.object({
  issues: z.array(z.object({
    key: z.string().uuid(), code: z.string().trim().min(1).max(40), message: z.string().trim().max(200).optional(),
    localRef: z.string().max(40).optional(), capturedAt: z.string().max(40).optional(), total: z.coerce.number().min(0).max(1e9).optional(),
  })).min(1).max(20),
});
router.post('/sync-issues', validate({ body: issueBody }), asyncH(async (req, res) => {
  let recorded = 0;
  for (const i of req.body.issues) {
    // Tenant-scoped read (audit_logs has a per-business SELECT policy): this can only ever see this business's rows.
    const seen = await query(`SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'sale.offline_sync_issue' AND new_value->>'key' = $2 AND new_value->>'code' = $3 LIMIT 1`, [req.user.businessId, i.key.toLowerCase(), i.code]);
    if (seen.rowCount) continue;
    await audit(req, 'sale.offline_sync_issue', { entityType: 'sale_request', entityId: i.key.toLowerCase(), summary: `Offline sale ${i.localRef || i.key.slice(0, 8)} needs review on a device: ${i.code}${i.message ? ` — ${i.message}` : ''}`, newValue: { key: i.key.toLowerCase(), code: i.code, message: i.message || null, localRef: i.localRef || null, capturedAt: i.capturedAt || null, total: i.total ?? null } });
    recorded += 1;
  }
  res.status(201).json({ recorded });
}));

/**
 * Dismiss an offline sale that needs review (the customer was NOT sold to / it will not be recorded). Owner/Manager only, enforced here:
 * an owner/manager session, or a cashier session carrying a verified owner/manager's credentials. Audit-only: no sale, stock or ledger change.
 * Refused (409) if the server already has a sale for this key — a recorded sale cannot be "dismissed".
 */
const dismissBody = z.object({
  key: z.string().uuid(), reason: z.string().trim().min(3).max(200),
  localRef: z.string().max(40).optional(), total: z.coerce.number().min(0).max(1e9).optional(),
  approval: z.object({ email: z.string().email(), password: z.string().min(1) }).nullable().optional(),
});
router.post('/offline-dismissals', validate({ body: dismissBody }), asyncH(async (req, res) => {
  const b = req.body;
  const key = b.key.toLowerCase();
  const auth = await withTransaction(async (client) => {
    const a = await svc.resolveManagerAuthority(client, req.user, b.approval, 'OFFLINE_DISMISS_APPROVAL_REQUIRED');
    const used = await client.query('SELECT 1 FROM sale_requests WHERE idempotency_key = $1', [key]);
    if (used.rowCount) throw new HttpError(409, 'This sale was already recorded by the server, so it cannot be dismissed.', { code: 'OFFLINE_SALE_ALREADY_RECORDED' });
    return a;
  });
  await audit(req, 'sale.offline_dismissed', { entityType: 'sale_request', entityId: key, summary: `Offline sale ${b.localRef || key.slice(0, 8)} dismissed: ${b.reason} · approved by user #${auth.approvedBy}`, newValue: { key, reason: b.reason, localRef: b.localRef || null, total: b.total ?? null, approvedBy: auth.approvedBy, requestedBy: req.user.id } });
  res.status(201).json({ dismissed: true });
}));

router.get('/limits', asyncH(async (req, res) => res.json(await svc.discountLimits())));

router.get(
  '/',
  validate({
    query: z.object({
      from: date.optional(), to: date.optional(), employeeId: id.optional(), q: z.string().max(60).optional(),
      payment: z.enum(['cash', 'upi', 'card', 'credit', 'split']).optional(), status: z.enum(['completed', 'refunded', 'cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  asyncH(async (req, res) => res.json(await svc.listSales(req.user, req.query))),
);

router.get('/:id', validate({ params: z.object({ id }) }), asyncH(async (req, res) => res.json(await svc.getSale(req.params.id, req.user))));

const returnBody = z.object({
  items: z.array(z.object({ saleItemId: id, quantity: quantitySchema, restock: z.boolean().optional() })).min(1, 'Choose at least one item to return.').max(100),
  reason: z.enum(returns.REASONS).default('other'),
  note: z.string().trim().max(300).optional(),
  refunds: z.array(payLine).min(1).max(4).optional(),
});
// Line-level (partial) return. Cashiers: only their own recent bills (the service enforces it). Needs an Idempotency-Key so a retry never refunds twice.
router.post('/:id/returns', validate({ params: z.object({ id }), body: returnBody }), asyncH(async (req, res) => {
  const key = idempotencyKey(req, { what: 'return' });
  const { return: ret, replayed } = await returns.processReturn(req.user, req.params.id, req.body, key);
  const sale = await svc.getSale(req.params.id, req.user);
  if (replayed) return res.set('Idempotent-Replayed', 'true').status(200).json({ return: ret, sale });
  await audit(req, 'sale.returned', { entityType: 'sale', entityId: req.params.id, summary: `Return on sale #${req.params.id} · ₹${ret.total} · ${ret.reason}${ret.completesSale ? ' · whole bill' : ''}`, newValue: { returnId: ret.id, total: ret.total, reason: ret.reason, items: ret.items.map((i) => [i.saleItemId, i.quantity, i.restocked]), refunds: ret.refunds } });
  return res.status(201).json({ return: ret, sale });
}));

router.post('/:id/refund', authorize('business_owner', 'manager'), validate({ params: z.object({ id }) }), asyncH(async (req, res) => {
  const out = await svc.refundSale(req.params.id, req.user);
  await audit(req, 'sale.refunded', { entityType: 'sale', entityId: req.params.id, summary: `Sale #${req.params.id} refunded` });
  res.json(out);
}));

module.exports = router;
module.exports.completeSale = completeSale;
module.exports.saleBody = saleBody;
