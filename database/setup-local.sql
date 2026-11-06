-- One-time local setup (run as a PostgreSQL superuser, e.g. `psql -U postgres -f database/setup-local.sql`).
-- Creates SEPARATE roles and databases for SHARKPOS 2. It never touches the original "sharkpos" database.
CREATE ROLE sharkpos2_owner LOGIN PASSWORD 'owner_dev_pw' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sharkpos2_app   LOGIN PASSWORD 'app_dev_pw'   NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sharkpos2_backup LOGIN PASSWORD 'backup_dev_pw' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE sharkpos2      OWNER sharkpos2_owner;
CREATE DATABASE sharkpos2_test OWNER sharkpos2_owner;
REVOKE ALL ON DATABASE sharkpos2      FROM PUBLIC;
REVOKE ALL ON DATABASE sharkpos2_test FROM PUBLIC;
GRANT CONNECT ON DATABASE sharkpos2      TO sharkpos2_app;
GRANT CONNECT ON DATABASE sharkpos2_test TO sharkpos2_app;
GRANT CONNECT ON DATABASE sharkpos2      TO sharkpos2_backup;
GRANT CONNECT ON DATABASE sharkpos2_test TO sharkpos2_backup;
