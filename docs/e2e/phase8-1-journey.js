// Phase 8.1 browser E2E — Scan & Add Products (Playwright, NOT a project dependency). Start the API (PORT 4001) and `npm run dev` in frontend/, then:
//   CAM_PNG_1=/path/ean13-a.png CAM_PNG_2=/path/ean13-b.png CODE_1=8906073778537 CODE_2=8901207005039 NODE_PATH=$(npm root -g) node docs/e2e/phase8-1-journey.js
// The "camera" is a stand-in stream (canvas.captureStream) that shows a real EAN-13 image, so the real <video> + decoder path runs. Follows the
// acceptance test of the Phase 8.1 brief (Tests 1–9) plus: USB-style scan, manual entry, network failure, cashier blocked, 25-product session.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const API = 'http://127.0.0.1:5174/api';
const WEB = 'http://127.0.0.1:5174';
const CODE_1 = process.env.CODE_1 || '8906073778537';
const CODE_2 = process.env.CODE_2 || '8901207005039';
const j = async (m, p, body, token) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); let b = null; try { b = await r.json(); } catch { /* empty */ } return { status: r.status, body: b }; };
const step = (n) => console.log(`✔ ${n}`);
const ean13 = (i) => { const d = `89${String(i).padStart(10, '0')}`; let s = 0; for (let k = 11, w = 3; k >= 0; k -= 1, w = w === 3 ? 1 : 3) s += Number(d[k]) * w; return d + ((10 - (s % 10)) % 10); };

// A hardware scanner hands the OS the whole burst within a few ms. Playwright's keyboard.type sends keys one round-trip at a time, which is
// slower than a real scanner whenever the page is busy decoding the camera, so the burst is dispatched inside the page in ONE task instead.
const usbScan = (page, code) => page.evaluate((c) => { for (const ch of c) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, code);

// stand-in camera: window.__setCam(0|1|-1) chooses which barcode image is in front of the lens (-1 = nothing); window.__gum counts camera starts
const camStub = (b64a, b64b) => `(() => { window.__gum = 0; window.__cam = 0;
  const mk = (b) => { const i = new Image(); i.src = 'data:image/png;base64,' + b; return i; }; const imgs = [mk('${b64a}'), mk('${b64b}')];
  const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720; const g = cv.getContext('2d');
  const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 1280, 720); const i = imgs[window.__cam]; if (i && i.complete) g.drawImage(i, (1280 - i.width * 1.1) / 2, (720 - i.height * 1.1) / 2, i.width * 1.1, i.height * 1.1); };
  setInterval(draw, 66); draw(); window.__setCam = (n) => { window.__cam = n; };
  navigator.mediaDevices.getUserMedia = async () => { window.__gum += 1; return cv.captureStream(15); };
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', label: 'stub', deviceId: 'stub' }]; })();`;

(async () => {
  const stamp = Date.now();
  const email = `p81.owner.${stamp}@example.com`; const cashEmail = `p81.cash.${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', { businessName: `P81 Mart ${stamp}`, ownerName: 'P81 Owner', email, phone: '9876500123', password: 'Passw0rdOK' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ot = reg.body.accessToken;
  await j('POST', '/categories', { name: 'Snacks', taxRate: 0 }, ot);
  assert.equal((await j('POST', '/employees', { name: 'Counter Cashier', email: cashEmail, password: 'Passw0rdOK', role: 'cashier' }, ot)).status, 201);

  const browser = await chromium.launch();
  const mobile = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] };
  const login = async (ctx, em) => { const page = await ctx.newPage(); await page.goto(WEB + '/login'); await page.getByLabel('Email').fill(em); await page.getByLabel('Password').fill('Passw0rdOK'); await page.getByRole('button', { name: /sign in/i }).click(); return page; };

  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(camStub(fs.readFileSync(process.env.CAM_PNG_1).toString('base64'), fs.readFileSync(process.env.CAM_PNG_2).toString('base64')));
  const o = await login(ctx, email);
  await o.waitForURL('**/today', { timeout: 15000 });

  // TEST 1 — Products → Scan & Add Products
  await o.goto(WEB + '/products');
  await o.getByRole('button', { name: /Add product/ }).waitFor();           // the normal button is still there
  await o.getByTestId('scan-add-link').click();
  await o.waitForURL('**/products/scan-add');
  await o.getByRole('heading', { name: 'Scan & Add Products' }).waitFor();
  assert.ok(await o.getByText("Scan the barcode printed on the product. We’ll fill the barcode automatically.").count());
  step('Products page has "Scan & Add Products" next to "+ Add product"; it opens the dedicated screen');

  const fill = async (page, name, sell, buy, stock) => {
    await page.getByLabel('Product name').or(page.locator('input[name="name"]')).first().fill(name);
    await page.locator('input[name="sellingPrice"]').fill(String(sell));
    await page.locator('input[name="purchasePrice"]').fill(String(buy));
    await page.locator('input[name="stock"]').fill(String(stock));
  };

  // TEST 2 — a real barcode is captured by the camera and appears in the form without typing
  await o.getByTestId('scanned-code').waitFor({ timeout: 30000 });
  const gum0 = await o.evaluate(() => window.__gum);   // 1 in production; 2 under React StrictMode's dev-only double mount
  assert.ok(gum0 >= 1 && gum0 <= 2, `camera started ${gum0} times`);
  assert.equal((await o.getByTestId('scanned-code').innerText()).trim(), CODE_1);
  await o.screenshot({ path: 'p81-form.png' });
  step(`camera scan → form opens with barcode ${CODE_1} already filled (locked, nothing typed)`);
  assert.equal(await o.locator('input[value="' + CODE_1 + '"]').count(), 0, 'barcode is not an editable input');

  // TEST 3 — quick mode fields, Save & Scan Next
  await o.locator('input[name="name"]').fill('Maggi 70g');
  await o.getByTestId('save-scan-next').click();                         // empty fields → highlighted, nothing saved
  await o.getByText('Enter the selling price.').waitFor();
  assert.equal(await o.getByTestId('session-count').innerText(), '0');
  assert.equal(await o.locator('input[name="name"]').inputValue(), 'Maggi 70g', 'entered fields are kept on a validation failure');
  step('validation failure: invalid fields highlighted, entered data kept, counter NOT incremented');
  await fill(o, 'Maggi 70g', 14, 11, 42);
  await o.locator('select[name="unit"]').selectOption('pcs');
  // network failure must not show success and must not lose the form
  let blocked = true;
  await o.route('**/api/products', (route) => (route.request().method() === 'POST' && blocked ? route.abort('connectionreset') : route.continue()));
  await o.getByTestId('save-scan-next').click();
  await o.getByTestId('save-error').waitFor();
  assert.equal((await o.getByTestId('save-error').innerText()).trim(), 'Could not save product. Please check your connection and try again.');
  assert.equal(await o.getByTestId('session-count').innerText(), '0');
  assert.equal(await o.locator('input[name="name"]').inputValue(), 'Maggi 70g');
  step('network failure: honest error message, form and barcode kept, counter NOT incremented');
  blocked = false;
  await o.getByTestId('save-scan-next').click();
  await o.getByTestId('scanned-code').waitFor({ state: 'detached' });
  await o.getByText('✓ Product added').first().waitFor();
  assert.equal(await o.getByTestId('session-count').innerText(), '1');
  assert.equal((await o.getByTestId('last-name').innerText()).trim(), 'Maggi 70g');
  step('Save & Scan Next: product created, counter 1, last-added shown, success status (no big modal)');

  // TEST 5 — scanner is immediately ready; the camera was NOT restarted
  await o.getByTestId('scan-frame').waitFor();
  assert.equal(await o.evaluate(() => window.__gum), gum0, 'the camera was not restarted by saving a product');
  assert.ok(await o.evaluate(() => { const v = document.querySelector('[data-testid=scanner-video]'); return !!v && v.srcObject && v.srcObject.active; }));
  step('scanner is ready again immediately; saving did not restart the camera');

  // TEST 6 — the same barcode again → Barcode already registered, no duplicate
  await o.evaluate(() => window.__setCam(-1)); await o.waitForTimeout(1500); await o.evaluate(() => window.__setCam(0));
  await o.getByTestId('existing-panel').waitFor({ timeout: 20000 });
  assert.equal((await o.getByTestId('existing-name').innerText()).trim(), 'Maggi 70g');
  await o.screenshot({ path: 'p81-existing.png' });
  assert.equal(await o.getByTestId('session-count').innerText(), '1');
  assert.equal(await o.getByTestId('save-scan-next').count(), 0, 'no create form for a known barcode');
  step('same barcode scanned again → "Barcode already registered" panel with the product, no duplicate form');
  await o.getByTestId('add-stock-qty').fill('8'); await o.getByTestId('add-stock-btn').click();
  await o.getByTestId('existing-stock').filter({ hasText: '50' }).waitFor();
  step('Add Stock through the safe inventory route: 42 → 50');
  await o.getByTestId('edit-existing').click();
  await o.getByRole('dialog', { name: /Edit product/i }).or(o.getByText('Edit product')).first().waitFor();
  await o.keyboard.press('Escape'); await o.getByRole('button', { name: 'Cancel' }).first().click().catch(() => {});
  step('Edit Product opens the normal product editor');
  if (await o.getByTestId('existing-done').count()) await o.getByTestId('existing-done').click();

  // TEST 7 — a second unknown barcode
  await o.evaluate(() => window.__setCam(-1)); await o.waitForTimeout(1200); await o.evaluate(() => window.__setCam(1));
  await o.getByTestId('scanned-code').waitFor({ timeout: 25000 });
  assert.equal((await o.getByTestId('scanned-code').innerText()).trim(), CODE_2);
  await fill(o, 'Surf Excel 500g', 82, 70, 12);
  await o.getByTestId('save-scan-next').click();
  await o.waitForFunction(() => document.querySelector('[data-testid=session-count]').innerText === '2');
  await o.evaluate(() => window.__setCam(-1));
  step('second unknown barcode → second product created, counter 2');

  // USB / Bluetooth scanner: fast keystrokes + Enter with focus outside any input; and manual entry
  const usb = ean13(7001);
  await o.locator('h1').click();
  await o.keyboard.type(usb, { delay: 8 }); await o.keyboard.press('Enter');   // real key presses (the page is idle here)
  await o.getByTestId('scanned-code').waitFor();
  assert.equal((await o.getByTestId('scanned-code').innerText()).trim(), usb);
  await fill(o, 'USB scanned item', 20, 15, 5); await o.getByTestId('save-scan-next').click();
  await o.waitForFunction(() => document.querySelector('[data-testid=session-count]').innerText === '3');
  const manual = ean13(7002);
  await o.getByRole('textbox', { name: 'Enter barcode manually' }).fill(manual); await o.getByRole('textbox', { name: 'Enter barcode manually' }).press('Enter');
  await o.getByTestId('scanned-code').waitFor();
  assert.equal((await o.getByTestId('scanned-code').innerText()).trim(), manual);
  await o.getByRole('button', { name: 'Cancel and scan again' }).click();
  assert.equal(await o.getByTestId('session-count').innerText(), '3', 'cancel creates nothing');
  step('USB/Bluetooth-style scan and manual entry both open the form with the barcode; cancel creates nothing');

  // a longer session stays responsive: 25 more products without leaving the page
  const t0 = Date.now(); const first = 8000;
  for (let n = 0; n < 25; n += 1) {
    const code = ean13(first + n);
    await usbScan(o, code);
    await o.getByTestId('scanned-code').waitFor({ timeout: 8000 }).catch(async (e) => { await o.screenshot({ path: 'p81-bulk-fail.png' }); console.log('bulk', n, 'active:', await o.evaluate(() => document.activeElement && `${document.activeElement.tagName}:${document.activeElement.getAttribute('aria-label') || document.activeElement.name}`), 'result:', await o.getByTestId('scan-result').allInnerTexts()); throw e; });
    await fill(o, `Bulk item ${n}`, 10 + n, 7 + n, 3);
    await o.getByTestId('save-scan-next').click();
    await o.waitForFunction((c) => document.querySelector('[data-testid=session-count]').innerText === String(c), 4 + n);
  }
  const per = Math.round((Date.now() - t0) / 25);
  assert.equal(await o.getByTestId('session-count').innerText(), '28');
  assert.equal(await o.evaluate(() => window.__gum), gum0, 'no camera restart after 28 products');
  step(`28 products in one session without leaving the page (≈${per} ms per product in this test); camera never restarted`);
  await o.screenshot({ path: 'p81-session.png' });

  // TEST 4 / 8 — Finish → Products shows everything
  await o.getByTestId('scan-done').click();
  await o.waitForURL('**/products');
  await o.getByLabel('Search products').fill('Maggi'); await o.locator('p:visible', { hasText: 'Maggi 70g' }).first().waitFor();   // the table renders a desktop and a phone layout; wait for the visible one
  assert.ok(await o.getByText(`Barcode: ${CODE_1}`).count() || await o.getByText(CODE_1).count(), 'Maggi shows its barcode');
  await o.getByLabel('Search products').fill('Surf Excel'); await o.locator('p:visible', { hasText: 'Surf Excel 500g' }).first().waitFor();
  assert.ok(await o.getByText(CODE_2).count());
  const list = (await j('GET', '/products?limit=200&q=', null, ot)).body;
  const bulk = list.rows.filter((p) => /^Bulk item/.test(p.name));
  assert.equal(bulk.length, 25); assert.ok(bulk.every((p) => p.barcodes.length === 1));
  const maggi = list.rows.find((p) => p.name === 'Maggi 70g');
  assert.equal(maggi.stock, 50); assert.equal(list.rows.filter((p) => p.barcodes.some((b) => b.barcode === CODE_1)).length, 1, 'no duplicate for the re-scan');
  step('Products lists both scanned products with their barcodes; no duplicates; stock correct');

  // TEST 9 — Counter Mode (cashier) scans them exactly as before
  const cctx = await browser.newContext(mobile);
  const c = await login(cctx, cashEmail);
  await c.waitForURL('**/counter', { timeout: 15000 });
  const box = c.getByLabel('Scan barcode or search product');
  await box.fill(CODE_1); await box.press('Enter');
  await c.getByText('Maggi 70g').first().waitFor();
  await box.fill(CODE_2); await box.press('Enter');
  await c.getByText('Surf Excel 500g').first().waitFor();
  step('Counter Mode scans both new products (cashier) exactly as before');
  await c.goto(WEB + '/products/scan-add'); await c.waitForURL('**/counter');
  assert.equal(await c.getByTestId('scan-add-link').count(), 0);
  const cl = await j('POST', '/auth/login', { email: cashEmail, password: 'Passw0rdOK' });
  assert.equal((await j('POST', '/products', { barcode: ean13(9999), name: 'x', categoryId: 1, purchasePrice: 1, sellingPrice: 1, stock: 1 }, cl.body.accessToken)).status, 403);
  step('cashier cannot open Scan & Add (route guard) and the API refuses product creation (403)');

  await browser.close();
  console.log('PHASE 8.1 E2E PASSED');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
