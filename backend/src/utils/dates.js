// Store-local calendar helpers. "Today" always means the shop's own time zone (config.storeTz), never the server's.
const { query } = require('../db');
const config = require('../config');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function todayLocal(q = query) {
  return (await q('SELECT ((now() AT TIME ZONE $1)::date)::text AS d', [config.storeTz])).rows[0].d;
}

const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
/** Whole days from date string a to date string b (b later → positive). */
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
function addDays(s, n) { const d = new Date(toUtc(s)); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const isValidDate = (s) => DATE_RE.test(s) && !Number.isNaN(toUtc(s)) && new Date(toUtc(s)).toISOString().slice(0, 10) === s;

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { todayLocal, daysBetween, addDays, isValidDate, r2 };
