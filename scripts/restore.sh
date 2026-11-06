#!/usr/bin/env bash
# SHARKPOS 2 — restore an encrypted backup into a database.
#   Usage: BACKUP_PASSPHRASE=... TARGET_DATABASE_URL=postgres://sharkpos2_owner:...@host/sharkpos2_restore scripts/restore.sh <backup-file>
# Always restore into a NEW, EMPTY database first (e.g. sharkpos2_restore), check it, and only then switch the app to it.
# Connect as the OWNER role (sharkpos2_owner) so the restored objects belong to it. The runtime role keeps its least-privilege grants from the dump.
# Safety: refuses non-"sharkpos2*" databases and refuses a database that already has tables, unless OVERWRITE=yes.
set -euo pipefail
FILE="${1:?Usage: restore.sh <backup-file>}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE}"
[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }
DB_NAME="$(node -e 'console.log(decodeURIComponent(new URL(process.env.TARGET_DATABASE_URL).pathname.slice(1)))')"
case "$DB_NAME" in sharkpos2*) ;; *) echo "Refusing: \"$DB_NAME\" is not a SHARKPOS 2 database." >&2; exit 1;; esac

EXISTING="$(psql "$TARGET_DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$EXISTING" != "0" ] && [ "${OVERWRITE:-no}" != "yes" ]; then
  echo "Refusing: \"$DB_NAME\" already has $EXISTING tables. Restore into an empty database, or set OVERWRITE=yes if you really mean to replace it." >&2; exit 1
fi
CLEAN=(); [ "${OVERWRITE:-no}" = "yes" ] && CLEAN=(--clean --if-exists)

echo "Restoring $(basename "$FILE") into \"$DB_NAME\" …"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | pg_restore --no-owner --exit-on-error "${CLEAN[@]}" -d "$TARGET_DATABASE_URL"

# Tenant tables use FORCED row-level security: the owner role sees 0 rows in them. Count with the backup role (BYPASSRLS) via VERIFY_DATABASE_URL.
VERIFY="${VERIFY_DATABASE_URL:-$TARGET_DATABASE_URL}"
echo "Row counts in the restored database:"
for t in businesses accounts memberships subscriptions payments products sales audit_logs; do
  printf '  %-15s %s\n' "$t" "$(psql "$VERIFY" -Atc "SELECT count(*) FROM $t")"
done
[ -z "${VERIFY_DATABASE_URL:-}" ] && echo "  (tenant tables such as products/sales show 0 for the owner role by design — set VERIFY_DATABASE_URL to the sharkpos2_backup URL to see real counts.)"
echo "Restore complete. Next: run 'npm run migrate -- --status' against it and point a staging copy of the API at it before going live."
