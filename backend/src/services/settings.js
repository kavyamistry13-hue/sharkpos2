const { query } = require('../db');
const config = require('../config');
const { cached, invalidateAll } = require('../utils/cache');

const DEFAULTS = {
  storeName: 'SharkMart Fresh',
  storeAddress: '12, MG Road, Bengaluru',
  gstin: '',
  invoiceFooter: 'Thank you for shopping with us!',
  cashierMaxDiscountPct: config.rules.cashierMaxDiscountPct,
};

async function getSettings() {
  return cached('settings', 5000, async () => {
    const res = await query('SELECT key, value FROM settings');
    const merged = { ...DEFAULTS };
    for (const r of res.rows) merged[r.key] = r.value;
    return merged;
  });
}

async function updateSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in DEFAULTS)) continue;
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }
  invalidateAll();
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS };
