# SHARKPOS 2 — Sprint 5: Measurement & Value (+ Sprint 6 pilot preparation)

Deterministic and free. No AI/ML wording, no paid service, nothing deployed or committed.

## 1. Features
- **Accept / reject / not now** on every Action Center recommendation (owner and manager). The recommendation is looked up on the server and frozen as shown; a client cannot supply its own. A changed mind is a new row.
- **Outcomes** for accepted actions, from the shop's own records, with honest states: verified, pending, no change, did not work out, not measurable.
- **Recommendation accuracy:** generated, accepted, rejected, deferred, acted-upon, verified/neutral/failed/pending/not-measurable. Rates appear only with ≥5 decisions / ≥5 measured outcomes; otherwise null with a reason.
- **Value ledger** (append-only): *verified* value is written only by the measurement engine from records; *user-reported* value is separate and never added to verified totals; corrections are new rows.
- **Store Health:** 6 areas (inventory, overdue credit, margin leaks, suppliers, operations, follow-through), each starting at 100 and losing listed points; weighted average; areas without data are left out; fewer than 3 areas = "not enough data".
- **Value & ROI page:** Recommendation → Action → Outcome → Verified value, store health, value by category/type/month, decisions list, ledger.

### What is measured (and what is not)
| Recommendation | Outcome rule | ₹ value |
|---|---|---|
| Overdue udhaar | payments in the credit ledger after accepting, capped at the balance then | recovered_credit |
| Dead stock | completed sales of the listed products after accepting, at purchase cost | inventory_released |
| Stock-out / reorder | stock received after accepting and now above minimum | none (lost sales can't be measured) |
| Price/margin leak | realised profit on units sold after minus the old margin on the same units | margin_improvement |
| Supplier price rise / cheaper supplier | deliveries invoiced below the cost at acceptance × units | cost_saving |
| Overdue supplier order, uncounted cash | delivery received / count recorded | none |
| Expiry, others | not measurable | none |
Attribution caveat (shown in the UI): records prove the money arrived, not that the action alone caused it. Windows: 14–30 days; a re-measure adds a correction row if the supported amount drops (e.g. a refund).

## 2. Migration
`database/migrations/012_measurement.sql` (additive): `recommendation_log`, `action_decisions`, `action_outcomes`, `value_ledger`. Tenant composite FKs, forced RLS, backup_read policy, insert-only for the app role (UPDATE/TRUNCATE revoked, DELETE only for demo businesses). A CHECK makes a "verified" row impossible without a decision and an outcome. Demo reset updated to clear the new tables.

## 3. API (`/api/measurement`, owner+manager; reversal owner-only)
`POST /decisions` · `GET /decisions` · `GET /decisions/:id` · `POST /decisions/:id/evaluate` · `POST /evaluate` · `GET /accuracy` · `GET /store-health` · `GET /roi` · `GET /value-ledger` · `POST /value-ledger/reported` · `POST /value-ledger/:id/correct` (owner).
`GET /intelligence/actions` and `/today` now also record which recommendations were shown (best effort).

## 4. Frontend
New: `pages/Value.jsx` (nav "Value & ROI", `/value`). Changed: `components/TodayList.jsx` (Accept / Reject / Not now with status), `pages/Intelligence.jsx`, `layouts/AppLayout.jsx`, `App.jsx`. Dashboard widget gets the controls through TodayList.

## 5–7. Tests and build
New `backend/tests/measurement.test.js`: 22 tests (access, validation, accept/reject/defer, duplicates and concurrent submits, each outcome rule, pending/neutral/unsuccessful paths, not-measurable, append-only at DB level, forged verified value rejected, reported value separate, owner correction, engine correction on lower value, accuracy with insufficient data and 5-outcome rate, store health empty/explained/weighted, partial failure of a data source and of one decision, tenant isolation incl. RLS, backup role).
Full backend suite: **196 tests, 196 pass, 0 fail** (174 earlier + 22). `npm run build` (frontend): success.

## 8. Known limitations
- "Generated" counts a recommendation once per calendar month; a recurring problem is one recommendation per month.
- Outcome rules cover 7 recommendation kinds; others are "not measurable" (by design).
- Value is attribution-limited (see above); a customer may have paid anyway.
- Decision "acted upon" is inferred from records, not asked.
- Follow-through counts acceptance of everything, including low-priority items.
- Health thresholds/weights are fixed constants documented in the response.
- The page was verified by build and API tests, not in a browser.

## 9. Decisions
Server-side snapshots; state-based idempotency (same decision, same month = existing row); owner reversal wins over re-measurement; reported value kept out of every verified total; no ROI ratio against subscription price (no verified price data).
