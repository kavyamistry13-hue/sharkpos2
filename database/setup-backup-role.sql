-- Backup role: read-only. Created BEFORE running migrations (migration 007 gives it SELECT + read policies).
-- Run once per database server as the admin/owner user. Replace the password and the database name (must start with sharkpos2).
CREATE ROLE sharkpos2_backup LOGIN PASSWORD 'CHANGE-ME-long-random' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE sharkpos2 TO sharkpos2_backup;
