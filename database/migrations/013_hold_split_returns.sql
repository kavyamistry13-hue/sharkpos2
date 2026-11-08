-- SHARKPOS 2 — 013: server-side held bills (Sprint 6), split payments and line-level partial returns (Sprint 7).
-- Additive. Existing rows are preserved and BACKFILLED so every report can read the new tables without a special case for old data:
--   * every existing sale gets one sale_payments row (its single payment method, the full total);
--   * every existing full refund gets one sale_returns row + one sale_return_refunds row (header only: legacy sales have no per-line return rows).
-- Existing objects that change (all widened or extended, nothing removed): the payment_method CHECK on sales (adds 'split'),
-- sale_items (+returned_qty counter, +UNIQUE(business_id,id) so return lines can reference a sale line with a tenant-safe FK),
-- credit_ledger (+return_id, and the "one refund per sale" unique index is replaced by "one refund per return").
-- The original sale lines and totals are NEVER rewritten: money that goes back to the customer lives in the return tables.
-- sales.refund_amount / sale_items.returned_qty are running counters kept in the same transaction as the return record.

-- ---------- sales: 'split' payment method; refunded amount can never exceed the bill ----------
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%payment_method%'
  LOOP
    EXECUTE format('ALTER TABLE sales DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_chk CHECK (payment_method IN ('cash', 'upi', 'card', 'credit', 'split'));
-- (the DROP above also removed 011's credit-needs-customer rule because its text mentions payment_method — put it back, unchanged)
ALTER TABLE sales ADD CONSTRAINT sales_credit_needs_customer_chk CHECK (payment_method <> 'credit' OR customer_id IS NOT NULL);
ALTER TABLE sales ADD CONSTRAINT sales_refund_le_total_chk CHECK (refund_amount >= 0 AND refund_amount <= total);

-- ---------- sale_items: how much of the line has been returned ----------
ALTER TABLE sale_items ADD COLUMN returned_qty NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_returned_chk CHECK (returned_qty >= 0 AND returned_qty <= quantity);
ALTER TABLE sale_items ADD CONSTRAINT uq_sale_items_biz_id UNIQUE (business_id, id);

-- ---------- sale_payments: the tender lines of a sale (cash 400 + UPI 600 = 1000). One line per method. ----------
CREATE TABLE sale_payments (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  sale_id      INT NOT NULL,
  method       VARCHAR(10) NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'credit')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sale_id, method),
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sale_payments_sale ON sale_payments (business_id, sale_id);
CREATE INDEX idx_sale_payments_method ON sale_payments (business_id, method, created_at);

-- ---------- sale_returns: one row per return event (a full refund is just a return of every remaining line) ----------
CREATE TABLE sale_returns (
  id               SERIAL PRIMARY KEY,
  business_id      INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  sale_id          INT NOT NULL,
  idempotency_key  UUID,
  request_hash     CHAR(64),
  total_refund     NUMERIC(12,2) NOT NULL CHECK (total_refund >= 0),
  taxable_value    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason           VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (reason IN ('damaged', 'wrong_item', 'changed_mind', 'quality', 'expired', 'other')),
  note             VARCHAR(300),
  completes_sale   BOOLEAN NOT NULL DEFAULT FALSE,           -- true when this return brought the whole sale back (sale becomes 'refunded')
  is_legacy        BOOLEAN NOT NULL DEFAULT FALSE,           -- backfilled from a pre-013 full refund: no per-line detail exists
  processed_by     INT REFERENCES accounts(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sale_returns_sale ON sale_returns (business_id, sale_id);
CREATE INDEX idx_sale_returns_created ON sale_returns (business_id, created_at);
CREATE INDEX idx_sale_returns_by ON sale_returns (business_id, processed_by, created_at);

CREATE TABLE sale_return_items (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  return_id      INT NOT NULL,
  sale_item_id   INT NOT NULL,
  product_id     INT NOT NULL,
  quantity       NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  refund_amount  NUMERIC(12,2) NOT NULL CHECK (refund_amount >= 0),   -- what the customer gets back for these units (taxable + tax)
  taxable_value  NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_cost      NUMERIC(12,4),                                        -- cost snapshot of the original sale line (for profit reversal)
  restocked      BOOLEAN NOT NULL,
  UNIQUE (business_id, return_id, sale_item_id),
  FOREIGN KEY (business_id, return_id) REFERENCES sale_returns (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, sale_item_id) REFERENCES sale_items (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX idx_sale_return_items_line ON sale_return_items (business_id, sale_item_id);

-- How the refund went back: one line per method (cash / upi / card / credit = reduces the customer's udhaar).
CREATE TABLE sale_return_refunds (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  return_id    INT NOT NULL,
  method       VARCHAR(10) NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'credit')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  UNIQUE (business_id, return_id, method),
  FOREIGN KEY (business_id, return_id) REFERENCES sale_returns (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sale_return_refunds_return ON sale_return_refunds (business_id, return_id);

-- ---------- credit_ledger: partial returns mean more than one refund entry per sale ----------
ALTER TABLE credit_ledger ADD COLUMN return_id INT;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_return_fk FOREIGN KEY (business_id, return_id) REFERENCES sale_returns (business_id, id);
DROP INDEX uq_credit_ledger_refund;
CREATE UNIQUE INDEX uq_credit_ledger_refund_legacy ON credit_ledger (business_id, sale_id) WHERE entry_type = 'refund' AND return_id IS NULL;
CREATE UNIQUE INDEX uq_credit_ledger_refund_return ON credit_ledger (business_id, return_id) WHERE entry_type = 'refund' AND return_id IS NOT NULL;

-- ---------- held_bills: a parked cart. Server-side so it survives refresh and device changes. It touches NO stock, revenue, profit or shift. ----------
CREATE TABLE held_bills (
  id                SERIAL PRIMARY KEY,
  business_id       INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  status            VARCHAR(10) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'completed', 'discarded')),
  created_by        INT NOT NULL REFERENCES accounts(id),
  customer_id       INT,
  label             VARCHAR(60),
  items             JSONB NOT NULL,                  -- [{productId, quantity, name, unitPrice}] — name/price are display snapshots only; pricing is re-done on resume/complete
  discount          JSONB,                           -- {type, value} or NULL
  version           INT NOT NULL DEFAULT 1,          -- bumped on every change (optimistic concurrency)
  request_key       UUID,                            -- idempotency key of the hold request
  resumed_count     INT NOT NULL DEFAULT 0,
  completed_sale_id INT,
  completed_at      TIMESTAMPTZ,
  discarded_by      INT REFERENCES accounts(id),
  discarded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id),
  FOREIGN KEY (business_id, completed_sale_id) REFERENCES sales (business_id, id),
  UNIQUE (business_id, completed_sale_id),           -- one sale can complete at most one held bill
  CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 100),
  CHECK ((status = 'completed') = (completed_sale_id IS NOT NULL)),
  CHECK ((status = 'discarded') = (discarded_at IS NOT NULL))
);
CREATE INDEX idx_held_bills_open ON held_bills (business_id, status, created_by, created_at);

-- ---------- RLS, grants ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['held_bills']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
  -- Append-only money records: read + insert inside the tenant, never update; DELETE only for is_demo businesses (demo reset).
  FOREACH t IN ARRAY ARRAY['sale_payments', 'sale_returns', 'sale_return_items', 'sale_return_refunds']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT USING (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY demo_delete ON %I FOR DELETE USING (business_id = current_business_id() AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.is_demo))', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I FROM sharkpos2_app', t);
  END LOOP;
END $$;

-- ---------- back-fill existing data, one tenant at a time (RLS stays forced; an unset tenant matches nothing, so the loop sets it) ----------
DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM businesses LOOP
    PERFORM set_config('app.business_id', b.id::text, true);

    -- every existing sale: one tender line (its single payment method, the whole bill)
    INSERT INTO sale_payments (sale_id, method, amount, created_at)
      SELECT id, payment_method, total, created_at FROM sales WHERE total > 0 AND payment_method <> 'split';

    -- every existing full refund: a return record (header only) + the refund line, so refund reports read ONE source
    INSERT INTO sale_returns (sale_id, total_refund, taxable_value, tax_amount, reason, completes_sale, is_legacy, processed_by, created_at)
      SELECT id, refund_amount, refund_amount - tax, tax, 'other', TRUE, TRUE, refunded_by, COALESCE(refunded_at, updated_at) FROM sales WHERE status = 'refunded' AND refund_amount > 0;
    INSERT INTO sale_return_refunds (return_id, method, amount)
      SELECT r.id, s.payment_method, r.total_refund FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE r.is_legacy AND s.payment_method <> 'split';

    UPDATE sale_items si SET returned_qty = si.quantity FROM sales s WHERE s.id = si.sale_id AND s.status = 'refunded';
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END $$;
