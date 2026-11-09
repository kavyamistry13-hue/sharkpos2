-- 015 — Phase 8: manufacturer barcodes mapped to a shop's own products.
-- Additive: one new table, nothing existing is changed. The barcode printed on the packaging is only an IDENTIFIER; the price,
-- tax, unit and stock always come from the shop's product row (so two shops can map the same barcode to different prices).
--
--   manufacturer barcode  →  product_barcodes (this shop's mapping)  →  products (price / stock / unit)
--
-- • barcode is TEXT/VARCHAR, never a number: leading zeros are kept exactly ("0891234567890" stays "0891234567890").
-- • UNIQUE (business_id, barcode): inside ONE shop a barcode points to exactly one product; across shops it can repeat freely.
-- • Several barcodes per product are allowed (different pack sizes / re-labelled stock); at most one is "primary" (the one shown first).
-- • Composite FK (business_id, product_id) → a mapping can never point at another shop's product; RLS is forced like every tenant table.

CREATE TABLE product_barcodes (
  id            SERIAL PRIMARY KEY,
  business_id   INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  product_id    INT NOT NULL,
  barcode       VARCHAR(48) NOT NULL CHECK (barcode ~ '^[A-Za-z0-9][A-Za-z0-9._/+-]{3,47}$'),
  barcode_type  VARCHAR(10) NOT NULL DEFAULT 'other' CHECK (barcode_type IN ('ean13', 'ean8', 'upca', 'gtin14', 'other')),
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    INT REFERENCES accounts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, barcode),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_product_barcodes_product ON product_barcodes (business_id, product_id);
CREATE UNIQUE INDEX uq_product_barcodes_one_primary ON product_barcodes (business_id, product_id) WHERE is_primary;

ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_barcodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_barcodes USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id());
CREATE POLICY backup_read ON product_barcodes FOR SELECT TO sharkpos2_backup USING (true);
CREATE TRIGGER trg_product_barcodes_upd BEFORE UPDATE ON product_barcodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
