# SHARKPOS 2 — Product Innovation Report

*5 Nov 2026 · Companion to `PRODUCT_INNOVATION_AUDIT.md` (read its §0 first). Proposal only: no code has been changed, nothing deployed. Implementation starts only after you approve the roadmap.*

**The one-paragraph version.** The backend is secure and well tested (111/111 pass), but the product cannot yet answer "what should I do next?" for a real shop, for two reasons. First, **the data it would need is not captured**: no suppliers, purchase orders, purchase-cost history, credit/udhaar, batch expiry, loose quantities or MRP-inclusive tax. Second, **recommendations are not tracked**: they are recomputed and forgotten, so nothing can be measured or learned. The plan is therefore: fix the data foundations (Gate 0) while shipping an Action Center on the data that already exists, then layer the money-framed features on top.

---

## A. What we already have

See Audit §1 and §0. In short: production-grade multi-tenant core (RLS, idempotent POS, audit), a transparent statistical forecast and restock recommender, a rule-based risk engine, a grounded-LLM brief/copilot with deterministic fallback, a working SaaS billing layer and a platform admin panel.

## B. What is weak

1. The product shows **information**, not **decisions** (dashboard = tiles and charts).
2. Missing real-shop data: decimals, MRP-inclusive tax, suppliers/POs, credit, batches, cost snapshot.
3. No recommendation lifecycle, so no acceptance rate, no outcome, no "value saved".
4. Counter workflow gaps: hold, return, split pay, scan, shift.
5. Onboarding by hand-typing every product.
6. Reported profit is retroactively unstable.
7. Performance traps that appear with real volume (Audit T1–T3).
8. No product analytics for you as a SaaS operator.

## C. What retailers actually need (ranked by how often the pain occurs)

| Rank | Real daily problem | Today |
|---|---|---|
| 1 | "Who owes me, how much, since when?" (udhaar) | Absent |
| 2 | "What do I order today, from whom, how many — and did it arrive?" | Reorder maths only; no supplier, no PO |
| 3 | Selling loose items by weight/volume | Impossible |
| 4 | Prices that match the MRP on the pack (tax included) | Tax added on top |
| 5 | "Did the cash in the drawer match?" | Absent |
| 6 | Getting 1,500 items into the system without typing them | Absent |
| 7 | Scanning barcodes and printing receipts quickly | Search-by-SKU only; browser print |
| 8 | "Which stock is dead / about to expire and what's it worth?" | Partial (slow-moving list, one expiry date) |
| 9 | "Did supplier cost go up and am I still making margin?" | Impossible (no cost history) |
| 10 | "Which regular customers stopped coming?" | Partial (inactive > 45 days; no personal interval) |

---

## D. 30 feature ideas

Ratings: **H**igh / **M**edium / **L**ow. *Frequency* = how often the pain occurs. *Complexity* assumes the Gate 0 foundations exist. *Diff.* = how hard for others to copy: my judgement, not a competitor survey. Monetisation: **Core** = keeps users on any plan, **Tier** = justifies a higher plan, **Retention** = value mostly in not churning.

**Gate 0 — foundations (not "features", but every later idea depends on them)**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Decimal quantity + units | Loose goods can't be sold → `NUMERIC(12,3)` qty, unit (kg/g/l/pcs), pack↔piece conversion | Cashier | Daily | H | H | M | L | Core |
| 2 | MRP-inclusive tax + HSN + per-line tax stored | Bills disagree with pack price; GST split not stored → price mode per product/category, back-calculate tax, store tax per line | Owner, cashier | Daily | H | H | M | L | Core |
| 3 | Cost snapshot + purchase-price history | Profit drifts; no price-rise detection → store unit cost on each sale line; log every purchase-price change | Owner | Daily | H | H | M | M | Core |
| 4 | Category & supplier management | Suppliers can't be created at all → CRUD + UI, supplier terms and lead time | Owner | Setup + weekly | H | M | S | L | Core |

**Daily operating system**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 5 | **Action Center** | Owner doesn't know what to do first → persisted actions with severity, category, evidence, button, status, outcome; de-duplicated; every action explains itself | Owner | Daily | H | H | M | H | Tier |
| 6 | **"What should I do today?"** | Too many screens → top 3–5 actions ranked by ₹ at stake from the Action Center | Owner | Daily | H | H | S (on #5) | H | Tier |
| 7 | Morning Brief + Closing Report | No daily rhythm → brief at open (yesterday, risks, actions), closing summary with sales/profit/bills/refunds/discounts/cash difference/tomorrow's priorities; view in app first, WhatsApp/email later | Owner | Daily | H | H | M | M | Retention |
| 8 | Owner Mode / Cashier Mode | 14 menu items for owners; clutter for cashiers → role-based home: Owner "Today" (≈6 blocks), Cashier big-button counter | All | Daily | M | H | S | L | Core |
| 9 | Counter essentials: hold bill, partial return/exchange, split payment | Real counter flows missing → server-side held bills, return by line with reason, payment lines (cash+UPI) | Cashier | Daily | H | H | M | L | Core |
| 10 | Shift Handover | Cash differences go unexplained → open/close shift, expected vs counted cash, mandatory explanation, audit record | Cashier, owner | Daily | H | H | M | M | Tier |

**Money and inventory**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 11 | **Udhaar / Credit Manager** | Informal credit in notebooks → append-only customer ledger, credit limit, due dates, partial payments, aging (0–7/8–30/30+), WhatsApp reminder link | Owner | Daily | H | H | M | M | Core (acquisition driver) |
| 12 | Purchase orders + goods receipt | Orders live on paper/phone → PO per supplier, receive with shortfall/rejects/price, links to stock and cost history | Owner/manager | Weekly | H | H | L | M | Core |
| 13 | **Smart Reorder v2** | Reorder maths ignores pack size, MOQ, pending POs, supplier → recommendation → editable PO draft; tracks whether it prevented a stockout | Owner | Daily | H | H | M | M | Tier |
| 14 | **Cash Trapped in Inventory** | Owners can't see stock as money → ₹ locked, split fast / slow / dead, ₹ releasable | Owner | Weekly | H | H | S | H | Tier |
| 15 | Dead Stock Detector | Slow stock hides capital → rank by ₹ and age, suggest discount/bundle/stop reorder, measure recovered cash | Owner | Weekly | H | M | M | M | Tier |
| 16 | Batch expiry + Expiry Rescue | One expiry per product is wrong → batches (FEFO sale), at-risk list with ₹ loss, actions, measured waste prevented | Owner | Weekly | H | H | L | M | Tier |
| 17 | Price Change Intelligence | Supplier cost rises silently erode margin → on receipt compare to last cost, show new margin, propose new price, owner approves | Owner | Weekly | H | H | M | H | Tier |
| 18 | Profit Leak Detector | Margin lost to discounts, refunds, wastage, rising costs → itemised ₹ leaks with cause | Owner | Weekly | H | H | M | H | Tier |
| 19 | Stock count / wastage / damage log | Stock drifts from reality → quick count, reasons, variance in ₹ | Manager | Weekly | M | M | S | L | Core |
| 20 | Supplier Reliability Score | Late/short deliveries unnoticed → on-time %, fill rate, price change from PO data; shows the inputs | Owner | Monthly | M | M | M | H | Tier |
| 21 | Best Supplier to Buy From | Price-only comparisons mislead → rank by landed cost, reliability, MOQ, terms, with explanation (needs #12, #20) | Owner | Weekly | M | M | M | M | Tier |

**Customers and people**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 22 | Customer Memory + "missed usual visit" list | Regulars drift away unnoticed → per-customer visit interval, favourites, "usually every 12 days, 27 since"; owner taps to WhatsApp (no auto-spam); wording is observation, not prediction | Owner | Weekly | M | H | S | M | Tier |
| 23 | Employee Assist (reframe Risk Center) | "Risk"/"anomaly" wording can accuse staff → "unusual activity — review", add refunds-by-cashier, off-hours, price overrides; human review required | Owner | Weekly | M | M | S | L | Core |

**Intelligence layer**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 24 | Store Health (explainable) | Owners want one number, but only if honest → 5 sub-scores, each with a published formula and "what changed" | Owner | Weekly | M | M | M | M | Retention |
| 25 | Business Memory / Local Intelligence | Shop patterns forgotten → weekday curves, busy hours, supplier lead time actuals, seasonality once ≥ 1 year of data; always labelled "based on your history" | Owner | Continuous | M | H | L | H | Tier |
| 26 | **Value Protected** + Feedback engine | Owners can't see ROI → each action records outcome; show ₹ with method (actual/estimated/forecast); 👍/👎 on recommendations; acceptance rate | Owner, you | Monthly | H | H | M | H | Retention |
| 27 | Natural-language business commands | Typing beats menus for some owners → allow-listed typed tools ("customers who owe > ₹1,000"), read-only auto, writes become a proposed action needing a click | Owner | Weekly | M | M | L | M | Tier |

**Setup, hardware, platform**

| # | Idea | Problem → Solution | User | Freq. | Business value | Retention | Complexity | Diff. | Monetisation |
|---|---|---|---|---|---|---|---|---|---|
| 28 | One-click setup + Import Intelligence | Cannot start in 10 minutes → guided steps; CSV/Excel import with staged preview (duplicate barcodes, missing prices, bad GST, suspicious prices) and nothing imported silently | Owner | Once | H | H | M | L | Core (activation) |
| 29 | Barcode + receipt printing | Slow billing → multiple barcodes per product, scan-first POS, label print, thermal (ESC/POS via browser/WebUSB where supported), camera scan later | Cashier | Daily | H | H | M | L | Core |
| 30 | Platform product analytics + offline POS (later) | You can't see activation/retention; outages stop sales → event table and admin funnel now; offline queue after core validated | You / cashier | Daily | H | H | M / XL | M | Internal / Core |

*Also considered and parked: WhatsApp Business API automation (paid; use free click-to-chat links first), regional-language UI (needed before wide launch; planned in the 1-year roadmap).*

---

## E. Top 10 (after Gate 0), ranked

Ranked by value × retention ÷ effort, respecting dependencies.

1. **Action Center + lifecycle + feedback** (#5, #26-lite) — everything else plugs into it.
2. **Udhaar Manager** (#11) — highest-frequency unmet pain; strong acquisition story.
3. **Purchase orders + Smart Reorder v2** (#12, #13).
4. **Cash Trapped + Dead Stock** (#14, #15) — cheap, works on existing data.
5. **Morning Brief + Closing Report + Shift Handover** (#7, #10).
6. **Import + One-click setup + Barcode** (#28, #29) — activation.
7. **Price Change Intelligence + Profit Leak** (#17, #18) — needs cost history.
8. **Batch Expiry Rescue** (#16).
9. **Customer missed-visit list** (#22).
10. **Platform product analytics** (#30a) — should really start in week 1; ranked here because users don't see it.

## F. Top 5 "killer" features

1. **Action Center / "What should I do today?"** — a closed loop (recommend → act → outcome → learn) instead of a dashboard.
2. **Udhaar with aging and one-tap WhatsApp reminders** — attacks a daily money problem directly.
3. **Cash Trapped in Inventory** — turns stock into rupees and ties recommendations to recovered cash.
4. **Closing Report with cash-difference accountability** — builds a daily habit and trust with owners who don't watch the counter.
5. **Value Protected ledger** — retention mechanism, but **only from measured outcomes**; shows "actual", "estimated" and "forecast" separately and never invents savings.

## G. Features NOT worth building (now)

See Audit §9. Biggest traps: free-form chatbot, LLM-written SQL, ML churn/fraud claims, auto-messaging customers, automatic price/order changes, opaque scores, native apps, full accounting, multi-store before single-store is excellent.

---

## H. Recommended database changes (all additive; numbered 009+)

Every table: `business_id DEFAULT current_business_id()`, composite FKs, `ENABLE`+`FORCE` RLS with the existing policy, backup read policy, indexes, no `DELETE` for the app role on ledgers.

| Migration | Change | Rollback consideration |
|---|---|---|
| 009 units & decimals | `ALTER COLUMN` quantity/stock types to `NUMERIC(12,3)`; add `units`, `products.unit_id`, `products.pack_qty` | Lossless widening. Test on a restored backup. Cast back is lossless only while no fractional quantities exist |
| 010 tax model | `products.price_includes_tax`, `products.hsn`; `sale_items.tax_rate, tax_amount, discount_share, unit_cost, cost_source('actual'\|'estimated')`; back-fill old rows as `estimated` | New nullable columns; old code ignores them |
| 011 cost history | `product_cost_history(product_id, cost, effective_at, source, ref_id)` + trigger on `purchase_price` change | Drop table; no data dependency |
| 012 suppliers & PO | `suppliers` add terms/min order/notes; `supplier_products`; `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`; old `restock_orders` kept and mapped | Keep `restock_orders` read-only afterwards |
| 013 batches | `stock_batches(product_id, batch_no, expiry, qty_remaining, unit_cost, received_at)`; FEFO deduction; migrate each product's current stock+expiry into one opening batch | Sum of batches must equal `products.stock` (invariant test) |
| 014 credit | `customer_ledger_entries` (append-only: credit_sale, payment, adjustment, write_off), `customers.credit_limit`, `sale_payments` (payment lines) | Ledger balance derived, never edited |
| 015 returns | `sale_returns`, `sale_return_items` (reason, refund method, restock yes/no) | — |
| 016 shifts | `cash_shifts` (opening, expected, counted, difference, explanation, closed_by) | — |
| 017 actions | `actions` (type, category, severity, `dedupe_key` unique while open, evidence jsonb, recommendation jsonb, status, created/resolved_at, outcome jsonb, rule_version), `action_events` (append-only), `action_feedback` | — |
| 018 rollups | `product_daily_stats`, `business_daily_stats` (maintained in the sale transaction or lazily rebuilt); fixes Audit T1–T3 | Rebuildable from raw tables |
| 019 barcodes & import | `product_barcodes (business_id, barcode UNIQUE)`, `import_jobs`, `import_rows` | — |
| 020 platform analytics | `usage_events` (no PII; platform table), `ai_usage (business_id, day, calls, tokens_in, tokens_out)` | — |

## I. Recommended API changes

New (all behind existing `authenticate` → `subscriptionGate`; manager+ unless noted):
`/api/actions` (list, accept, snooze, dismiss, feedback, outcome) · `/api/today` · `/api/suppliers`, `/api/categories` (CRUD) · `/api/purchase-orders` (+ receive) · `/api/credit` (ledger, aging, record payment, limit; write-off owner-only) · `/api/shifts` (open/close; cashier can open/close own) · `/api/returns` · `/api/sales/hold` · `/api/products/import` (stage → preview → commit) · `/api/products/:id/barcodes` · `/api/reports/closing`, `/api/reports/value-protected` · `/api/ai/command` · `/api/platform/analytics`.
Changes to existing: `POST /sales` accepts payment lines and credit; refund route supports lines; fix `docs/api.md` (generate from Zod schemas).

## J. Recommended frontend changes

- **Owner "Today" home**: Today's business · Needs attention · Recommends (buttons) — replaces the tile grid; keep Analytics for exploration.
- **Cashier counter mode**: New sale / Hold / Return / Customer / Print, large targets, scan field always focused.
- Collapse owner nav from 14 to ~7 (Today, Counter, Stock, Money (credit, cash), Customers, Reports, Settings); remove `Why`/`Present` from the product build.
- Action cards component shared by Today, Inventory, Customers.
- Web manifest + service worker (installable PWA) — shell caching only until offline POS is designed.
- Hindi and one regional language; large-number formatting `₹1,42,800`.
- Frontend tests (none today): Vitest + Testing Library; Playwright for sell → refund → close shift.

## K. AI architecture changes

1. **Detectors** (pure functions, versioned, unit-tested) read the DB under the caller's tenant and emit action candidates with evidence. No LLM.
2. **Ranker**: priority = ₹ at stake × urgency × confidence; dedupe by `dedupe_key`.
3. **Explainer**: deterministic template per action type; optional LLM rewording behind the existing number-grounding guard.
4. **Outcome evaluators**: after an action is accepted, a later job/lazy check records what happened (stockout avoided? sell-through of discounted stock? ₹ collected?).
5. **Commands**: intent → one of N allow-listed typed tools (Zod-validated args). Read tools run; write tools return a *proposed action* needing a confirm click and the same role checks as the normal API. The model never sees SQL or credentials.
6. **Cost control**: per-plan monthly quotas from `ai_usage`, per-business (not per-IP) limiter, response caching, token caps, fallback to deterministic text. POS never calls an LLM.
7. **Scheduling**: no cron exists today. Compute lazily on first open each day plus on write events; add a scheduled worker only when hosting allows (decision needed at deployment).
8. **Labelling**: every card says Statistical / Rule-based / Estimate / Forecast / Actual.

## L. Security implications

- Every new table gets the standard RLS pattern; add a **generic regression test** that enumerates all tables with `business_id` and fails if RLS is not forced or a policy is missing.
- Ledgers (credit, shifts, returns, actions events) append-only; write-offs and credit-limit changes owner-only and audited; also add the three currently unaudited actions (restock dismiss, alert review, customer create).
- NL commands: authorisation identical to REST; no cross-tenant tool arguments; prompt inputs exclude phone numbers and emails.
- Import: size/row limits, strict parsing, spreadsheet-formula neutralisation on export.
- WhatsApp links expose a customer phone to the owner's own device only; no third-party calls.
- Employee monitoring: wording, notice to staff, retention — covered by the (still unreviewed) legal drafts; needs lawyer review before launch.
- Keep idempotency on any new money-moving POST (credit payment, return, shift close).

## M. Testing requirements

Per feature: unit (pure detector/money maths, incl. property tests for rounding and tax-inclusive back-calculation), API, **tenant isolation**, permission matrix (owner/manager/cashier/platform), error cases, regression (the 111 existing tests must stay green; none weakened), UI tests where a flow matters. Plus: migration tests against a restored backup, invariants (sum of batches = stock; ledger balance = sum of entries; sale lines sum to bill), a load script seeding 1k/10k tenants, and a test that asserts the LLM path is never reached by POS routes.

## N. SaaS metrics

| Group | Metric | Source |
|---|---|---|
| Acquisition | visits, registrations, trial starts | landing events + `subscriptions` |
| Activation | first product, 10 products/import, first sale, 10th sale, first action viewed, first action accepted | `usage_events` |
| Engagement | bills/day, days active/week, actions viewed/accepted/executed, POs created, closing reports opened | `usage_events`, `actions` |
| Retention | D1/D7/D30; weekly active owners | `usage_events` |
| Revenue | MRR, ARR, ARPU, trial→paid, churn, failed payments | `subscriptions`, `payments` (existing, plus real MRR from payments rather than plan price) |
| AI | acceptance rate, 👍/👎 ratio, tokens per business | `actions`, `ai_usage` |
| **North star** | weekly active owners who **act on ≥ 1 recommendation** | `actions` |

## O. 90-day roadmap (assumes one full-time developer; scale if part-time)

| Weeks | Deliver | Exit check |
|---|---|---|
| 1–2 | `usage_events`; fix T1–T3 (rollups + non-blocking risk scoring); category/supplier CRUD; audit gaps; doc fixes | 111 tests + new tests green; POS search stays fast with 10k seeded SKUs |
| 3–4 | Decimals/units; MRP-inclusive tax; cost snapshot + cost history | Old bills unchanged; new bills tax-correct; migration tested on restored backup |
| 5–6 | Action Center v1 (stockout, expiry, slow stock, unusual activity, inactive customers) + "What should I do today?" + feedback buttons | Every action has evidence + button + status |
| 7–8 | Owner Today home, Cashier counter mode, hold bill, split pay, partial returns | Playwright flow passes |
| 9–10 | Udhaar Manager | Ledger invariants, aging, WhatsApp link |
| 11–12 | Import + one-click setup + barcode fields; Cash Trapped + Dead Stock; Closing Report | Time-to-first-sale test < 10 min with a 500-row file |

Pilot with 3–5 real shops from week 8.

## P. 1-year roadmap

- **Q1 (above)**
- **Q2**: purchase orders + Smart Reorder v2; shift handover; Price Change Intelligence; Profit Leak; Morning Brief delivery by email; Hindi + one regional language; PWA install.
- **Q3**: batch expiry rescue; supplier reliability + best supplier; Store Health; Value Protected; NL commands (read-only first); customer missed-visit list.
- **Q4**: seasonality/Business Memory; offline POS design → build; thermal-print hardening; multi-store design; reassess pricing with real usage data.

## Q. Estimated development complexity (dev-weeks, one developer, including tests)

| Item | Weeks | Depends on |
|---|---|---|
| Performance fixes (rollups, async risk) | 2 | — |
| Category/supplier CRUD + audit gaps | 1 | — |
| Decimals/units | 2 | — |
| MRP-inclusive tax + cost snapshot + history | 3 | — |
| Action Center v1 + feedback | 3 | rollups |
| Owner/Cashier modes + hold/split/returns | 4 | tax, decimals |
| Udhaar | 3 | split payment |
| Import + setup + barcode | 3 | decimals, suppliers |
| Cash Trapped + Dead Stock | 1 | cost snapshot |
| Closing report + shift handover | 2 | split payment |
| PO + Smart Reorder v2 | 4 | suppliers, Action Center |
| Price Change + Profit Leak | 3 | cost history, PO |
| Batch expiry | 3 | PO/receipt |
| Supplier reliability / best supplier | 2 | PO |
| Store Health, Value Protected | 3 | Action outcomes |
| NL commands | 2–3 | Action Center |
| Platform analytics views | 2 | usage events |
| Offline POS | 8+ | everything stable |
| **Total through Q3** | **≈ 40–45** | |

---

## Decisions I need from you before building

1. Approve **Gate 0** (decimals, MRP-inclusive tax, cost snapshot, supplier/category CRUD) as the first block, ahead of new "intelligence".
2. Target segment for the first 5 pilot shops (kirana/grocery vs. expiry-heavy retail) — it changes whether batch expiry moves earlier.
3. Reminders: free **click-to-chat WhatsApp links** first (my recommendation) vs. the paid WhatsApp Business API later.
4. A monthly LLM budget (or "deterministic only for now").
5. Hosting reality: free tiers sleep, so scheduled jobs are lazy until you approve something better.
