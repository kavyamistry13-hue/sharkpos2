# Sprint 5–6: security upgrade, CI and deployment notes

## Dependencies (backend)
| Package | Before | After |
|---|---|---|
| zod | 3.25.76 (`^3.24.1`) | **4.6.7** (`^4.6.7`) — fixes the advisory for zod < 4.6.6 |
| body-parser | 1.20.8 | 1.20.9 |
| qs | 6.16.0 | 6.16.2 (resolved by `npm update`; newer than the 6.16.1 target, not a downgrade) |
`npm audit --omit=dev`: 0 vulnerabilities (backend and frontend). `npm audit fix --force` was not used.

## Zod 3 → 4 migration notes
Only what actually broke was changed:
1. **`PUT /products/:id` data-loss bug** — the update schema was `base.partial()` and `base` has `.default()` on stock, minimumStock, unit, priceIncludesTax and leadTimeDays. Zod 4 re-applies defaults inside optional fields, so editing only a name would have reset stock to 0 and unit to `pcs` (3 existing tests caught it). Fix: `update` schema built from the same fields with their defaults removed (`routes/products.js`). Create still applies the defaults.
2. `routes/demo.js`: `z.literal(true, { errorMap })` → `{ error: 'Confirmation required' }`.
3. **Error wording**: Zod 4 rewrote its default messages. The web app shows these, so `utils/zodCompat.js` (loaded by `middleware/validate.js`) maps issues back to the Zod 3 wording through `z.config({ customError })`. Rules are unchanged; custom messages are untouched.
Unchanged and verified: `z.coerce.*`, `.refine`, `.email`, `.regex`, `.strict`, `.extend` on plain objects, `.or(z.literal('').transform())`, `safeParse` + `error.issues`, the `{ error, details:[{field,message}] }` API shape.
New tests: `tests/zod-compat.test.js` (partial update keeps defaults-fields, create defaults, exact error messages, query coercion). Written and passed on Zod 3 first, then on Zod 4.

## CI changes
`.github/workflows/ci.yml`, deploy job: a new preflight step checks all required secrets/variables. If any is missing the job logs a warning naming them and **skips** deployment (green), instead of failing with "missing secret". When everything is present, deployment runs as before (still gated by the `production` environment approval). No values are stored in the repository.

## Required GitHub configuration (Settings → Environments → production)
Secrets: `MIGRATION_DATABASE_URL` (owner-role Postgres URL used only to run migrations), `RENDER_DEPLOY_HOOK_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Variables: `API_URL`, `APP_URL`, `PAGES_PROJECT`.
Backup/restore workflows additionally use secrets `BACKUP_DATABASE_URL`, `BACKUP_PASSPHRASE`, `BACKUP_VAULT_TOKEN` and variable `BACKUP_VAULT_REPO`.
Render needs its own env vars from `render.yaml` (DATABASE_URL, JWT_SECRET, CORS_ORIGIN, PROXY_SHARED_SECRET, payment and LLM keys) set in the Render dashboard.

## Verified here vs not verified
Verified locally: full test suite, frontend build, migrations on an empty database and again on the migrated one, backup → restore drill, audit.
Not verified (no access / no Docker): the GitHub Actions run itself, the backend Docker image build, Render and Cloudflare deployment, the public smoke test. Do not treat deployment as working until a real run succeeds with the secrets above.
