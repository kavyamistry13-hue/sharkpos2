# SHARKPOS 2 — consolidated report, Phases 1–4

Status: **built and tested locally. Nothing is deployed. No hosting resource or paid service has been created.**
SHARKPOS 1 (the hackathon project and its database) was not touched.

## 1. What each phase delivered
| Phase | Delivered |
|---|---|
| 1 Multi-tenant & security | Separate data per business enforced inside PostgreSQL (row-level security), least-privilege database roles, bcrypt passwords, short-lived access tokens + rotating httpOnly refresh cookie, CSRF header, lockout and rate limits, audit trail, owner/manager/cashier roles |
| 2 Billing | Database-driven plans, 14-day trial, subscription state machine (trial → active → past due → expired/cancelled), Razorpay orders with server-side signature check and webhooks, read-only mode for lapsed businesses, plan limits enforced by the API |
| 3 Free-tier deployment (prepared) | Cloudflare Pages + Render + Neon runbook, same-site proxy for cookies, health checks, metrics, encrypted nightly backups with tested restore, CI workflows, **duplicate-sale protection** (idempotency keys, migration 008) |
| 4 Product site & admin | Landing page, live pricing page, three draft legal pages + contact page, onboarding checklist, platform admin dashboard (overview, business search, trial extension, suspend/activate, plan editor) |

## 2. Phase 4 details
- **Public site** (`/`, `/pricing`, `/terms`, `/privacy`, `/refunds`, `/contact`): responsive, keyboard-accessible, mobile menu. Prices, limits and bullet points come from `GET /api/plans`; nothing is hard-coded. Pricing "Start free trial" carries the chosen plan into registration. Signed-in users visiting `/` go straight to their app.
- **Legal pages are DRAFTS.** Every page shows a "Draft for review — not reviewed by a lawyer" banner and keeps `[to be added]` placeholders (legal entity, address, grievance officer, retention periods, refund rule, jurisdiction city). A test stops anyone claiming legal approval. They are written around Indian practice (DPDP Act 2023, Razorpay, GST) but **a qualified Indian lawyer must review them before launch.**
- **Onboarding:** `GET /api/onboarding`, `POST /api/onboarding/dismiss`. Five steps computed from real data (shop address, first product, first sale, invite cashier, choose plan); owner can hide it; per business; cashiers cannot see it.
- **Platform admin:** `GET /api/platform/overview` (businesses, trials, paying, expired, estimated MRR, 30-day collections, failed payments; demo businesses excluded), business search by name/owner/email with plan and subscription state, `extend-trial` (never for paying businesses), plan create/edit/hide with strict validation, all audited.
- **Plans stay configurable:** edit them in the Plans tab (or the `plans` table). Price changes apply from the next payment; a hidden plan keeps existing subscribers; the default plan cannot be hidden.
- Site details are set at build time with `VITE_SUPPORT_EMAIL`, `VITE_LEGAL_ENTITY`, `VITE_BUSINESS_ADDRESS`, `VITE_GRIEVANCE_OFFICER` (not secrets).

## 3. Test and build results (actual)
- Backend: **111 / 111 pass** (`npm test`): 95 from Phases 1–3 + 7 platform + 4 onboarding + 5 public-site guard tests. All earlier tests still pass unchanged.
- Frontend production build: passes.
- Real browser (Chromium) at 375 px phone and 1280 px desktop: landing, pricing, 3 legal pages, contact, registration (plan carried from pricing), onboarding card (show, hide, stays hidden after reload), platform overview / businesses / plans / plan editor. No horizontal overflow; no JavaScript errors. One layout bug (comparison table overflowing on phones) was found and fixed. Only console noise: Google Fonts blocked in this sandbox and the normal 401 before sign-in.
- Not covered by automated tests: the page visuals beyond the screenshots I reviewed, and the platform admin screens' button flows (suspend / extend / save plan are covered at API level, not clicked in the browser).

## 4. Known risks
1. **Legal text is unreviewed** (above) — launching without review is a business risk.
2. **Platform-level audit entries** (plan edits) are written but cannot be read in the app: row-level security hides rows with no business. Trial extensions are visible to the business's own audit view. A platform audit view is future work.
3. Render free restarts/sleeps at any time (about 1 minute to wake); Render itself says free instances are not for production. Duplicate-sale protection means a retry is safe, but the cashier can still wait up to ~15 s.
4. Neon Free is **development/testing only for now**: public endpoint with no IP allow-list, 1 GB, 100 compute-hours/month, 6-hour restore window, suspends after 5 minutes idle.
5. Not verified anywhere real: Docker image build, Render/Neon/Cloudflare/GitHub Actions behaviour, TLS `verify-full` to Neon, Razorpay live mode (only test/mock), CSP with the live Razorpay window.
6. No email sending exists (no password-reset or receipt emails); support is by a plain email address.
7. Old idempotency keys are never purged yet. MRR is an estimate from plan prices, not accounting.
8. Overview counts load all subscriptions in memory — fine for hundreds of businesses, revisit at thousands.

## 5. Remaining tasks (all need you)
- Have the three legal pages reviewed by a lawyer; fill every `[...]` placeholder; decide the refund rule and data-retention period.
- Choose a support email address; set the four `VITE_*` values.
- Decide whether Neon Free is acceptable for real shop data (recommendation: no — use it for testing only).
- Razorpay: open an account, complete business verification, test mode first, then live keys.
- Optional later: email delivery, platform audit viewer, key-purge job, own domain (paid), paid hosting if the free limits bite.

## 6. Accounts, secrets and settings needed to deploy
Accounts (all have free tiers; decline any paid upgrade): GitHub, Cloudflare, Render, Neon, Razorpay (test mode); optional AI key.
Secrets live only in provider dashboards / GitHub environment secrets, never in the repo: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `JWT_SECRET`, payment key and webhook secrets, `PROXY_SHARED_SECRET`, backup passphrase and vault token, deploy hook, Cloudflare token. Exact list and steps: `docs/phase3-deployment.md`.

## 7. Free-tier limits (as gathered earlier from the providers' pages; re-check before relying)
Render free: sleeps after 15 min idle, ~1 min wake, 750 instance-hours/month, may restart anytime. Neon free: 1 GB, 100 compute-hours, 5-min auto-suspend, 6-hour restore, no IP allow-list. Cloudflare Pages Functions: 100,000 requests/day, 10 ms CPU per request. GitHub Actions: free minutes for private repos are limited. Keep-alive pings are best effort and not guaranteed.

## 8. Run locally
```
bash /home/claude/sharkpos/start-db.sh      # local PostgreSQL on 5433 (dev machine setup)
cd backend && npm install && npm run migrate && npm test
npm run dev                                  # API  http://localhost:4001
cd ../frontend && npm install && npm run dev # app  http://localhost:5174
```
Platform admin (local only): `PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='long passphrase' npm run create-admin` from `backend/`.
During this phase I applied migration 008 (additive: one new table) and created one local platform-admin account (`owner@sharkpos-local.test`) plus a few test businesses in the **local development database `sharkpos2`** only. Nothing was deleted.

## 9. Deploy later (only after your explicit approval)
Follow `docs/phase3-deployment.md`: create the free accounts → Neon database and roles → Render service → Cloudflare Pages project with the proxy function → GitHub secrets → run migrations → create platform admin → smoke test → run a backup and a restore drill. I will not start any of it until you say so.
