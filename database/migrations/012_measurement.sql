-- SHARKPOS 2 — 012: measurement & value (Sprint 5). Purely additive; no existing object is changed.
-- Recommendation → Action → Outcome → Measured value. Every table is append-only: a changed mind, a re-measurement or a correction is a NEW row.

-- ---------- recommendation_log: one row per recommendation per calendar month it was shown (so "generated" can be counted honestly) ----------
CREATE TABLE recommendation_log (
  id            SERIAL PRIMARY KEY,
  business_id   INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  action_key    VARCHAR(120) NOT NULL,
  action_type   VARCHAR(40) NOT NULL,
  category      VARCHAR(20) NOT NULL CHECK (category IN ('stock', 'money', 'suppliers', 'profit', 'operations')),
  severity      VARCHAR(10) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  snapshot      JSONB NOT NULL,
  seen_month    DATE NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, action_key, seen_month)
);
CREATE INDEX idx_reco_log_seen ON recommendation_log (business_id, first_seen_at);

-- ---------- action_decisions: what the owner/manager did with a recommendation. The recommendation is frozen in `snapshot`. ----------
CREATE TABLE action_decisions (
  id          SERIAL PRIMARY KEY,
  business_id INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  action_key  VARCHAR(120) NOT NULL,
  action_type VARCHAR(40) NOT NULL,
  category    VARCHAR(20) NOT NULL CHECK (category IN ('stock', 'money', 'suppliers', 'profit', 'operations')),
  severity    VARCHAR(10) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  decision    VARCHAR(10) NOT NULL CHECK (decision IN ('accepted', 'rejected', 'deferred')),
  reason      VARCHAR(500),
  snapshot    JSONB NOT NULL,                      -- the recommendation exactly as it was shown
  baseline    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the numbers the outcome is later compared against
  decided_by  INT REFERENCES accounts(id),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX idx_decisions_key ON action_decisions (business_id, action_key, decided_at DESC, id DESC);
CREATE INDEX idx_decisions_time ON action_decisions (business_id, decided_at);

-- ---------- action_outcomes: what was observed afterwards. A new row only when the observation changes; the latest row wins. ----------
CREATE TABLE action_outcomes (
  id              SERIAL PRIMARY KEY,
  business_id     INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  decision_id     INT NOT NULL,
  status          VARCHAR(14) NOT NULL CHECK (status IN ('pending', 'verified', 'neutral', 'unsuccessful', 'not_measurable', 'unknown')),
  outcome_type    VARCHAR(30) NOT NULL,
  headline        VARCHAR(200) NOT NULL,
  explanation     VARCHAR(600) NOT NULL,
  measured_amount NUMERIC(12,2),                   -- ₹ measured so far from real records; NULL = no rupee figure exists
  acted           BOOLEAN NOT NULL DEFAULT FALSE,  -- the data shows something was actually done
  metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, decision_id) REFERENCES action_decisions (business_id, id)
);
CREATE INDEX idx_outcomes_decision ON action_outcomes (business_id, decision_id, id DESC);

-- ---------- value_ledger: measured (verified) and user-reported value, kept apart. balance = Σ(amount × effect) ----------
CREATE TABLE value_ledger (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  entry_date   DATE NOT NULL,
  entry_type   VARCHAR(10) NOT NULL CHECK (entry_type IN ('measured', 'reported', 'correction')),
  verification VARCHAR(10) NOT NULL CHECK (verification IN ('verified', 'reported')),
  effect       SMALLINT NOT NULL CHECK (effect IN (1, -1)),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  value_type   VARCHAR(24) NOT NULL CHECK (value_type IN ('recovered_credit', 'inventory_released', 'margin_improvement', 'cost_saving', 'avoided_loss', 'recovered_cash', 'stockout_impact')),
  decision_id  INT,
  outcome_id   INT,
  reverses_id  INT,
  ref_type     VARCHAR(30),
  ref_id       INT,
  explanation  VARCHAR(500) NOT NULL,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   INT REFERENCES accounts(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, decision_id) REFERENCES action_decisions (business_id, id),
  FOREIGN KEY (business_id, outcome_id)  REFERENCES action_outcomes (business_id, id),
  FOREIGN KEY (business_id, reverses_id) REFERENCES value_ledger (business_id, id),
  -- Verified value can only come from a measured outcome of a recorded decision; a typed-in figure can never be 'verified'.
  CHECK ((entry_type = 'measured'   AND verification = 'verified' AND effect = 1  AND decision_id IS NOT NULL AND outcome_id IS NOT NULL)
      OR (entry_type = 'reported'   AND verification = 'reported' AND effect = 1  AND created_by IS NOT NULL)
      OR (entry_type = 'correction' AND effect = -1))
);
CREATE UNIQUE INDEX uq_value_ledger_reversal ON value_ledger (business_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX idx_value_ledger_date ON value_ledger (business_id, entry_date);
CREATE INDEX idx_value_ledger_decision ON value_ledger (business_id, decision_id, value_type);

-- ---------- RLS, grants: read + insert inside the tenant; never UPDATE; DELETE only for is_demo businesses (demo reset) ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recommendation_log', 'action_decisions', 'action_outcomes', 'value_ledger']
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
