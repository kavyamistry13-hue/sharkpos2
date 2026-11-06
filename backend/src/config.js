const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.startsWith('replace-with')) {
  if (isProd) throw new Error('JWT_SECRET must be set in production.');
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn('[config] JWT_SECRET not set — generated a temporary one. Sessions reset on restart.');
}
if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production.');

// SHARKPOS 2 must never run against the original SHARKPOS (hackathon) database.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set (see backend/.env.example).');
const dbName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
if (!/^sharkpos2/.test(dbName)) {
  throw new Error(`Refusing to start: DATABASE_URL points at "${dbName}". SHARKPOS 2 only runs against databases named "sharkpos2*".`);
}

const corsOrigins = (process.env.CORS_ORIGIN || (isProd ? '' : 'http://localhost:5174')).split(',').map((s) => s.trim()).filter(Boolean);
if (isProd) {
  // Production must never depend on localhost, and browsers must reach us over HTTPS only.
  if (!corsOrigins.length) throw new Error('CORS_ORIGIN must be set in production (the https URL of the web app).');
  const bad = corsOrigins.filter((o) => !/^https:\/\//.test(o) || /localhost|127\.0\.0\.1/.test(o));
  if (bad.length) throw new Error(`CORS_ORIGIN must be https and not localhost in production (got ${bad.join(', ')}).`);
  if (/localhost|127\.0\.0\.1/.test(new URL(databaseUrl).hostname)) throw new Error('DATABASE_URL must not point at localhost in production.');
}

if (isProd && process.env.PROXY_SHARED_SECRET && process.env.PROXY_SHARED_SECRET.length < 32) throw new Error('PROXY_SHARED_SECRET must be at least 32 characters.');
if (isProd && (process.env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock') throw new Error('PAYMENT_PROVIDER=mock is not allowed in production.');

module.exports = {
  isProd,
  isTest,
  port: Number(process.env.PORT) || 4001,
  corsOrigins,
  // Reverse proxies in front of the API (Render's load balancer = 1). Wrong values break per-IP rate limiting.
  trustProxyHops: process.env.TRUST_PROXY_HOPS === undefined ? 1 : Number(process.env.TRUST_PROXY_HOPS),
  // Free-tier databases allow few connections; keep the pool small there. The connect timeout covers a sleeping serverless database waking up.
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 10,
  dbConnectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000,
  // When the API sits behind our own Cloudflare proxy, that proxy sends the real visitor IP signed with this shared secret.
  // How long a retry waits for an identical in-flight sale request before answering 409 "still processing".
  saleLockTimeoutMs: Number(process.env.SALE_LOCK_TIMEOUT_MS) || 10000,
  proxySecret: process.env.PROXY_SHARED_SECRET || '',
  version: process.env.APP_VERSION || process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || 'dev',
  databaseUrl,
  dbName,
  // Demo reload wipes a business's data, so it only works on businesses flagged is_demo, and never in production by default.
  allowDemo: !isProd || process.env.ALLOW_DEMO === 'true',
  jwtSecret,
  accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshDays: Number(process.env.REFRESH_TOKEN_DAYS) || 30,
  cookieSecure: isProd || process.env.COOKIE_SECURE === 'true',
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  storeTz: process.env.STORE_TZ || 'Asia/Kolkata',
  llm: {
    provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
    apiKey: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    model: process.env.LLM_MODEL || 'claude-sonnet-4-5',
    baseUrl: process.env.LLM_BASE_URL || '',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 15000,
  },
  billing: {
    trialDays: Number(process.env.TRIAL_DAYS) || 14,
    graceDays: Number(process.env.PAST_DUE_GRACE_DAYS) || 3,
    defaultPlan: process.env.DEFAULT_PLAN || 'business',
  },
  payment: {
    // razorpay (real) | mock (development only, refused in production)
    provider: (process.env.PAYMENT_PROVIDER || (process.env.PAYMENT_KEY_ID ? 'razorpay' : 'none')).toLowerCase(),
    keyId: process.env.PAYMENT_KEY_ID || '',
    keySecret: process.env.PAYMENT_KEY_SECRET || '',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
  },
  rules: {
    cashierMaxDiscountPct: 10,
    defaultTaxRate: 5,
    reviewPeriodDays: 3,
    serviceLevelZ: 1.28,
    riskAlertThreshold: 40,
  },
};
