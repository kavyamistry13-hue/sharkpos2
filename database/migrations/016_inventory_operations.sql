-- 016 — Phase 9: production inventory & operations.
-- Additive only: new nullable columns, three new tenant tables, indexes. Nothing existing is dropped or rewritten, so products
-- without batches / reorder settings behave exactly as before.
--
--   • products: max_stock, reorder_level (optional; NULL = "use the existing minimum_stock rules"), track_batches (opt-in batch/expiry).
--   • inventory_movements: reason, note, stock_after, batch_id. The table stays APPEND-ONLY (014): history is never updated.
--   • stock_batches: optional batch / manufacturing date / expiry per product, with the quantity still on hand (FEFO = first-expiry-first-out).
--   • stock_counts / stock_count_items: physical count sessions. A count NEVER changes stock by itself; stock moves only when a
--     manager/owner approves it, and then through normal, audited adjustment movements.
--   • goods_receipt_items: optional batch_no / manufactured / expiry captured at receiving time.
-- No DROP POLICY (RLS is only ever added to).

-- ---------- products ----------
ALTER TABLE products ADD COLUMN max_stock     NUMERIC(12,3) CHECK (max_stock IS NULL OR max_stock >= 0);
ALTER TABLE products ADD COLUMN reorder_level NUMERIC(12,3) CHECK (reorder_level IS NULL OR reorder_level >= 0);
ALTER TABLE products ADD COLUMN track_batches BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD CONSTRAINT products_stock_levels_chk CHECK (max_stock IS NULL OR max_stock >= minimum_stock);
-- Only indexes whose use was demonstrated with EXPLAIN on a 1,000-product / 12,000-movement shop are added (supplier filter, movement feed, batch FEFO/expiry).
-- SKU / active+stock / product-level expiry lookups were measured at < 0.2 ms on the existing indexes, so no index was added for them.
CREATE INDEX idx_products_biz_supplier ON products (business_id, supplier_id);

-- ---------- batches ----------
CREATE TABLE stock_batches (
  id                SERIAL PRIMARY KEY,
  business_id       INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  product_id        INT NOT NULL,
  batch_no          VARCHAR(40) NOT NULL,
  manufactured_date DATE,
  expiry_date       DATE,
  quantity_received NUMERIC(12,3) NOT NULL CHECK (quantity_received > 0),
  quantity_on_hand  NUMERIC(12,3) NOT NULL CHECK (quantity_on_hand >= 0),
  unit_cost         NUMERIC(10,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  supplier_id       INT,
  goods_receipt_id  INT,
  created_by        INT REFERENCES accounts(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (quantity_on_hand <= quantity_received),
  CHECK (manufactured_date IS NULL OR expiry_date IS NULL OR manufactured_date <= expiry_date),
  UNIQUE (business_id, id),
  UNIQUE (business_id, product_id, batch_no),
  FOREIGN KEY (business_id, product_id)       REFERENCES products (business_id, id),
  FOREIGN KEY (business_id, supplier_id)      REFERENCES suppliers (business_id, id),
  FOREIGN KEY (business_id, goods_receipt_id) REFERENCES goods_receipts (business_id, id)
);
CREATE INDEX idx_batches_fefo ON stock_batches (business_id, product_id, expiry_date NULLS LAST, id) WHERE quantity_on_hand > 0;
CREATE INDEX idx_batches_expiry ON stock_batches (business_id, expiry_date) WHERE quantity_on_hand > 0 AND expiry_date IS NOT NULL;

ALTER TABLE goods_receipt_items ADD COLUMN batch_no          VARCHAR(40);
ALTER TABLE goods_receipt_items ADD COLUMN manufactured_date DATE;
ALTER TABLE goods_receipt_items ADD COLUMN expiry_date       DATE;

-- ---------- movements: why / what it became / which batch ----------
ALTER TABLE inventory_movements ADD COLUMN reason      VARCHAR(24)
  CHECK (reason IS NULL OR reason IN ('damaged', 'expired', 'lost', 'theft', 'counting_error', 'found_stock', 'manual_correction', 'other', 'stock_count'));
ALTER TABLE inventory_movements ADD COLUMN note        VARCHAR(200);
ALTER TABLE inventory_movements ADD COLUMN stock_after NUMERIC(12,3);
ALTER TABLE inventory_movements ADD COLUMN batch_id    INT;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_batch_fk
  FOREIGN KEY (business_id, batch_id) REFERENCES stock_batches (business_id, id);
CREATE INDEX idx_movements_biz_time ON inventory_movements (business_id, created_at DESC, id DESC);

-- Every writer updates products.stock first and inserts the movement second, so the product's stock at insert time IS the resulting
-- stock. Filling stock_after here (instead of in each of the six writers) means no path can forget it, and a future writer gets it free.
-- Runs as the caller, so RLS still applies (a movement can only read its own shop's product).
CREATE FUNCTION set_movement_stock_after() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.stock_after IS NULL THEN
    SELECT stock INTO NEW.stock_after FROM products WHERE business_id = NEW.business_id AND id = NEW.product_id;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_movements_stock_after BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION set_movement_stock_after();

-- ---------- physical stock counts ----------
CREATE TABLE stock_counts (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  title        VARCHAR(120) NOT NULL DEFAULT 'Stock count',
  status       VARCHAR(12) NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'approved', 'cancelled')),
  started_by   INT REFERENCES accounts(id),
  submitted_by INT REFERENCES accounts(id),
  approved_by  INT REFERENCES accounts(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  approved_at  TIMESTAMPTZ,
  note         VARCHAR(200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX idx_stock_counts_biz ON stock_counts (business_id, status, started_at DESC);

CREATE TABLE stock_count_items (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  stock_count_id INT NOT NULL,
  product_id     INT NOT NULL,
  expected_qty   NUMERIC(12,3) NOT NULL,          -- system stock when this product was first counted
  counted_qty    NUMERIC(12,3) NOT NULL CHECK (counted_qty >= 0),
  unit_cost      NUMERIC(10,2) NOT NULL DEFAULT 0, -- cost snapshot, so the ₹ variance of an old count never changes
  counted_by     INT REFERENCES accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, stock_count_id, product_id),
  FOREIGN KEY (business_id, stock_count_id) REFERENCES stock_counts (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, product_id)     REFERENCES products (business_id, id)
);
CREATE INDEX idx_stock_count_items_count ON stock_count_items (business_id, stock_count_id);

-- ---------- RLS (forced), backup read access, updated_at ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_batches', 'stock_counts', 'stock_count_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
