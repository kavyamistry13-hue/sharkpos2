# Phase 2 report — plans, trials and payments

## Delivered
- **Plans** in the `plans` table (Starter ₹99, Business ₹199, Pro ₹399 per month; prices, limits and features are data, not code). Public `GET /api/plans`.
- **Subscriptions** with states trialing / active / past_due / cancelled / expired. 14-day free trial on registration (`TRIAL_DAYS`); trial end → expired, data is never deleted. 3-day grace after a missed renewal (`PAST_DUE_GRACE_DAYS`).
- **Razorpay (Orders API)**: owner starts checkout, amount is taken from the DB, browser returns payment id + signature, server verifies the HMAC, re-fetches the payment from Razorpay, then activates. Webhook `POST /api/billing/webhook` (verified on raw body, idempotent). Tables: plans, subscriptions, payments, billing_events.
- **Enforcement**: expired/cancelled → read-only (HTTP 402); plan feature gates (AI insights, advanced reports); limits (users, products).
- **UI**: Billing page (plan, price, status, next billing date, upgrade/downgrade/cancel/resume, usage, payment history), expiry/trial banner ("Your subscription has expired. Your data is safe. Renew Subscription"), plan picker at signup, upgrade prompts on locked features.
- **Tests**: 68 passing (45 from Phase 1 + 23 billing: state machine, trial, payment, forged signature, cross-business verify, webhooks, grace, cancel/resume, plan changes, gates, limits).

## Design decisions
- One-time monthly **Orders** with manual renewal instead of Razorpay recurring subscriptions (simpler, no mandate setup; autopay can be added later).
- Upgrade = pay the new plan's full price and restart the period (no proration). Downgrade applies at next renewal.
- Dev/test **mock** provider uses the same signature scheme; it is refused when `NODE_ENV=production`.

## What you must provide for real payments
1. Razorpay account → Test Mode Key ID and Key Secret → `PAYMENT_PROVIDER=razorpay`, `PAYMENT_KEY_ID`, `PAYMENT_KEY_SECRET`.
2. Webhook in the dashboard: URL `https://<your-domain>/api/billing/webhook`, events `payment.captured`, `order.paid`, `payment.failed`; copy its secret to `PAYMENT_WEBHOOK_SECRET`.
Real Razorpay calls could not be exercised here (no keys, no outbound access); only the mock provider has been run end to end.

## Known limitations
Multiple stores are listed as "coming soon" (no store concept yet); no proration; no recurring autopay; no password reset / email verification; no invoices/GST receipts for subscription payments.

## Not started
Phase 3 (cloud deployment, backups, monitoring, CI/CD) and Phase 4 (landing page, pricing page, platform admin dashboard, onboarding, legal) await your approval. Nothing has been deployed.
