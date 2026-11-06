// Plan catalogue. Prices, limits and features live in the `plans` table only — nothing is hard-coded elsewhere.
const { sysQuery } = require('../../db');

const shape = (r) => ({
  id: r.id, code: r.code, name: r.name, pricePaise: r.price_paise, price: r.price_paise / 100, currency: r.currency,
  intervalDays: r.interval_days, features: r.features, highlights: r.highlights, sortOrder: r.sort_order,
});

async function listPlans() {
  return (await sysQuery('SELECT * FROM plans WHERE is_active ORDER BY sort_order, id')).rows.map(shape);
}
async function getPlanByCode(code) {
  const r = await sysQuery('SELECT * FROM plans WHERE code = $1 AND is_active', [code]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}
async function getPlanById(id) {
  const r = await sysQuery('SELECT * FROM plans WHERE id = $1', [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

module.exports = { listPlans, getPlanByCode, getPlanById };
