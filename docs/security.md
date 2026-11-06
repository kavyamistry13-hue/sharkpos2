# SHARKPOS 2 — security notes (Phase 1)

| Area | Implementation |
|---|---|
| Passwords | bcrypt, 12 rounds; min 8 chars with letters+numbers; constant-time dummy compare for unknown emails |
| Sessions | 15-min access token (memory only) + rotating httpOnly SameSite=Strict refresh cookie; reuse detection; revoke on logout / password change / employee removal |
| Brute force | per-IP rate limits on login/register, per-account lockout (5 fails → 15 min) |
| AuthZ | role checks on every route; membership re-read from DB per request; managers limited to cashier management; last-owner protection |
| Tenant isolation | RLS (forced) + composite FKs + tenant-scoped data layer + per-tenant caches; tested at API and SQL level |
| IDOR | foreign ids return 404 (not 403) so existence is not revealed |
| Injection | parameterised SQL everywhere; Zod validation on all inputs |
| XSS | React escaping; strict CSP on API; no tokens in localStorage |
| CSRF | SameSite=Strict + required `X-Requested-With` header on cookie endpoints; bearer tokens elsewhere |
| CORS / headers | allow-list origins; Helmet; `x-powered-by` off |
| Errors | consistent `{error, details}` JSON; 5xx never leak internals; UI shows a generic message |
| Secrets | env only; `.env` git-ignored; production refuses a short/missing `JWT_SECRET` |
| Audit | append-only table (no UPDATE/DELETE for the app role) |
| Database | least-privilege runtime role; separate owner role for migrations |

| Sales | per-bill idempotency key stored with the sale in one transaction (`sale_requests`, RLS, no delete); duplicate/concurrent submissions cannot double-sell or double-deduct stock; key reuse with a different payload is rejected |
| Payments | amount always from the DB plan; HMAC-SHA256 signature verified server-side (timing-safe); payment re-fetched from Razorpay and must be `captured`; webhooks verified on the raw body, idempotent by event id; subscription activated only server-side; payments/billing_events cannot be deleted by the app role; no payment secret in frontend code |
| Subscription gate | expired/cancelled businesses get HTTP 402 on every write (data kept, read-only); plan features/limits enforced in the backend |

| Production start-up | refuses to boot on weak JWT secret, non-https/localhost CORS, localhost DB, mock payments |
| Backups | encrypted (AES-256), read-only backup role, verified after creation, restore tested in CI weekly |
| Logging | structured, no secrets/bodies/queries; auth and payment failures are separate events |

Not yet done: independent penetration test, email verification & password reset by email, WAF/DDoS layer, a documented secrets-rotation procedure.

## Free-hosting proxy (Phase 3)
The web app's Cloudflare Function forwards `/api/*` with a shared secret and the visitor IP. The API honours that IP only when the secret matches (timing-safe); client-sent `x-sp-*` headers are stripped at the proxy and ignored without the secret. Neon's free plan has no IP allow-list, so the database relies on TLS + strong passwords + least-privilege roles + row-level security.

