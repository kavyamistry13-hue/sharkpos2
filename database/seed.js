// Loads the SHARKPOS 2 demo business (+ a platform admin). Usage: npm run seed   (from backend/)
// Safety: refuses to run unless DATABASE_URL points at a "sharkpos2*" database. Only touches the demo business.
const path = require('path');
require('../backend/node_modules/dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { assertSafeTarget } = require('./safety');
const bcrypt = require('../backend/node_modules/bcryptjs');

(async () => {
  const dbName = assertSafeTarget(process.env.DATABASE_URL || '');
  const { pool, sysQuery } = require('../backend/src/db');
  const { loadDemoData } = require('../backend/src/seed/demo');
  const { BCRYPT_ROUNDS } = require('../backend/src/services/authService');
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production.');
  console.log(`Seeding demo business into database "${dbName}"…`);

  const platformPw = process.env.PLATFORM_ADMIN_PASSWORD || 'platform123';
  await sysQuery(
    `INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ('Platform Admin', 'platform@sharkpos.ai', $1, TRUE)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET is_platform_admin = TRUE, password_hash = EXCLUDED.password_hash`,
    [await bcrypt.hash(platformPw, BCRYPT_ROUNDS)],
  );
  let b = (await sysQuery("SELECT id FROM businesses WHERE slug = 'demo-sharkmart'")).rows[0];
  if (!b) b = (await sysQuery("INSERT INTO businesses (name, slug, email, phone, address, is_demo) VALUES ('SharkMart Fresh (Demo)', 'demo-sharkmart', 'demo@sharkpos.ai', '9000000000', '12, MG Road, Bengaluru', TRUE) RETURNING id")).rows[0];
  // The demo shop always has a running Pro subscription so every feature can be shown.
  await sysQuery(
    `INSERT INTO subscriptions (business_id, plan_id, status, start_date, end_date) VALUES ($1, (SELECT id FROM plans WHERE code = 'pro'), 'active', now(), now() + interval '3650 days')
     ON CONFLICT (business_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', end_date = EXCLUDED.end_date, cancel_at_period_end = FALSE, pending_plan_id = NULL`, [b.id]);
  const summary = await loadDemoData({ businessId: b.id, log: (m) => console.log(m) });
  console.table(summary);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
