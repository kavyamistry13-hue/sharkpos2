// The offline product catalog (Phase 17B): the minimum a till needs to keep selling — id, name, sku, price, tax, unit, stock, expiry, barcodes.
// Never cost, supplier, margin or anything else. Fields are WHITELISTED here, so even if the server one day sends more, it is not stored.
// Pricing/tax stay the job of shared/billing.mjs; this file only finds products and tracks how stale the data is.
import { OfflineError } from './db.js';
import { assertScope, scopeKey, sameScope } from './scope.js';
import { unsyncedCount } from './queue.js';

export const CATALOG_WARN_AFTER_MS = 24 * 3600e3;     // older than this: still usable, but the screen says the prices may be out of date
const MAX_PAGES = 100;                                 // 100 × 500 = 50,000 products is far beyond any shop; stops a runaway loop

const round3 = (n) => Math.round(n * 1000) / 1000;
const catalogKey = (scope) => `catalog:${scopeKey(scope)}`;

/** Keeps only the whitelisted fields, with the right types. Returns null for a row that is unusable. */
export function sanitizeProduct(p) {
  if (!p || !Number.isInteger(p.id) || p.id <= 0 || typeof p.name !== 'string' || !p.name) return null;
  const price = Number(p.price); const stock = Number(p.stock); const taxRate = Number(p.taxRate);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || !Number.isFinite(taxRate) || taxRate < 0) return null;
  return {
    id: p.id, name: p.name.slice(0, 160), sku: String(p.sku || '').slice(0, 40), category: String(p.category || '').slice(0, 80), price, stock, taxRate,
    unit: String(p.unit || 'pcs').slice(0, 8), allowDecimal: !!p.allowDecimal, priceIncludesTax: !!p.priceIncludesTax,
    expiryDate: typeof p.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.expiryDate) ? p.expiryDate : null,
    barcodes: Array.isArray(p.barcodes) ? p.barcodes.filter((b) => typeof b === 'string').slice(0, 20).map((b) => b.slice(0, 48)) : [],
  };
}

export async function saveCatalog(adapter, scope, { generatedAt, rows }, { now = Date.now() } = {}) {
  assertScope(scope);
  const clean = []; const seen = new Set();
  for (const r of rows || []) { const p = sanitizeProduct(r); if (p && !seen.has(p.id)) { seen.add(p.id); clean.push(p); } }
  const record = { businessId: scope.businessId, userId: scope.userId, generatedAt: generatedAt || new Date(now).toISOString(), savedAt: new Date(now).toISOString(), count: clean.length, rows: clean };
  await adapter.put('catalog', catalogKey(scope), record);
  return record;
}
/** The caller's own catalog, or null. A record stamped for another scope is never returned, even if it somehow sits under this key. */
export async function loadCatalog(adapter, scope) {
  assertScope(scope);
  const r = await adapter.get('catalog', catalogKey(scope));
  return r && sameScope(r, scope) ? r : null;
}

/** Downloads every page, then returns { generatedAt, rows }. Nothing is saved here: a half-downloaded catalog must never replace a good one. */
export async function fetchCatalog(apiGet, { pageSize = 500 } = {}) {
  const rows = []; let after = 0; let generatedAt = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await apiGet('/products/offline-catalog', { after, limit: pageSize });
    generatedAt = generatedAt || r.generatedAt; rows.push(...r.rows);
    if (r.nextAfter == null) return { generatedAt, rows };
    after = r.nextAfter;
  }
  throw new OfflineError('OFFLINE_CATALOG_TOO_LARGE', 'The product list is too large to keep offline.');
}
/**
 * Refreshes the cache from the server. By default it does NOT refresh while sales are waiting to sync: fresh server stock would hide
 * the quantities already promised offline. After the queue drains the caller refreshes again.
 */
export async function refreshCatalog(adapter, scope, apiGet, { force = false, now = Date.now(), pageSize } = {}) {
  if (!force && (await unsyncedCount(adapter, scope)) > 0) return { skipped: 'UNSYNCED_SALES' };
  const fresh = await fetchCatalog(apiGet, { pageSize });
  const record = await saveCatalog(adapter, scope, fresh, { now });
  return { record };
}

export function catalogStatus(record, now = Date.now()) {
  if (!record) return { present: false, level: 'none', ageMs: null, generatedAt: null, count: 0 };
  const ageMs = Math.max(0, now - Date.parse(record.generatedAt));
  return { present: true, level: ageMs > CATALOG_WARN_AFTER_MS ? 'stale' : 'fresh', ageMs, generatedAt: record.generatedAt, count: record.count };
}

// ---------------------------------------------------------------- finding products
const GS1_LENS = [8, 12, 13, 14];
function gs1Valid(code) {
  if (!/^\d+$/.test(code) || !GS1_LENS.includes(code.length)) return false;
  const d = code.split('').map(Number); const check = d.pop(); let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}
/** Same rule as the server (services/barcodes.js): UPC-A / EAN-13 / GTIN-14 forms of one code are equivalent. A parity test keeps them identical. */
export function equivalents(code) {
  const out = [code];
  if (gs1Valid(code)) {
    const g14 = code.padStart(14, '0');
    for (const len of GS1_LENS) { const v = g14.slice(14 - len); if (g14.slice(0, 14 - len).split('').every((c) => c === '0') && !out.includes(v)) out.push(v); }
  }
  return out;
}

export function buildIndex(record) {
  const rows = (record && record.rows) || [];
  const byId = new Map(); const byBarcode = new Map(); const bySku = new Map();
  for (const p of rows) {
    byId.set(p.id, p);
    for (const b of p.barcodes) if (!byBarcode.has(b)) byBarcode.set(b, p);
    const s = p.sku.toLowerCase(); if (s && !bySku.has(s)) bySku.set(s, p);
  }
  return { rows, byId, byBarcode, bySku };
}
/** Barcode (any equivalent width) → product, else exact SKU. Mirrors the server's lookup. */
export function findByCode(index, raw) {
  const code = String(raw == null ? '' : raw).trim();
  if (!code) return null;
  for (const form of equivalents(code)) { const p = index.byBarcode.get(form); if (p) return { product: p, matchedBy: 'barcode' }; }
  const p = index.bySku.get(code.toLowerCase());
  return p ? { product: p, matchedBy: 'sku' } : null;
}
/** Name / SKU / category / barcode search, like /products/pos-search (which also hides out-of-stock and expired goods). */
export function searchProducts(index, q, { limit = 24, today = new Date().toISOString().slice(0, 10) } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  const codes = needle.length >= 4 ? new Set(equivalents(String(q).trim())) : new Set();
  return index.rows
    .filter((p) => p.stock > 0 && !(p.expiryDate && p.expiryDate < today))
    .filter((p) => !needle || p.barcodes.some((b) => codes.has(b)) || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
/** Stock the till may still promise: cached stock minus what offline sales already took. */
export const availableStock = (product, queued) => Math.max(0, round3(product.stock - ((queued && queued.get(product.id)) || 0)));
