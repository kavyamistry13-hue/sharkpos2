// Customer intelligence: segments and insights come from purchase data only (spend, frequency, categories).
const { query } = require('../db');
const { conflict, notFound } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');

const INACTIVE_AFTER_DAYS = 45;
const NEW_WITHIN_DAYS = 30;

function segmentFor(c, vipThreshold) {
  if (c.orders === 0) return 'new';
  if (c.daysSinceLast > INACTIVE_AFTER_DAYS) return 'inactive';
  if (c.orders >= 5 && c.spending >= vipThreshold) return 'vip';
  if (c.daysSinceFirst <= NEW_WITHIN_DAYS || c.orders <= 2) return 'new';
  return 'regular';
}

/** Deterministic, non-sensitive insight text. The AI layer may rephrase it, never change the numbers. */
function insightFor(c) {
  const money = `₹${Math.round(c.spending).toLocaleString('en-IN')}`;
  const cat = c.favoriteCategory ? c.favoriteCategory.toLowerCase() : null;
  switch (c.segment) {
    case 'vip':
      return `High-value customer: ${money} across ${c.orders} orders${cat ? `, strongest in ${cat}` : ''}. Consider early access to new ${cat || 'product'} offers or a loyalty reward.`;
    case 'inactive':
      return `No purchase for ${c.daysSinceLast} days after ${c.orders} orders${cat ? ` (mostly ${cat})` : ''}. A win-back offer on ${cat || 'their usual items'} could bring them back.`;
    case 'new':
      return c.orders === 0 ? 'No purchases yet.' : `Recent customer with ${c.orders} order${c.orders > 1 ? 's' : ''}${cat ? ` so far, leaning towards ${cat}` : ''}. A second-visit offer can build the habit.`;
    default:
      return `Shows regular purchases (${c.orders} orders, about one every ${c.avgGapDays || '—'} days)${cat ? ` with a preference for ${cat}` : ''}. Targeted promotions on ${cat || 'their favourite category'} are a good fit.`;
  }
}

async function listCustomers({ q, segment, sort = 'spending', page = 1, limit = 50 }) {
  const res = await query(
    `SELECT c.id, c.name, c.phone, c.email, c.created_at,
            COUNT(s.id)::int AS orders,
            COALESCE(SUM(s.total), 0) AS spending,
            MAX(s.created_at) AS last_purchase,
            MIN(s.created_at) AS first_purchase,
            fav.category AS favorite_category
       FROM customers c
       LEFT JOIN sales s ON s.customer_id = c.id AND s.status = 'completed'
       LEFT JOIN LATERAL (
         SELECT cat.name AS category
           FROM sale_items si
           JOIN sales s2 ON s2.id = si.sale_id AND s2.customer_id = c.id AND s2.status = 'completed'
           JOIN products p ON p.id = si.product_id
           JOIN categories cat ON cat.id = p.category_id
          GROUP BY cat.name ORDER BY SUM(si.total) DESC LIMIT 1
       ) fav ON TRUE
      GROUP BY c.id, fav.category
      ORDER BY c.id`,
  );
  const now = Date.now();
  let rows = res.rows.map((r) => {
    const last = r.last_purchase ? new Date(r.last_purchase).getTime() : null;
    const first = r.first_purchase ? new Date(r.first_purchase).getTime() : null;
    const daysSinceLast = last ? Math.floor((now - last) / 86400000) : null;
    const daysSinceFirst = first ? Math.floor((now - first) / 86400000) : null;
    const avgGapDays = r.orders > 1 ? Math.max(1, Math.round((last - first) / 86400000 / (r.orders - 1))) : null;
    return {
      id: r.id, name: r.name, phone: r.phone, email: r.email, createdAt: r.created_at,
      orders: r.orders, spending: Math.round(r.spending * 100) / 100,
      avgOrderValue: r.orders ? Math.round((r.spending / r.orders) * 100) / 100 : 0,
      favoriteCategory: r.favorite_category, lastPurchase: r.last_purchase, daysSinceLast, daysSinceFirst, avgGapDays,
      purchaseFrequency: avgGapDays ? `Every ${avgGapDays} days` : r.orders ? 'One-time' : '—',
    };
  });
  const spends = rows.filter((r) => r.orders >= 5).map((r) => r.spending).sort((a, b) => a - b);
  const vipThreshold = spends.length ? spends[Math.floor(spends.length * 0.7)] : Infinity;
  rows = rows.map((r) => {
    const segment = segmentFor(r, vipThreshold);
    const withSeg = { ...r, segment };
    return { ...withSeg, insight: insightFor(withSeg) };
  });

  const counts = { all: rows.length, new: 0, regular: 0, vip: 0, inactive: 0 };
  rows.forEach((r) => { counts[r.segment] += 1; });
  if (segment && segment !== 'all') rows = rows.filter((r) => r.segment === segment);
  if (q) {
    const n = q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(n) || r.phone.includes(q));
  }
  const sorters = {
    spending: (a, b) => b.spending - a.spending,
    orders: (a, b) => b.orders - a.orders,
    recent: (a, b) => (a.daysSinceLast ?? 1e9) - (b.daysSinceLast ?? 1e9),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  rows.sort(sorters[sort] || sorters.spending);
  const total = rows.length;
  return { total, counts, page, limit, rows: rows.slice((page - 1) * limit, page * limit) };
}

async function getCustomer(id) {
  const all = await listCustomers({ limit: 10000 });
  const c = all.rows.find((r) => r.id === id);
  if (!c) throw notFound('Customer not found.');
  const recent = await query(
    `SELECT id, invoice_no, total, created_at FROM sales WHERE customer_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 8`,
    [id],
  );
  const cats = await query(
    `SELECT cat.name, SUM(si.total) AS spend FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.customer_id = $1 AND s.status = 'completed'
       JOIN products p ON p.id = si.product_id JOIN categories cat ON cat.id = p.category_id GROUP BY cat.name ORDER BY spend DESC LIMIT 4`,
    [id],
  );
  return {
    ...c,
    recentOrders: recent.rows.map((r) => ({ id: r.id, invoiceNo: r.invoice_no, total: r.total, createdAt: r.created_at })),
    topCategories: cats.rows.map((r) => ({ name: r.name, spend: Math.round(r.spend * 100) / 100 })),
  };
}

async function createCustomer({ name, phone, email }) {
  const dup = await query('SELECT id FROM customers WHERE phone = $1', [phone]);
  if (dup.rowCount) throw conflict('A customer with this phone number already exists.');
  const res = await query('INSERT INTO customers (name, phone, email) VALUES ($1,$2,$3) RETURNING id', [name, phone, email || null]);
  invalidateAll();
  return getCustomer(res.rows[0].id);
}

/** Lightweight lookup for the POS customer picker. */
async function searchCustomers(q) {
  const needle = `%${q || ''}%`;
  const res = await query(
    `SELECT id, name, phone FROM customers WHERE name ILIKE $1 OR phone LIKE $1 ORDER BY name LIMIT 8`,
    [needle],
  );
  return res.rows;
}

module.exports = { listCustomers, getCustomer, createCustomer, searchCustomers, insightFor };
