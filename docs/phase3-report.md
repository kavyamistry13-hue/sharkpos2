# Phase 3 report — zero-cost production setup (prepared, NOT deployed)

Stack chosen by you: Cloudflare Pages (free) + Render free web service + Neon free PostgreSQL, free provider URLs, encrypted backups with tested restore. Full runbook, exact limits and steps: `docs/phase3-deployment.md`.

## Done and verified here
- **Auth on free URLs:** `pages.dev` and `onrender.com` are different sites, so the SameSite=Strict cookie cannot work directly. Fix: a Cloudflare Pages Function proxies `/api/*`, so the browser sees one origin. Verified in a real browser (Chromium via `wrangler pages dev` → API): login, reload (silent refresh via cookie), expired access token → automatic refresh and retry, logout (cookie removed, reload → login, protected page → login), all 13 app pages load with no errors; cookie is `HttpOnly; Secure; SameSite=Strict`.
- **Real visitor IP behind the proxy**, trusted only with a shared secret (tests: forged header ignored). Proxy function unit-tested (strips spoofed headers, keeps all cookies, writes never replayed, reads retried while the API wakes).
- **Free-tier adaptations:** small DB pool + connect timeout (sleeping database), `/api/health/live` (no DB) for keep-alive, early warm-up ping from the web app, optional cron keep-alive Worker (shop hours only), migrations moved into the GitHub deploy job (free Render has no pre-deploy step).
- **Backups at ₹0:** encrypted dump → private GitHub "vault" repo with retention; weekly restore drill; CI backup→restore on each push. Found and fixed a bug where `backup.sh` exited with an error at the end of a successful run. Prune/upload flow tested with a stand-in `gh`.
- **Security fix:** upgraded `react-router-dom` 6 → 7.18.4 (moderate advisory); production dependency audit: 0 vulnerabilities (backend and frontend). The app only redirects to fixed internal paths, so it was not exploitable here.
- **Tests/builds:** backend 95/95 pass (incl. 13 idempotency + 5 POS-client tests); frontend build passes; workflows pass actionlint; `render.yaml` parses.

## Not verified (cannot be from this sandbox)
Docker image build (no daemon; CI builds it) · anything on Render, Neon, Cloudflare, GitHub Actions or Razorpay · real TLS (`sslmode=verify-full`) to Neon · Neon role creation and connection cap · Render deploy-hook `ref` parameter · CSP with the live Razorpay window · Cloudflare cold-start retry timing with a real sleeping Render service.

## Needs your decision
1. Duplicate-sale risk: **fixed** (migration 008, idempotency keys).
2. Whether the **public Neon endpoint** (no IP allow-list on Free) is acceptable; mitigations listed in the runbook.
3. Approval to deploy (nothing runs until you say so).

## Not started
Phase 4 (landing page, pricing page, platform admin dashboard, onboarding, legal).
