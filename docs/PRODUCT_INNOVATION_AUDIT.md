# SHARKPOS 2 — Product Innovation Audit

*Audit date: 5 Nov 2026. Scope: read-only. No production code, migration, test or config was changed. Nothing was deployed.*

**How this audit was done.** I unpacked the repository and read the code, not just the docs: all 8 migrations, `app.js`, `db.js`, every service, the AI modules, all route files, the main frontend pages, the CI workflow and the phase reports. I then ran the backend test suite against a throwaway PostgreSQL 16 instance (a separate copy, not your `sharkpos2` database) to check the claims below. Where a document and the code disagree, the code wins and the disagreement is listed in §0.

**Not verified:** frontend production build, behaviour in a browser, Razorpay in any mode other than `mock`, Docker image, CI on GitHub, backup/restore scripts (CI is configured to run them; I did not). I did not survey competitors, so every "differentiation" statement in this audit is a judgement about the product loop, not a market comparison.

---

## 0. Claims vs. code (read this first)

| Claim (brief, README, docs) | What the code shows |
|---|---|
| "~111 passing backend tests" | **Verified: 111 / 111 pass** (48.6 s, PostgreSQL 16, `npm test`). README still says "77 tests" (stale). |
| Multi-tenant with RLS | **Verified.** 11 tenant tables (`categories, suppliers, products, customers, sales, sale_items, inventory_movements, anomaly_alerts, restock_orders, settings, sale_requests`) have `ENABLE` + `FORCE` RLS, `business_id DEFAULT current_business_id()`, composite FKs. Raw-SQL isolation is tested (`saas.test.js`). |
| "AI Copilot" | **Regex intent router → deterministic SQL/statistics → optional LLM rephrase.** `copilot.js` matches ~12 intents by regular expression; anything else returns a help message. The LLM only rewords, and its answer is discarded unless every number is in the supplied facts (`grounding.js`). This is a good, honest design — but it is not a free-form assistant. |
| "Statistical demand forecasting" | **Verified** (`forecast.js`): 28-day window, 14-day weighted moving average, trend nudge, normal-model stockout probability, safety stock. No weekday/seasonal terms. |
| Supplier lead time in reorder logic | Uses **`products.lead_time_days`**. A `suppliers` table exists, but **no API or UI can create or edit a supplier or category** (only `seed/demo.js` and registration's starter categories insert them). A real new business has zero suppliers. |
| "Inventory" with restock approval | `restock_orders` is a thin approve/dismiss/receive record: no supplier link, no expected date, no cancel, no received-vs-ordered quantity, no cost. It is **not** a purchase order. |
| "Customers" | Segments from purchase history only. **No credit/udhaar of any kind.** |
| Profit | "Estimated profit" is computed with the product's **current** `purchase_price` (`analytics.js`), because `sale_items` does not store cost. Historical profit silently changes when you edit a purchase price. |
| Risk Center `cancellation_frequency` | Nothing in the app can create a `cancelled` sale (only the demo seed does). That factor never fires for real data. |
| README: "PWA-ready" | No web manifest, no service worker, no offline code anywhere in `frontend/`. |
| `docs/api.md` | Stale (old A/M/C role scheme and error shape; lists `/products` as open to all roles while the route is manager+). Do not use it as a contract. |
| "Rule-based, not ML" labelling | **Consistently honest** in code comments, `/ai/forecast` response and `Why.jsx`. Keep this. |

---

## 1. Existing features (verified in code)

| Area | What exists | Where |
|---|---|---|
| Auth | bcrypt-12, 15-min JWT in memory, rotating httpOnly refresh cookie with reuse detection, lockout after 5 fails, membership + role re-read from DB on every request | `middleware/auth.js`, `authService.js` |
| POS | Server-side pricing in integer paise, proportional discount allocation, category tax added on top, 3 payment methods (one per bill), cash-tendered/change display, customer picker, print via `window.print()` | `billing.js`, `sales.js`, `Pos.jsx`, `Invoice.jsx` |
| Discount control | Cashier limit (setting, default 10 %); above it, a manager/owner must enter credentials; manager cap 30 % | `sales.js` |
| Sale safety | Idempotency key per sale (`sale_requests`), row-locked stock, oversell blocked, expired products blocked | `sales.js`, migration 008 |
| Refunds | **Full refund only**, manager+; restores stock; audited | `sales.js` |
| Products | CRUD, soft delete, per-product lead time and **one** expiry date, plan limit on count | `products.js` |
| Inventory | Stock ledger (`inventory_movements`), alerts (stockout / low / expiry / overstock), restock recommendations, approve → receive flow | `inventory.js` |
| Forecast | See §0 | `forecast.js` |
| Analytics | Overview, sales trend, category, top products, payment mix, hourly; plan-gated "advanced" product analytics | `analytics.js` |
| Customers | Name/phone/email; segments (new/regular/vip/inactive), favourite category, average gap, insight text | `customers.js` |
| Risk Center | 8 explainable scoring factors → alert ≥ 40; review/dismiss | `risk.js` |
| Employees | Staff list with revenue, discounts, refunds, risk level; role rules (managers manage cashiers only; last-owner protection) | `employees.js` |
| AI | Daily brief, Copilot, restock reasons; optional LLM with number-grounding guardrail and deterministic fallback | `ai/*` |
| SaaS | Plans (Starter ₹99 / Business ₹199 / Pro ₹399 in DB), 14-day trial, Razorpay checkout + webhook (signature, idempotent by event id), 402 read-only mode when lapsed, plan limits & feature gates, onboarding checklist | `services/billing/*` |
| Platform admin | Overview (businesses, trials, paying, estimated MRR, 30-day collections), business search, extend trial, suspend/activate, plan editor | `routes/platform.js` |
| Public site | Landing, pricing (live from `/api/plans`), 3 **draft** legal pages, contact | `pages/public/*` |
| Ops | Health endpoints, in-memory metrics, encrypted backups + restore drill workflow, CI (test, migrate, backup→restore, frontend build) | `scripts/`, `.github/` |
| Demo | Demo business seed/reset (only for `is_demo` businesses) | `seed/demo.js`, `routes/demo.js` |

## 2. Existing user workflows

| User | Works end to end today | Breaks or is missing |
|---|---|---|
| **Owner** | Register → 14-day trial → add products one by one → invite staff → watch dashboard/brief → approve restock → mark received → review risk alerts → pay for plan | Cannot add a supplier or category; cannot import products; cannot see money owed to/by anyone; dashboard is information-first (6 KPI tiles, 2 charts, lists), 14 nav items |
| **Manager** | Same as owner minus billing/audit/settings edits; refunds; manages cashiers | Same gaps |
| **Cashier** | Search/tap/Enter to add, discount (with manager approval), pay, print | No hold bill, no return/exchange, no split payment, no loose-weight quantity, no scan-first flow, no shift open/close; sees "Why SHARKPOS AI?" in nav |
| **Platform admin** | See businesses, extend trial, suspend, edit plans | No funnel, activation, retention, or usage view; platform audit entries are written but unreadable (RLS) |

## 3. Existing database capabilities

Tenant tables (11) listed in §0, plus platform tables `businesses, accounts, memberships, sessions, audit_logs, plans, subscriptions, payments, billing_events`. Strengths: composite tenant FKs, forced RLS, append-only audit, no-delete on payments/billing events/sale claims, additive numbered migrations, a backup role with a read-only policy.

**What the schema cannot represent today** (each blocks a feature in the brief):

| Missing | Consequence |
|---|---|
| Decimal quantity (`stock`, `quantity` are `INT`) | Cannot sell loose rice/sugar/oil by kg or litre — the core of a kirana |
| Cost snapshot on `sale_items` | Profit is only an estimate; price-change and margin-leak analysis impossible |
| Purchase-price history | Cannot detect supplier price rises |
| Tax-inclusive pricing, HSN, per-line tax stored | Indian MRP is tax-inclusive; the engine adds tax **on top** of the selling price. Invoice tax split is not persisted per line |
| Batches / lots with expiry | One expiry date per product: expiry rescue would be wrong for any product with two deliveries |
| Purchase orders & goods receipts | No supplier delay, shortfall or price tracking → no supplier reliability |
| Customer ledger / credit | No udhaar, no aging, no collections |
| Split payment lines | One `payment_method` per bill; cash-vs-UPI reconciliation is bill-level only |
| Returns by line, exchanges | Only whole-bill refund |
| Cash shifts / drawer | No opening cash, no handover, no difference record |
| Barcode (multiple per product) | `sku` doubles as barcode only if the owner types it that way |
| Action / recommendation lifecycle | Recommendations are recomputed on request and forgotten; nothing records accepted/ignored/outcome |
| Daily rollups | Every dashboard, forecast and POS search re-aggregates raw `sale_items` |
| Product/usage events, AI usage | Cannot compute activation/retention or AI cost per tenant |

## 4. Existing AI capabilities (honest classification)

| Capability | Method | Label it as |
|---|---|---|
| Demand forecast, stockout risk, reorder qty | Weighted moving average + normal approximation | Statistical |
| Risk Center | Weighted rules vs. cashier's own history | Rule-based |
| Customer segments/insights | Thresholds on spend/recency | Rule-based |
| Copilot | Regex intents → SQL → templated text | Rule-based, optional LLM rewording |
| Daily brief | Template; optional LLM rewording with number check | Rule-based + optional LLM |

Gaps: no per-tenant LLM quota or usage record (only a 30 req/min limiter keyed by IP); `aiInsights` is a boolean plan flag; no feedback capture; no outcome tracking; the LLM prompt includes product names and amounts (acceptable) but there is no data-minimisation policy yet.

## 5. Existing security boundaries

Strong: tenant isolation at three layers; role re-validation per request; CSRF header on cookie routes; Zod on inputs; parameterised SQL; production boot refuses weak config; payments verified server-side; idempotent sales; least-privilege DB roles; tenant-keyed cache.

Gaps found:
1. **Audit coverage**: no audit entry for restock dismissal, risk-alert review/dismiss, customer creation. (Sale create/refund, product, employee, settings, restock approve/receive are audited.)
2. Platform-level audit rows are write-only in practice (known; documented in phase report).
3. No email verification or password reset (documented).
4. AI limiter is per-IP, not per-business or per-user.
5. In-process cache and metrics: correct for one instance; stale across multiple instances.
6. `sale_requests` keys never purged (documented).
7. The AI/Present/Why pages and `/demo` routes are hackathon artefacts still in the production bundle; demo reset is guarded by `is_demo` and `ALLOW_DEMO`, which is correct, but `/why` is reachable by every role.

## 6. Existing SaaS capabilities

Plans/limits in DB; trial; subscription state machine; Razorpay; read-only lapse mode; platform dashboard with estimated MRR. **Missing for running a SaaS business:** acquisition/activation/retention events, churn reasons, email delivery (receipts, reminders, dunning), per-plan AI quotas, support tooling, a platform audit viewer.

## 7. Weak UX areas

1. Dashboard shows numbers and charts; the only "action" is a link. Nothing says "do this first".
2. Owner navigation has 14 items; a shop owner wants ~4.
3. Cashier screen lacks the actions a counter needs daily (hold, return, split pay, scan).
4. Onboarding is "add products one by one"; no import, so a 2,000-SKU shop cannot get started in 10 minutes.
5. Starter categories exist but cannot be edited; suppliers cannot be added at all.
6. Quantities are whole numbers only.
7. English only.
8. Pitch pages (`Why`, `Present`) mixed into the product.

## 8. Missing retailer workflows (verified absent)

Udhaar/credit · supplier directory · purchase orders & goods receipt · batch expiry · loose/decimal quantity and unit conversion (kg↔g, carton↔pcs) · tax-inclusive MRP billing and HSN · split payments · partial returns/exchanges · hold bill · shift open/close and cash handover · stock count / wastage / damage logging with reasons · product import · barcode fields and label printing · WhatsApp sharing · expenses (needed for true profit) · offline · multi-store (plan field says "coming soon") · regional languages.

## 9. Features that should NOT be built (now)

| Idea | Why not |
|---|---|
| Free-form "ask anything" chatbot | Violates the brief's own rule; the grounded, allow-listed command model is safer and cheaper |
| LLM that writes SQL or performs mutations directly | Authorisation bypass risk; unverifiable |
| ML churn / fraud "prediction" | Too little data per shop; cannot be validated; use "missed usual visit interval" and "unusual activity" wording |
| Automatic customer SMS/WhatsApp blasts | Spam, consent and DPDP exposure; use owner-initiated click-to-chat links |
| Automatic price changes or auto-ordering | Owners must approve every price and order |
| Opaque composite "AI score" | Not explainable; ship Store Health only with a visible formula |
| Competitor price scraping | Legal/maintenance burden, low reliability |
| Voice assistant, face recognition for staff | Novelty; privacy risk |
| Native Android/iOS apps | A proper PWA first |
| Full GST return filing / accounting | Different product; export clean data instead |
| Delivery/marketplace integrations, loyalty-points programmes | Before product-market fit |
| Multi-store, weighing-scale integration | After single-store is solid |

## 10. Opportunities for differentiation

1. A closed loop most small-shop tools lack: **detect → recommend → act → measure → learn**, with every recommendation traceable to the shop's own numbers.
2. **Rupee framing**: cash trapped in stock, udhaar outstanding, margin lost — shown as money, not charts.
3. **Daily ritual**: morning brief → counter → closing report with cash difference.
4. **Trust by honesty**: "statistical / rule-based" labelling already in the code base; keep it as a brand promise.
5. **Local intelligence**: per-shop weekday and seasonal patterns that improve with tenure (retention moat).

## 11. Technical risks

| # | Risk | Evidence | Severity |
|---|---|---|---|
| T1 | **Cache invalidation on every sale forces a full product-stats recompute** (all active products + 28 days of sale rows) on the next POS search | `createSale → invalidateAll()`; `searchForPos → getProductStats()` | High at ≥ a few thousand SKUs or busy tills |
| T2 | **Risk scoring runs synchronously inside checkout** and re-aggregates 90 days of sales each time | `createSale → evaluateSales → getBaselines` | Medium, grows with sales volume |
| T3 | `getCustomer` loads **all** customers to find one; `listCustomers` computes every customer then filters/paginates in JS | `customers.js` | Medium at thousands of customers |
| T4 | Integer quantities; tax-exclusive pricing | schema, `billing.js` | High for product fit, and it gets costlier to change as data accumulates |
| T5 | Profit uses current purchase price | `analytics.js` | High for trust: reported profit changes retroactively |
| T6 | No scheduler: the app runs on a sleeping free tier, so nightly rollups, morning briefs and reminders need a lazy "compute on first open" design or a cron | `render.yaml`, phase-3 docs | Medium |
| T7 | No frontend tests; backend has none for POS UI logic | `frontend/package.json` has no test script | Medium |
| T8 | `restock_orders` semantics will conflict with real purchase orders | §0 | Medium (plan a migration path) |
| T9 | Free-tier hosting is not suitable for real shop data (the phase report says so) | `phase1-4-report.md` | Business risk, not code |
| T10 | Stale docs (`api.md`, README test count, "PWA-ready") | §0 | Low, but erodes trust in the rest |

## 12. Recommended roadmap (summary — details in `PRODUCT_INNOVATION_REPORT.md`)

- **Gate 0 — Retail data foundations (before any new "intelligence")**: decimal quantity and units, tax-inclusive MRP pricing, cost snapshot on sale lines, category + supplier management, performance fixes T1–T3.
- **P0**: Action Center with lifecycle and feedback; Today/Owner home; Closing report and Morning brief; Udhaar; Purchase orders + Smart Reorder v2; Cash Trapped + Dead Stock; product import + barcode; platform product analytics.
- **P1**: Price-change intelligence and profit-leak; batch expiry rescue; supplier reliability; shift handover; Store Health; Value Protected; customer missed-visit list with WhatsApp click-to-chat; NL commands (allow-listed).
- **P2**: Best-supplier comparison; offline POS; seasonality; multi-store; weighing scale.
- **Rejected**: §9.
