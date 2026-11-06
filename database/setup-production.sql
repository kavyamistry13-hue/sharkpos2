-- One-time production setup. Run as the managed database's admin user BEFORE the first migration:
--   psql "$ADMIN_DATABASE_URL" -v app_password="$APP_DB_PASSWORD" -v backup_password="$BACKUP_DB_PASSWORD" -v dbname=sharkpos2 -f database/setup-production.sql
-- The admin user becomes the schema owner and is used only for migrations (MIGRATION_DATABASE_URL). The API runs as sharkpos2_app,
-- which owns nothing and cannot bypass row-level security. Database name must start with "sharkpos2".
CREATE ROLE sharkpos2_app    LOGIN PASSWORD :'app_password'    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE sharkpos2_backup LOGIN PASSWORD :'backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"dbname" TO sharkpos2_app, sharkpos2_backup;
