-- SHARKPOS 2 — 008: idempotent sale submission.
-- Every "Complete sale" carries a client-generated Idempotency-Key (UUID). The key is CLAIMED in the same transaction that creates the
-- sale and deducts stock, so either all of it exists (key + sale + stock + ledger) or none of it does.
--   * PRIMARY KEY (business_id, idempotency_key): the database itself refuses a second claim. A concurrent request with the same key
--     waits on the unique index until the first one commits, then sees the conflict and returns the original sale.
--   * request_hash: SHA-256 of the canonical sale payload (items, discount, customer, payment method, cashier). Reusing a key with a
--     different payload is detected and rejected instead of silently returning an unrelated sale.
--   * A request that FAILS rolls back, including its claim, so a corrected retry with the same key can succeed (nothing happened).
CREATE TABLE sale_requests (
  business_id      INT NOT NULL DEFAULT current_business_id() REFERENCES businesses(id),
  idempotency_key  UUID NOT NULL,
  request_hash     CHAR(64) NOT NULL,
  employee_id      INT NOT NULL REFERENCES accounts(id),
  sale_id          INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, idempotency_key),
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id),
  UNIQUE (business_id, sale_id)            -- one sale can never be linked to two keys
);
CREATE INDEX idx_sale_requests_created ON sale_requests (created_at);   -- for a future "purge keys older than N days" job

ALTER TABLE sale_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_requests USING (business_id = current_business_id()) WITH CHECK (business_id = current_business_id());
CREATE POLICY backup_read ON sale_requests FOR SELECT TO sharkpos2_backup USING (true);

-- Default privileges would also grant DELETE; the claim record is part of the sales trail, so take it away explicitly.
REVOKE DELETE, TRUNCATE ON sale_requests FROM sharkpos2_app;
