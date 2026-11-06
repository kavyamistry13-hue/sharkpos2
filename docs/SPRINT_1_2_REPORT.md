# SHARKPOS 2 — Sprint 1 + 2 implementation report

Scope: financial/data correctness (Sprint 1) and purchasing foundation (Sprint 2). Nothing else was changed. Not deployed, committed or pushed.

## Database (additive only — `database/migrations/009_*.sql`, `010_*.sql`)
**009 decimal units & snapshots**
- `products.unit` (pcs, kg, g, l, ml, m, pack, box, dozen), `products.price_includes_tax`.
- `stock`, `minimum_stock`, `sale_items.quantity`, `inventory_movements.quantity`, `restock_orders.quantity` widened to `NUMERIC(12,3)`. CHECK constraints keep counted units (pcs/pack/box/dozen) whole at database level.
- `sale_items` snapshots: `unit_cost`, `cost_source` (`snapshot` | `estimated`), `tax_rate`, `price_includes_tax`, `discount_share`, `taxable_value`, `tax_amount`, `snapshot_backfilled`.
- `product_cost_history` (append-only). `inventory_movements.reference_type`.
- Backfill of existing rows: cost = the product's *current* purchase price, flagged `estimated` + `snapshot_backfilled` (true historical cost was never stored, so old profit remains an estimate and is labelled so).

**010 purchasing**
- `suppliers` extended (contact, address, GSTIN, payment terms, min order value, notes, `is_active`).
- New: `supplier_products`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`, `supplier_price_history`; `restock_orders.purchase_order_item_id`.
- All new tables: `business_id` + composite tenant FKs, forced RLS, `backup_read` policy. Receipts, receipt items, price history and cost history are append-only (no UPDATE/TRUNCATE for the app role, DELETE only for demo businesses).

## Behaviour
- **Decimal quantities** for kg/g/l/ml/m on products, cart, sales, refunds, stock, restock and POs. Validated in Zod, service layer and database.
- **Tax-inclusive pricing** per product (`priceIncludesTax`): `tax = round(payable × rate / (100 + rate))`, taxable value = payable − tax; discounts reduce taxable value and tax proportionally. Tax-on-top (the previous behaviour) stays the default for existing and new API-created products, so existing clients are unchanged.
- **Snapshots**: every sale line stores cost, tax rate, discount share, taxable value and tax at sale time. Later edits to price, cost or category tax never change past sales.
- **Profit** = taxable value − snapshot cost × quantity (tax is never profit; discount is already inside taxable value). Purchase price is treated as ex-GST.
- **Categories** CRUD (managers+; delete owner-only; blocked while in use).
- **Suppliers** CRUD, deactivate (blocked with open POs), per-product terms (supplier SKU, pack size, MOQ, lead time, last cost, preferred), price history.
- **Purchase orders**: draft → ordered → partially_received → received; cancelled; close short. Expected delivery date (default today + lead time, past dates refused), ordered/received/rejected/outstanding per line, advisory warnings (MOQ, pack size, min order value), overdue flag, purchase history.
- **Receiving**: partial deliveries, no over-receipt (409), rejected goods stay outstanding and never enter stock, optional `Idempotency-Key`. A changed unit cost updates `products.purchase_price` (last cost), writes cost history and supplier price history, and returns `priceChanges` with old/new margin. **Selling prices are never changed automatically.**
- **Restock integration**: approved restock orders can be turned into draft POs grouped by each product's supplier. Forecast "on order" counts restock orders not on a PO + outstanding PO quantities, so nothing is double-counted. A restock order linked to a PO is received through the PO (direct receive → 409). Cancelling a PO releases its restock orders (dismissed).

## API (all manager+, audited, tenant-scoped, behind the subscription gate)
- `GET/POST /api/categories`, `PUT/DELETE /api/categories/:id`
- `GET/POST /api/suppliers`, `GET/PUT /api/suppliers/:id`, `PUT/DELETE /api/suppliers/:id/products/:productId`, `GET /api/suppliers/:id/price-history`
- `GET/POST /api/purchase-orders`, `GET /api/purchase-orders/history`, `POST /api/purchase-orders/from-restock`, `GET/PUT /api/purchase-orders/:id`, `POST /api/purchase-orders/:id/{order,receive,close,cancel}`
- `GET /api/products/:id/cost-history`, `GET /api/products/:id/suppliers`
- Changed responses (additive fields): products/POS search (`unit`, `allowDecimal`, `priceIncludesTax`), sales (`unit`, `taxRate`, `priceIncludesTax`, `taxAmount`, `taxableValue`, `discountShare`, `taxIncluded`), bill preview (`taxIncluded`, `taxAdded`), restock orders (`unit`, `purchaseOrder`).

## Frontend
Products (unit, "price includes GST", decimal stock), POS (decimal quantity entry, unit labels, tax-included display), Invoice, Inventory (decimal restock quantity, PO link), and a new **Purchasing** page (purchase orders, receiving, from-restock, suppliers with product terms and price history, categories) at `/purchasing` for owner/manager.

## Tests
Backend suite: 111 original tests unchanged and passing, plus new files `units-tax-snapshots`, `purchasing` (including demo reset), `migration-backfill`, `rls-coverage`. A real bug found by the new tests (SQL parameter typing in the receive status update) was fixed.

## Assumptions and limits (please review)
1. Purchase price is ex-GST; the selling price may be incl. or excl. GST per product.
2. Backfilled historical profit is an estimate (current cost); lines are flagged. New sales are exact.
3. No over-receipt; supplier over-shipments must be handled by raising another order or adjusting stock.
4. Marking a preferred supplier also sets the product's supplier and lead time.
5. Frontend was verified by a production build only; no browser click-through was done.
6. Existing products default to tax-on-top; the UI checkbox "includes GST" defaults to checked only for newly added products in the form.
7. `rls-coverage` explicitly exempts five pre-existing platform tables (payments, billing_events, subscriptions, memberships, sessions) that this sprint did not change.
