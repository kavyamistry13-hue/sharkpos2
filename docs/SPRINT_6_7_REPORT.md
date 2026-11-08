# SHARKPOS 2 — Sprint 6–7 (Weeks 7–8): Owner Today, Cashier counter mode, Hold bill, Split payment, Partial returns

Not committed, not pushed, not deployed. Free-first: no paid service, and the POS does not depend on any LLM.

## 1. What each feature does

### Owner Today (`/today`, `GET /api/intelligence/owner-today`, owner/manager)
Home page for owners and managers. Three parts, in this order:
1. **Today's business** — net sales, gross profit, bills, customers, payment breakdown, vs yesterday. Same maths as the closing report (`dailyOps.activity`).
2. **Needs attention** — critical stock, expiring items, outstanding udhaar, unusual activity, supplier issues, cash differences (counted drawers/shifts that did not match, last 7 days). Grouped from the Action Center list plus facts read from the books.
3. **SHARKPOS recommends** — `actions.todayList` (the Action Center) rendered by the existing `TodayList` (what / why / evidence / action button / severity / Accept-Reject-Defer status). Store Health and verified value (Sprint 5) sit under it.

No second recommendation engine: the page calls the Action Center, Store Health and Value code. Every figure is tagged **Actual** (counted), **Estimated** (uses the recorded cost), **Forecast** (stock-out projection) or **Recommendation** (never a saving until measured). The wording of the tags comes from the server (`kinds`).

### Cashier counter mode (`/counter`, all roles; the cashier's home)
Large controls: New sale, Held, Return, Last receipt; barcode/search field (a scanner's Enter adds the exact SKU match); +/- quantity; Hold; Pay (single or split); receipt with Print; clear green success / red error banners. It contains **no selling logic**: it calls `/sales/preview`, `/sales`, `/held-bills`, `/sales/:id/returns`. No discounts, approvals, reports or owner pages are reachable from it; the cashier is redirected away from `/today`.

### Hold bill (server-side)
`held_bills` table, tenant-scoped (RLS). A held bill stores `[{productId, quantity, name, unitPrice}]`, discount, customer and label. It touches **no** stock, sale, payment, revenue, profit, tax or shift. Resume re-checks the cart against today's catalogue and reports problems instead of failing. Completing goes through the one normal sale path (`createSale` with `heldBillId`) which locks the hold row and marks it `completed` in the **same transaction**: a hold completes at most once even with two tills, a double click or a retry. Edits use a `version` check. Audit: `hold.created`, `hold.resumed`, `hold.updated`, `hold.discarded`, and `sale.created` (with the hold id).

### Split payment
`sale_payments` holds one row per tender line (cash/upi/card/credit, each method once). Lines are integer paise and must add up to the bill **exactly**; short/over is refused with a clear message and nothing is sold. `sales.payment_method` is `split` when more than one line. A credit line puts only that amount on the customer's udhaar ledger (needs a customer; the credit limit still applies). Closing report, shift cash, analytics payment breakdown, the Sales filter and receipts read the tender lines, so a split bill counts once as a bill and once per method as money. Single-payment sales are unchanged (they now carry one tender line).

### Partial returns
`sale_returns` (+ `sale_return_items`, `sale_return_refunds`). A return picks sale **lines** and quantities; the cap is *sold − already returned* (409 otherwise, concurrency-safe: the sale row is locked). The refund per line is its payable value (taxable + tax, after the bill-discount share) pro-rated by quantity; the last unit takes the exact remainder, so a fully returned bill refunds exactly its total. Refund money goes back **by the methods that paid** (proportional by default, or explicit lines, never more than a method paid, credit share reduces udhaar). Restock per line: on by default; damaged/expired default to not restocked; an explicit `restock` overrides. The original sale lines and totals are never rewritten: only two running counters change (`sale_items.returned_qty`, `sales.refund_amount`), in the same transaction as the return record. Once every unit is back the sale becomes `refunded`. The old "Refund in full" button now returns everything still on the bill and also writes a return record.

## 2. Permissions
| Action | Owner | Manager | Cashier |
|---|---|---|---|
| Owner Today | yes | yes | no (403, redirected) |
| Counter mode, hold, resume, complete, split pay | yes | yes | yes — **own** held bills only |
| See/discard others' held bills | yes | yes | no (404) |
| Partial return | any bill | any bill | own bills within 24 h only (older: 403 "needs a manager") |
| Full refund button (`/refund`) | yes | yes | no (403) |

## 3. Database (migration `013_hold_split_returns.sql`, additive)
New: `held_bills`, `sale_payments`, `sale_returns`, `sale_return_items`, `sale_return_refunds` (all FORCE RLS with tenant policies, composite tenant FKs, backup-read policy; the four money tables are append-only: no UPDATE/TRUNCATE for the app role, DELETE only for demo businesses). Changed: `sales.payment_method` CHECK adds `split`; `sales.refund_amount <= total` CHECK; `sale_items.returned_qty` (+CHECK `<= quantity`, + `UNIQUE(business_id,id)`); `credit_ledger.return_id` and the one-refund-per-sale index replaced by one-refund-per-return (legacy rows keep the old rule). Indexes on every new lookup path. Hold bills: CHECKs make "completed ⇔ has a sale", "discarded ⇔ has a time", 1–100 items; one sale can complete one hold.
**Backfill (per tenant, RLS stays forced):** every existing sale gets one tender line; every existing full refund gets a header-only return record + refund line; refunded sales' lines are marked returned. Verified on a pre-013 database with legacy data for two tenants (tender lines = totals, refund records = `refund_amount`, no cross-tenant leakage).
Migration 011 was not edited.

## 4. Testing
See the final report. New backend files: `hold-split.test.js` (18), `partial-returns.test.js` (15), `owner-today-journey.test.js` (4, incl. the API journey). The browser journey is `docs/e2e/sprint6-7-journey.js` (Playwright run from outside the project; it is not a project dependency).

## 5. Known limitations
- **Reports that still count a partly-returned sale gross:** customer lifetime value, employee performance, forecast velocity, dead-stock / profit-leak / measurement evaluators and the risk scorer. Updated to be net of returns: closing report, shift cash, analytics overview/sales/payment breakdown, product analytics, top products, Owner Today. A *fully* refunded sale is excluded everywhere, as before.
- Attribution date: a return reduces profit/units of the **original sale's** day in sales-based reports, but the **refund money** is counted on the day it was processed (cash drawer is right).
- Legacy (pre-013) refunds have header-only return records: no per-line detail exists for them.
- Cashier return window (24 h), open-hold limit (20) are constants, not per-business settings. Old bills need a manager to perform the return; there is no in-counter manager-approval step for returns.
- Held bills never expire automatically and do not reserve stock (by design: no inventory effect until completion). Price is the price at completion, and the resume screen tells the cashier about changes.
- Counter mode has no discount or manager-approval step (use the normal POS for those). Cash-tendered/change is not part of the split screen.
- No frontend component-test tooling exists in the project; the UI is covered by the browser E2E and the API tests.
- 011's one-time `UPDATE sales SET refunded_at …` runs without a tenant set, so under forced RLS it most likely touched 0 rows on a real database. 013 does not depend on it (falls back to `updated_at`). Left as is (applied migrations are not edited).
