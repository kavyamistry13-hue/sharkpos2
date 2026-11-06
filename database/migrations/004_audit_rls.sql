-- SHARKPOS 2 — 004: audit logs can be read only inside their own business (writes are allowed from any context).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read_own  ON audit_logs FOR SELECT USING (business_id = current_business_id());
CREATE POLICY audit_insert_any ON audit_logs FOR INSERT WITH CHECK (true);
