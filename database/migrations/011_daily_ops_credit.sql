-- SHARKPOS 2 — 011: daily operations (Sprint 3). Additive: credit (udhaar) ledger, cashier shifts, cash reconciliations, refund attribution.
-- The only existing object that is changed is the payment_method CHECK on sales, which is WIDENED to accept 'credit'.

-- ---------- sales: credit payment method + who/when refunded ----------
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%payment_method%'
  LOOP
    EXECUTE format('ALTER TABLE sales DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_chk CHECK (payment_method IN ('cash', 'upi', 'card', 'credit'));
-- A credit (udhaar) sale always belongs to a customer.
ALTER TABLE sales ADD CONSTRAINT sales_credit_needs_customer_chk CHECK (payment_method <> 'credit' OR customer_id IS NOT NULL);
ALTER TABLE sales ADD COLUMN refunded_at TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN refunded_by INT REFERENCES accounts(id);
UPDATE sales SET refunded_at = updated_at WHERE status = 'refunded' AND refunded_at IS NULL;

-- ---------- customers: credit limit (0 = udhaar not enabled for this customer) ----------
ALTER TABLE customers ADD COLUMN credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0);

-- ---------- credit_ledger: append-only udhaar ledger. balance = Σ(amount × effect) ----------
CREATE TABLE credit_ledger (
  id              SERIAL PRIMARY KEY,
  business_id     INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  customer_id     INT NOT NULL,
  entry_type      VARCHAR(12) NOT NULL CHECK (entry_type IN ('sale', 'payment', 'refund', 'adjustment')),
  effect          SMALLINT NOT NULL CHECK (effect IN (1, -1)),          -- +1 customer owes more, -1 customer owes less
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  sale_id         INT,
  payment_method  VARCHAR(10) CHECK (payment_method IN ('cash', 'upi', 'card')),
  note            VARCHAR(300),
  created_by      INT REFERENCES accounts(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id),
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id),
  CHECK ((entry_type = 'sale' AND effect = 1 AND sale_id IS NOT NULL)
      OR (entry_type = 'refund' AND effect = -1 AND sale_id IS NOT NULL)
      OR (entry_type = 'payment' AND effect = -1 AND payment_method IS NOT NULL)
      OR (entry_type = 'adjustment' AND note IS NOT NULL))
);
CREATE INDEX idx_credit_ledger_customer ON credit_ledger (business_id, customer_id, created_at);
CREATE INDEX idx_credit_ledger_created ON credit_ledger (business_id, created_at);
CREATE UNIQUE INDEX uq_credit_ledger_sale ON credit_ledger (business_id, sale_id) WHERE entry_type = 'sale';
CREATE UNIQUE INDEX uq_credit_ledger_refund ON credit_ledger (business_id, sale_id) WHERE entry_type = 'refund';

-- ---------- shifts: one open shift per cashier; the summary is frozen when the shift is closed ----------
CREATE TABLE shifts (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  user_id        INT NOT NULL REFERENCES accounts(id),
  status         VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_cash   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  closed_at      TIMESTAMPTZ,
  closed_by      INT REFERENCES accounts(id),
  expected_cash  NUMERIC(12,2),
  counted_cash   NUMERIC(12,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  variance       NUMERIC(12,2),
  summary        JSONB,
  notes          VARCHAR(500),
  handover_to    INT REFERENCES accounts(id),
  handover_note  VARCHAR(500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL))
);
CREATE UNIQUE INDEX uq_shifts_one_open ON shifts (business_id, user_id) WHERE status = 'open';
CREATE INDEX idx_shifts_opened ON shifts (business_id, opened_at);

-- A closed shift is a record: it can no longer be edited.
CREATE FUNCTION shifts_closed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'A closed shift cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_shifts_closed_immutable BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION shifts_closed_immutable();

-- ---------- cash_reconciliations: append-only; a correction is a new record, the latest one for a date wins ----------
CREATE TABLE cash_reconciliations (
  id             SERIAL PRIMARY KEY,
  business_id    INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  business_date  DATE NOT NULL,
  shift_id       INT,
  opening_cash   NUMERIC(12,2) NOT NULL CHECK (opening_cash >= 0),
  expected_cash  NUMERIC(12,2) NOT NULL,
  actual_cash    NUMERIC(12,2) NOT NULL CHECK (actual_cash >= 0),
  variance       NUMERIC(12,2) NOT NULL,
  breakdown      JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          VARCHAR(500),
  reconciled_by  INT REFERENCES accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, shift_id) REFERENCES shifts (business_id, id)
);
CREATE INDEX idx_cash_recon_date ON cash_reconciliations (business_id, business_date, created_at);

-- ---------- RLS, triggers, grants ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shifts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id())', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
    EXECUTE format('CREATE TRIGGER trg_%s_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
  -- Append-only: read + insert inside the tenant, never update; DELETE only for is_demo businesses (demo reset).
  FOREACH t IN ARRAY ARRAY['credit_ledger', 'cash_reconciliations']
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
