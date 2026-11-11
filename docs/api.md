# API reference

Base path `/api`. JSON in and out. Send `Authorization: Bearer <token>` on everything except login and health. Errors: `{ "error": { "code", "message", "details?" } }`.
Roles: **A** admin, **M** manager, **C** cashier.

## Auth
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /health | public | liveness |
| POST | /auth/login | public | `{email,password}` → `{token,user}` (rate limited) |
| GET | /auth/me | all | current user |
| POST | /auth/change-password | all | `{currentPassword,newPassword}` |

## Products
| Method | Path | Roles and notes |
|---|---|---|

| GET | /products | all (list, search, filter) |
| GET | /products/lookups | all (categories, suppliers) |
| GET | /products/pos-search?q= | all |
| GET | /products/:id | A,M |
| POST | /products | A,M |
| PUT | /products/:id | A,M |
| DELETE | /products/:id | A |

## Sales
| Method | Path | Roles and notes |
|---|---|---|

| POST | /sales/preview | all | price a cart, no side effects |
| GET | /sales/limits | all | discount limit for current user |
| POST | /sales | all | create sale; 403 `APPROVAL_REQUIRED` if discount exceeds limit without manager credentials |
| GET | /sales | all (cashier sees own) |
| GET | /sales/:id | all |
| POST | /sales/:id/refund | A,M |

## Inventory
| Method | Path | Roles and notes |
|---|---|---|

| GET | /inventory?filter=low\|out\|over\|fast\|slow\|expiring\|atrisk | A,M |
| GET | /inventory/alerts | A,M |
| GET | /inventory/:productId/movements | A,M |
| GET | /inventory/restock-orders | A,M |
| POST | /inventory/restock-orders/:id/receive | A,M |

## AI (A,M)
| Method | Path | Roles and notes |
|---|---|---|

| GET | /ai/status | whether an LLM is configured |
| GET | /ai/brief | daily brief |
| POST | /ai/copilot | `{question}` → `{answer, facts, source}` |
| GET | /ai/restock | AI restock recommendations with reasons |
| POST | /ai/restock/:productId/approve | `{quantity?}` creates a restock order |
| POST | /ai/restock/:productId/dismiss | |
| GET | /ai/forecast/:productId | forecast detail |

## Analytics
| Method | Path | Roles and notes |
|---|---|---|

| GET | /analytics/overview | dashboard KPIs |
| GET | /analytics/sales?range=today\|7d\|30d\|3m | |
| GET | /analytics/products?range= | |

## Risk
| Method | Path | Roles and notes |
|---|---|---|

| GET | /risk/alerts?status=&severity= | |
| GET | /risk/transactions | |
| GET | /risk/alerts/:id/sale | |
| POST | /risk/alerts/:id/status | `{status: open\|reviewed\|dismissed}` |

## Customers / Employees / Settings
| Method | Path | Roles and notes |
|---|---|---|

| GET | /customers/search?q= | all |
| POST | /customers | all |
| GET | /customers, /customers/:id | A,M |
| GET, POST, PUT | /employees, /employees/:id | A (see route for read access) |
| GET | /settings | all |
| PUT | /settings | A |

## Demo
| Method | Path | Roles and notes |
|---|---|---|

| GET | /demo/status | |
| POST | /demo/load | A, `{confirm:true}`; disabled in production unless `ALLOW_DEMO=true` |


## Sprint 6–7 additions (hold bill, split payment, partial returns, Owner Today)

All money-moving calls need an `Idempotency-Key: <uuid>` header (400 `IDEMPOTENCY_KEY_REQUIRED` without it). Same key + same body replays the original result (HTTP 200, `Idempotent-Replayed: true`); same key + different body is 422 `IDEMPOTENCY_KEY_REUSED`.

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /sales | O,M,C | Now accepts `payments: [{method, amount}]` (split, max 4, each method once) **or** `paymentMethod` (not both); optional `heldBillId`. Lines must add up to the bill exactly: 400 `PAYMENT_SHORT` / `PAYMENT_EXCEEDS_BILL` / `DUPLICATE_PAYMENT_METHOD` / `PAYMENT_PRECISION`. Response adds `payments[]`. A split sale has `paymentMethod: "split"`. |
| GET | /sales?payment= | O,M,C | `split` or any tender method (matches any tender line). |
| GET | /sales/:id | O,M,C | Adds `payments[]`, `returns[]`, and per line `id`, `returnedQty`, `returnableQty`. |
| POST | /sales/:id/returns | O,M,C* | Body `{items:[{saleItemId, quantity, restock?}], reason, note?, refunds?:[{method, amount}]}`. Needs key. 409 `RETURN_EXCEEDS_SOLD`, `SALE_NOT_RETURNABLE`; 400 `REFUND_METHOD_EXCEEDS_PAID`, `REFUND_SPLIT_MISMATCH`, `LINE_NOT_IN_SALE`. *Cashier: own bills only, within 24 h (else 403). |
| POST | /sales/:id/refund | O,M | Unchanged: returns everything still on the bill (now also a return record). |
| GET | /held-bills?status= | O,M,C | Cashier sees own only. |
| POST | /held-bills | O,M,C | `{items, discount?, customerId?, label?}`; optional key; max 20 open per user (409 `HOLD_LIMIT`). |
| GET / PUT | /held-bills/:id | O,M,C | GET re-validates the cart (`issues[]`: PRODUCT_UNAVAILABLE, EXPIRED, INSUFFICIENT_STOCK, PRICE_CHANGED) and prices it. PUT edits the cart, optional `version` (409 `HOLD_VERSION_CONFLICT`). |
| POST | /held-bills/:id/resume | O,M,C | Counts the resume (audited), returns the re-validated cart. Hold stays `held`. |
| POST | /held-bills/:id/discard | O,M,C | Idempotent. 409 if already completed. |
| POST | /held-bills/:id/complete | O,M,C | Sells the server-side cart via the normal sale path. Needs key. 409 `HELD_BILL_NOT_OPEN` if it was already completed/discarded. |
| GET | /intelligence/owner-today | O,M | Owner Today: `business`, `needsAttention`, `forecast`, `recommendations` (the Action Center list), `health`, `value`, `kinds`. Read-only. |

## Phase 9 additions (inventory & operations) — O = owner, M = manager
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /inventory?filter=&categoryId=&supplierId= | O,M | Filters: `low`, `reorder`, `expired`, `expiring7/30/90`, `batch`, `nobatch`. Overview totals include cost/selling value, `needReorder`, `last7Days`. |
| GET | /inventory/reorder | O,M | Recommendation only (never creates a PO): `suggestedReorderQty`, supplier, on-order qty. |
| POST | /inventory/adjust | O,M | `{productId, delta\|newQty, reason, note?, batchId?}`; reason enum; 409 if it would go negative. |
| GET | /inventory/timeline | O,M | Paged movement feed (`stockAfter`, reason, batch). |
| GET | /inventory/expiry, /inventory/batches, /inventory/:productId/batches | O,M | Batch / expiry reports. POST on `/:productId/batches` adds a batch (opening stock). |
| * | /stock-counts (+ `/:id/items`, `/submit`, `/approve`, `/cancel`) | O,M | Count -> review -> approve. Only approve changes stock (409 `COUNT_STALE`, `COUNT_ALREADY_OPEN`). |
| POST | /products/import/validate, /preview, /import | O,M | Body `text/csv`. All-or-nothing; 422 `IMPORT_INVALID` with row errors. Limits: 5 MB / 5,000 rows. |
| GET | /exports/:kind.csv | O,M (sales, customers: O) | Column allowlists, formula-injection safe, 50,000-row cap. |
| PUT/POST | /products (`maxStock`, `reorderLevel`) | O,M | Optional; `max >= minimum`. |
| POST | /purchase-orders/:id/receive | O,M | Lines accept optional `batchNo`, `manufacturedDate`, `expiryDate`. |
