-- SHARKPOS 2 — 002: tenant-owned tables. Every row carries business_id; composite FKs make a cross-tenant
-- reference impossible even for code that forgets a filter; row-level security is the last line of defence.

CREATE TABLE categories (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  name         VARCHAR(80) NOT NULL,
  tax_rate     NUMERIC(5,2) NOT NULL DEFAULT 5.00 CHECK (tax_rate >= 0 AND tax_rate <= 40),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, name)
);

CREATE TABLE suppliers (
  id              SERIAL PRIMARY KEY,
  business_id     INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  name            VARCHAR(120) NOT NULL,
  phone           VARCHAR(30),
  email           VARCHAR(190),
  lead_time_days  INT NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE products (
  id              SERIAL PRIMARY KEY,
  business_id     INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  sku             VARCHAR(40)  NOT NULL,
  name            VARCHAR(160) NOT NULL,
  category_id     INT NOT NULL,
  purchase_price  NUMERIC(10,2) NOT NULL CHECK (purchase_price >= 0),
  selling_price   NUMERIC(10,2) NOT NULL CHECK (selling_price >= 0),
  stock           INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  minimum_stock   INT NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  supplier_id     INT,
  lead_time_days  INT NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  expiry_date     DATE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,          -- soft delete: inactive products keep their history
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku),
  FOREIGN KEY (business_id, category_id) REFERENCES categories (business_id, id),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
);
CREATE INDEX idx_products_biz_category ON products(business_id, category_id);
CREATE INDEX idx_products_biz_name ON products(business_id, lower(name));

CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  name         VARCHAR(120) NOT NULL,
  phone        VARCHAR(20)  NOT NULL,
  email        VARCHAR(190),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, phone)
);

CREATE TABLE sales (
  id                    SERIAL PRIMARY KEY,
  business_id           INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  invoice_no            VARCHAR(30),
  customer_id           INT,
  employee_id           INT NOT NULL REFERENCES accounts(id),
  subtotal              NUMERIC(12,2) NOT NULL,
  discount              NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax                   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(12,2) NOT NULL,
  payment_method        VARCHAR(10) NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card')),
  status                VARCHAR(12) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded', 'cancelled')),
  refund_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_approved_by  INT REFERENCES accounts(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, invoice_no),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);
CREATE INDEX idx_sales_biz_created ON sales(business_id, created_at);
CREATE INDEX idx_sales_biz_employee ON sales(business_id, employee_id, created_at);
CREATE INDEX idx_sales_biz_customer ON sales(business_id, customer_id);

CREATE TABLE sale_items (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  sale_id      INT NOT NULL,
  product_id   INT NOT NULL,
  quantity     INT NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(10,2) NOT NULL,
  total        NUMERIC(12,2) NOT NULL,
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX idx_sale_items_sale ON sale_items(business_id, sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(business_id, product_id);

CREATE TABLE inventory_movements (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  product_id     INT NOT NULL,
  movement_type  VARCHAR(12) NOT NULL CHECK (movement_type IN ('initial', 'sale', 'restock', 'refund', 'adjustment')),
  quantity       INT NOT NULL,
  reference_id   INT,
  created_by     INT REFERENCES accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX idx_movements_product ON inventory_movements(business_id, product_id, created_at);

CREATE TABLE anomaly_alerts (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  sale_id      INT NOT NULL,
  risk_score   INT NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  severity     VARCHAR(10) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason       TEXT NOT NULL,
  factors      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by  INT REFERENCES accounts(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sale_id),
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX idx_alerts_status ON anomaly_alerts(business_id, status);

CREATE TABLE restock_orders (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  product_id   INT NOT NULL,
  quantity     INT NOT NULL CHECK (quantity > 0),
  reason       TEXT,
  status       VARCHAR(12) NOT NULL CHECK (status IN ('approved', 'dismissed', 'received')),
  created_by   INT REFERENCES accounts(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX idx_restock_product ON restock_orders(business_id, product_id, status);

CREATE TABLE settings (
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  key          VARCHAR(60) NOT NULL,
  value        JSONB NOT NULL,
  PRIMARY KEY (business_id, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories','suppliers','products','customers','sales','sale_items','inventory_movements','anomaly_alerts','restock_orders','settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['categories','suppliers','products','customers','sales','anomaly_alerts']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
