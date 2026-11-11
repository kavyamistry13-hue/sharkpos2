// Phase 9 — CSV import (validate → preview → confirm, atomic), CSV export (allowlisted, tenant-isolated, role-checked), search and filters.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, uniq } = require('./helpers');
const { makeShop, addProduct, addCustomer, sell, daysAgoIso } = require('./sprint-helpers');
const csv = require('../src/utils/csv');

let env; let api; let A; let B;
before(async () => { env = await boot(); api = client(env.base); A = await makeShop(api); B = await makeShop(api); });
after(async () => { await env.close(); });

const as = (s, who = 'owner') => api(s[who].token);
const sql = (s, text, params) => env.db.runAsTenant(s.businessId, async () => (await env.db.query(text, params)).rows);
const raw = (s, who, method, path, body, type = 'text/csv') => fetch(env.base + path, { method, headers: { authorization: `Bearer ${s[who].token}`, ...(body !== undefined ? { 'content-type': type } : {}) }, body });
const post = async (s, who, path, text) => { const r = await raw(s, who, 'POST', path, text); return { status: r.status, body: await r.json().catch(() => null) }; };
const HEAD = 'name,sku,barcode,category,unit,cost_price,selling_price,tax_rate,min_stock,max_stock';
const cat = (s) => s.category.name;
const productCount = async (s) => (await sql(s, 'SELECT COUNT(*)::int AS n FROM products'))[0].n;
const j = (r) => JSON.stringify(r.body ?? {});

describe('csv parser', () => {
  test('handles BOM, CRLF, quotes, commas, line breaks in quotes and blank lines; rejects malformed and empty input', () => {
    const p = csv.parse('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n"multi\nline",z\r\n');
    assert.deepEqual(p.header, ['a', 'b']); assert.deepEqual(p.rows, [['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
    assert.throws(() => csv.parse('a,b\n"open,1'), /never closed/);
    assert.throws(() => csv.parse('a,b\nx"y,1'), /quote/);
    assert.throws(() => csv.parse(''), /empty/); assert.throws(() => csv.parse('\n\n'), /empty/);
    assert.throws(() => csv.parse({}), /text/);
  });
  test('export writer quotes, and neutralises formula injection in text cells only', () => {
    const out = csv.toCsv([{ n: '=HYPERLINK("x")', q: -5, t: '@cmd', c: 'a,b' }], [{ key: 'n', header: 'n', text: true }, { key: 'q', header: 'q' }, { key: 't', header: 't', text: true }, { key: 'c', header: 'c', text: true }]);
    assert.ok(out.includes(`"'=HYPERLINK(""x"")"`)); assert.ok(out.includes(',-5,')); assert.ok(out.includes("'@cmd")); assert.ok(out.includes('"a,b"'));
  });
});

describe('product import', () => {
  test('valid file: preview shows no errors and writes nothing; confirm imports every row through the normal product rules', async () => {
    const before = await productCount(A);
    const text = `${HEAD}\r\nImport Rice 1kg,IMP-R1,0890123456789,${cat(A)},pcs,40,55,,10,100\r\nImport Dal,IMP-D1,,${cat(A)},kg,80,99.50,,5,20\r\n`;
    const pv = await post(A, 'manager', '/products/import/preview', text);
    assert.equal(pv.status, 200, j(pv)); assert.equal(pv.body.ok, true); assert.equal(pv.body.summary.valid, 2); assert.equal(await productCount(A), before, 'preview never writes');
    const r = await post(A, 'owner', '/products/import', text);
    assert.equal(r.status, 201, j(r)); assert.equal(r.body.imported, 2);
    assert.equal(await productCount(A), before + 2);
    const list = (await as(A).get('/products?q=Import')).body.rows;
    const rice = list.find((p) => p.sku === 'IMP-R1');
    assert.equal(rice.sellingPrice, 55); assert.equal(rice.maxStock, 100); assert.equal(rice.minimumStock, 10);
    assert.equal(rice.barcodes[0].barcode, '0890123456789', 'leading zero preserved');
    assert.equal((await as(A, 'cashier').get('/products/scan?code=0890123456789')).body.found, true, 'immediately scannable');
    assert.ok((await sql(A, `SELECT 1 FROM audit_logs WHERE action = 'product.imported'`)).length >= 1);
  });

  test('invalid rows: every problem is reported with its line, and NOTHING is imported (atomic)', async () => {
    const before = await productCount(A);
    const text = [HEAD,
      `Good Item,G1,,${cat(A)},pcs,10,15,,1,10`,
      `,G2,,${cat(A)},pcs,10,15,,1,10`,                                   // line 3 no name
      `Bad Unit,G3,,${cat(A)},crate,10,15,,1,10`,                         // 4 unit
      `Bad Price,G4,,${cat(A)},pcs,10,abc,,1,10`,                         // 5 price
      `Neg,G5,,${cat(A)},pcs,10,-5,,1,10`,                                // 6 negative
      `No Cat,G6,,Nonexistent Cat,pcs,10,15,,1,10`,                       // 7 category
      `Tax,G7,,${cat(A)},pcs,10,15,${Number(A.category.taxRate) === 7 ? 9 : 7},1,10`,   // 8 tax mismatch
      `Max,G8,,${cat(A)},pcs,10,15,,10,5`,                                // 9 max < min
      `Frac,G9,,${cat(A)},pcs,10,15,,1.5,10`,                             // 10 fractional pcs
      `Price3dp,G10,,${cat(A)},pcs,10,15.123,,1,10`,                      // 11 decimals
      `Sci,G11,8.90123E+12,${cat(A)},pcs,10,15,,1,10`,                    // 12 excel-mangled barcode
      `BadCode,G12,@@,${cat(A)},pcs,10,15,,1,10`,                         // 13 invalid barcode
    ].join('\n');
    const pv = await post(A, 'owner', '/products/import/preview', text);
    assert.equal(pv.body.ok, false); assert.equal(pv.body.summary.total, 12); assert.equal(pv.body.summary.valid, 1);
    const lines = pv.body.errors.map((e) => e.line); assert.deepEqual(lines, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const msg = (l) => pv.body.errors.find((e) => e.line === l).errors.join(' ');
    assert.match(msg(3), /Name is required/); assert.match(msg(4), /Unit "crate"/); assert.match(msg(5), /plain number/); assert.match(msg(6), /plain number/);
    assert.match(msg(7), /does not exist/); assert.match(msg(8), /does not match category/); assert.match(msg(9), /Maximum stock/); assert.match(msg(10), /whole number/); assert.match(msg(11), /decimal places/); assert.match(msg(12), /Excel/); assert.match(msg(13), /not valid/);
    const r = await post(A, 'owner', '/products/import', text);
    assert.equal(r.status, 422); assert.equal(r.body.details.code, 'IMPORT_INVALID'); assert.equal(r.body.details.errors.length, 11);
    assert.equal(await productCount(A), before, 'the one good row was NOT imported either');
    assert.equal((await sql(A, `SELECT 1 FROM products WHERE sku = 'G1'`)).length, 0);
  });

  test('duplicate SKU and duplicate barcode: against the shop and inside the file (any equivalent barcode width)', async () => {
    const existing = await addProduct(api, A, { sku: 'EXIST-1' });
    await as(A).post(`/products/${existing.id}/barcodes`, { barcode: '8901207005039' });
    await as(A).post(`/products/${(await addProduct(api, A)).id}/barcodes`, { barcode: '0036000291452' });
    const before = await productCount(A);
    const text = [HEAD,
      `Dup Sku,exist-1,,${cat(A)},pcs,1,2,,0,`,                           // 2: sku exists (case-insensitive)
      `Dup Code,D2,8901207005039,${cat(A)},pcs,1,2,,0,`,                  // 3: barcode exists
      `Dup UPC form,D3,036000291452,${cat(A)},pcs,1,2,,0,`,              // 4: UPC-A width of an EAN-13 already in the shop → taken (equivalent)
      `First,F1,5012345678900,${cat(A)},pcs,1,2,,0,`,                     // 5: ok
      `Again sku,f1,,${cat(A)},pcs,1,2,,0,`,                              // 6: repeated in file
      `Again code,F2,5012345678900,${cat(A)},pcs,1,2,,0,`,                // 7: repeated in file
    ].join('\n');
    const pv = (await post(A, 'owner', '/products/import/preview', text)).body;
    const msg = (l) => (pv.errors.find((e) => e.line === l) || { errors: [] }).errors.join(' ');
    assert.match(msg(2), /already exists/); assert.match(msg(3), /already belongs to/); assert.match(msg(4), /already belongs to/);
    assert.equal(msg(5), ''); assert.match(msg(6), /repeated in this file \(first on line 5\)/); assert.match(msg(7), /repeated in this file/);
    assert.equal((await post(A, 'owner', '/products/import', text)).status, 422);
    assert.equal(await productCount(A), before);
  });

  test('a barcode that exists only in ANOTHER shop is fine (barcodes are per shop)', async () => {
    const bp = await addProduct(api, B); await as(B).post(`/products/${bp.id}/barcodes`, { barcode: '4006381333931' });
    const r = await post(A, 'owner', '/products/import', `${HEAD}\nCross,X-1,4006381333931,${cat(A)},pcs,1,2,,0,\n`);
    assert.equal(r.status, 201, j(r));
  });

  test('file-level errors: malformed, empty, header only, unknown / missing / repeated columns, wrong content type', async () => {
    const e = async (t) => post(A, 'owner', '/products/import/preview', t);
    assert.equal((await e('')).status, 400); assert.equal((await e('   \n')).status, 400);
    assert.equal((await e(`${HEAD}\n"unterminated,1`)).status, 400);
    assert.match((await e(HEAD)).body.fileErrors.join(' '), /no product rows/);
    assert.match((await e(`name,category\nx,${cat(A)}`)).body.fileErrors.join(' '), /Missing required column: selling_price/);
    assert.match((await e(`name,category,selling_price,colour\nx,${cat(A)},1,red`)).body.fileErrors.join(' '), /Unknown column: colour/);
    assert.match((await e(`name,name,category,selling_price\nx,x,${cat(A)},1`)).body.fileErrors.join(' '), /more than once/);
    const json = await raw(A, 'owner', 'POST', '/products/import/preview', JSON.stringify({ a: 1 }), 'application/json');
    assert.equal(json.status, 400);
  });

  test('large file: 3,000 rows validate and import in one transaction, and a too-large file is refused', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `Bulk ${i},BULK-${i},,${cat(A)},pcs,5,9,,2,20`);
    const text = `${HEAD}\n${rows.join('\n')}\n`;
    const t0 = Date.now();
    const r = await post(A, 'owner', '/products/import', text);
    assert.equal(r.status, 201, j(r).slice(0, 300)); assert.equal(r.body.imported, 3000);
    assert.ok(Date.now() - t0 < 60000, `import took ${Date.now() - t0}ms`);
    assert.equal((await sql(A, `SELECT COUNT(*)::int AS n FROM products WHERE sku LIKE 'BULK-%'`))[0].n, 3000);
    const huge = await post(A, 'owner', '/products/import/preview', `${HEAD}\n${'x'.repeat(6 * 1024 * 1024)}`);
    assert.ok([400, 413].includes(huge.status), String(huge.status));
    const many = await post(A, 'owner', '/products/import/preview', `${HEAD}\n${'a,b\n'.repeat(5001)}`);
    assert.equal(many.status, 400); assert.match(many.body.error || '', /more than 5000 rows/);
  });

  test('RBAC + tenant: cashier gets 403 on template, preview and import; no token is 401; rows land only in the importing shop', async () => {
    const text = `${HEAD}\nOnly A,ONLYA,,${cat(A)},pcs,1,2,,0,\n`;
    for (const path of ['/products/import/preview', '/products/import']) { assert.equal((await post(A, 'cashier', path, text)).status, 403); }
    assert.equal((await raw(A, 'cashier', 'GET', '/products/import/template')).status, 403);
    assert.equal((await fetch(`${env.base}/api/products/import/preview`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text })).status, 401);
    assert.equal((await post(A, 'manager', '/products/import', text)).status, 201);
    assert.equal((await sql(B, `SELECT 1 FROM products WHERE sku = 'ONLYA'`)).length, 0);
    const tpl = await raw(A, 'manager', 'GET', '/products/import/template'); assert.equal(tpl.status, 200);
    assert.equal((await post(A, 'owner', '/products/import/preview', (await tpl.text()).replace('﻿', ''))).status, 200, 'the template is itself a valid-shaped file');
  });

  test('plan limit: an import that would exceed the plan imports nothing', async () => {
    const C = await makeShop(api);
    const cap = (await as(C).get('/billing')).body;
    const limit = cap && cap.subscription && cap.subscription.features ? cap.subscription.features.maxProducts : null;
    if (!limit) return;                                           // plan without a product cap
    const rows = Array.from({ length: limit + 5 }, (_, i) => `Lim ${i},LIM-${i},,${C.category.name},pcs,1,2,,0,`);
    const r = await post(C, 'owner', '/products/import', `${HEAD}\n${rows.join('\n')}\n`);
    assert.equal(r.status, 403); assert.equal(r.body.details.code, 'PLAN_LIMIT'); assert.equal(await productCount(C), 0);
  });
});

describe('csv export', () => {
  test('products + inventory export: correct values, allowlisted columns, no internal ids/secrets, formula-safe', async () => {
    const p = await addProduct(api, A, { name: '=SUM(1+1) Risky', sku: 'EXP-1', stock: 7, minimumStock: 2, maxStock: 30, reorderLevel: 4, purchasePrice: 12, sellingPrice: 20 });
    await as(A).post(`/products/${p.id}/barcodes`, { barcode: '0891111222333' });
    const res = await raw(A, 'manager', 'GET', '/exports/products');
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/); assert.match(res.headers.get('content-disposition'), /attachment; filename="sharkpos-products-/);
    const { header, rows } = csv.parse(await res.text());
    assert.deepEqual(header, ['sku', 'name', 'barcode', 'category', 'unit', 'cost_price', 'selling_price', 'tax_rate', 'stock', 'min_stock', 'reorder_level', 'max_stock', 'supplier', 'track_batches', 'expiry_date', 'active']);
    const row = Object.fromEntries(header.map((h, i) => [h, rows.find((r) => r[0] === 'EXP-1')[i]]));
    assert.equal(row.name, "'=SUM(1+1) Risky"); assert.equal(row.barcode, '0891111222333'); assert.equal(Number(row.stock), 7); assert.equal(Number(row.max_stock), 30); assert.equal(Number(row.selling_price), 20); assert.equal(row.active, 'true');
    const inv = csv.parse(await (await raw(A, 'owner', 'GET', '/exports/inventory')).text());
    const ir = Object.fromEntries(inv.header.map((h, i) => [h, inv.rows.find((r) => r[0] === 'EXP-1')[i]]));
    assert.equal(Number(ir.cost_value), 84); assert.equal(Number(ir.selling_value), 140); assert.equal(ir.needs_reorder, 'false');
    assert.ok(!(await (await raw(A, 'owner', 'GET', '/exports/products')).text()).match(/password|hash|token|secret/i));
  });

  test('sales, purchases, suppliers, customers (Udhaar) export; sales and customers are owner-only', async () => {
    const c = await addCustomer(api, A, { name: 'Export Cust' }); const p = await addProduct(api, A, { stock: 5, sellingPrice: 100 });
    await as(A).post('/credit/sales', {}).catch(() => {});       // (credit sale endpoint shape varies; the plain sale below is enough for the export)
    assert.equal((await sell(api, A, p.id, { quantity: 1, customerId: c.id })).status, 201);
    const sales = csv.parse(await (await raw(A, 'owner', 'GET', '/exports/sales')).text());
    assert.deepEqual(sales.header, ['invoice_no', 'date', 'status', 'payment_method', 'customer', 'cashier', 'subtotal', 'discount', 'tax', 'total', 'refund_amount']);
    assert.ok(sales.rows.some((r) => r[4] === 'Export Cust'));
    const cust = csv.parse(await (await raw(A, 'owner', 'GET', '/exports/customers')).text());
    assert.deepEqual(cust.header, ['name', 'phone', 'email', 'credit_limit', 'udhaar_balance']); assert.ok(cust.rows.some((r) => r[0] === 'Export Cust'));
    for (const k of ['purchases', 'suppliers']) assert.equal((await raw(A, 'manager', 'GET', `/exports/${k}`)).status, 200, k);
    for (const k of ['sales', 'customers']) assert.equal((await raw(A, 'manager', 'GET', `/exports/${k}`)).status, 403, k);
    for (const k of ['products', 'inventory', 'sales', 'purchases', 'suppliers', 'customers']) assert.equal((await raw(A, 'cashier', 'GET', `/exports/${k}`)).status, 403, `cashier ${k}`);
    assert.equal((await raw(A, 'owner', 'GET', '/exports/users')).status, 400, 'no export of accounts/users exists');
    assert.equal((await fetch(`${env.base}/api/exports/products`)).status, 401);
    assert.ok((await sql(A, `SELECT 1 FROM audit_logs WHERE action = 'export.downloaded'`)).length >= 3);
  });

  test('tenant isolation: shop B\'s export contains none of shop A\'s data', async () => {
    const mine = await addProduct(api, B, { name: 'B-only widget', sku: 'B-ONLY-1' });
    const a = await (await raw(A, 'owner', 'GET', '/exports/products')).text();
    const b = await (await raw(B, 'owner', 'GET', '/exports/products')).text();
    assert.ok(b.includes('B-ONLY-1')); assert.ok(!a.includes('B-ONLY-1')); assert.ok(!b.includes('EXP-1') && !b.includes('IMP-R1'));
    for (const k of ['sales', 'customers', 'suppliers', 'purchases', 'inventory']) assert.ok(!(await (await raw(B, 'owner', 'GET', `/exports/${k}`)).text()).includes('Export Cust'), k);
    assert.ok(mine.id);
  });
});

describe('search and filters', () => {
  let F; let sup; let c2;
  before(async () => {
    F = await makeShop(api);
    sup = (await as(F).post('/suppliers', { name: uniq('FSupp '), leadTimeDays: 3, paymentTermsDays: 15, minOrderValue: 0 })).body;
    c2 = (await as(F).post('/categories', { name: 'Filter Cat', taxRate: 5 })).body;
  });
  const names = async (qs) => (await as(F).get(`/products?limit=200&${qs}`)).body.rows.map((r) => r.name).sort();
  test('search by name, SKU and barcode (partial and exact, leading zeros)', async () => {
    const p = await addProduct(api, F, { name: 'Zeta Detergent', sku: 'ZD-900' }); await as(F).post(`/products/${p.id}/barcodes`, { barcode: '0891234500012' });
    await addProduct(api, F, { name: 'Other thing', sku: 'OT-1' });
    assert.deepEqual(await names('q=detergent'), ['Zeta Detergent']); assert.deepEqual(await names('q=zd-9'), ['Zeta Detergent']);
    assert.deepEqual(await names('q=0891234500012'), ['Zeta Detergent']); assert.deepEqual(await names('q=34500'), ['Zeta Detergent']);
    assert.deepEqual(await names('q=nomatchxyz'), []);
  });
  test('every filter: category, supplier, status, reorder, batch / non-batch, expiry 7/30/90/expired, active / inactive', async () => {
    const mk = (over) => addProduct(api, F, over);
    const cat = await mk({ name: 'F-cat', categoryId: c2.id }); const sp = await mk({ name: 'F-sup', supplierId: sup.id });
    const low = await mk({ name: 'F-low', stock: 1, minimumStock: 5 }); const out = await mk({ name: 'F-out', stock: 0, minimumStock: 0 });
    const bt = await mk({ name: 'F-batch', stock: 0 });
    await as(F).post(`/inventory/${bt.id}/batches`, { quantity: 5, batchNo: 'N1', expiryDate: daysAgoIso(-5) });
    await as(F).post(`/inventory/${bt.id}/batches`, { quantity: 5, batchNo: 'N2', expiryDate: daysAgoIso(-60) });
    const legacy = await mk({ name: 'F-legacy', stock: 3, expiryDate: daysAgoIso(2) });
    const gone = await mk({ name: 'F-gone' }); assert.equal((await as(F).del(`/products/${gone.id}`)).status, 200);
    assert.ok((await names(`categoryId=${c2.id}`)).includes('F-cat') && !(await names(`categoryId=${c2.id}`)).includes('F-sup'));
    assert.deepEqual(await names(`supplierId=${sup.id}`), ['F-sup']);
    assert.ok((await names('status=low_stock')).includes('F-low')); assert.ok((await names('status=out_of_stock')).includes('F-out'));
    assert.ok((await names('reorder=true')).includes('F-low') && !(await names('reorder=true')).includes('F-cat'));
    assert.deepEqual((await names('batch=yes')), ['F-batch']); assert.ok((await names('batch=no')).includes('F-cat') && !(await names('batch=no')).includes('F-batch'));
    assert.ok((await names('expiry=7')).includes('F-batch') && !(await names('expiry=7')).includes('F-legacy'));
    assert.ok((await names('expiry=90')).includes('F-batch')); assert.ok((await names('expiry=expired')).includes('F-legacy'));
    assert.deepEqual(await names('active=inactive'), ['F-gone']); assert.ok(!(await names('active=active')).includes('F-gone'));
    const inv = async (qs) => (await as(F).get(`/inventory?${qs}`)).body.rows.map((r) => r.name).sort();
    assert.ok((await inv('filter=reorder')).includes('F-low')); assert.deepEqual(await inv('filter=batch'), ['F-batch']); assert.ok((await inv('filter=nobatch')).includes('F-cat'));
    assert.deepEqual(await inv('filter=expiring7'), ['F-batch']); assert.ok((await inv('filter=expired')).includes('F-legacy'));
    assert.deepEqual(await inv(`filter=nobatch&supplierId=${sup.id}`), ['F-sup']); assert.ok((await inv(`categoryId=${c2.id}`)).includes('F-cat'));
    assert.equal((await as(F).get('/inventory?filter=bogus')).status, 400);
    assert.equal((await as(F, 'cashier').get('/products?active=inactive')).status, 403);
  });
  test('cross-tenant: filters and search never return another shop\'s products (including archived ones)', async () => {
    assert.deepEqual((await as(B).get('/products?q=F-&limit=200')).body.rows.filter((r) => r.name.startsWith('F-')), []);
    assert.deepEqual((await as(B).get('/products?active=inactive&limit=200')).body.rows.filter((r) => r.name === 'F-gone'), []);
    assert.equal((await as(B).get(`/products?supplierId=${sup.id}`)).body.total, 0);
  });
});
