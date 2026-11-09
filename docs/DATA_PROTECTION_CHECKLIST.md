# SHARKPOS 2 — Data Protection Checklist (before a real shop goes live)

Tick every box yourself. Anything you cannot tick is a reason to wait. Details: `docs/SECURITY.md`.

## A. Secrets and access
- [ ] `JWT_SECRET` is a fresh random value (`openssl rand -hex 48`), set only in the host's secret store.
- [ ] `PROXY_SHARED_SECRET`, payment keys and `LLM_API_KEY` are set in the host's secret store only (never in a file in the repo).
- [ ] Production DB passwords are **not** the local/dev ones; created with `database/setup-production.sql` (three separate roles: owner, app, backup).
- [ ] The API runs with the **app** role only. The owner role is used only for migrations, the backup role only for backups.
- [ ] `gitleaks detect` (free) was run on the real Git repository **including history**; anything found was rotated.
- [ ] No demo accounts exist in the production database; `ALLOW_DEMO` is off.
- [ ] The platform-admin account has a strong unique password and is not shared.
- [ ] `NODE_ENV=production`: the app refuses to start with weak secrets, localhost DB, non-https CORS or mock payments — a start-up error is a good sign.

## B. Backups (do these in order)
- [ ] `BACKUP_PASSPHRASE` (≥ 20 characters) is stored in **two** safe places (password manager + printed copy). Without it, backups cannot be read.
- [ ] The backup vault is private (private GitHub repo with a repo-limited token, or a private bucket).
- [ ] `scripts/backup.sh` ran against production and printed "Verified … tables with data".
- [ ] Nightly backup workflow is enabled; a failure sends an email you actually read.
- [ ] **Restore tested**: restored the latest backup into a new empty `sharkpos2_restore` DB with `scripts/restore.sh`.
- [ ] `node scripts/verify-restore.js` printed **RESTORE VERIFIED** (counts and checksums identical).
- [ ] You know the honest numbers: data loss up to ~24 h (nightly backups); recovery 1–3 h by one person.
- [ ] Take and verify an extra backup **before every migration or release**.

## C. Isolation and permissions (run once on the production build)
- [ ] `NODE_ENV=test node --test --test-concurrency=1 tests/*.test.js` is fully green (currently 324 tests).
- [ ] Two test shops exist; logged in as shop B you cannot open shop A's sale/customer/product by changing the id in the address bar.
- [ ] A cashier login cannot open Owner Today, Reports, Suppliers, Employees, Audit, Settings (the screens are hidden **and** the API says 403).
- [ ] Each employee has their own login. Nobody shares the owner password.
- [ ] Discount-approval passwords are only given by managers/owners; 5 wrong approvals lock that cashier's approvals for 15 minutes.

## D. Money integrity
- [ ] Closing report for a day with a return and a split payment matches the cash drawer.
- [ ] Udhaar balance of a test customer is correct after a credit sale and a payment.
- [ ] A finished sale cannot be edited or deleted by the application (database-enforced since migration 014).

## E. Operations
- [ ] Health check (`/api/health`) is monitored (free uptime monitor) and alerts you.
- [ ] Logs contain no passwords/tokens (they should only show path, status, request id).
- [ ] `npm audit --omit=dev` shows 0 high/critical in backend and frontend; repeat monthly.
- [ ] You know the first-hour incident steps (SECURITY.md §11) and where secrets are rotated.
- [ ] Shop owner has been told: backups are nightly, how to report a problem, and that data is private to their shop.

## F. Accepted risks to tell the shop owner about
- No MFA and no "forgot password by email" yet — password resets are done by the owner/support.
- A stolen phone with a logged-in session works until the 15-minute token expires or the owner deactivates the user.
- Reports for partial returns of forecast/dead-stock/risk scoring still count the full sale value (does not affect money, drawer or closing report).
