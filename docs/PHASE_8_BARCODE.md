# Phase 8 — Manufacturer barcode scanning + mobile fast Counter

The shopkeeper never prints, buys or sticks a barcode. The code already on the packaging (EAN-13, EAN-8, UPC-A, GTIN-14, other common 1D codes) is
scanned once to link it to the shop's own product; after that every scan finds that product.

```
manufacturer barcode → scanner (camera / USB / Bluetooth / typed) → this shop's mapping → product → price/stock/unit → cart → payment → sale
```
A barcode only IDENTIFIES a product. It carries no price, tax, stock, shop, customer or sale data; those always come from the shop's product row.

## Data model (migration 015, additive)
`product_barcodes(id, business_id, product_id, barcode VARCHAR(48), barcode_type, is_primary, created_by, created_at, updated_at)`
- `barcode` is text, never a number: leading zeros are kept ("0891234567890" stays exact). Allowed: 4–48 of `A-Z a-z 0-9 . _ / + -`.
- `UNIQUE (business_id, barcode)`: one barcode → one product *inside a shop*; the same barcode may exist in many shops.
- Several barcodes per product; one optional primary (partial unique index). Composite FK `(business_id, product_id)` cascades on product delete.
- `barcode_type` (ean13/ean8/upca/gtin14/other) is derived from the GS1 check digit; informational only.
- RLS enabled + forced; `tenant_isolation` and `backup_read` policies like every tenant table.
- Equivalent widths: UPC-A (12) = EAN-13 `0`+UPC = GTIN-14 `00`+UPC. Lookup and duplicate checks match all forms; the stored value is never rewritten.
- Lookup order: barcode mapping, then exact SKU (shops that typed the code into SKU keep working).

## API
| Route | Roles | Purpose |
|---|---|---|
| `GET /api/products/scan?code=` | all | code → this shop's product (found / out-of-stock / expired flagged), plus `canRegister` |
| `POST /api/products/quick-create` | owner, manager | first-time registration: barcode + name + price + unit (+ stock, category, cost) → product + barcode, returns scan shape |
| `GET/POST /api/products/:id/barcodes` | owner, manager | list / link another barcode |
| `PUT/DELETE /api/products/:id/barcodes/:barcodeId` | owner, manager | replace value, make primary / remove |
| `POST /api/products`, `GET /api/products?q=`, `GET /api/products/pos-search` | unchanged roles | now accept/search barcodes too |
Errors: 400 `BAD_BARCODE`, 409 `BARCODE_TAKEN` (names the owning product). Audit actions: `product.created` (with barcode), `product.barcode_added`, `product.barcode_replaced`, `product.barcode_primary`, `product.barcode_removed`.

## Counter workflow
1. Tap **Scan** (or use a USB/Bluetooth scanner: digits + Enter, works even when the search box is not focused; normal name/SKU typing is unchanged).
2. Known code → product is added; "✓ Product added / name / ₹price / Qty n"; the camera keeps scanning. Same code again → quantity +1 on the same line.
3. Out of stock → "Out of stock (0 left)", nothing added (the sale engine still enforces stock; no silent negative inventory). Expired → refused.
4. Unknown code → "Barcode not registered": owner/manager choose **Create new product** (name, price, unit, stock, Save & add to bill) or **Add to existing product**; cashiers see "ask a manager or the owner" (no permission bypass).
5. Manual entry inside the scanner covers a denied/missing camera or a damaged code. Pay / split payment / Udhaar / hold / returns / shifts are the existing engine.

## Scanner library
Native `BarcodeDetector` where the browser has it (Chrome on Android: fast, good in low light); otherwise `@zxing/browser` 0.2.1 (MIT) + `@zxing/library` 0.23.0 (Apache-2.0), lazy-loaded as a separate ~120 kB gzip chunk (Counter itself stays ~13 kB gzip). Pure JS, no WASM, so no CSP relaxation; free, no service. Also works inside a future Capacitor/Android WebView (needs the CAMERA permission in the manifest).
Reliability: invalid check digits are dropped; the same code held in view counts once (re-count after ~4 s hold or after leaving the view); non-GTIN codes need two matching reads; lookups are queued so a slow network cannot reorder scans. Hosting header changed to `Permissions-Policy: camera=(self)`. Camera needs HTTPS (or localhost).

## Multi-tenant and security
Every barcode query runs inside the caller's tenant with forced RLS; another shop's mapping is invisible, so a foreign product can never be returned or linked. Management routes are owner/manager only; input is validated (regex + length) and queries are parameterised; changes are audited. No Security-phase protection was changed.

## Offline readiness (Phase 17 — NOT implemented)
All code→product resolution goes through `lookupBarcode()` in `frontend/src/services/barcode.js`; Phase 17 can answer it from a local cache. It will need locally, per shop: a product snapshot (id, name, sku, selling price, tax rate, price-includes-tax, unit/allowDecimal, stock, active/expiry flags), the barcode→product map with the equivalent-width rule, a snapshot version/timestamp for sync, a queue of offline registrations (barcode + product fields, replayed with idempotency), and a clear "stock may be stale" rule (the server still validates at sale time).

## Known limitations
- Cashiers cannot register unknown barcodes (by design). Quick-created products have cost price 0 until filled in.
- Decoding quality was tested with generated EAN-13 images and a stand-in camera stream, not on real phones/packaging; iOS Safari uses the slower ZXing path.
- The camera scanner is on the Counter; the older POS page supports keyboard/USB scanning only.
- Lookup cache is per browser tab (30 s); server re-validates price/stock at sale time.
- No label generation/printing (out of scope for Phase 8).
