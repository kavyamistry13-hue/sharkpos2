-- SHARKPOS 2 — 009: decimal quantities, units, tax-inclusive pricing, and historical snapshots on every sale line.
-- Additive: no column is dropped or renamed, no constraint is weakened, RLS is unchanged.
--   * Quantities become NUMERIC(12,3). The change is a lossless widening of INT; existing values are preserved.
--     Rollback: ALTER ... TYPE INT USING round(x)::int is lossless only while no fractional quantity has been stored.
--   * Whole-number units (pcs, pack, box, dozen) are protected by CHECK constraints; only kg, g, l, ml, m may hold fractions.
--   * sale_items now stores unit cost, tax rate, tax mode, discount share, taxable value and tax amount AS THEY WERE AT SALE TIME,
--     so later price/cost/tax edits can never change historical profit.
--   * Existing sale lines are back-filled and flagged (snapshot_backfilled, cost_source = 'estimated') because the true historical
--     cost was never stored: they use today's purchase price. New sales are stored with cost_source = 'snapshot'.

-- ---------- units, tax mode, decimal quantities ----------
ALTER TABLE products ADD COLUMN unit VARCHAR(8) NOT NULL DEFAULT 'pcs'
  CHECK (unit IN ('pcs','kg','g','l','ml','m','pack','box','dozen'));
ALTER TABLE products ADD COLUMN price_includes_tax BOOLEAN NOT NULL DEFAULT FALSE;   -- FALSE keeps the old behaviour (tax added on top)
ALTER TABLE products ALTER COLUMN stock TYPE NUMERIC(12,3), ALTER COLUMN minimum_stock TYPE NUMERIC(12,3);
ALTER TABLE products ADD CONSTRAINT products_whole_units_chk
  CHECK (unit IN ('kg','g','l','ml','m') OR (stock = trunc(stock) AND minimum_stock = trunc(minimum_stock)));

ALTER TABLE sale_items ALTER COLUMN quantity TYPE NUMERIC(12,3);
ALTER TABLE inventory_movements ALTER COLUMN quantity TYPE NUMERIC(12,3);
ALTER TABLE restock_orders ALTER COLUMN quantity TYPE NUMERIC(12,3);
ALTER TABLE inventory_movements ADD COLUMN reference_type VARCHAR(20);   -- 'sale' | 'refund' | 'restock_order' | 'goods_receipt' | NULL (legacy)

-- ---------- snapshots on sale lines ----------
ALTER TABLE sale_items
  ADD COLUMN unit                VARCHAR(8)    NOT NULL DEFAULT 'pcs',
  ADD COLUMN unit_cost           NUMERIC(10,2),
  ADD COLUMN cost_source         VARCHAR(10)   NOT NULL DEFAULT 'snapshot' CHECK (cost_source IN ('snapshot','estimated')),
  ADD COLUMN tax_rate            NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN price_includes_tax  BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN discount_share      NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN taxable_value       NUMERIC(12,2),
  ADD COLUMN tax_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN snapshot_backfilled BOOLEAN       NOT NULL DEFAULT FALSE;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_whole_units_chk CHECK (unit IN ('kg','g','l','ml','m') OR quantity = trunc(quantity));

-- ---------- cost history (append-only) ----------
CREATE TABLE product_cost_history (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  product_id   INT NOT NULL,
  cost         NUMERIC(10,2) NOT NULL CHECK (cost >= 0),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       VARCHAR(10) NOT NULL CHECK (source IN ('initial','manual','purchase')),
  ref_type     VARCHAR(20),
  ref_id       INT,
  created_by   INT REFERENCES accounts(id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX idx_cost_history_product ON product_cost_history (business_id, product_id, effective_at DESC);

ALTER TABLE product_cost_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_cost_history FORCE ROW LEVEL SECURITY;
-- Append-only: rows can be read and added inside the tenant, never updated. DELETE is possible only for a business flagged is_demo
-- (the demo reset wipes and reloads its own data); a real business's history can never be deleted by the application role.
CREATE POLICY tenant_isolation ON product_cost_history FOR SELECT USING (business_id = current_business_id());
CREATE POLICY tenant_insert    ON product_cost_history FOR INSERT WITH CHECK (business_id = current_business_id());
CREATE POLICY demo_delete      ON product_cost_history FOR DELETE USING (business_id = current_business_id() AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.is_demo));
CREATE POLICY backup_read ON product_cost_history FOR SELECT TO sharkpos2_backup USING (true);
REVOKE UPDATE, TRUNCATE ON product_cost_history FROM sharkpos2_app;

-- ---------- back-fill existing data, one tenant at a time (RLS stays forced; the owner role is subject to it) ----------
DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM businesses LOOP
    PERFORM set_config('app.business_id', b.id::text, true);

    INSERT INTO product_cost_history (product_id, cost, effective_at, source)
      SELECT id, purchase_price, created_at, 'initial' FROM products;

    UPDATE sale_items si
       SET unit_cost = p.purchase_price,
           cost_source = 'estimated',
           unit = p.unit,
           tax_rate = c.tax_rate,
           price_includes_tax = FALSE,
           discount_share = CASE WHEN s.subtotal > 0 THEN round(s.discount * si.total / s.subtotal, 2) ELSE 0 END,
           snapshot_backfilled = TRUE
      FROM sales s, products p, categories c
     WHERE s.id = si.sale_id AND p.id = si.product_id AND c.id = p.category_id;

    UPDATE sale_items
       SET taxable_value = total - discount_share,
           tax_amount = round((total - discount_share) * tax_rate / 100, 2)
     WHERE snapshot_backfilled;
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END $$;
