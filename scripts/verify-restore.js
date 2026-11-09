// Compares two databases table by table: row count + an order-independent content checksum.
// A backup is NOT considered successful until a restore passes this. Read-only; use the BACKUP role (it can read every tenant's rows).
//   SOURCE_DATABASE_URL=postgres://sharkpos2_backup:...@host/sharkpos2  RESTORED_DATABASE_URL=postgres://sharkpos2_backup:...@host/sharkpos2_restore  node scripts/verify-restore.js
// Exit code 0 = every table matches; 1 = a mismatch, missing table or error. Prints counts and checksums only, never row contents.
const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));

const name = (u) => decodeURIComponent(new URL(u).pathname.slice(1));
async function fingerprint(url) {
  if (!/^sharkpos2/.test(name(url))) throw new Error(`Refusing: "${name(url)}" is not a SHARKPOS 2 database.`);
  const c = new Client({ connectionString: url }); await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');   // one consistent snapshot
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map((r) => r.tablename);
    const out = {};
    for (const t of tables) {
      const r = (await c.query(`SELECT count(*)::bigint AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS sum FROM public."${t}" x`)).rows[0];
      out[t] = { n: String(r.n), sum: r.sum };
    }
    await c.query('COMMIT');
    return out;
  } finally { await c.end(); }
}

async function main() {
  const { SOURCE_DATABASE_URL: src, RESTORED_DATABASE_URL: dst } = process.env;
  if (!src || !dst) throw new Error('Set SOURCE_DATABASE_URL and RESTORED_DATABASE_URL.');
  if (name(src) === name(dst) && new URL(src).host === new URL(dst).host) throw new Error('Source and restored database are the same database.');
  const [a, b] = [await fingerprint(src), await fingerprint(dst)];
  let bad = 0; let rows = 0;
  for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[t]; const y = b[t];
    const state = !x ? 'EXTRA IN RESTORE' : !y ? 'MISSING IN RESTORE' : x.n !== y.n ? 'COUNT DIFFERS' : x.sum !== y.sum ? 'CONTENT DIFFERS' : 'ok';
    if (state !== 'ok') bad += 1; else rows += Number(x.n);
    console.log(`${state === 'ok' ? '  ok ' : ' FAIL'} ${t.padEnd(26)} source=${x ? x.n : '-'} restored=${y ? y.n : '-'} ${state === 'ok' ? x.sum.slice(0, 8) : state}`);
  }
  console.log(bad ? `\nRESTORE NOT VERIFIED: ${bad} table(s) differ.` : `\nRESTORE VERIFIED: ${Object.keys(a).length} tables, ${rows} rows, counts and checksums identical.`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
