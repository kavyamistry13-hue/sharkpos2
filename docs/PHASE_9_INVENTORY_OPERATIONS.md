# Phase 9 — Inventory & Operations

Migration `016_inventory_operations.sql` (additive). One stock engine: every change goes through the existing sale / purchase-receive paths or the shared `stockOps.applyAdjustment`; no second ledger.

**Features:** reorder levels + suggestions (recommendation only); batches/expiry with FEFO on sale (expired-only stock refused, 409 `EXPIRED_STOCK_ONLY`); audited adjustments with reasons; stock timeline (`stock_after` filled by DB trigger); physical stock count workflow (approve is the only stock-changing step, stale counts refused); batch capture on PO receiving; CSV product import (validate -> preview -> atomic import, leading-zero barcodes kept, tax comes from the category); allow-listed CSV exports; search/filters; inventory UI tabs (Overview, Reorder, Expiry, Batches, Counts).

**New tables (all forced RLS, backup_read, updated_at):** stock_batches, stock_counts, stock_count_items. Indexes kept only where EXPLAIN showed use.

**Known limitations**
- A sale return goes to the product's untracked stock, not the original batch.
- `tax_rate` in CSV must match the product's category rate.
- Bulk import is audited as one `product.imported` event.
- Right after a bulk load run `ANALYZE`; cold plans on unanalysed data are slow (seeding artifact, not code).
- Gitleaks history scan needs the real repo (snapshot had no `.git`).
