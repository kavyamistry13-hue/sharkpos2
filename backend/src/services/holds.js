// Held bills: a cart parked on the SERVER so it survives a refresh, a power cut or a change of till.
// A held bill is only a saved cart. It deducts no stock and creates no sale, revenue, profit, tax or shift movement.
// It becomes a sale only when completed through the normal sale path (services/sales.js createSale with heldBillId), which locks the hold
// and marks it completed in the same transaction — so a hold can be completed at most once, even with two tills or a double click.
const { query, withTransaction } = require('../db');
const { badRequest, forbidden, notFound, conflict, HttpError } = require('../utils/errors');
const { computeBill } = require('./billing');
const { toPaise } = require('../utils/money');
const { assertQuantity } = require('../utils/units');
const { loadProductsForCart, mergeItems } = require('./sales');

const MAX_OPEN_PER_USER = 20;
const isManager = (u) => u.role === 'business_owner' || u.role === 'manager';
const todayIso = () => new Date().toISOString().slice(0, 10);

const map = (r) => ({
  id: r.id, status: r.status, label: r.label, createdBy: r.created_by, createdByName: r.by_name || null, customerId: r.customer_id, customerName: r.customer_name || null,
  items: r.items, discount: r.discount, itemCount: r.items.length, version: r.version, resumedCount: r.resumed_count,
  completedSaleId: r.completed_sale_id, completedAt: r.completed_at, discardedAt: r.discarded_at, createdAt: r.created_at, updatedAt: r.updated_at,
  estimatedTotal: Math.round(r.items.reduce((a, i) => a + toPaise(i.unitPrice || 0) * i.quantity, 0)) / 100,
});
const SQL = `SELECT h.*, u.name AS by_name, c.name AS customer_name FROM held_bills h JOIN users u ON u.id = h.created_by LEFT JOIN customers c ON c.id = h.customer_id`;

async function snapshotItems(client, rawItems) {
  const merged = mergeItems(rawItems);
  const products = await loadProductsForCart(client, merged, { lock: false });
  return merged.map((it) => {
    const p = products.get(it.productId);
    if (!p || !p.is_active) throw notFound('One of the products was not found.');
    assertQuantity(p.unit, it.quantity, 'Quantity', p.name);
    return { productId: p.id, quantity: it.quantity, name: p.name, unitPrice: p.selling_price };
  });
}

async function assertCustomer(client, customerId) {
  if (customerId && !(await client.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rowCount) throw notFound('Customer not found.');
}

async function loadHold(q, id, user, { lock = false } = {}) {
  const r = (await q(`${SQL} WHERE h.id = $1${lock ? ' FOR UPDATE OF h' : ''}`, [id])).rows[0];
  if (!r || (!isManager(user) && r.created_by !== user.id)) throw notFound('Held bill not found.');
  return r;
}

async function createHold(user, input, requestKey) {
  const row = await withTransaction(async (client) => {
    if (requestKey) {
      const prev = (await client.query('SELECT id, created_by FROM held_bills WHERE request_key = $1', [requestKey])).rows[0];
      if (prev) {
        if (prev.created_by !== user.id) throw new HttpError(422, 'This idempotency key was already used by someone else.', { code: 'IDEMPOTENCY_KEY_REUSED' });
        return { id: prev.id, replayed: true };
      }
    }
    const open = (await client.query(`SELECT COUNT(*)::int AS n FROM held_bills WHERE status = 'held' AND created_by = $1`, [user.id])).rows[0].n;
    if (open >= MAX_OPEN_PER_USER) throw conflict(`You already have ${MAX_OPEN_PER_USER} held bills. Complete or discard one first.`, { code: 'HOLD_LIMIT' });
    await assertCustomer(client, input.customerId);
    const items = await snapshotItems(client, input.items);
    const ins = (await client.query(
      `INSERT INTO held_bills (created_by, customer_id, label, items, discount, request_key) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id`,
      [user.id, input.customerId || null, input.label ? String(input.label).trim().slice(0, 60) || null : null, JSON.stringify(items), input.discount ? JSON.stringify(input.discount) : null, requestKey || null],
    )).rows[0];
    return { id: ins.id, replayed: false };
  });
  return { hold: map(await loadHold(query, row.id, user)), replayed: row.replayed };
}

async function listHolds(user, { status = 'held' } = {}) {
  const where = ['h.status = $1'];
  const params = [status];
  if (!isManager(user)) { params.push(user.id); where.push(`h.created_by = $${params.length}`); }
  const rows = (await query(`${SQL} WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC, h.id DESC LIMIT 100`, params)).rows;
  return rows.map(map);
}

/**
 * The held cart re-checked against TODAY's catalogue: deleted/inactive products, expiry, stock, price changes. Never throws for a stale
 * product — it reports each problem so the cashier can fix the cart — and prices what is still sellable.
 */
async function checkHold(h) {
  const merged = h.items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity) }));
  const products = await loadProductsForCart({ query }, merged, { lock: false });
  const issues = [];
  const sellable = [];
  for (const it of h.items) {
    const p = products.get(it.productId);
    if (!p || !p.is_active) { issues.push({ productId: it.productId, name: it.name, code: 'PRODUCT_UNAVAILABLE', message: `${it.name} is no longer available.` }); continue; }
    if (p.expiry_date && p.expiry_date < todayIso()) { issues.push({ productId: it.productId, name: p.name, code: 'EXPIRED', message: `${p.name} is expired.` }); continue; }
    if (p.stock < it.quantity) { issues.push({ productId: it.productId, name: p.name, code: 'INSUFFICIENT_STOCK', message: `Only ${p.stock} ${p.unit} of ${p.name} left (held ${it.quantity}).`, available: p.stock }); continue; }
    if (toPaise(p.selling_price) !== toPaise(it.unitPrice)) issues.push({ productId: it.productId, name: p.name, code: 'PRICE_CHANGED', severity: 'info', message: `${p.name} price changed from ₹${it.unitPrice} to ₹${p.selling_price}. The new price will be used.`, oldPrice: it.unitPrice, newPrice: p.selling_price });
    sellable.push({ productId: p.id, name: p.name, quantity: it.quantity, unitPaise: toPaise(p.selling_price), taxRate: p.tax_rate, priceIncludesTax: p.price_includes_tax, unit: p.unit, unitCost: p.purchase_price });
  }
  const blocking = issues.filter((i) => i.severity !== 'info');
  const bill = sellable.length ? computeBill(sellable, h.discount || null) : null;
  return { issues, canComplete: blocking.length === 0 && sellable.length > 0, bill };
}

async function getHold(user, id) {
  const h = await loadHold(query, id, user);
  const hold = map(h);
  return h.status === 'held' ? { hold, ...(await checkHold(h)) } : { hold, issues: [], canComplete: false, bill: null };
}

/** Resume = open the cart again. Counts the resume (audit trail) and returns it re-validated; the hold stays 'held' until it is completed. */
async function resumeHold(user, id) {
  await withTransaction(async (client) => {
    const h = await loadHold(client.query.bind(client), id, user, { lock: true });
    if (h.status !== 'held') throw conflict(`This held bill is already ${h.status}.`, { code: 'HELD_BILL_NOT_OPEN', status: h.status });
    await client.query('UPDATE held_bills SET resumed_count = resumed_count + 1 WHERE id = $1', [id]);
  });
  return getHold(user, id);
}

/** Edit the parked cart (e.g. cashier resumed it, changed it and parked it again). `version` guards against two tills editing at once. */
async function updateHold(user, id, input) {
  await withTransaction(async (client) => {
    const h = await loadHold(client.query.bind(client), id, user, { lock: true });
    if (h.status !== 'held') throw conflict(`This held bill is already ${h.status}.`, { code: 'HELD_BILL_NOT_OPEN', status: h.status });
    if (input.version !== undefined && input.version !== h.version) throw conflict('This held bill was changed on another screen. Reopen it to see the latest.', { code: 'HOLD_VERSION_CONFLICT', version: h.version });
    await assertCustomer(client, input.customerId);
    const items = await snapshotItems(client, input.items);
    await client.query(
      `UPDATE held_bills SET items = $2::jsonb, discount = $3::jsonb, customer_id = $4, label = $5, version = version + 1 WHERE id = $1`,
      [id, JSON.stringify(items), input.discount ? JSON.stringify(input.discount) : null, input.customerId || null, input.label ? String(input.label).trim().slice(0, 60) || null : null],
    );
  });
  return getHold(user, id);
}

async function discardHold(user, id) {
  const out = await withTransaction(async (client) => {
    const h = await loadHold(client.query.bind(client), id, user, { lock: true });
    if (h.status === 'completed') throw conflict('This held bill was already completed as a sale.', { code: 'HELD_BILL_NOT_OPEN', status: h.status });
    if (h.status === 'discarded') return { already: true };
    await client.query(`UPDATE held_bills SET status = 'discarded', discarded_by = $2, discarded_at = now(), version = version + 1 WHERE id = $1`, [id, user.id]);
    return { already: false };
  });
  return { hold: map(await loadHold(query, id, user)), already: out.already };
}

module.exports = { createHold, listHolds, getHold, resumeHold, updateHold, discardHold, checkHold, MAX_OPEN_PER_USER };
