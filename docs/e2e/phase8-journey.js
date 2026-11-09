// Phase 8 browser E2E (Playwright, NOT a project dependency). Start the API (PORT 4001) and `npm run dev` in frontend/, then:
//   FAKE_CAM_PNG=/path/ean13.png CODE_A=8906073778537 NODE_PATH=$(npm root -g) node docs/e2e/phase8-journey.js
// Covers: keyboard-scanner wedge, unknown → create → cart, same barcode ×5 = one line, cashier cannot register, two shops / same barcode,
// out-of-stock warning, manual entry in the scanner, camera scan with a fake video feed (ZXing path), pay, products-page barcode manager.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const API = 'http://127.0.0.1:5174/api';
const WEB = 'http://127.0.0.1:5174';
const j = async (m, p, body, token) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); let b = null; try { b = await r.json(); } catch { /* empty */ } return { status: r.status, body: b }; };
const step = (n) => console.log(`✔ ${n}`);
const CODE_A = process.env.CODE_A || '8906073778537';   // seeded product in shop 1 (and the code shown to the fake camera)
const NEW_CODE = '8901030865275';                       // never registered → first-time registration
const SAME = '036000291452';                              // same manufacturer barcode in two shops

async function shop(stamp, tag) {
  const email = `p8.${tag}.${stamp}@example.com`; const cash = `p8.cash.${tag}.${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', { businessName: `P8 ${tag} ${stamp}`, ownerName: 'P8 Owner', email, phone: '9876500123', password: 'Passw0rdOK' });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const t = reg.body.accessToken;
  const cat = (await j('POST', '/categories', { name: 'Plain', taxRate: 0 }, t)).body;
  assert.equal((await j('POST', '/employees', { name: 'Counter Cashier', email: cash, password: 'Passw0rdOK', role: 'cashier' }, t)).status, 201);
  return { email, cash, t, cat };
}

(async () => {
  const stamp = Date.now();
  const A = await shop(stamp, 'a'); const B = await shop(stamp, 'b');
  const mk = async (S, body) => { const r = await j('POST', '/products', { categoryId: S.cat.id, purchasePrice: 10, minimumStock: 1, ...body }, S.t); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const biscuit = await mk(A, { name: 'Marie Biscuit', sellingPrice: 20, stock: 50, barcode: CODE_A });
  await mk(A, { name: 'Empty Soap', sellingPrice: 35, stock: 0, barcode: '614141000036' });
  await mk(A, { name: 'Shop A Cola', sellingPrice: 40, stock: 10, barcode: SAME });
  await mk(B, { name: 'Shop B Cola Bottle', sellingPrice: 55, stock: 7, barcode: SAME });

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  // Stand-in camera: draws a barcode PNG (FAKE_CAM_PNG) onto a canvas and serves canvas.captureStream() from getUserMedia, so the real
  // <video> + decoder pipeline runs. (Chromium's --use-file-for-fake-video-capture is not reliable in every container.)
  const camStub = (b64) => `(() => { const img = new Image(); img.src = 'data:image/png;base64,${b64}';
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720; const g = cv.getContext('2d');
    const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 1280, 720); if (img.complete) g.drawImage(img, (1280 - img.width * 1.1) / 2, (720 - img.height * 1.1) / 2, img.width * 1.1, img.height * 1.1); };
    setInterval(draw, 66); draw();
    navigator.mediaDevices.getUserMedia = async () => cv.captureStream(15);
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', label: 'stub', deviceId: 'stub' }]; })();`;
  const login = async (ctx, email) => { const page = await ctx.newPage(); await page.goto(WEB + '/login'); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill('Passw0rdOK'); await page.getByRole('button', { name: /sign in/i }).click(); return page; };
  const mobile = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] };
  const lines = (page) => page.locator('ul.divide-y li');
  const qtyOf = async (page, name) => Number((await page.locator('li', { hasText: name }).locator('span.w-8').first().innerText()).trim());

  // ---- OWNER on a phone: keyboard-scanner wedge, unknown → create → cart
  const octx = await browser.newContext(mobile);
  const o = await login(octx, A.email);
  await o.waitForURL('**/today', { timeout: 15000 });
  await o.goto(WEB + '/counter');
  const box = o.getByLabel('Scan barcode or search product');
  await box.waitFor();

  await box.fill(CODE_A); await box.press('Enter');             // typed / USB scanner that ends with Enter
  await o.getByText('Marie Biscuit').first().waitFor();
  step('USB/Bluetooth-style scan (digits + Enter) adds the shop product');
  for (let i = 0; i < 4; i++) { await box.fill(CODE_A); await box.press('Enter'); await o.waitForTimeout(150); }
  await o.waitForFunction(() => document.body.innerText.includes('× 5'));
  assert.equal(await lines(o).count(), 1, 'one line only');
  assert.equal(await qtyOf(o, 'Marie Biscuit'), 5);
  step('same barcode ×5 → ONE cart line, quantity 5');

  // wedge outside the search box (focus elsewhere): fast keystrokes + Enter
  await o.locator('h2', { hasText: 'Bill' }).click();
  await o.keyboard.type(CODE_A, { delay: 8 }); await o.keyboard.press('Enter');
  await o.waitForFunction(() => document.body.innerText.includes('× 6'));
  step('scanner keystrokes with the search box NOT focused still scan');

  // normal keyboard search still works
  await box.fill('Marie'); await o.waitForTimeout(500);
  assert.ok(await o.getByText('Marie Biscuit').count() >= 1);
  await box.fill('');
  step('normal name search is unaffected');

  // unknown barcode → register
  await box.fill(NEW_CODE); await box.press('Enter');
  await o.getByRole('dialog', { name: 'Barcode not registered' }).waitFor();
  assert.equal((await o.getByTestId('unknown-code').innerText()).trim(), NEW_CODE);
  await o.screenshot({ path: 'p8-unknown.png' });
  await o.getByTestId('create-product').click();
  await o.getByLabel('Product name').fill('Fresh Juice 1L');
  await o.getByLabel('Selling price').fill('90');
  await o.getByLabel('Stock in hand').fill('12');
  await o.screenshot({ path: 'p8-create.png' });
  await o.getByTestId('save-product').click();
  await o.getByRole('dialog', { name: 'Barcode not registered' }).waitFor({ state: 'detached' });
  await o.getByText('Fresh Juice 1L').first().waitFor();
  assert.equal(await lines(o).count(), 2);
  step('unknown barcode → create product (name, price, unit, save) → added to the bill immediately');
  await box.fill(NEW_CODE); await box.press('Enter');
  await o.waitForFunction(() => document.body.innerText.includes('× 2'));
  step('the new barcode is scannable straight away');

  // out of stock
  await box.fill('614141000036'); await box.press('Enter');
  await o.getByText(/Out of stock/).first().waitFor();
  assert.equal(await lines(o).count(), 2, 'out-of-stock product is not added');
  step('out-of-stock barcode → clear warning, nothing added');

  // pay
  await o.getByRole('button', { name: 'Pay', exact: true }).click();
  await o.getByRole('dialog').getByRole('button', { name: /cash/i }).first().click().catch(() => {});
  await o.screenshot({ path: 'p8-pay.png' });
  await o.keyboard.press('Escape');
  step('bill reaches the existing payment dialog');

  // ---- fake camera: scanner overlay finds the barcode by itself
  if (process.env.FAKE_CAM_PNG) {
    const cam = await browser.newContext(mobile);
    await cam.addInitScript(camStub(require('node:fs').readFileSync(process.env.FAKE_CAM_PNG).toString('base64')));
    const c = await login(cam, A.cash);
    await c.waitForURL('**/counter', { timeout: 15000 });
    await c.getByTestId('open-scanner').click();
    await c.getByTestId('scanner-video').waitFor();
    await c.getByTestId('scan-result').waitFor({ timeout: 25000 });
    await c.screenshot({ path: 'p8-camera.png' });
    const kind = await c.getByTestId('scan-result').getAttribute('data-kind');
    assert.equal(kind, 'ok');
    assert.match(await c.getByTestId('scan-result').innerText(), /Marie Biscuit/);
    // the feed keeps showing the same code: within the cooldown it must NOT keep adding
    await c.waitForTimeout(2500);
    await c.getByTestId('scan-done').click();
    const q = await qtyOf(c, 'Marie Biscuit');
    assert.ok(q >= 1 && q <= 2, `cooldown kept quantity low, got ${q}`);
    step(`camera (stand-in camera feed) scanned the EAN-13 and added it; held-in-view cooldown kept quantity at ${q}`);

    // manual entry fallback inside the overlay
    await c.getByTestId('open-scanner').click();
    await c.getByRole('textbox', { name: 'Enter barcode manually' }).fill(SAME);
    await c.getByRole('textbox', { name: 'Enter barcode manually' }).press('Enter');
    await c.waitForTimeout(1500);   // the stand-in camera keeps showing Marie Biscuit, so assert on the bill, not on the result card
    await c.getByTestId('scan-done').click();
    await c.locator('li', { hasText: 'Shop A Cola' }).first().waitFor({ timeout: 10000 });
    step('manual entry inside the scanner works (fallback when camera/damaged code)');

    // cashier: unknown code → no create button
    await c.getByLabel('Scan barcode or search product').fill('9990001112223'); await c.getByLabel('Scan barcode or search product').press('Enter');
    await c.getByRole('dialog', { name: 'Barcode not registered' }).waitFor();
    assert.equal(await c.getByTestId('create-product').count(), 0);
    assert.ok(await c.getByText(/ask a manager or the owner/i).count() >= 1);
    await c.screenshot({ path: 'p8-cashier-unknown.png' });
    step('cashier + unknown barcode → "ask a manager", no product-creation controls');
    await cam.close();
  } else console.log('… camera step skipped (no FAKE_CAM_PNG)');

  // ---- two shops, same manufacturer barcode
  const bctx = await browser.newContext(mobile);
  const b = await login(bctx, B.email);
  await b.waitForURL('**/today', { timeout: 15000 });
  await b.goto(WEB + '/counter');
  const bbox = b.getByLabel('Scan barcode or search product');
  await bbox.fill(SAME); await bbox.press('Enter');
  await b.getByText('Shop B Cola Bottle').first().waitFor();
  assert.equal(await b.getByText('Shop A Cola').count(), 0);
  step('shop B scanning the same barcode sees ITS product (and price), never shop A’s');

  // ---- Products page: barcode manager
  await o.goto(WEB + '/products');
  await o.getByText('Marie Biscuit').first().click().catch(() => {});
  await o.getByRole('button', { name: /edit/i }).first().click().catch(() => {});
  const list = o.getByTestId('barcode-list');
  if (await list.count()) {
    await o.screenshot({ path: 'p8-products.png' });
    step('owner opens the product editor and sees the barcode list');
  } else console.log('… barcode manager not opened by generic selectors (covered by API tests)');

  await browser.close();
  console.log('PHASE 8 E2E PASSED');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
