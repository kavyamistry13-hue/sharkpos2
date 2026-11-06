// Runs pending SQL migrations in database/migrations (in filename order) as the OWNER role.
// Usage: npm run migrate     (from backend/)    |    npm run migrate -- --status
// Safety: refuses to run unless the target database name starts with "sharkpos2".
const fs = require('fs');
const path = require('path');
const { Client } = require('../backend/node_modules/pg');
require('../backend/node_modules/dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { assertSafeTarget } = require('./safety');

(async () => {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set (see backend/.env.example).');
  const dbName = assertSafeTarget(url);
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  if (process.argv.includes('--status')) {
    files.forEach((f) => console.log(`${done.has(f) ? 'applied' : 'PENDING'}  ${f}`));
    return c.end();
  }
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[${dbName}] applying ${f}`);
    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw new Error(`${f}: ${e.message}`); }
  }
  console.log(`[${dbName}] up to date.`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
