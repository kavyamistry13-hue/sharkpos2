# Phase 8.1 — Scan & Add Products (continuous manufacturer-barcode registration)

For owners/managers who must register hundreds of products: **scan the barcode already printed on the pack → the form opens with the barcode filled in → Save & Scan Next → scan the next one.** Nobody types a barcode, prints a label or generates a code.

## Where it is
Products page → **Scan & Add Products** (next to **+ Add product**, which is unchanged) → `/products/scan-add`. Owner and manager only: the route is guarded in the app and every API call is authorised server-side (a cashier gets 403 / is redirected to the Counter).

## Flow
1. The screen shows the instruction, **Added this session: N**, **Last added**, the camera, and **Finish**.
2. A code arrives from the camera, a USB/Bluetooth scanner (fast keys + Enter, even when no field is focused) or the manual box.
3. **Unknown in this shop** → a bottom sheet opens with the barcode shown read-only ("scanned, locked"; wrong code → Cancel and scan again). Quick mode: name, category, unit, selling price, purchase price, current stock. *More details*: SKU, price-includes-tax, minimum stock, supplier, lead time, expiry — every field of the normal product form remains.
4. **Save & Scan Next** → product created and barcode linked in one transaction → counter +1 → small "✓ Product added" status (no modal to dismiss) → form clears → scanner ready. Category and unit of the last product are pre-selected for the next one.
5. **Already registered in this shop** → "Barcode already registered" panel (name, SKU, selling price, purchase price, stock) with **Edit Product** (the normal editor), **Add Stock** (atomic, audited) and **Done**. No duplicate is ever created and nothing is overwritten silently.

## What is reused (no second implementation)
- The Phase 8 `BarcodeScanner` (BarcodeDetector → `@zxing/browser` fallback, same normalisation and cooldown). It gained display props only (`embedded`, `title`, `hint`, `doneLabel`, result `detail`). The camera is **paused, never restarted** while a form is open, so it starts once per session.
- `lookupBarcode()` / `GET /api/products/scan`, the Phase 8 barcode rules (per-shop uniqueness, leading zeros, equivalent widths, primary barcode) and `POST /api/products` — the normal product creation (auth, RBAC, tenant, Zod, plan limit, atomic barcode link, `product.created` audit). No new creation path.
- The keyboard-scanner logic is now one shared hook (`hooks/useWedgeScanner.js`), used by Scan & Add and the Counter.

## API / database
- **No migration.** **New route:** `POST /api/inventory/:productId/add-stock` `{quantity}` (owner/manager): `stock = stock + qty` under a row lock, unit-aware (whole numbers for pcs), an `adjustment` inventory movement, audit `inventory.stock_added`; another shop's product is "not found". A plain "set stock to X" could overwrite a sale made in the meantime; this cannot.
- **Race hardening:** two requests registering the same barcode at once now both get the same clear `409 BARCODE_TAKEN` (naming the winning product) instead of a nameless 409 — the barcode write runs under a savepoint and re-checks after a unique violation. The screen then shows the existing-product panel.

## Errors
Invalid barcode → clear message. Validation → the offending fields are highlighted, entered data is kept, the counter does not move. Network failure → "Could not save product. Please check your connection and try again." — never a false success; the form and barcode are kept; a retry that finds the product was actually saved lands on the existing-product panel. Camera denied → "Use a USB/Bluetooth scanner, or enter the barcode manually" with the manual box.

## Fix found while testing
The keyboard-scanner timer compared key times at the moment the handler ran. When the page was busy (camera decoding, re-rendering) queued keystrokes looked slow, the buffer was reset mid-scan and a **truncated** barcode could be accepted. It now uses each key's own timestamp (`event.timeStamp`) and the listener is never detached between scans. This also hardens the Counter.

## Offline readiness (Phase 17 — not implemented)
Scanner, lookup (`services/barcode.js`), page logic and persistence are separate; the page does not depend on one network call shape except `POST /products` and `add-stock`. A future offline queue can replace those two calls with queued, idempotent writes. Local data needs are as listed in `PHASE_8_BARCODE.md`.

## Limitations
- Each scanned product needs its own name/prices typed; nothing is guessed from the barcode and no external barcode database is used.
- Camera decoding was tested with generated EAN-13 images through a stand-in camera stream, not real phones/packaging. HTTPS (or localhost) is required for the camera.
- Barcodes are captured one at a time (no batch/CSV import in this phase).
- The creation POST has no idempotency key; the unique barcode constraint is what prevents duplicates after a lost response.
