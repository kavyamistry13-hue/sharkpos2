# SHARKPOS 2

Commercial, multi-tenant SaaS version of SHARKPOS AI: POS + inventory + analytics + AI for small retailers.
**This is a separate project.** The original SHARKPOS (hackathon version) is untouched and keeps its own code, database (`sharkpos`) and ports (4000 / 5173).

| | SHARKPOS (hackathon) | SHARKPOS 2 |
|---|---|---|
| Frontend | :5173 | **:5174** |
| Backend | :4000 | **:4001** |
| Database | `sharkpos` | **`sharkpos2`** (own roles) |

## Status
**Phase 1 — complete and tested** (multi-tenancy, registration, roles, security, audit log, responsive UI).
**Phase 2 — complete and tested** (plans, 14-day trial, Razorpay payments, billing page, plan limits and feature gates; see `docs/phase2-report.md`).
**Phase 3 — prepared for a ₹0 stack, NOT deployed** (Cloudflare Pages + Render free + Neon free, encrypted backups with tested restore, monitoring, CI/CD; see `docs/phase3-deployment.md`). It goes live only after you approve.
**Phase 4 — landing, pricing, draft legal pages, onboarding checklist, platform admin dashboard: built, NOT deployed (see `docs/phase1-4-report.md`).** Nothing is deployed until you approve.

## What Phase 1 delivers
- **Multi-tenancy** — every business has isolated data. Enforced three ways: (1) row-level security in PostgreSQL, (2) composite foreign keys that make cross-business references impossible, (3) tenant-scoped data layer and per-business caches. Frontend filtering is never relied on.
- **Registration & onboarding** — create account → create business → dashboard (2 short steps, phone-friendly). Creates the business, owner and starter categories/settings in one transaction.
- **Roles (enforced on the backend)** — `platform_admin`, `business_owner`, `manager`, `cashier`. Roles are re-read from the database on every request, so removing an employee or changing a role takes effect immediately.
- **Security** — bcrypt (12 rounds), 15-minute access tokens in memory, rotating httpOnly refresh cookie with reuse detection, CSRF header, account lockout, rate limits, Helmet/CSP, strict CORS, Zod validation, parameterised SQL, generic error messages, secrets only in env.
- **Audit log** — sign-ins, product create/edit/price change/delete, sales, refunds, restocks, employees, settings; append-only (the app role cannot update or delete it). Owners see it under *Activity log*.
- **Existing features carried over** — POS (server-side billing in paise), products, inventory + AI restock, sales/refunds, customers, analytics, Copilot, Risk Center (rule-based), employees, settings. AI is optional and never blocks the POS.
- **UX states** — loading, empty, error and success states on every major page; error boundary shows "Something went wrong. Please try again."

## Run locally
Prerequisites: Node 20+, PostgreSQL 14+ running.

```bash
# 1. databases + roles (one time, as a PostgreSQL superuser)
psql -U postgres -f database/setup-local.sql

# 2. backend
cd backend
cp .env.example .env            # Windows: copy .env.example .env  (then edit passwords/JWT_SECRET)
npm install
npm run migrate                 # creates all tables as sharkpos2_owner
# To try billing locally add to .env:  PAYMENT_PROVIDER=mock  PAYMENT_KEY_SECRET=local-dev  PAYMENT_WEBHOOK_SECRET=local-dev
npm run seed                    # demo business + platform admin (development only)
npm run dev                     # http://localhost:4001

# 3. frontend (new terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5174
```
If your Postgres runs on another port, change it in `backend/.env` (the example uses 5432).

Open **http://localhost:5174**.

| Account | Email | Password |
|---|---|---|
| Business owner (demo) | admin@sharkpos.ai | admin123 |
| Manager | manager@sharkpos.ai | manager123 |
| Cashier | cashier@sharkpos.ai | cashier123 |
| Platform admin | platform@sharkpos.ai | platform123 |

Or click **Create your business account** to register a brand-new, empty business.
Demo credentials are for development only; the login page hides them in production builds.

## Tests
```bash
cd backend && npm test      # 77 tests; uses the throw-away database sharkpos2_test
```
Covers registration, login, lockout, token tampering, refresh rotation/reuse, logout, role permissions (owner/manager/cashier/platform), **Business A vs Business B isolation** (API and raw SQL), POS totals, stock, refunds, discount approval across tenants, audit log, AI fallback and error handling.

## Safety rails against touching the original project
- `DATABASE_URL` must name a database starting with `sharkpos2`; the server, migrations and seed refuse to start otherwise.
- Separate roles (`sharkpos2_owner`, `sharkpos2_app`) with no rights on the original database.
- Different ports. No file of the original project is modified or imported.

## Layout
```
backend/   Express API (routes → services → tenant-aware db layer), tests
frontend/  React + Vite + Tailwind PWA-ready SPA
database/  migrations/ (001–008), migrate.js, seed.js, create-platform-admin.js, setup-local.sql, setup-production.sql
scripts/   backup.sh, restore.sh, backup-prune.js
ops/       keepalive/ (optional Cloudflare cron Worker)
.github/   workflows: ci.yml (test + approved deploy), backup.yml, restore-drill.yml
docs/      architecture.md, PHASE_8_BARCODE.md, PHASE_8_1_SCAN_ADD.md, SECURITY.md, DATA_PROTECTION_CHECKLIST.md, SECURITY_AUDIT_REPORT.md, phase1-3 reports, phase3-deployment.md
```
See [docs/architecture.md](docs/architecture.md) and [docs/phase1-report.md](docs/phase1-report.md).
