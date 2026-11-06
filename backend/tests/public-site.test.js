// SHARKPOS 2 — Phase 4 tests: public site guard-rails (no hard-coded prices, legal pages stay marked as drafts, every link has a route).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FE = path.join(__dirname, '..', '..', 'frontend', 'src');
const read = (f) => fs.readFileSync(path.join(FE, f), 'utf8');
const publicFiles = fs.readdirSync(path.join(FE, 'pages', 'public')).filter((f) => /\.jsx?$/.test(f));

test('public pages never hard-code a price or plan limit (plans are configurable in the database)', () => {
  for (const f of publicFiles) {
    const src = read(`pages/public/${f}`);
    assert.doesNotMatch(src, /₹\s?\d{2,}/, `${f} contains a hard-coded rupee price`);
  }
});

test('legal pages are drafts: visible warning, placeholders to fill, and no claim of legal approval', async () => {
  const { LEGAL } = await import(require('node:url').pathToFileURL(path.join(FE, 'pages', 'public', 'legalContent.js')).href);
  assert.deepEqual(Object.keys(LEGAL).sort(), ['privacy', 'refunds', 'terms']);
  assert.match(read('pages/public/Legal.jsx'), /Draft for review/);
  assert.match(read('pages/public/Legal.jsx'), /not been reviewed or approved by a lawyer/);
  assert.match(read('pages/public/legalContent.js'), /NOT been reviewed by a lawyer/);
  for (const [k, d] of Object.entries(LEGAL)) {
    const text = d.sections.flatMap((s) => [s.heading, ...s.paras]).join('\n');
    assert.ok(d.sections.length >= 5, `${k} has substance`);
    assert.match(text, /\[[^\]]*to be (added|decided|confirmed)[^\]]*\]/i, `${k} keeps visible placeholders for owner decisions`);
    assert.doesNotMatch(text, /legally (approved|compliant|binding opinion)|fully compliant|guarantee(d)? compliance/i, `${k} must not claim legal approval`);
  }
  const all = JSON.stringify(LEGAL);
  assert.match(all, /Razorpay/); assert.match(all, /Digital Personal Data Protection/);
  assert.doesNotMatch(all, /password[^.]*(store|keep)[^.]*plain/i);
});

test('every footer/nav link on the public site has a matching route, and the public routes sit outside the login guard', () => {
  const app = read('App.jsx');
  const layout = read('pages/public/PublicLayout.jsx');
  const targets = [...layout.matchAll(/to: '([^']+)'/g)].map((m) => m[1].split('#')[0] || '/');
  for (const t of new Set([...targets, '/login', '/register'])) assert.ok(app.includes(`path="${t}"`), `no route for ${t}`);
  const publicBlock = app.slice(app.indexOf('<PublicLayout />'), app.indexOf('<Route path="/login"'));
  for (const p of ['/', '/pricing', '/contact', '/terms', '/privacy', '/refunds']) assert.ok(publicBlock.includes(`path="${p}"`), `${p} should be public`);
  assert.doesNotMatch(publicBlock, /Guard/, 'public pages must not require sign-in');
  assert.match(app, /user \? <Navigate to=\{home\(user\)\}/, 'signed-in users go straight to their app from /');
});

test('pricing reads plans from the API and registration keeps the plan picked on the pricing page', () => {
  assert.match(read('pages/public/usePlans.js'), /\/api\/plans/);
  assert.match(read('pages/public/PlanCards.jsx'), /register\?plan=/);
  assert.match(read('pages/Register.jsx'), /params\.get\('plan'\)/);
});

test('marketing copy makes no promise the product does not keep', () => {
  const copy = publicFiles.map((f) => read(`pages/public/${f}`)).join('\n');
  assert.doesNotMatch(copy, /works offline|offline mode|GST (return )?filing|e-?invoice|guaranteed|100% (secure|uptime)|unhackable|bank-grade/i);
});
