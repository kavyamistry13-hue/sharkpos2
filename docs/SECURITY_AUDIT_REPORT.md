# SHARKPOS 2 — Security Audit Report (Security & Data Protection phase)

Scope: the existing SHARKPOS 2 repository (Sprints 1–7). Method: read-only inspection first; then direct-API probes as separate tenants and roles (never through the UI), live-database introspection of roles/RLS/policies, a real backup→restore drill, and fixes only for confirmed gaps. Nothing was committed, pushed or deployed. SHARKPOS 1 was not touched.

## 1. Executive summary
The foundations were sound: forced row-level security on 31 tenant tables, a least-privilege runtime role, DB-rechecked sessions, rotating hashed refresh tokens, parameterised SQL, an append-only audit log, encrypted backups and an idempotent money path. **No tenant-isolation break and no unauthenticated access was found** (111 business routes probed as anonymous/cashier/manager/owner; Shop B vs Shop A attacked by id on every listed entity).
Real gaps were found and fixed: one **High** (discount-approval password oracle) and several **Medium** (money/stock ledgers rewritable by the app credential; oversize body returned 500; backup verification omitted newer tables; no restore content proof; migration 011's refund backfill silently did nothing). Remaining risks are listed in §6. This is not a claim of "100% secure": there has been no independent penetration test.

Results: backend suite **324 / 324 passing** (237 pre-existing, 87 new security tests; 0 failed); frontend build OK; Sprint 6–7 browser journey **PASS**; `npm audit` 0 vulnerabilities (backend and frontend); restore drill **VERIFIED** (40 tables, 546 rows, identical counts and checksums).

## 2. Existing controls (verified, not assumed)
See `docs/SECURITY.md` §1–§9. Highlights: HS256 pinned JWT 15 min + DB re-check per request; refresh cookie httpOnly/SameSite=Strict with reuse detection; bcrypt-12, lockout, rate limits; `authorize()` on every route; FORCE RLS + composite tenant FKs; Helmet/CSP/CORS allow-list; request log without bodies; production start-up refuses weak config.

## 3. Findings
Severity: Critical / High / Medium / Low / Informational. "Test" = proving regression test in `backend/tests/security.test.js` (ST) or `security-migration.test.js` (SM).

| ID | Sev | Component | Description | Exploit scenario | Impact | Fix | Status / proving test |
|---|---|---|---|---|---|---|---|
| F-01 | **High** | `services/sales.js` discount approval | Approver email+password checked with bcrypt but with no lockout, no throttle, no failure record | A cashier (or stolen cashier token) posts sales with `approval:{email: owner, password: guess}` up to the global rate limit, bypassing the login lockout | Guessing a manager/owner password → full business takeover | New `services/approvalGuard.js`: 5 failures/15 min per cashier → 429; failures count toward the approver's login lockout; uniform error and constant-time bcrypt | **Fixed** — ST "discount approval is not a password oracle" |
| F-02 | Medium | DB: `sales`, `sale_items`, `inventory_movements` | Single `FOR ALL` tenant policy; app role could UPDATE/DELETE | Bug or stolen app credential edits a finished sale's total/date, deletes sales, or rewrites stock history inside the tenant | Silent financial/stock tampering; audit gap | Migration **014**: RESTRICTIVE policies (DELETE for demo businesses only; inventory UPDATE denied), UPDATE/TRUNCATE revoked, triggers freeze money fields and make refund counters one-way. Additive, nothing dropped | **Fixed** — ST "ledger tamper…", "a sale can still be returned and refunded…"; SM both tests |
| F-03 | Medium | `middleware/error.js` | Body > 100 kB returned HTTP 500 (`entity.too.large` unhandled) and logged as an application error | Anyone can post a 200 kB body to produce 500s/noise and hide real errors | Misleading errors; log noise; DoS signal | Return **413** with a generic message | **Fixed** — ST "oversized body -> 413" |
| F-04 | Medium | `scripts/backup.sh` | Verification checked 5 hard-coded tables, so Sprint 7 tables (sale_payments, sale_returns, held_bills…) could be missing from a "verified" backup | A permissions change or new table silently excluded from backups | Data loss discovered only at restore time | Verification now lists the live tables and requires a data entry for each | **Fixed** — drill: 40/40 tables; ST static check |
| F-05 | Medium | restore process | Restore printed 8 table counts only; nothing proved content equality | Truncated/altered restore looks "successful" | False confidence | `restore.sh` prints every table; new `scripts/verify-restore.js` compares counts + checksums, exit 1 on any difference | **Fixed** — drill incl. negative control |
| F-06 | Medium | migration 011 | `UPDATE sales SET refunded_at…` ran with no tenant → RLS hid every row → legacy refunds kept `refunded_at = NULL` | Legacy refunded sales attributed to the wrong day / missing from refund reports | Wrong reports on legacy data | Migration 014 redoes the backfill per tenant (idempotent) | **Fixed** — SM "014 repairs 011's backfill" |
| F-07 | Low | `routes/sales.js`, `heldBills.js` | Percentage discount > 100 accepted and silently clamped to a free sale | Owner/manager typo or crafted request → ₹0 bill | Data-quality; bypasses the displayed discount % in audit | Zod refine: percent ≤ 100 | **Fixed** — ST "discounts over 100%…" |
| F-08 | Low | `notFoundHandler` | Echoed the raw request URL in JSON | Reflected text in error body | Low (JSON + nosniff) | Generic "Route not found." | **Fixed** — ST "unknown routes…" |
| F-09 | Low | DB: billing_events, payments, subscriptions, memberships, sessions | `business_id` present but **no RLS** (platform code, app-level guards) | A future route that queries these via the tenant path without a filter would leak | Medium blast radius if a bug is introduced | Accepted design; classified in SECURITY.md; routes guarded and tested | **Open (accepted)** — recommend adding RLS in a later phase |
| F-10 | Low | DB view `users` | Exposes `password_hash`; runs with owner privileges | A future query selecting `*` from `users` and returning it | Hash disclosure | No route returns it (tested); recommend a view without the hash and a separate lookup for the approval flow | **Open** — ST "password hash … never appear" |
| F-11 | Low | auth | Locked account answers 429 (vs 401) and registration reveals existing emails | Account enumeration | Privacy | Needs product decision (uniform responses) | **Open** |
| F-12 | Info | auth | Access token stays valid ≤ 15 min after logout/password change (deactivation is immediate) | Stolen token | Short window | Acceptable; optional token-version claim later | Open (accepted) |
| F-13 | Info | auth | No MFA, no email verification, no email password reset | Credential stuffing | Account takeover risk | Roadmap | Open |
| F-14 | Info | sales | Owner may discount 100% (by design, audited); managers 30% | Insider fraud by owner | Business risk | Documented | Accepted |
| F-15 | Info | approvalGuard | Throttle is in memory per process | Restart or multi-instance resets it (account lockout in DB still applies) | Reduced throttle | Use a shared store if scaled out | Accepted |
| F-16 | Info | secrets scan | gitleaks/trufflehog/semgrep/trivy are **not installed** in this environment; only a built-in pattern scan, npm audit and manual review ran. The audited snapshot had no `.git`, so **history was not scanned** | A secret committed in the past | Unknown | Run `gitleaks detect` locally (free) | **NOT VERIFIED** |
| F-17 | Info | tests | Existing fixtures backdated `sales.created_at` through the app role — exactly what F-02 forbids | — | — | Three fixture lines now use a test-only helper (`backdateSaleFixture`, owner role, trigger off inside one transaction). **No assertion was changed or removed.** | Done |

## 4. Result per area
- **Tenant isolation — PASS.** B cannot read, modify, sell, return, refund or discard A's products, customers, sales, held bills, Udhaar, inventory, forecasts, employees or audit; list endpoints never contain A's rows; tenant hints in body/header/query ignored; forged `bid`/role claims rejected; deactivated user loses access immediately. DB level: no tenant = zero rows; cross-tenant writes rejected by RLS.
- **RBAC — PASS.** Full matrix in SECURITY.md §3 (derived from 111 probed routes). 29 explicit denial tests, manager escalation attempts blocked, last-owner protected.
- **Authentication — PASS WITH CAVEAT** (F-01 fixed; F-11–F-13 open).
- **API security — PASS.** SQLi strings, bad ids, prototype pollution, mass assignment, malformed/oversized JSON, XSS payloads, headers and CORS tested.
- **Financial integrity — PASS WITH CAVEAT.** All malicious cases rejected; idempotency, replay and concurrency hold; caveat: known reporting limitations (§5).
- **PostgreSQL/RLS — PASS WITH CAVEAT** (F-09, F-10).
- **Audit logging — PASS.** Append-only for the app role, no secrets stored.
- **Secrets — PASS WITH CAVEAT** (history not verified, F-16).
- **Dependencies — PASS.** `npm audit` 0/0; Zod stays 4.x; no upgrades made.
- **Backup / Restore — PASS.** Real drill with count + checksum comparison (see SECURITY.md §9). Caveat: the GitHub-vault upload and scheduled workflows were not executed here.
- **Disaster recovery — PASS WITH CAVEAT.** Scenarios A–F documented with honest RPO ≈ 24 h / RTO ≈ 1–3 h; not rehearsed on production.
- **Frontend — PASS.** Access token memory-only (no localStorage), no `innerHTML`/`dangerouslySetInnerHTML`, demo credentials only in dev builds, cashier kept out of owner pages (E2E), and the backend remains the authorization boundary.

## 5. Sprint 6–7 known limitations — classification
| Limitation | Class | Decision |
|---|---|---|
| Partial-return reports count full sale value (customer LTV, employee performance, forecast velocity, dead stock, profit leak, risk scorer) | Data-integrity risk (reporting only; money, drawer and closing report are correct) | **Must fix before pilot** — not changed in this phase (touches six intelligence modules; separate, tested change) |
| Return attribution date | Data-integrity risk (low) | Can fix after pilot |
| Legacy header-only refund records | Data-integrity risk (legacy data only; a fresh pilot shop has none) | Acceptable / can fix after pilot |
| Hard-coded 24 h cashier return window | Operational; it is also a fraud control | Acceptable limitation |
| Hard-coded 20 open holds | Operational; also bounds abuse | Can fix after pilot |
| Holds never expire | Operational (clutter; stock is not reserved) | Can fix after pilot |
| Counter mode has no discount / manager-approval flow | Acceptable (a restriction, not a hole) | Acceptable |
| Migration 011 tenant-context concern | Data-integrity risk | **Fixed** (migration 014, F-06) |

## 6. Remaining risks and recommended next phase
1. Run `gitleaks` on real history; rotate anything found (F-16). 2. Fix partial-return reporting before the pilot (§5). 3. RLS or a stricter design for the five platform tables and a hash-free `users` view (F-09, F-10). 4. Password reset by email, optional MFA for owners, uniform auth responses (F-11, F-13). 5. Rehearse scenario A on the production host and record the real RTO; consider a second off-site vault. 6. Independent penetration test before scaling beyond a pilot. 7. Optional ⚠️ PAID: managed secrets rotation, WAF, uptime/SIEM tooling — none were used.

## 7. Production readiness assessment
**Ready for a small, supervised pilot** once the Data Protection Checklist is completed (especially: gitleaks on history, production restore drill, secrets set in the host) and the partial-return reporting limitation is fixed or explained to the shop owner. **Not yet** suitable for unsupervised scale without MFA/password reset, a rehearsed production recovery and an external penetration test.

## 8. Files and migrations
Changed: `backend/src/middleware/error.js`, `backend/src/routes/{sales,heldBills}.js`, `backend/src/services/sales.js`, `scripts/{backup.sh,restore.sh}`, `README.md` (docs list), three test fixtures (`tests/{helpers,intelligence,measurement,partial-returns}.test.js` helper lines). Added: `database/migrations/014_ledger_hardening.sql`, `backend/src/services/approvalGuard.js`, `scripts/verify-restore.js`, `backend/tests/{security,security-migration}.test.js`, `docs/{SECURITY,DATA_PROTECTION_CHECKLIST,SECURITY_AUDIT_REPORT}.md`. Replaced: `docs/security.md` → `docs/SECURITY.md` (content preserved as an appendix; avoids a case-only filename clash on Windows/macOS).
