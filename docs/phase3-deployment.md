# SHARKPOS 2 — Phase 3: zero-cost production setup and runbook

**Status: configured and tested locally. NOT deployed.** Nothing here touches any cloud account. Nothing is created, paid or deployed until you say so.

Goal: run SHARKPOS 2 for **₹0/month** on free tiers, for testing and a first pilot with friendly shops, with a clear path to upgrade when money arrives.

## 1. The stack

```
Browser ──https──► https://<project>.pages.dev        Cloudflare Pages (free): React app + one small proxy Function
                         │  /api/*  (Pages Function adds a secret + the visitor's IP)
                         ▼
                   https://<service>.onrender.com      Render FREE web service (Docker, Node 22)
                         │  TLS, role sharkpos2_app, direct endpoint
                         ▼
                   Neon FREE PostgreSQL 16              (no 30-day expiry; sleeps when idle)

GitHub Actions (free) ─ tests, migrations, deploy (after YOUR approval), nightly encrypted backup ─► private "vault" repo
Cloudflare Worker cron (free, optional) ─ keeps Render awake during shop hours
Razorpay (test mode) ─ webhook straight to the Render URL
```

### Why a proxy (the cookie problem and its free fix)
The login cookie is `HttpOnly; Secure; SameSite=Strict`. `pages.dev` and `onrender.com` are both on the browser's Public Suffix List, so `x.pages.dev` and `y.onrender.com` are **different sites** — the browser would never send the cookie to the API, and every page reload would log the user out. A same-site custom domain is the classic fix, but it costs money. The free fix: the browser only ever talks to **one** origin (`<project>.pages.dev`); a Cloudflare Pages Function (`frontend/functions/api/[[path]].js`) forwards `/api/*` to Render. The cookie is first-party, CSRF protection and strict CORS keep working, and **no code in the auth design changed**. If you later buy a domain, the same setup keeps working.

Security of the proxy: it strips any client-sent `x-sp-*` headers, adds `x-sp-proxy-secret` and the real IP (`cf-connecting-ip`, which Cloudflare sets itself). The API trusts that IP **only** if the secret matches (timing-safe), so rate limiting and lockouts see real visitors and forged headers are ignored. Tested.

## 2. Free-tier limits (checked against the providers' own pages on 9–10 Oct 2026)

### Cloudflare Pages + Functions
| Limit | Value | Source |
|---|---|---|
| Builds | 500/month (we deploy with GitHub Actions: `wrangler pages deploy`, so builds are not used) | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Files per site / file size | 20,000 / 25 MiB | same |
| Function requests | **100,000 per day**, shared with Workers, resets 00:00 UTC (05:30 IST). Over the limit → error 1027 and **the API proxy stops until reset** | [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) |
| CPU per request | 10 ms (waiting on the API does not count) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cron triggers | 5 per account (keep-alive uses 1) | same |
| Static bandwidth | not limited on the page I read | |

My estimate (not a published figure): a busy shop makes ~500–1,500 API calls a day, so the 100k/day cap covers roughly 70–200 active shops.

### Render free web service — [Render docs](https://render.com/docs/free)
| Limit | Value |
|---|---|
| Sleep | spins down after **15 minutes without inbound traffic**; waking takes **about one minute** |
| Hours | **750 instance hours per month** per workspace; a service that is awake all month needs ~744 |
| Disk | none (files lost on restart) — we store nothing on disk |
| Restarts | Render **may restart a free service at any time** |
| Scaling / jobs | one instance only; no one-off jobs, no shell |
| Outbound | ports 25/465/587 blocked (we send no email) |
| Other | monthly bandwidth and build-minute allowances apply (amounts shown in the dashboard) |
| Render's own wording | free instances are "for testing, hobby projects… **Do not use them for production applications.**" |
| Free Postgres | **expires after 30 days** — we do **not** use it |

I could not confirm from that page whether free instances support a pre-deploy command, so migrations run in GitHub Actions instead (works either way).

### Neon free PostgreSQL — [Neon free-plan limits](https://neon.com/faqs/free-plan-limits-and-quotas), [plans](https://neon.com/docs/introduction/plans)
| Limit | Value |
|---|---|
| Storage | **1 GB per project** (writes fail beyond it; no data deleted) |
| Compute | **100 CU-hours per project per month** (autoscale up to 2 CU). When used up, the database is suspended **until next month** |
| Idle | compute suspends after 5 min of inactivity; can't be turned off. First query after idle wakes it (~1–3 s; the API allows 15 s) |
| Network | 5 GB public transfer/month |
| Restore history | **6 hours** only (so our own backups matter) |
| Branches / snapshots | 10 / 1 manual |
| **IP Allow list** | **Not available on Free** (Scale plan only) → the database has a public endpoint |
| No expiry | correct: no 30-day deletion (unlike Render Postgres) |

Capacity: the dev database with 25,147 sales is 50 MB (~2 KB per sale), so 1 GB ≈ 500,000 sales shared by all shops.
Not confirmed from the pages I could read: Neon's maximum connections on the smallest compute (we cap the pool at 5) and role-creation rules (`database/setup-production.sql` uses plain `CREATE ROLE`; if Neon refuses, create the two roles in the Neon console with the same names and run the `GRANT CONNECT` lines).
Supabase was considered and **not chosen**: free projects are paused after a period of inactivity and its direct connection is IPv6-only (I could not open its pausing page to quote exact terms).

### GitHub Actions — check [current docs](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
Private repos get a monthly free-minutes allowance (2,000 on the Free plan, from memory — verify). Our usage: CI ≈ 6–8 min per push + backup ≈ 1 min/night ≈ 30 min/month. In **public** repos, scheduled workflows are disabled after 60 days of no repository activity — use a private repo.

## 3. What will NOT work reliably for a real shop (read this)

1. **Render sleeps.** After 15 quiet minutes the next click waits ~1 minute (the proxy retries reads and shows "server is waking up" for writes). Mitigation: the app pings the API as the login page loads, and the optional keep-alive Worker pings every 10 min during 08:00–22:00 IST (~430 of the 750 free hours). It is *not* guaranteed: Render may still restart the instance any time, and keep-alive pings are traffic Render could treat differently — its docs say not to use free instances for production.
2. **Duplicate sales — FIXED (migration 008).** "Complete sale" now carries a per-bill `Idempotency-Key`; the server records it with the sale in one transaction, so a retry after a dropped connection or a Render restart returns the original sale and never deducts stock twice. See *Idempotent sales* below. Residual: if Render is down for longer than the app's ~15 s of automatic retries, the cashier sees an error; pressing the button again is safe (same key).
3. **Neon compute budget.** 100 CU-hours ≈ 400 hours/month at the smallest size. If the database is busy ~14 h a day it can reach the cap late in the month and **then goes offline until the 1st**. Anything that polls the database (e.g. the Presentation-mode dashboard refreshes every 30 s) keeps it awake. Watch usage in the Neon console; keep-alive does not touch the DB.
4. **6-hour restore window.** A bad delete older than 6 hours is recoverable only from our nightly backup (up to 24 h of data lost).
5. **Public database endpoint** (no IP allow-list on Free). Protection: TLS with certificate verification, 32+ char random passwords, least-privilege roles (the API role cannot bypass row-level security; the backup role is read-only), tenant isolation tested. It is still reachable from the internet by anyone holding the password — treat the connection strings like cash, rotate them if exposed.
6. **Razorpay webhooks may hit a sleeping API.** The browser verification path normally activates payments immediately, and the webhook is a safety net that Razorpay retries (retry schedule from memory — verify in Razorpay docs). Use **test mode** only until you finish Razorpay's business verification.
7. **No custom domain / no email.** The address is `<project>.pages.dev`. No password-reset or receipt emails exist yet (and Render blocks SMTP on free).
8. **Monitoring is thin.** Render free keeps limited log history, and the in-app "Server health" counters reset every time the API sleeps. Use the free uptime ping + the Render log view; the structured logs are there when you upgrade.
9. **100k requests/day proxy cap** (above) — a spike/bot flood can take the API offline until 05:30 IST. Rate limits exist but the proxy count is before them.
10. **Ops view on Neon sleep:** `/api/health` (with DB check) wakes Neon on purpose; only `/api/health/live` is used for keep-alive.

Honest recommendation: this setup is fine for **development, a demo, and a 1–3 shop pilot with people who accept occasional slowness**. Do not sell it to paying shops until at least item 2 is fixed and Render is on a paid instance (about US$7/month, no sleeping) — the config differs only by `plan: starter`.

## 4. Environment variables and secrets

Names only in git: `backend/.env.production.example`. Never commit values.

| Where | Name | Value |
|---|---|---|
| Render | `NODE_ENV` | `production` (already in `render.yaml`) |
| Render | `DATABASE_URL` | Neon **direct** URL (host without `-pooler`), role `sharkpos2_app`, `?sslmode=verify-full`. *Pooled connections break tenant isolation settings — do not use them.* |
| Render | `JWT_SECRET` | `openssl rand -hex 48` |
| Render | `CORS_ORIGIN` | `https://<project>.pages.dev` |
| Render | `PROXY_SHARED_SECRET` | `openssl rand -hex 32` (same in Cloudflare) |
| Render | `PAYMENT_PROVIDER/PAYMENT_KEY_ID/PAYMENT_KEY_SECRET/PAYMENT_WEBHOOK_SECRET` | Razorpay **test** keys |
| Render | `LLM_PROVIDER/LLM_API_KEY/LLM_MODEL` | optional (AI falls back to rules without it) |
| Cloudflare Pages | `API_ORIGIN` | `https://<service>.onrender.com` |
| Cloudflare Pages | `PROXY_SHARED_SECRET` | same as Render (add as *Secret*) |
| GitHub env `production` — secrets | `MIGRATION_DATABASE_URL` (Neon owner role), `RENDER_DEPLOY_HOOK_URL`, `CLOUDFLARE_API_TOKEN` (Pages:Edit), `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_DATABASE_URL` (role `sharkpos2_backup`), `BACKUP_PASSPHRASE` (20+ chars), `BACKUP_VAULT_TOKEN` (fine-grained token: only the vault repo, Contents read/write) | |
| GitHub env `production` — variables | `API_URL`, `APP_URL`, `PAGES_PROJECT`, `BACKUP_VAULT_REPO` (`owner/vault`) | |

The API **refuses to start** in production on: short `JWT_SECRET`/`PROXY_SHARED_SECRET`, non-https or localhost `CORS_ORIGIN`, localhost database, database name not starting with `sharkpos2`, or mock payments. Do not set `MIGRATION_DATABASE_URL` on Render — only GitHub needs the owner login.

## 5. Accounts you need (all free, no card required unless noted by the provider)
GitHub · Cloudflare (Pages) · Render · Neon · Razorpay (test mode) · optional AI key. Render and Neon may ask for a card at signup — **decline anything that adds a paid plan**; if a card is mandatory, tell me and we pick another provider.

## 6. Deployment steps (do NOT start until you approve)
1. **GitHub:** create a **private** repo `sharkpos2` and a second **private** repo `sharkpos2-vault`. Push this project (`.env` is git-ignored). Create environment **production** with yourself as required reviewer.
2. **Neon:** create a project (region nearest India, e.g. Singapore) → create database **`sharkpos2`** → as the owner role run:
   `psql "$ADMIN_URL" -v app_password="…" -v backup_password="…" -v dbname=sharkpos2 -f database/setup-production.sql` (generate the two passwords with `openssl rand -hex 24`). Copy the *direct* connection strings for owner / `sharkpos2_app` / `sharkpos2_backup`.
3. **Migrate once:** `MIGRATION_DATABASE_URL=… node database/migrate.js` (from `backend/` after `npm ci`), then create the first admin:
   `DATABASE_URL=<app url> PLATFORM_ADMIN_EMAIL=… PLATFORM_ADMIN_PASSWORD='12+ chars' npm run create-admin`.
4. **Render:** New → Blueprint → pick the repo (`render.yaml`, plan **free**) → fill the secrets from §4 → create. Copy the Deploy Hook URL and the service URL.
5. **Cloudflare Pages:** Workers & Pages → Create → *Direct upload* project named e.g. `sharkpos2` (**not** Git-connected) → Settings → Variables and secrets: `API_ORIGIN`, `PROXY_SHARED_SECRET`. Create an API token with *Cloudflare Pages: Edit*.
6. **GitHub secrets/variables** from §4; run the *CI* workflow → approve the deploy.
7. **Razorpay (test):** webhook `https://<service>.onrender.com/api/billing/webhook`, events `payment.captured`, `order.paid`, `payment.failed`.
8. **Optional keep-alive:** put the Render URL in `ops/keepalive/wrangler.toml`, then `cd ops/keepalive && npx wrangler deploy`.
9. **Uptime check:** a free monitor on `https://<project>.pages.dev/api/health` (alerts you when DB or API is down).
10. **Rehearse:** register a test business → pay in Razorpay test mode → log in/out/reload on a phone → run *Database backup* then *Restore drill* workflows.

## 7. Backups
- Nightly 02:00 IST (`backup.yml`): `pg_dump` as read-only `sharkpos2_backup` → AES-256 encrypted → verified → stored as a release in your private vault repo → pruned (the newest backup of each of the last 14 days, 8 weeks and 12 months that have a backup).
- Weekly `restore-drill.yml` restores the newest real backup into a throw-away database on the runner; CI also does a backup→restore on every push.
- **Cost: ₹0.** Encrypted dumps are small (1.2 MB for 25k sales). GitHub's soft limits for release assets are generous; a 5 MB file nightly is ~1.8 GB/year before pruning — pruning keeps roughly 34 files.
- **Security:** the passphrase never leaves GitHub secrets + your password manager; the vault token is limited to one repo. Anyone with the passphrase *and* the file can read your customers' data — keep both apart.
- Restore: `scripts/restore.sh` (refuses non-`sharkpos2*` targets and non-empty databases). Procedure unchanged from the earlier plan: stop API → download newest release asset → restore into an **empty** database → check counts → migrate → point `DATABASE_URL` at it → resume. Free-tier note: use a *new Neon database/branch*; Neon's own 6-hour restore can undo recent mistakes faster.
- Backup role has read-only SELECT plus a read policy on every tenant table (migration 007), tested.

## 8. Monitoring
`/api/health` (DB-aware, 503 when down) · `/api/health/live` (no DB, for keep-alive) · structured JSON logs with `api_error`, `db_error`, `auth_failure`, `payment_failure`, `slow_request`, request ids · platform-admin "Server health" card. Unchanged from the earlier plan; see §3.8 for free-tier caveats.

## 9. CI/CD
Push → tests (95) → migrations on an empty DB → backup/restore drill → frontend build → Docker image build → audit → **manual approval** → run migrations on Neon → deploy Render and wait until `/api/health` shows the new commit → deploy Cloudflare Pages → smoke test through the public address. Nothing deploys if a step fails. Rule: every migration must keep the previous app version working.

## 10. Upgrade path (when there is revenue)
| Trigger | Action | Approx. cost |
|---|---|---|
| First paying shop | Render `plan: starter` (no sleep) | ~US$7/mo |
| Neon CU-hours/1 GB near limit, or want longer restore | Neon paid plan (usage-based) | check Neon pricing |
| Want a branded address | buy a domain, add to Cloudflare Pages | ~₹700–900/yr |
| >100 active shops | Cloudflare Workers Paid | ~US$5/mo |


## Idempotent sales (duplicate-sale protection)
- **Client:** one UUID key per bill, reused for double-taps, the approval step and automatic retries (network failure, 502/503/504, 409 in-progress; delays 1.5 s, 4 s, 9 s). Changing the bill makes a new key.
- **API:** `POST /api/sales` requires `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED`). Same key + same payload → original sale, HTTP 200 + `Idempotent-Replayed: true`, no new stock/audit/risk. Same key + different payload or cashier → 422 `IDEMPOTENCY_KEY_REUSED`. Same key still running → waits on the DB lock, then 409 `IDEMPOTENCY_IN_PROGRESS` (`SALE_LOCK_TIMEOUT_MS`, default 10000).
- **Database:** table `sale_requests` (migration 008), PK `(business_id, idempotency_key)`, unique sale link, RLS, delete/truncate revoked from the app role. Failed sales roll back the claim, so a corrected retry works.
- **Not done yet:** purging old keys (future job; index on `created_at` exists).

## Neon: development/testing only for now
Use Neon Free for development and testing, not for a real shop's data, until you decide otherwise. Safeguards: TLS `verify-full`; direct (non-pooled) endpoint; random 32+ char role passwords; least-privilege `sharkpos2_app` (no BYPASSRLS), separate owner and read-only backup roles; row-level security on every tenant table; encrypted backups with a tested restore. Limitations: public endpoint with no IP allow-list on Free; 1 GB; 100 CU-hours/month; 6-hour restore window; suspends after 5 min idle; real TLS and role creation on Neon not yet verified.
