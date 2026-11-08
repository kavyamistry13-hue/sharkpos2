// Udhaar (customer credit). The ledger is append-only: balance = Σ(amount × effect). A credit sale adds to it, a payment or a refund reduces it,
// an owner adjustment corrects it (with a mandatory reason). Nothing here talks to a payment provider or sends a message.
const { query, withTransaction } = require('../db');
const config = require('../config');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { daysBetween, todayLocal, r2 } = require('../utils/dates');
const { getSettings } = require('./settings');
const { invalidateAll } = require('../utils/cache');

const toPaise = (n) => Math.round(Number(n) * 100);
const BUCKETS = ['0-30', '31-60', '61-90', '90+'];

/**
 * Pure aging calculation. `entries` are ledger rows in chronological order: { effect, amount, entryType, saleId, localDate }.
 * A refund first cancels the very sale it belongs to; payments (and anything left over) are applied to the OLDEST unpaid charge first (FIFO).
 * What is still unpaid is bucketed by the age of the charge it belongs to.
 */
function computeAging(entries, asOf) {
  const charges = [];
  let pool = 0;
  for (const e of entries) {
    const p = toPaise(e.amount);
    if (e.effect === 1) { charges.push({ saleId: e.saleId || null, date: e.localDate, remaining: p }); continue; }
    let left = p;
    if (e.entryType === 'refund' && e.saleId) {
      const target = charges.find((c) => c.saleId === e.saleId && c.remaining > 0);
      if (target) { const take = Math.min(target.remaining, left); target.remaining -= take; left -= take; }
    }
    pool += left;
  }
  for (const c of charges) {
    if (pool <= 0) break;
    const take = Math.min(c.remaining, pool);
    c.remaining -= take; pool -= take;
  }
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const open = [];
  for (const c of charges) {
    if (c.remaining <= 0) continue;
    const ageDays = Math.max(0, daysBetween(c.date, asOf));
    buckets[ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+'] += c.remaining;
    open.push({ saleId: c.saleId, date: c.date, ageDays, remaining: r2(c.remaining / 100) });
  }
  const outstanding = open.reduce((a, c) => a + Math.round(c.remaining * 100), 0);
  return {
    outstanding: r2(outstanding / 100),
    advance: r2(pool / 100),                                   // customer paid more than they owed (e.g. refund after payment)
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, r2(buckets[b] / 100)])),
    oldestDays: open.length ? Math.max(...open.map((c) => c.ageDays)) : null,
    openCharges: open,
  };
}

const mapEntry = (r) => ({
  id: r.id, type: r.entry_type, effect: r.effect, amount: r.amount, saleId: r.sale_id, invoiceNo: r.invoice_no || null,
  method: r.payment_method, note: r.note, by: r.by_name || null, createdAt: r.created_at, localDate: r.local_date,
});
const entryForAging = (r) => ({ effect: r.effect, amount: r.amount, entryType: r.entry_type, saleId: r.sale_id, localDate: r.local_date });

const ENTRY_SQL = `SELECT l.id, l.customer_id, l.entry_type, l.effect, l.amount, l.sale_id, l.payment_method, l.note, l.created_at,
                          (l.created_at AT TIME ZONE $1)::date::text AS local_date, s.invoice_no, u.name AS by_name
                     FROM credit_ledger l LEFT JOIN sales s ON s.id = l.sale_id LEFT JOIN users u ON u.id = l.created_by`;

async function loadCustomer(q, id, lock = false) {
  const c = (await q(`SELECT id, name, phone, credit_limit FROM customers WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!c) throw notFound('Customer not found.');
  return c;
}
async function balanceOf(q, customerId) {
  return r2((await q('SELECT COALESCE(SUM(amount * effect), 0) AS b FROM credit_ledger WHERE customer_id = $1', [customerId])).rows[0].b);
}

/** Light read for the till: limit and what is left of it. */
async function getBalance(customerId) {
  const c = await loadCustomer(query, customerId);
  const balance = await balanceOf(query, customerId);
  return { customerId: c.id, name: c.name, phone: c.phone, creditLimit: c.credit_limit, balance, available: Math.max(0, r2(c.credit_limit - balance)), enabled: c.credit_limit > 0 };
}

async function getAccount(customerId, { limit = 200 } = {}) {
  const c = await loadCustomer(query, customerId);
  const rows = (await query(`${ENTRY_SQL} WHERE l.customer_id = $2 ORDER BY l.created_at, l.id`, [config.storeTz, customerId])).rows;
  const today = await todayLocal();
  const aging = computeAging(rows.map(entryForAging), today);
  const balance = r2(rows.reduce((a, r) => a + r.amount * r.effect, 0));
  return {
    customerId: c.id, name: c.name, phone: c.phone, creditLimit: c.credit_limit, balance, available: Math.max(0, r2(c.credit_limit - balance)),
    enabled: c.credit_limit > 0, aging, history: rows.map(mapEntry).reverse().slice(0, limit),
  };
}

/** Called inside the sale transaction. Locks the customer so two tills cannot both spend the last of the limit. */
async function recordCreditSale(client, { customerId, saleId, amount, userId }) {
  const c = await loadCustomer(client.query.bind(client), customerId, true);
  if (!(c.credit_limit > 0)) throw conflict(`Credit is not enabled for ${c.name}. A manager can set a credit limit first.`, { code: 'CREDIT_NOT_ENABLED' });
  const balance = await balanceOf(client.query.bind(client), customerId);
  if (r2(balance + amount) > c.credit_limit) {
    throw conflict(`This bill of ₹${amount} would take ${c.name} over the credit limit of ₹${c.credit_limit} (already owes ₹${balance}).`, { code: 'CREDIT_LIMIT_EXCEEDED', creditLimit: c.credit_limit, balance, available: Math.max(0, r2(c.credit_limit - balance)) });
  }
  await client.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, sale_id, created_by) VALUES ($1,'sale',1,$2,$3,$4)`, [customerId, amount, saleId, userId]);
}

/** Called inside the refund transaction for a credit sale: the customer no longer owes it. */
async function reverseCreditSale(client, { customerId, saleId, amount, userId }) {
  await loadCustomer(client.query.bind(client), customerId, true);
  await client.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, sale_id, note, created_by) VALUES ($1,'refund',-1,$2,$3,'Sale refunded',$4)`, [customerId, amount, saleId, userId]);
}

/** Partial-return version of reverseCreditSale: reduces what the customer owes by `amount`, tied to one return record. */
async function reverseCreditAmount(client, { customerId, saleId, returnId, amount, userId }) {
  await loadCustomer(client.query.bind(client), customerId, true);
  await client.query(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, sale_id, return_id, note, created_by) VALUES ($1,'refund',-1,$2,$3,$4,'Items returned',$5)`, [customerId, amount, saleId, returnId, userId]);
}

async function recordPayment(user, customerId, { amount, method, note }) {
  const amt = r2(amount);
  if (!(amt > 0)) throw badRequest('Enter an amount greater than zero.');
  const out = await withTransaction(async (client) => {
    const q = client.query.bind(client);
    const c = await loadCustomer(q, customerId, true);
    const balance = await balanceOf(q, customerId);
    if (balance <= 0) throw conflict(`${c.name} has nothing outstanding.`, { code: 'NOTHING_OUTSTANDING' });
    if (amt > balance) throw conflict(`${c.name} owes ₹${balance}. A payment cannot be more than that.`, { code: 'PAYMENT_EXCEEDS_BALANCE', balance });
    const ins = (await q(
      `INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, payment_method, note, created_by) VALUES ($1,'payment',-1,$2,$3,$4,$5) RETURNING id, created_at`,
      [customerId, amt, method, note || null, user.id],
    )).rows[0];
    return { entryId: ins.id, createdAt: ins.created_at, customer: c.name, balanceBefore: balance, balanceAfter: r2(balance - amt) };
  });
  invalidateAll();
  return { ...out, amount: amt, method };
}

/** Owner-only correction (write-off or fix). Always needs a written reason. */
async function adjust(user, customerId, { amount, direction, note }) {
  const amt = r2(amount);
  const out = await withTransaction(async (client) => {
    const q = client.query.bind(client);
    const c = await loadCustomer(q, customerId, true);
    const before = await balanceOf(q, customerId);
    if (direction === 'decrease' && amt > before) throw conflict(`${c.name} owes ₹${before}; cannot reduce by ₹${amt}.`, { code: 'ADJUSTMENT_EXCEEDS_BALANCE', balance: before });
    await q(`INSERT INTO credit_ledger (customer_id, entry_type, effect, amount, note, created_by) VALUES ($1,'adjustment',$2,$3,$4,$5)`, [customerId, direction === 'increase' ? 1 : -1, amt, note, user.id]);
    return { customer: c.name, balanceBefore: before, balanceAfter: r2(before + (direction === 'increase' ? amt : -amt)) };
  });
  invalidateAll();
  return out;
}

async function setCreditLimit(customerId, creditLimit) {
  const cur = await loadCustomer(query, customerId);
  const balance = await balanceOf(query, customerId);
  await query('UPDATE customers SET credit_limit = $1 WHERE id = $2', [creditLimit, customerId]);
  invalidateAll();
  return { customerId, name: cur.name, before: cur.credit_limit, after: creditLimit, balance, overLimit: balance > creditLimit };
}

/** Every customer who currently owes money, with aging. */
async function listDebtors({ overdueDays = null, q = null } = {}) {
  const tz = config.storeTz;
  const base = (await query(
    `SELECT c.id, c.name, c.phone, c.credit_limit, SUM(l.amount * l.effect) AS balance,
            MAX(l.created_at) FILTER (WHERE l.entry_type = 'payment') AS last_payment_at
       FROM customers c JOIN credit_ledger l ON l.customer_id = c.id
      GROUP BY c.id HAVING SUM(l.amount * l.effect) > 0 ORDER BY SUM(l.amount * l.effect) DESC`,
  )).rows;
  if (!base.length) return [];
  const ids = base.map((r) => r.id);
  const ent = (await query(`${ENTRY_SQL} WHERE l.customer_id = ANY($2::int[]) ORDER BY l.created_at, l.id`, [tz, ids])).rows;
  const by = new Map();
  for (const r of ent) { if (!by.has(r.customer_id)) by.set(r.customer_id, []); by.get(r.customer_id).push(entryForAging(r)); }
  const today = await todayLocal();
  let rows = base.map((c) => {
    const aging = computeAging(by.get(c.id) || [], today);
    return { customerId: c.id, name: c.name, phone: c.phone, creditLimit: c.credit_limit, balance: r2(c.balance), lastPaymentAt: c.last_payment_at, oldestDays: aging.oldestDays, aging: aging.buckets, overdue: overdueDays !== null && aging.oldestDays !== null && aging.oldestDays > overdueDays };
  });
  if (q) { const n = q.toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(n) || r.phone.includes(n)); }
  if (overdueDays !== null) rows = rows.filter((r) => r.overdue);
  return rows;
}

async function summary({ overdueDays = 30 } = {}) {
  const all = (await listDebtors()).map((r) => ({ ...r, overdue: r.oldestDays !== null && r.oldestDays > overdueDays }));
  const month = (await query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type = 'sale'), 0) AS given, COALESCE(SUM(amount) FILTER (WHERE entry_type = 'payment'), 0) AS collected
       FROM credit_ledger WHERE created_at >= now() - interval '30 days'`,
  )).rows[0];
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, r2(all.reduce((a, r) => a + r.aging[b], 0))]));
  const over = all.filter((r) => r.overdue);
  return {
    outstanding: r2(all.reduce((a, r) => a + r.balance, 0)), debtors: all.length, overdueDays,
    overdueAmount: r2(over.reduce((a, r) => a + r.balance, 0)), overdueCustomers: over.length,
    aging: buckets, givenLast30Days: r2(month.given), collectedLast30Days: r2(month.collected),
    top: all.slice(0, 5).map((r) => ({ customerId: r.customerId, name: r.name, balance: r.balance, oldestDays: r.oldestDays })),
  };
}

// ---------------------------------------------------------------- free WhatsApp click-to-chat reminder (no API, no cost, nothing is sent)
function waPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

function reminderMessage({ lang, name, store, balance, oldestDays }) {
  if (lang === 'hi') {
    return `नमस्ते ${name}, ${store} की ओर से एक छोटी सी याद दिलाना है: आपके खाते में ${inr(balance)} बकाया है${oldestDays > 0 ? ` (सबसे पुराना ${oldestDays} दिन का)` : ''}। कृपया अपनी सुविधा से भुगतान कर दें। धन्यवाद!`;
  }
  return `Hello ${name}, a gentle reminder from ${store}: ${inr(balance)} is pending on your account${oldestDays > 0 ? ` (oldest bill ${oldestDays} days old)` : ''}. Please pay when convenient. Thank you!`;
}

async function buildReminder(customerId, { lang = 'en' } = {}) {
  const acct = await getAccount(customerId, { limit: 0 });
  if (!(acct.balance > 0)) throw conflict(`${acct.name} has nothing outstanding.`, { code: 'NOTHING_OUTSTANDING' });
  const wa = waPhone(acct.phone);
  if (!wa) throw badRequest(`${acct.name} does not have a phone number that WhatsApp can open.`, { code: 'INVALID_PHONE' });
  const store = (await getSettings()).storeName;
  const message = reminderMessage({ lang, name: acct.name, store, balance: acct.balance, oldestDays: acct.aging.oldestDays || 0 });
  return { customerId: acct.customerId, name: acct.name, phone: acct.phone, whatsappNumber: wa, balance: acct.balance, oldestDays: acct.aging.oldestDays, lang, message, link: `https://wa.me/${wa}?text=${encodeURIComponent(message)}`, sent: false };
}

module.exports = { computeAging, getBalance, getAccount, recordCreditSale, reverseCreditSale, reverseCreditAmount, recordPayment, adjust, setCreditLimit, listDebtors, summary, buildReminder, waPhone, reminderMessage, BUCKETS };
