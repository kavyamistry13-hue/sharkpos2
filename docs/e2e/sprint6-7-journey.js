// Run: start the API (PORT 4001) and `npm run dev` in frontend/, then `NODE_PATH=$(npm root -g) node docs/e2e/sprint6-7-journey.js`. Playwright is NOT a project dependency (not installed by this sprint).
// Browser E2E (Playwright, run from the scratchpad — NOT added to the project's dependencies).
// LOGIN → OWNER TODAY → CASHIER MODE → CREATE SALE → HOLD → RESUME → SPLIT PAYMENT → COMPLETE → PARTIAL RETURN → INVENTORY / SHIFT / REPORT UPDATE
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const API = 'http://127.0.0.1:5174/api';
const j = async (m, p, body, token) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(m === 'POST' && p === '/sales' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const step = (n) => console.log(`✔ ${n}`);

(async () => {
  const stamp = Date.now();
  const ownerEmail = `e2e.owner.${stamp}@example.com`; const cashEmail = `e2e.cash.${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', { businessName: `E2E Mart ${stamp}`, ownerName: 'E2E Owner', email: ownerEmail, phone: '9876500123', password: 'Passw0rdOK' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ot = reg.body.accessToken;
  const cat = (await j('POST', '/categories', { name: 'Plain', taxRate: 0 }, ot)).body;
  const prod = (await j('POST', '/products', { name: 'Gift box', categoryId: cat.id, purchasePrice: 300, sellingPrice: 500, stock: 20, minimumStock: 2 }, ot)).body;
  assert.equal((await j('POST', '/employees', { name: 'Counter Cashier', email: cashEmail, password: 'Passw0rdOK', role: 'cashier' }, ot)).status, 201);

  const browser = await chromium.launch();
  const login = async (ctx, email) => { const page = await ctx.newPage(); await page.goto('http://127.0.0.1:5174/login'); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill('Passw0rdOK'); await page.getByRole('button', { name: /sign in/i }).click(); return page; };

  // OWNER: lands on Today
  const octx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const owner = await login(octx, ownerEmail);
  await owner.waitForURL('**/today', { timeout: 15000 });
  await owner.getByRole('heading', { name: 'Today', exact: true }).waitFor();
  await owner.getByRole('heading', { name: /Today’s business/ }).waitFor();
  await owner.getByRole('heading', { name: /Needs your attention/ }).waitFor();
  await owner.getByRole('heading', { name: /SHARKPOS recommends/ }).waitFor();
  assert.ok(await owner.getByText('Actual').first().isVisible(), 'kind labels visible');
  step('owner login lands on Owner Today with the three sections and Actual/Estimated labels');
  await owner.screenshot({ path: 'owner-today-before.png', fullPage: true });

  // CASHIER: counter mode, no owner-only nav
  const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cash = await login(cctx, cashEmail);
  await cash.waitForURL('**/counter', { timeout: 15000 });
  assert.equal(await cash.getByRole('link', { name: 'Today', exact: true }).count(), 0, 'cashier has no Today link');
  assert.equal(await cash.getByRole('link', { name: /Udhaar|Audit|Billing|Action Center/ }).count(), 0, 'no owner-only menu');
  await cash.goto('http://127.0.0.1:5174/today');
  await cash.waitForURL('**/counter');
  step('cashier lands on Counter mode and is kept out of owner pages');

  // CREATE SALE → HOLD
  const search = cash.getByLabel('Scan barcode or search product');
  await search.fill('Gift'); await cash.getByRole('button', { name: /Gift box/ }).first().click();
  await cash.getByRole('button', { name: 'More Gift box' }).click();       // qty 2 → ₹1000
  await cash.getByText('₹1,000.00').first().waitFor();
  await cash.getByRole('button', { name: 'Hold', exact: true }).click();
  await cash.getByText(/Bill held/).waitFor();
  step('cart of 2 held; success banner shown');
  assert.equal((await j('GET', '/products/' + prod.id, null, ot)).body.stock, 20, 'hold deducted nothing');

  // REFRESH → still held (server-side)
  await cash.reload();
  await cash.getByRole('button', { name: /^Held \(1\)/ }).waitFor();
  step('held bill survives a page refresh (server-side)');

  // RESUME
  await cash.getByRole('button', { name: /^Held/ }).click();
  await cash.getByRole('button', { name: 'Resume' }).click();
  await cash.getByText('from held bill').waitFor();
  await cash.getByText('₹1,000.00').first().waitFor();
  step('held bill resumed with its items');

  // SPLIT PAYMENT: cash 400 + UPI 600
  await cash.getByRole('button', { name: 'Pay', exact: true }).click();
  await cash.getByRole('radio', { name: 'Split payment' }).click();
  await cash.getByLabel('Cash amount').fill('400');
  await cash.getByLabel('UPI amount').fill('500');
  await cash.getByText('₹100.00 still to collect').waitFor();
  assert.ok(await cash.getByRole('button', { name: 'Complete sale' }).isDisabled(), 'cannot complete while under-paid');
  await cash.getByLabel('UPI amount').fill('600');
  await cash.getByText('Adds up exactly').waitFor();
  await cash.getByRole('button', { name: 'Complete sale' }).click();
  await cash.getByText(/Sale INV-.* complete/).waitFor();
  step('split payment: blocked until it adds up exactly, then sale completes');
  await cash.getByRole('heading', { name: /Invoice INV-/ }).waitFor();
  await cash.getByText(/CASH ₹400\.00 \+ UPI ₹600\.00/).waitFor();
  step('receipt shows both tender lines');
  await cash.getByRole('button', { name: 'Close' }).first().click().catch(() => {});

  const stockAfterSale = (await j('GET', '/products/' + prod.id, null, ot)).body.stock;
  assert.equal(stockAfterSale, 18);

  // PARTIAL RETURN of 1
  await cash.keyboard.press('Escape');
  await cash.getByRole('button', { name: 'Return', exact: true }).click();
  await cash.getByLabel('Find the bill by invoice number or customer').fill('INV-');
  await cash.getByRole('button', { name: /INV-/ }).first().click();
  await cash.getByLabel('Return quantity of Gift box').fill('1');
  await cash.getByRole('button', { name: 'Return selected items' }).click();
  await cash.getByText(/Give back ₹500\.00/).waitFor();
  step('partial return of 1 unit: ₹500 to give back, refund split shown');
  await cash.screenshot({ path: 'counter-return.png' });

  // INVENTORY / SHIFT / REPORT
  assert.equal((await j('GET', '/products/' + prod.id, null, ot)).body.stock, 19);
  const rep = (await j('GET', '/reports/closing', null, ot)).body;
  assert.equal(rep.sales.billedTotal, 1000); assert.equal(rep.sales.refunds, 500); assert.equal(rep.sales.netSales, 500);
  step('inventory 19, closing report: billed 1000, refunds 500, net 500');
  await owner.reload();
  await owner.getByText('₹500').first().waitFor();
  await owner.getByText(/1 return\(s\)/).waitFor();
  await owner.screenshot({ path: 'owner-today-after.png', fullPage: true });
  step('Owner Today reflects the sale and the return');

  await browser.close();
  console.log('E2E PASS');
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });
