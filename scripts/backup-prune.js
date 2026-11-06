// Retention policy for backup files named sharkpos2-YYYYMMDDTHHMMSSZ.dump.enc.
// Keeps the newest backup of each of the last N days, N weeks and N months; everything else is returned for deletion.
// Usage: ls backups | node scripts/backup-prune.js   → prints the names to delete (one per line). Never deletes anything itself.
const RE = /^sharkpos2-(\d{4})(\d{2})(\d{2})T(\d{6})Z\.dump\.enc$/;

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function toDelete(names, { daily = 14, weekly = 8, monthly = 12 } = {}) {
  const items = names.map((n) => { const m = RE.exec(n); return m ? { name: n, date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), key: `${m[1]}${m[2]}${m[3]}${m[4]}` } : null; }).filter(Boolean)
    .sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first
  const keep = new Set();
  const take = (bucket, limit) => {
    const seen = new Set();
    for (const it of items) {
      const k = bucket(it.date);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k); keep.add(it.name);
    }
  };
  take((d) => d.toISOString().slice(0, 10), daily);
  take((d) => isoWeek(d), weekly);
  take((d) => d.toISOString().slice(0, 7), monthly);
  if (items.length) keep.add(items[0].name); // never delete the newest
  return items.filter((i) => !keep.has(i.name)).map((i) => i.name);
}

module.exports = { toDelete };

if (require.main === module) {
  const input = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean);
  const env = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
  console.log(toDelete(input, { daily: env('KEEP_DAILY', 14), weekly: env('KEEP_WEEKLY', 8), monthly: env('KEEP_MONTHLY', 12) }).join('\n'));
}
