// CSV product import: upload → validate → preview → confirm → import.
// • Validation never writes. Import re-validates the SAME text on the server (the preview is advice, not a token to trust) and then writes
//   every row in ONE transaction through products.createProductTx — the same code that creates a product by hand — so a bad row, a
//   duplicate that appeared in the meantime, or a plan limit means NOTHING is imported (no silent partial import).
// • Tenant scope comes only from the request context + forced RLS; categories / SKUs / barcodes are looked up inside the caller's shop.
const { query, withTransaction, currentBusinessId } = require('../db');
const { badRequest, conflict, HttpError } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');
const { UNITS, round3 } = require('../utils/units');
const csv = require('../utils/csv');
const barcodes = require('./barcodes');
const products = require('./products');
const { assertWithinLimit } = require('./billing/subscription');

const COLUMNS = ['name', 'sku', 'barcode', 'category', 'unit', 'cost_price', 'selling_price', 'tax_rate', 'min_stock', 'max_stock', 'reorder_level', 'stock'];
const REQUIRED = ['name', 'category', 'selling_price'];
const TEMPLATE = `${COLUMNS.join(',')}\r\nMaggi Noodles 70g,MAGGI-70,"0890123456789",Grocery,pcs,10.50,14,12,10,100,20,50\r\n`;

const NUM = /^\d+(\.\d+)?$/;
const EXCEL_SCI = /^\d+(\.\d+)?e[+-]?\d+$/i;

function num(raw, label, { max = 1e6, dp = 2, errors }) {
  const t = String(raw).trim();
  if (t === '') return null;
  if (!NUM.test(t)) { errors.push(`${label} "${t}" must be a plain number (no ₹, commas or minus sign).`); return undefined; }
  const n = Number(t);
  if (n > max) { errors.push(`${label} is too large (maximum ${max}).`); return undefined; }
  const frac = (t.split('.')[1] || '').length;
  if (frac > dp) { errors.push(`${label} "${t}" can have at most ${dp} decimal places.`); return undefined; }
  return n;
}

/** Validates the whole file. Returns { rows:[{line, data, errors}], fileErrors, summary }. Never writes. */
async function validate(text) {
  const parsed = csv.parse(text);
  const header = parsed.header.map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const fileErrors = [];
  const seen = new Set();
  header.forEach((h) => { if (seen.has(h)) fileErrors.push(`The column "${h}" appears more than once.`); seen.add(h); });
  const unknown = header.filter((h) => h && !COLUMNS.includes(h));
  if (unknown.length) fileErrors.push(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Allowed: ${COLUMNS.join(', ')}.`);
  const missing = REQUIRED.filter((h) => !header.includes(h));
  if (missing.length) fileErrors.push(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  if (fileErrors.length) return { rows: [], fileErrors, summary: { total: parsed.rows.length, valid: 0, invalid: 0 } };
  if (!parsed.rows.length) return { rows: [], fileErrors: ['The file has a header but no product rows.'], summary: { total: 0, valid: 0, invalid: 0 } };

  const col = (r, name) => { const i = header.indexOf(name); return i === -1 ? '' : (r[i] ?? ''); };
  const cats = new Map((await query('SELECT id, name, tax_rate FROM categories')).rows.map((c) => [c.name.toLowerCase(), c]));
  const skuTaken = new Set((await query('SELECT lower(sku) AS s FROM products')).rows.map((r) => r.s));
  const fileCodes = parsed.rows.map((r) => String(col(r, 'barcode')).trim()).filter((c) => c && barcodesOk(c));
  const allForms = [...new Set(fileCodes.flatMap((c) => barcodes.equivalents(c)))];
  const codeTaken = new Map();
  if (allForms.length) for (const r of (await query('SELECT b.barcode, p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.business_id = b.business_id WHERE b.barcode = ANY($1::text[])', [allForms])).rows) codeTaken.set(r.barcode, r.name);

  const fileSkus = new Map(); const fileForms = new Map();
  const rows = parsed.rows.map((r, i) => {
    const line = parsed.lines[i]; const errors = []; const data = {};
    if (r.length > header.length) errors.push(`This row has ${r.length} values but the header has ${header.length}.`);
    const name = String(col(r, 'name')).trim();
    if (!name) errors.push('Name is required.'); else if (name.length > 160) errors.push('Name is longer than 160 characters.'); else data.name = name;

    const catName = String(col(r, 'category')).trim();
    const cat = cats.get(catName.toLowerCase());
    if (!catName) errors.push('Category is required.'); else if (!cat) errors.push(`Category "${catName}" does not exist. Create it first (Products → Categories) or fix the spelling.`); else data.categoryId = cat.id;

    const sku = String(col(r, 'sku')).trim();
    if (sku) {
      if (sku.length > 40) errors.push('SKU is longer than 40 characters.');
      else if (skuTaken.has(sku.toLowerCase())) errors.push(`SKU "${sku}" already exists in your shop.`);
      else if (fileSkus.has(sku.toLowerCase())) errors.push(`SKU "${sku}" is repeated in this file (first on line ${fileSkus.get(sku.toLowerCase())}).`);
      else { fileSkus.set(sku.toLowerCase(), line); data.sku = sku; }
    }

    const code = String(col(r, 'barcode')).trim();
    if (code) {
      if (EXCEL_SCI.test(code)) errors.push(`Barcode "${code}" looks like Excel turned it into a number (leading zeros / digits are lost). Format the barcode column as Text and export again.`);
      else if (!barcodesOk(code)) errors.push(`Barcode "${code}" is not valid (4–48 letters, digits or . _ / + -).`);
      else {
        const forms = barcodes.equivalents(code);
        const owner = forms.map((f) => codeTaken.get(f)).find(Boolean);
        const dup = forms.map((f) => fileForms.get(f)).find(Boolean);
        if (owner) errors.push(`Barcode ${code} already belongs to "${owner}".`);
        else if (dup) errors.push(`Barcode ${code} is repeated in this file (first on line ${dup}).`);
        else { forms.forEach((f) => fileForms.set(f, line)); data.barcode = code; }      // stored exactly as typed: leading zeros kept
      }
    }

    const unit = String(col(r, 'unit')).trim().toLowerCase() || 'pcs';
    if (!UNITS.includes(unit)) errors.push(`Unit "${unit}" is not valid. Use one of: ${UNITS.join(', ')}.`); else data.unit = unit;

    const sell = num(col(r, 'selling_price'), 'Selling price', { errors });
    if (sell === null) errors.push('Selling price is required (it is never guessed).'); else if (sell !== undefined) data.sellingPrice = sell;
    const cost = num(col(r, 'cost_price'), 'Cost price', { errors });
    if (cost !== undefined) data.purchasePrice = cost === null ? 0 : cost;

    // Tax belongs to the CATEGORY in SHARKPOS. A tax_rate column is only accepted when it agrees, so a wrong rate is never silently ignored.
    const tax = num(col(r, 'tax_rate'), 'Tax rate', { max: 28, errors });
    if (tax !== undefined && tax !== null && cat && Number(cat.tax_rate) !== tax) errors.push(`Tax rate ${tax}% does not match category "${cat.name}" (${cat.tax_rate}%). Tax is set per category — leave tax_rate empty or fix the category.`);

    const dec = ['kg', 'g', 'l', 'ml', 'm'].includes(data.unit);
    const lvl = (name, label) => { const v = num(col(r, name), label, { dp: 3, errors }); if (v != null && !dec && !Number.isInteger(v)) { errors.push(`${label} must be a whole number for unit "${data.unit || unit}".`); return undefined; } return v; };
    const min = lvl('min_stock', 'Minimum stock'); const max = lvl('max_stock', 'Maximum stock'); const reo = lvl('reorder_level', 'Reorder level'); const stk = lvl('stock', 'Stock');
    if (min !== undefined) data.minimumStock = min ?? 0;
    if (stk !== undefined) data.stock = stk ?? 0;
    if (max !== undefined && max !== null) { if (min != null && max < min) errors.push('Maximum stock cannot be lower than the minimum stock.'); else data.maxStock = max; }
    if (reo !== undefined && reo !== null) { if (max != null && reo > max) errors.push('Reorder level cannot be higher than the maximum stock.'); else data.reorderLevel = reo; }
    return { line, data, errors };
  });
  const invalid = rows.filter((r) => r.errors.length).length;
  return { rows, fileErrors: [], summary: { total: rows.length, valid: rows.length - invalid, invalid } };
}

function barcodesOk(c) { try { barcodes.cleanBarcode(c); return true; } catch { return false; } }

/** The public preview: first rows in full, every error, never the internal ids. */
async function preview(text) {
  const v = await validate(text);
  const errors = v.rows.filter((r) => r.errors.length).slice(0, 200).map((r) => ({ line: r.line, errors: r.errors }));
  return {
    ok: !v.fileErrors.length && v.summary.invalid === 0 && v.summary.total > 0,
    fileErrors: v.fileErrors, summary: v.summary, errors, errorsTruncated: v.summary.invalid > 200,
    sample: v.rows.filter((r) => !r.errors.length).slice(0, 10).map((r) => ({ line: r.line, name: r.data.name, sku: r.data.sku || null, barcode: r.data.barcode || null, unit: r.data.unit, sellingPrice: r.data.sellingPrice, purchasePrice: r.data.purchasePrice ?? 0, stock: r.data.stock ?? 0 })),
  };
}

async function importProducts(text, userId) {
  const v = await validate(text);
  if (v.fileErrors.length || v.summary.invalid || !v.summary.total) {
    throw new HttpError(422, v.fileErrors[0] || `${v.summary.invalid} row(s) have errors. Nothing was imported.`, { code: 'IMPORT_INVALID', fileErrors: v.fileErrors, summary: v.summary, errors: v.rows.filter((r) => r.errors.length).slice(0, 200).map((r) => ({ line: r.line, errors: r.errors })) });
  }
  await assertWithinLimit(currentBusinessId(), 'products', v.rows.length);
  let ids;
  try {
    ids = await withTransaction(async (client) => {
      const out = [];
      for (const r of v.rows) {
        out.push(await products.createProductTx(client, { leadTimeDays: 3, purchasePrice: 0, stock: 0, minimumStock: 0, ...r.data, sku: r.data.sku || undefined }, userId));
      }
      return out;
    });
  } catch (e) {
    // a duplicate that appeared AFTER validation (another user added it a moment ago) → nothing was written
    if (e && (e.code === '23505' || (e.status === 409 && e.details && e.details.code === 'BARCODE_TAKEN'))) throw conflict('Something changed while importing (a SKU or barcode was added by someone else). Nothing was imported — check the file again.', { code: 'IMPORT_CONFLICT' });
    throw e;
  }
  invalidateAll();
  return { imported: ids.length, productIds: ids };
}

module.exports = { COLUMNS, TEMPLATE, validate, preview, importProducts };
