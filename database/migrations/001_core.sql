-- SHARKPOS 2 — 001: platform tables (global, not tenant-owned) + helpers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- The current tenant for this connection/transaction. Unset => NULL => RLS matches nothing (fail closed).
CREATE OR REPLACE FUNCTION current_business_id() RETURNS int AS $$
  SELECT nullif(current_setting('app.business_id', true), '')::int
$$ LANGUAGE sql STABLE;

CREATE TABLE businesses (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(80)  NOT NULL UNIQUE,
  email       VARCHAR(190),
  phone       VARCHAR(20),
  address     VARCHAR(300),
  gstin       VARCHAR(20),
  status      VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_demo     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- Accounts are people who can sign in. One account may belong to several businesses.
CREATE TABLE accounts (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(120) NOT NULL,
  email              VARCHAR(190) NOT NULL,
  phone              VARCHAR(20),
  password_hash      VARCHAR(100) NOT NULL,
  is_platform_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins      INT NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_accounts_email ON accounts (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE memberships (
  id           SERIAL PRIMARY KEY,
  business_id  INT NOT NULL REFERENCES businesses(id),
  account_id   INT NOT NULL REFERENCES accounts(id),
  role         VARCHAR(20) NOT NULL CHECK (role IN ('business_owner', 'manager', 'cashier')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (business_id, account_id)
);
CREATE INDEX idx_memberships_account ON memberships(account_id);

-- Refresh-token sessions (only a hash of the token is stored)
CREATE TABLE sessions (
  id            UUID PRIMARY KEY,
  account_id    INT NOT NULL REFERENCES accounts(id),
  business_id   INT REFERENCES businesses(id),
  token_hash    CHAR(64) NOT NULL UNIQUE,
  user_agent    VARCHAR(300),
  ip            VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  business_id  INT REFERENCES businesses(id),
  account_id   INT REFERENCES accounts(id),
  actor_name   VARCHAR(120),
  action       VARCHAR(60) NOT NULL,
  entity_type  VARCHAR(40),
  entity_id    VARCHAR(40),
  summary      VARCHAR(300),
  old_value    JSONB,
  new_value    JSONB,
  ip           VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_business_time ON audit_logs(business_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(business_id, action);

CREATE TRIGGER trg_businesses_upd  BEFORE UPDATE ON businesses  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_accounts_upd    BEFORE UPDATE ON accounts    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_memberships_upd BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenant-scoped staff view: what the original code called "users", limited to the current business.
CREATE VIEW users AS
  SELECT a.id, a.name, a.email, m.role, (m.is_active AND a.is_active) AS is_active, a.password_hash, a.created_at
    FROM accounts a JOIN memberships m ON m.account_id = a.id
   WHERE m.business_id = current_business_id() AND m.deleted_at IS NULL AND a.deleted_at IS NULL;
