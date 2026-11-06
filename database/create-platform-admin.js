// Creates (or resets the password of) the platform owner account in ANY SHARKPOS 2 database, including production.
// Usage (from backend/):  PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='a long passphrase' DATABASE_URL=... npm run create-admin
// Runs against DATABASE_URL (the app role). Refuses databases not named "sharkpos2*" and weak passwords. Prints no secrets.
const path = require('path');
require('../backend/node_modules/dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { assertSafeTarget } = require('./safety');
const bcrypt = require('../backend/node_modules/bcryptjs');

(async () => {
  const dbName = assertSafeTarget(process.env.DATABASE_URL || '');
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  const name = process.env.PLATFORM_ADMIN_NAME || 'Platform Admin';
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set PLATFORM_ADMIN_EMAIL to a valid email address.');
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters with letters and numbers.');
  const { pool, sysQuery } = require('../backend/src/db');
  const { BCRYPT_ROUNDS } = require('../backend/src/services/authService');
  await sysQuery(
    `INSERT INTO accounts (name, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET is_platform_admin = TRUE, password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL`,
    [name, email, await bcrypt.hash(password, BCRYPT_ROUNDS)]);
  console.log(`Platform admin ${email} is ready in database "${dbName}".`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
