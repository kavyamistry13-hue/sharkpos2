-- SHARKPOS 2 — 007: read-only access for the backup role (sharkpos2_backup).
-- Tenant tables use FORCED row-level security, so a plain dump would contain zero rows. Instead of needing BYPASSRLS
-- (superuser-only on most managed databases), the backup role gets SELECT plus an extra read-only policy on each tenant table.
-- It cannot insert, update or delete anything, and the application role is unaffected.
-- The role itself is created by database/setup-production.sql (or setup-local.sql for development).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sharkpos2_backup') THEN
    RAISE EXCEPTION 'Role sharkpos2_backup does not exist. Run database/setup-production.sql (or setup-local.sql) first.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sharkpos2_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sharkpos2_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO sharkpos2_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sharkpos2_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO sharkpos2_backup;

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation' LOOP
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO sharkpos2_backup USING (true)', t);
  END LOOP;
END $$;
CREATE POLICY backup_read ON audit_logs FOR SELECT TO sharkpos2_backup USING (true);
