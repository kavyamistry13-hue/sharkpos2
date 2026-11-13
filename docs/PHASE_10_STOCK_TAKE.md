# Phase 10 — Stock Take / Cycle Counting

Builds on Phase 9 counts and Phase 9.1 costing. **No migration.** `costing.js` is untouched; counts never change `avg_cost`.

## Behaviour
- **Reopen** `POST /stock-counts/:id/reopen` (owner/manager): `review` → `counting`. No stock or cost change; items and snapshots preserved; audited `inventory.count_reopened`. Any other status → 409 `COUNT_NOT_REOPENABLE`.
- **Recount** `PUT /stock-counts/:id/items/:productId` with `{counted, recount:true}` (only while `counting`): refreshes `expected_qty` and `unit_cost` to live stock / live `avg_cost`. A normal PUT keeps the snapshots. Audited `inventory.count_item_recounted` (distinct from a plain correction).
- **Stale warnings**: each item exposes `currentStock`, `stale`, `inactive`; the count exposes `staleCount` (0 once approved/cancelled). The UI shows a banner and disables Approve while stale rows exist.
- **Approval is all-or-nothing**: if any item's stock changed since its snapshot, or its product was deactivated or is missing, approval returns 409 `COUNT_STALE` with a list (`reason`: `stock_changed` | `inactive` | `missing`) and applies zero adjustments. Recovery: reopen, recount or remove the rows, approve again.
- **Candidates** `GET /stock-counts/candidates`: read-only, active products only, tenant isolated. Filters: `low`, `never`, `least_recent`, `value`, plus category / supplier; `countId` excludes products already in that count. `lastCountedAt` is derived only from approved counts. Creates no rows, changes no stock.
- **Audit**: `count_started` now records title and note; new `count_reopened` and `count_item_recounted` events.

## Not included
Camera scanning, locations/bins/warehouses, a new stock or costing engine, Inventory page redesign.

## Tests
`backend/tests/stock-take.test.js` (18): reopen, recount, stale causes, deactivation, concurrent approvals, sale racing approval, snapshot-cost variance, movement reason/reference, batch/FEFO, audit, candidates, `lastCountedAt`, tenant isolation, cashier authorization.
