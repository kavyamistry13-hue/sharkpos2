-- 017 — Roadmap Phase 9.1: weighted-average costing.
-- Additive. products.purchase_price keeps its meaning ("latest purchase cost", shown to staff and used for supplier comparisons);
-- the NEW products.avg_cost is the financial cost of what is on the shelf and is what sales snapshot for COGS and what stock is valued at.
-- The existing append-only product_cost_history is EXTENDED (not replaced) with before/after average and quantity.
-- No DROP POLICY; existing rows keep working (new columns are nullable on history, avg_cost is back-filled from purchase_price).

-- ---------- products.avg_cost (4 decimals so averages such as 54.6667 do not drift) ----------
ALTER TABLE products ADD COLUMN avg_cost NUMERIC(14,4) CHECK (avg_cost IS NULL OR avg_cost >= 0);

-- Every writer that inserts a product without an average (seed, tests, import, demo reset, old code) starts at its purchase price.
CREATE FUNCTION set_product_avg_cost_default() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.avg_cost IS NULL THEN NEW.avg_cost := NEW.purchase_price; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_products_avg_cost_default BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION set_product_avg_cost_default();

-- Back-fill one tenant at a time (RLS stays forced; the owner role is subject to it), as migration 009 does.
DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM businesses LOOP
    PERFORM set_config('app.business_id', b.id::text, true);
    UPDATE products SET avg_cost = purchase_price WHERE avg_cost IS NULL;
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END $$;
ALTER TABLE products ALTER COLUMN avg_cost SET NOT NULL;

-- ---------- cost snapshots keep full precision ----------
ALTER TABLE sale_items        ALTER COLUMN unit_cost TYPE NUMERIC(14,4);
ALTER TABLE stock_count_items ALTER COLUMN unit_cost TYPE NUMERIC(14,4);

-- ---------- cost history: what the average was before/after and which quantities moved it ----------
ALTER TABLE product_cost_history ALTER COLUMN cost TYPE NUMERIC(14,4);
ALTER TABLE product_cost_history ADD COLUMN prev_avg_cost NUMERIC(14,4);
ALTER TABLE product_cost_history ADD COLUMN new_avg_cost  NUMERIC(14,4);
ALTER TABLE product_cost_history ADD COLUMN qty_before    NUMERIC(12,3);
ALTER TABLE product_cost_history ADD COLUMN qty_received  NUMERIC(12,3);
ALTER TABLE product_cost_history ADD COLUMN qty_after     NUMERIC(12,3);
ALTER TABLE product_cost_history DROP CONSTRAINT product_cost_history_source_check;
ALTER TABLE product_cost_history ADD CONSTRAINT product_cost_history_source_check CHECK (source IN ('initial', 'manual', 'purchase', 'return', 'batch'));
