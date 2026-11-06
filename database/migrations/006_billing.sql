-- SHARKPOS 2 — 006: plans, subscriptions, payments, billing events.
-- These are platform tables (like accounts/memberships): the billing service always filters by business_id explicitly.

CREATE TABLE plans (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(30) NOT NULL UNIQUE,
  name         VARCHAR(60) NOT NULL,
  price_paise  INT NOT NULL CHECK (price_paise >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'INR',
  interval_days INT NOT NULL DEFAULT 30 CHECK (interval_days > 0),
  -- limits and features live here and nowhere else (null limit = unlimited)
  features     JSONB NOT NULL,
  highlights   JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_plans_upd BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO plans (code, name, price_paise, features, highlights, sort_order) VALUES
 ('starter',  'Starter',  9900,  '{"maxUsers":2,"maxProducts":500,"maxStores":1,"aiInsights":false,"advancedReports":false,"advancedAi":false}',
   '["1 store","2 users","Up to 500 products","Basic reports"]', 1),
 ('business', 'Business', 19900, '{"maxUsers":5,"maxProducts":null,"maxStores":1,"aiInsights":true,"advancedReports":true,"advancedAi":false}',
   '["1 store","5 users","Unlimited products","Advanced reports","AI insights"]', 2),
 ('pro',      'Pro',      39900, '{"maxUsers":25,"maxProducts":null,"maxStores":5,"aiInsights":true,"advancedReports":true,"advancedAi":true}',
   '["Up to 25 users","Unlimited products","Advanced AI","Advanced analytics","Multiple stores (coming soon)"]', 3);

CREATE TABLE subscriptions (
  id                        SERIAL PRIMARY KEY,
  business_id               INT NOT NULL UNIQUE REFERENCES businesses(id),
  plan_id                   INT NOT NULL REFERENCES plans(id),
  pending_plan_id           INT REFERENCES plans(id),          -- scheduled downgrade, applied at the next renewal
  status                    VARCHAR(12) NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','expired')),
  start_date                TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_date                  TIMESTAMPTZ,                       -- end of the paid period
  trial_start               TIMESTAMPTZ,
  trial_end                 TIMESTAMPTZ,
  cancel_at_period_end      BOOLEAN NOT NULL DEFAULT FALSE,
  provider_customer_id      VARCHAR(80),
  provider_subscription_id  VARCHAR(80),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subscriptions_upd BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id                   SERIAL PRIMARY KEY,
  business_id          INT NOT NULL REFERENCES businesses(id),
  subscription_id      INT REFERENCES subscriptions(id),
  plan_id              INT NOT NULL REFERENCES plans(id),
  amount_paise         INT NOT NULL CHECK (amount_paise >= 0),
  currency             CHAR(3) NOT NULL DEFAULT 'INR',
  status               VARCHAR(10) NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  provider             VARCHAR(20) NOT NULL,
  provider_order_id    VARCHAR(80) NOT NULL UNIQUE,
  provider_payment_id  VARCHAR(80) UNIQUE,
  verified_by          VARCHAR(10) CHECK (verified_by IN ('client','webhook')),   -- which server-side path confirmed it
  failure_reason       VARCHAR(200),
  created_by           INT REFERENCES accounts(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at              TIMESTAMPTZ
);
CREATE INDEX idx_payments_business ON payments(business_id, created_at DESC);

CREATE TABLE billing_events (
  id                 BIGSERIAL PRIMARY KEY,
  business_id        INT REFERENCES businesses(id),
  type               VARCHAR(60) NOT NULL,
  provider_event_id  VARCHAR(100) UNIQUE,         -- makes webhook delivery idempotent
  payload            JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_events_business ON billing_events(business_id, created_at DESC);

-- Existing businesses (created in Phase 1) get a trial on the Business plan.
INSERT INTO subscriptions (business_id, plan_id, status, start_date, end_date, trial_start, trial_end)
SELECT b.id, (SELECT id FROM plans WHERE code = 'business'), 'trialing', now(), now() + interval '14 days', now(), now() + interval '14 days'
  FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = b.id);

GRANT SELECT, INSERT, UPDATE, DELETE ON plans, subscriptions, payments, billing_events TO sharkpos2_app;
REVOKE DELETE ON payments, billing_events FROM sharkpos2_app;   -- financial records are never deleted
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sharkpos2_app;
