# Roadmap Phase 9.1 — Weighted-average costing

Migration `017_weighted_average_costing.sql` (additive). Service: `backend/src/services/costing.js` (the only place the average is computed).

**Formula** (PostgreSQL `NUMERIC`, rounded to 4 decimals, under the product row lock):
`new_avg = (qty_before × old_avg + qty_in × unit_cost) / (qty_before + qty_in)`. With no stock on the shelf the average restarts at the received cost.

**Fields.** `products.avg_cost` = financial cost of what is on the shelf (used for COGS and stock value). `products.purchase_price` is unchanged: the latest purchase cost. `sale_items.unit_cost`, `stock_count_items.unit_cost` and `product_cost_history.cost` are widened to 4 decimals. `product_cost_history` (existing, append-only, RLS) gains `prev_avg_cost`, `new_avg_cost`, `qty_before`, `qty_received`, `qty_after` and the sources `return` and `batch`.

| Event | Effect on the average |
|---|---|
| PO receipt (partial / multiple / concurrent) | Folded in at the **actual received unit cost**; products are locked in id order, so receipts of one product run one after another |
| Batch opening stock **with** a cost | Folded in (source `batch`); without a cost it enters at the current average |
| Sale | Snapshots `avg_cost` into `sale_items.unit_cost` (COGS); average unchanged |
| Restocked return | Units re-enter at the **original sale cost** (source `return`); a non-restocked (damaged) return changes nothing |
| Adjustment, damaged, lost, theft, found, stock count | Quantity only; average unchanged, value = quantity × average (audited by the movement trail) |
| Edit of the product's purchase price (owner/manager) | **None.** `purchase_price` is the expected/latest supplier price; `avg_cost` and stock value do not change. The edit is still audited (audit log + a `manual` cost-history row with empty average/quantity columns) |

**The `manual` cost-history row is a price-edit audit record, NOT an average-cost event.** When an owner/manager edits a product's purchase price, the existing history still gets one row (`source = 'manual'`, `cost` = the new price, who and when), exactly as before Phase 9.1, so the price-edit trail is preserved. Its `prev_avg_cost`, `new_avg_cost`, `qty_before`, `qty_received` and `qty_after` are NULL by design: nothing was received, nothing was re-valued, and `avg_cost` is not read or written. Only the sources `purchase`, `return` and `batch` (and the creation row `initial`) describe the average, and only those carry the average/quantity columns. The edit itself is also in the audit log (`product.updated` / `product.price_changed`).

A receipt/return that leaves the average unchanged writes no cost-history row (the goods receipt and movement are still audited).
Reports use the average: inventory value, dead/overstock value, expiry value, profit (closing report, analytics), profit-leak checks and the stock-count variance value. Reorder spend estimates still use the latest purchase cost (that is the price of the next purchase).

**Limitations / decisions**
- The system has no unit conversions (a product has one base unit). Cost is per base unit; a carton purchase is entered in base units (10 cartons × 24 pcs @ ₹240/carton = 240 pcs @ ₹10).
- A sale return still goes to the product's untracked stock, not its original batch (Phase 9 limitation, unchanged). Batch `unit_cost` stays operational information; it does not drive COGS.
- Sales made before this migration keep their recorded cost; products start with `avg_cost = purchase_price`.
