-- 014 — Security phase: make the money/stock ledgers tamper-resistant at the database level, and repair 011's backfill.
-- Additive and tenant-safe: no table, column or row is dropped. Application behaviour is unchanged (the app never edited these columns).
--
-- Before:  sales, sale_items and inventory_movements had ONE `tenant_isolation` FOR ALL policy, so a bug (or a stolen app
--          credential) could rewrite a finished sale's totals, delete sales, or edit/delete stock history inside the tenant.
-- After:   • inventory_movements is append-only (no UPDATE; DELETE for demo businesses only).
--          • sales / sale_items keep UPDATE (refund bookkeeping needs it) but a trigger freezes every money field once written
--            and makes refund counters one-way. DELETE is allowed for demo businesses only (the demo reloader needs it).
--          • Done with RESTRICTIVE policies, so nothing is dropped and access can only shrink.
--          • 011's `refunded_at` backfill ran with no tenant context (RLS hid every row), so legacy refunds were left NULL; redo it per tenant.

-- ---------- 1. sales / sale_items / inventory_movements: narrow the catch-all policy (additively) ----------
-- The existing `tenant_isolation` FOR ALL policy stays. RESTRICTIVE policies are AND-ed with it, so they can only remove access.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales', 'sale_items', 'inventory_movements'] LOOP
    EXECUTE format('CREATE POLICY ledger_delete_demo_only ON %I AS RESTRICTIVE FOR DELETE USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.is_demo))', t);
    EXECUTE format('REVOKE TRUNCATE ON %I FROM sharkpos2_app', t);
  END LOOP;
END $$;

-- ---------- 2. inventory_movements: append-only (no UPDATE at all) ----------
CREATE POLICY ledger_no_update ON inventory_movements AS RESTRICTIVE FOR UPDATE USING (false);
REVOKE UPDATE ON inventory_movements FROM sharkpos2_app;

-- ---------- 3. freeze finished money fields ----------
CREATE OR REPLACE FUNCTION sales_money_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM businesses b WHERE b.id = OLD.business_id AND b.is_demo) THEN RETURN NEW; END IF;   -- demo data may be reshaped
  IF (NEW.business_id, NEW.subtotal, NEW.discount, NEW.tax, NEW.total, NEW.created_at, NEW.employee_id, NEW.customer_id, NEW.payment_method)
     IS DISTINCT FROM
     (OLD.business_id, OLD.subtotal, OLD.discount, OLD.tax, OLD.total, OLD.created_at, OLD.employee_id, OLD.customer_id, OLD.payment_method) THEN
    RAISE EXCEPTION 'A completed sale''s amounts, date, cashier and customer cannot be changed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refund_amount < OLD.refund_amount THEN
    RAISE EXCEPTION 'A refund cannot be reduced once recorded.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'refunded' AND NEW.status <> 'refunded' THEN
    RAISE EXCEPTION 'A refunded sale cannot be reopened.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sales_money_frozen BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION sales_money_frozen();

CREATE OR REPLACE FUNCTION sale_items_money_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM businesses b WHERE b.id = OLD.business_id AND b.is_demo) THEN RETURN NEW; END IF;
  IF (NEW.business_id, NEW.sale_id, NEW.product_id, NEW.quantity, NEW.unit_price, NEW.total)
     IS DISTINCT FROM
     (OLD.business_id, OLD.sale_id, OLD.product_id, OLD.quantity, OLD.unit_price, OLD.total) THEN
    RAISE EXCEPTION 'A sold line''s product, quantity and price cannot be changed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.returned_qty < OLD.returned_qty THEN
    RAISE EXCEPTION 'Returned quantity can only grow.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sale_items_money_frozen BEFORE UPDATE ON sale_items FOR EACH ROW EXECUTE FUNCTION sale_items_money_frozen();

-- ---------- 4. repair 011's backfill (legacy refunds had refunded_at left NULL because RLS hid every row) ----------
DO $$
DECLARE b record;
BEGIN
  FOR b IN SELECT id FROM businesses LOOP
    PERFORM set_config('app.business_id', b.id::text, true);
    UPDATE sales SET refunded_at = updated_at WHERE status = 'refunded' AND refunded_at IS NULL;
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END $$;
