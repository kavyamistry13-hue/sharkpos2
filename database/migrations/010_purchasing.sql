-- SHARKPOS 2 — 010: purchasing foundation (suppliers, supplier-product terms, purchase orders, receipts, price history).
-- Additive only. Existing restock_orders keep working; they can now be linked to a purchase-order line.
-- Receipts and price history are append-only for the application role (no UPDATE / DELETE).

-- ---------- richer suppliers ----------
ALTER TABLE suppliers
  ADD COLUMN contact_person     VARCHAR(120),
  ADD COLUMN address            VARCHAR(300),
  ADD COLUMN gstin              VARCHAR(20),
  ADD COLUMN payment_terms_days INT NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  ADD COLUMN min_order_value    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_order_value >= 0),
  ADD COLUMN notes              VARCHAR(500),
  ADD COLUMN is_active          BOOLEAN NOT NULL DEFAULT TRUE;     -- soft delete: history keeps pointing at the supplier

-- ---------- which supplier sells which product, on what terms ----------
CREATE TABLE supplier_products (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  supplier_id    INT NOT NULL,
  product_id     INT NOT NULL,
  supplier_sku   VARCHAR(40),
  pack_size      NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  min_order_qty  NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (min_order_qty > 0),
  lead_time_days INT CHECK (lead_time_days >= 0),                  -- NULL = use the supplier's lead time
  last_cost      NUMERIC(10,2) CHECK (last_cost >= 0),
  is_preferred   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, supplier_id, product_id),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id),
  FOREIGN KEY (business_id, product_id)  REFERENCES products  (business_id, id)
);
CREATE UNIQUE INDEX uq_supplier_products_preferred ON supplier_products (business_id, product_id) WHERE is_preferred;
CREATE INDEX idx_supplier_products_product ON supplier_products (business_id, product_id);

-- ---------- purchase orders ----------
CREATE TABLE purchase_orders (
  id            SERIAL PRIMARY KEY,
  business_id   INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  po_number     VARCHAR(30),
  supplier_id   INT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partially_received','received','cancelled')),
  order_date    DATE,
  expected_date DATE,
  ordered_at    TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  closed_short  BOOLEAN NOT NULL DEFAULT FALSE,                    -- closed with some quantity never delivered
  notes         VARCHAR(500),
  created_by    INT REFERENCES accounts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, po_number),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
);
CREATE INDEX idx_po_status   ON purchase_orders (business_id, status);
CREATE INDEX idx_po_supplier ON purchase_orders (business_id, supplier_id, created_at DESC);

CREATE TABLE purchase_order_items (
  id                SERIAL PRIMARY KEY,
  business_id       INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  purchase_order_id INT NOT NULL,
  product_id        INT NOT NULL,
  ordered_qty       NUMERIC(12,3) NOT NULL CHECK (ordered_qty > 0),
  received_qty      NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),     -- accepted into stock
  rejected_qty      NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),     -- delivered but refused (not in stock, still outstanding)
  unit_cost         NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),                  -- ordered price
  UNIQUE (business_id, id),
  UNIQUE (business_id, purchase_order_id, product_id),
  CHECK (received_qty <= ordered_qty),
  FOREIGN KEY (business_id, purchase_order_id) REFERENCES purchase_orders (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, product_id)        REFERENCES products (business_id, id)
);
CREATE INDEX idx_po_items_po      ON purchase_order_items (business_id, purchase_order_id);
CREATE INDEX idx_po_items_product ON purchase_order_items (business_id, product_id);

-- ---------- goods receipts (each delivery, full or partial) ----------
CREATE TABLE goods_receipts (
  id                SERIAL PRIMARY KEY,
  business_id       INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  purchase_order_id INT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by       INT REFERENCES accounts(id),
  invoice_no        VARCHAR(40),                                   -- supplier's bill number
  notes             VARCHAR(500),
  idempotency_key   UUID,                                          -- optional: a repeated submit returns the first receipt
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, purchase_order_id) REFERENCES purchase_orders (business_id, id)
);
CREATE INDEX idx_receipts_po ON goods_receipts (business_id, purchase_order_id);

CREATE TABLE goods_receipt_items (
  id                     SERIAL PRIMARY KEY,
  business_id            INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  goods_receipt_id       INT NOT NULL,
  purchase_order_item_id INT NOT NULL,
  product_id             INT NOT NULL,
  quantity               NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  rejected_quantity      NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  unit_cost              NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),            -- price actually invoiced
  CHECK (quantity > 0 OR rejected_quantity > 0),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, goods_receipt_id)       REFERENCES goods_receipts (business_id, id),
  FOREIGN KEY (business_id, purchase_order_item_id) REFERENCES purchase_order_items (business_id, id),
  FOREIGN KEY (business_id, product_id)             REFERENCES products (business_id, id)
);
CREATE INDEX idx_receipt_items_product ON goods_receipt_items (business_id, product_id);
CREATE INDEX idx_receipt_items_receipt ON goods_receipt_items (business_id, goods_receipt_id);

-- ---------- supplier price history (append-only) ----------
CREATE TABLE supplier_price_history (
  id                SERIAL PRIMARY KEY,
  business_id       INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  supplier_id       INT NOT NULL,
  product_id        INT NOT NULL,
  unit_cost         NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            VARCHAR(20) NOT NULL CHECK (source IN ('purchase_order','manual')),
  purchase_order_id INT,
  goods_receipt_id  INT,
  created_by        INT REFERENCES accounts(id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id),
  FOREIGN KEY (business_id, product_id)  REFERENCES products (business_id, id)
);
CREATE INDEX idx_supplier_price_hist ON supplier_price_history (business_id, supplier_id, product_id, recorded_at DESC);
CREATE INDEX idx_supplier_price_hist_product ON supplier_price_history (business_id, product_id, recorded_at DESC);

-- ---------- restock-order integration ----------
ALTER TABLE restock_orders ADD COLUMN purchase_order_item_id INT;
ALTER TABLE restock_orders ADD CONSTRAINT restock_po_item_fk
  FOREIGN KEY (business_id, purchase_order_item_id) REFERENCES purchase_order_items (business_id, id);
CREATE INDEX idx_restock_po_item ON restock_orders (business_id, purchase_order_item_id);

-- ---------- RLS, triggers, grants ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_products','purchase_orders','purchase_order_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
  END LOOP;
  -- Append-only ledgers: read + insert inside the tenant, never update. DELETE only for is_demo businesses (demo reset), never for real ones.
  FOREACH t IN ARRAY ARRAY['goods_receipts','goods_receipt_items','supplier_price_history']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT USING (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY demo_delete ON %I FOR DELETE USING (business_id = current_business_id() AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.is_demo))', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I FROM sharkpos2_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['supplier_products','purchase_orders']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
