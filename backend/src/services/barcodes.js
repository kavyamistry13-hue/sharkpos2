// Manufacturer-barcode mapping (Phase 8). A barcode only IDENTIFIES a product inside ONE shop; price, tax, unit and stock always
// come from that shop's product row. Every query here runs inside the caller's tenant (RLS forced), so another shop's mapping is invisible.
const { query, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { isDecimalUnit } = require('../utils/units');

// What may be stored: 4–48 chars, letters/digits and . _ / + - . Kept as TEXT exactly as scanned (leading zeros are significant).
const BARCODE_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{3,47}$/;

/** Trims scanner noise (CR/LF, spaces) and validates. Throws a 400 for anything that is not a plausible barcode. */
function cleanBarcode(raw) {
  const code = String(raw == null ? '' : raw).trim();
  if (!BARCODE_RE.test(code)) throw badRequest('That does not look like a valid barcode (4–48 letters, digits or . _ / + -).', { code: 'BAD_BARCODE' });
  return code;
}

/** GS1 check digit test for all-digit codes of length 8, 12, 13 or 14 (EAN-8, UPC-A, EAN-13, GTIN-14). */
function gs1Valid(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

function typeOf(code) {
  if (!gs1Valid(code)) return 'other';
  return { 8: 'ean8', 12: 'upca', 13: 'ean13', 14: 'gtin14' }[code.length];
}

/**
 * The same product can be read in different widths: a UPC-A (12 digits) is the EAN-13 "0"+UPC and the GTIN-14 "00"+UPC; many scanners
 * and camera libraries report one for the other. Returns every equivalent form, the code as given FIRST. The stored value is never altered.
 */
function equivalents(code) {
  const out = [code];
  if (gs1Valid(code)) {
    const g14 = code.padStart(14, '0');
    for (const len of [8, 12, 13, 14]) {
      const v = g14.slice(14 - len);
      if (g14.slice(0, 14 - len).split('').every((c) => c === '0') && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** Row shape the Counter needs. Out-of-stock and expired products ARE returned (flagged) so the cashier sees why they cannot be added. */
function scanShape(r, extra = {}) {
  const stock = Number(r.stock);
  const expired = !!(r.expiry_date && String(r.expiry_date).slice(0, 10) < new Date().toISOString().slice(0, 10));
  return {
    id: r.id, name: r.name, sku: r.sku, category: r.category, price: Number(r.selling_price), stock, taxRate: Number(r.tax_rate), unit: r.unit,
    allowDecimal: isDecimalUnit(r.unit), priceIncludesTax: !!r.price_includes_tax, outOfStock: stock <= 0, expired, ...extra,
  };
}

const PRODUCT_COLS = `p.id, p.name, p.sku, p.selling_price, p.stock, p.unit, p.price_includes_tax, p.expiry_date, c.name AS category, c.tax_rate`;

/** Barcode (any equivalent width) → this shop's product, else exact SKU (shops that typed their code into SKU keep working). */
async function lookup(raw) {
  const code = cleanBarcode(raw);
  const forms = equivalents(code);
  const byBarcode = (await query(
    `SELECT ${PRODUCT_COLS}, b.barcode
       FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.business_id = b.business_id JOIN categories c ON c.id = p.category_id
      WHERE b.barcode = ANY($1::text[]) AND p.is_active
      ORDER BY (b.barcode = $2) DESC, b.id LIMIT 1`,
    [forms, code],
  )).rows[0];
  if (byBarcode) return { found: true, matchedBy: 'barcode', barcode: code, product: scanShape(byBarcode, { barcode: byBarcode.barcode }) };
  const bySku = (await query(
    `SELECT ${PRODUCT_COLS} FROM products p JOIN categories c ON c.id = p.category_id WHERE lower(p.sku) = lower($1) AND p.is_active LIMIT 1`, [code],
  )).rows[0];
  if (bySku) return { found: true, matchedBy: 'sku', barcode: code, product: scanShape(bySku) };
  return { found: false, barcode: code };
}

async function listForProduct(productId) {
  const rows = (await query(
    `SELECT id, barcode, barcode_type, is_primary, created_at FROM product_barcodes WHERE product_id = $1 ORDER BY is_primary DESC, id`, [productId],
  )).rows;
  return rows.map((r) => ({ id: r.id, barcode: r.barcode, type: r.barcode_type, isPrimary: r.is_primary, createdAt: r.created_at }));
}

/** barcodes of many products in ONE query (list / detail screens). */
async function mapForProducts(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = (await query(
    `SELECT id, product_id, barcode, barcode_type, is_primary FROM product_barcodes WHERE product_id = ANY($1::int[]) ORDER BY is_primary DESC, id`, [ids],
  )).rows;
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push({ id: r.id, barcode: r.barcode, type: r.barcode_type, isPrimary: r.is_primary });
  }
  return map;
}

/** Inside a transaction: refuse a barcode this shop already maps (in ANY equivalent width), naming the product that owns it. */
async function assertFree(client, code, exceptBarcodeId = null) {
  const hit = (await client.query(
    `SELECT b.id, b.barcode, p.id AS product_id, p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.business_id = b.business_id
      WHERE b.barcode = ANY($1::text[]) AND ($2::int IS NULL OR b.id <> $2) LIMIT 1`,
    [equivalents(code), exceptBarcodeId],
  )).rows[0];
  if (hit) throw conflict(`This barcode already belongs to "${hit.name}".`, { code: 'BARCODE_TAKEN', productId: hit.product_id, productName: hit.name, barcodeId: hit.id });
}

/** Inserts a barcode for an existing product inside the caller's transaction. The first barcode of a product becomes primary. */
async function insertBarcode(client, productId, raw, userId, { primary } = {}) {
  const code = cleanBarcode(raw);
  await assertFree(client, code);
  const has = (await client.query('SELECT 1 FROM product_barcodes WHERE product_id = $1 LIMIT 1', [productId])).rowCount > 0;
  const makePrimary = primary === true || !has;
  if (makePrimary && has) await client.query('UPDATE product_barcodes SET is_primary = FALSE WHERE product_id = $1 AND is_primary', [productId]);
  const res = await client.query(
    `INSERT INTO product_barcodes (product_id, barcode, barcode_type, is_primary, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, barcode, barcode_type, is_primary`,
    [productId, code, typeOf(code), makePrimary, userId || null],
  );
  const r = res.rows[0];
  return { id: r.id, barcode: r.barcode, type: r.barcode_type, isPrimary: r.is_primary };
}

async function activeProduct(client, productId) {
  const p = (await client.query('SELECT id, name FROM products WHERE id = $1 AND is_active FOR UPDATE', [productId])).rows[0];
  if (!p) throw notFound('Product not found.');
  return p;
}

async function addBarcode(productId, raw, userId, opts) {
  const out = await withTransaction(async (client) => {
    const p = await activeProduct(client, productId);
    return { product: p, barcode: await insertBarcode(client, productId, raw, userId, opts) };
  });
  invalidateAll();
  return out;
}

/** Replace the value of a barcode (a mistyped or re-labelled code) and/or make it the primary one. */
async function updateBarcode(productId, barcodeId, { barcode, isPrimary }, userId) {
  const out = await withTransaction(async (client) => {
    const p = await activeProduct(client, productId);
    const cur = (await client.query('SELECT id, barcode, is_primary FROM product_barcodes WHERE id = $1 AND product_id = $2 FOR UPDATE', [barcodeId, productId])).rows[0];
    if (!cur) throw notFound('Barcode not found.');
    let value = cur.barcode;
    if (barcode !== undefined) {
      value = cleanBarcode(barcode);
      if (value !== cur.barcode) await assertFree(client, value, barcodeId);
    }
    if (isPrimary === true && !cur.is_primary) await client.query('UPDATE product_barcodes SET is_primary = FALSE WHERE product_id = $1 AND is_primary', [productId]);
    const res = await client.query(
      `UPDATE product_barcodes SET barcode = $2, barcode_type = $3, is_primary = $4 WHERE id = $1 RETURNING id, barcode, barcode_type, is_primary`,
      [barcodeId, value, typeOf(value), isPrimary === true ? true : cur.is_primary],
    );
    const r = res.rows[0];
    return { product: p, before: cur.barcode, barcode: { id: r.id, barcode: r.barcode, type: r.barcode_type, isPrimary: r.is_primary } };
  });
  invalidateAll();
  return out;
}

async function removeBarcode(productId, barcodeId) {
  const out = await withTransaction(async (client) => {
    const p = await activeProduct(client, productId);
    const gone = (await client.query('DELETE FROM product_barcodes WHERE id = $1 AND product_id = $2 RETURNING barcode, is_primary', [barcodeId, productId])).rows[0];
    if (!gone) throw notFound('Barcode not found.');
    // keep the "one primary" convention: promote the oldest remaining barcode
    if (gone.is_primary) await client.query('UPDATE product_barcodes SET is_primary = TRUE WHERE id = (SELECT id FROM product_barcodes WHERE product_id = $1 ORDER BY id LIMIT 1)', [productId]);
    return { product: p, barcode: gone.barcode };
  });
  invalidateAll();
  return out;
}

module.exports = { cleanBarcode, gs1Valid, typeOf, equivalents, lookup, listForProduct, mapForProducts, insertBarcode, addBarcode, updateBarcode, removeBarcode, scanShape };
