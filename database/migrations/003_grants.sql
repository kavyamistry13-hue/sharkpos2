-- SHARKPOS 2 — 003: least-privilege grants for the runtime role (sharkpos2_app). It owns nothing and cannot bypass RLS.
GRANT USAGE ON SCHEMA public TO sharkpos2_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sharkpos2_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sharkpos2_app;
-- audit logs are append-only for the application
REVOKE UPDATE, DELETE ON audit_logs FROM sharkpos2_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sharkpos2_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sharkpos2_app;
