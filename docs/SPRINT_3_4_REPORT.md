# SHARKPOS 2 — Sprint 3 (Daily Operations) + Sprint 4 (Intelligence)

Everything below is deterministic, rule-based and free. Nothing is labelled AI/ML. No paid service, no deployment, no commit.

## 1. Features
**Sprint 3**
- Closing report for any day (sales, payments, refunds, udhaar given/collected, cash movement, cashiers, top products, stock).
- Cash reconciliation: opening, expected (server-computed), counted, variance (a note is required if non-zero). Append-only, latest count per day applies.
- Shifts: one open shift per cashier, frozen summary at close, variance note, handover (person + note), closed shifts are immutable.
- Udhaar: customer credit limit, credit sale at the till, payments (cash/UPI/card), owner adjustments (with reason), outstanding list, FIFO aging (0-30/31-60/61-90/90+), full history, free WhatsApp click-to-chat reminder (English/Hindi, nothing is sent automatically).

**Sprint 4**
- Action Center: ranked, categorised (stock, money, suppliers, profit, operations), each with a "why".
- "What should I do today?": top of the Action Center, with a headline; also a dashboard widget.
- Cash trapped in inventory (dead, expired, excess stock at cost).
- Dead-stock detection (no completed sale in N days, new-product grace).
- Profit leaks: below cost, thin margin, sold at a loss (from per-sale cost snapshots), cost rise not passed on, discount outliers.
- Supplier intelligence: on-time %, fill rate, rejection %, overdue orders, price rises, cheaper quotes, products with no supplier. No verdict until 3 completed orders.
- Score = severity weight (critical 100, high 70, medium 40, low 10) + up to 25 for the rupee amount.

## 2. Migrations
`database/migrations/011_daily_ops_credit.sql` (additive): widens the `sales.payment_method` CHECK to include `credit` (the only changed object); `sales.refunded_at/refunded_by`; `customers.credit_limit`; tables `credit_ledger`, `shifts`, `cash_reconciliations` with forced RLS, tenant FKs, append-only rules (ledger, reconciliations), closed-shift immutability trigger, one-open-shift-per-user index. No migration for Sprint 4 (it reads Sprint 1/2 data).

## 3. API changes
- `POST /sales` accepts `paymentMethod: "credit"` (needs a customer; 409 `CREDIT_NOT_ENABLED` / `CREDIT_LIMIT_EXCEEDED`). Refunds reverse the credit entry.
- `/credit`: `GET /summary`, `GET /customers`, `GET /customers/:id` (manager+), `GET /customers/:id/balance` (all roles, for the till), `POST /customers/:id/payments`, `POST /customers/:id/adjustments` (owner), `PUT /customers/:id/limit`, `GET /customers/:id/reminder?lang=en|hi`.
- `/shifts`: `GET /current`, `POST /open`, `POST /close`, `POST /:id/close`, `GET /`, `GET /:id` (cashiers see only their own).
- `/reports`: `GET /closing?date=`, `GET|POST /cash-reconciliations` (manager+).
- `/intelligence` (manager+): `/actions`, `/today`, `/inventory-cash`, `/dead-stock`, `/profit-leaks`, `/suppliers`.

## 4. Frontend changes
New pages: Action Center (`/intelligence`), Udhaar (`/udhaar`), Closing & cash (`/closing`), Shifts (`/shifts`). Nav items and role-guarded routes added (cashiers see only Shifts of the new items). Dashboard "What should I do today?" widget. POS gets an "Udhaar" payment option showing limit/available and blocking when no customer or no limit. Sales filter, invoice and analytics labels handle `credit`.

## 5. Tests added
`backend/tests/daily-ops.test.js` (17) and `backend/tests/intelligence.test.js` (13): tenant isolation, roles, credit sales/limits/payments/refunds, aging, cash reconciliation, shifts and handover, closing report, dead stock, inventory cash, profit leaks, supplier intelligence, Action Center ranking and reaction to fixes, partial-failure degradation, empty and edge cases. `rls-coverage` and migration-backfill tests automatically cover the new tables and migration.

## 6. Full backend test result
174 tests, 174 pass, 0 fail (144 existing + 30 new), run with `node --test --test-concurrency=1`.

## 7. Frontend build
`vite build` succeeds (all new pages are lazy chunks). The screens were verified by build only, not in a browser.

## 8. Known limitations
- Credit sales are full-bill only (no part-payment at sale time); payments cannot exceed the balance; limit 0 = udhaar off.
- Refunding a credit sale after part-payment leaves a customer advance (negative balance).
- The closing report is a cash-basis day view (sales when rung up, refunds when processed); it differs from Analytics, which counts completed sales only.
- One register is assumed for shift cash attribution.
- Cashiers cannot pick a handover person (staff list is manager+); they can leave a handover note.
- Action Center thresholds are fixed (30-day overdue, 60-day dead stock, 45-day cover, 8% thin margin).
- Intelligence endpoints are not plan-gated.
- WhatsApp links are click-to-chat only.

## 9. Decisions and assumptions
Append-only ledgers (corrections are new rows); server computes all expected cash; the frozen shift summary is the record; judgments need at least 3 completed purchase orders; "trapped cash" is capital at rest, not recoverable money; Sprints 5/6 were not started.
