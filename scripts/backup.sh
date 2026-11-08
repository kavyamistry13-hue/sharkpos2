#!/usr/bin/env bash
# SHARKPOS 2 — encrypted logical backup of the production database.
#   Required env : BACKUP_DATABASE_URL  (role sharkpos2_backup — read-only, see database/setup-production.sql)
#                  BACKUP_PASSPHRASE    (>= 20 chars; keep a copy in your password manager — without it backups cannot be read)
#   Where to send it (pick one): BACKUP_GH_REPO=owner/private-repo + GH_TOKEN   |   BACKUP_S3_URI (s3://bucket/prefix)
#   Optional env : BACKUP_DIR (default ./backups)   BACKUP_S3_URI (s3://bucket/prefix)   AWS_ENDPOINT_URL (Cloudflare R2 / Backblaze B2 / MinIO)
#                  KEEP_DAILY=14 KEEP_WEEKLY=8 KEEP_MONTHLY=12
# The dump is verified (decrypted and listed) before it counts as a success. Nothing here writes to the database.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BACKUP_DATABASE_URL:?Set BACKUP_DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE}"
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || { echo "BACKUP_PASSPHRASE must be at least 20 characters." >&2; exit 1; }
DB_NAME="$(node -e 'console.log(decodeURIComponent(new URL(process.env.BACKUP_DATABASE_URL).pathname.slice(1)))')"
case "$DB_NAME" in sharkpos2*) ;; *) echo "Refusing: database \"$DB_NAME\" is not a SHARKPOS 2 database." >&2; exit 1;; esac

DIR="${BACKUP_DIR:-./backups}"; mkdir -p "$DIR"
NAME="sharkpos2-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
OUT="$DIR/$NAME"

# Runs "$1 <line>" for every non-empty input line (a plain `[ -n ] && cmd` loop would exit non-zero on the trailing blank line).
each_line() { local f="$1" line; while IFS= read -r line; do if [ -n "$line" ]; then "$f" "$line"; fi; done; }
OK=0; TMP="$(mktemp)"
trap '[ "$OK" = 1 ] || rm -f "$OUT"; rm -f "$TMP"' EXIT   # a failed or unverified backup never stays on disk
echo "Backing up \"$DB_NAME\" → $NAME"
# -Fc: compressed custom format (restorable table by table). --no-owner: restore sets ownership to whoever restores.
pg_dump "$BACKUP_DATABASE_URL" -Fc --no-owner --enable-row-security \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT"

# Verify: the file must decrypt and contain a table of contents with data entries for the key tables.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$OUT" -out "$TMP"
TOC="$(pg_restore --list "$TMP")"
for t in accounts businesses subscriptions payments sales; do
  echo "$TOC" | grep -q "TABLE public $t " || { echo "Verification failed: no table entry for $t in the backup." >&2; exit 1; }
done
OK=1
echo "Verified: $(du -h "$OUT" | cut -f1) encrypted, $(echo "$TOC" | grep -c 'TABLE DATA') tables with data."

if [ -n "${BACKUP_GH_REPO:-}" ]; then
  # Free option: a PRIVATE GitHub repository used only as a vault for the encrypted files (one release per backup).
  # GH_TOKEN = fine-grained token limited to that single repo with "Contents: read & write". The files are AES-256 encrypted before they leave this machine.
  TAG="${NAME%.dump.enc}"
  gh release create "$TAG" "$OUT" --repo "$BACKUP_GH_REPO" --title "$TAG" --notes "Encrypted SHARKPOS 2 database backup" >/dev/null
  echo "Uploaded to GitHub repo $BACKUP_GH_REPO (release $TAG)"
  del_gh() { gh release delete "${1%.dump.enc}" --repo "$BACKUP_GH_REPO" --yes --cleanup-tag >/dev/null && echo "Pruned $1"; }
  gh release list --repo "$BACKUP_GH_REPO" --limit 1000 --json tagName --jq '.[].tagName' | sed 's/$/.dump.enc/' | node scripts/backup-prune.js | each_line del_gh
elif [ -n "${BACKUP_S3_URI:-}" ]; then
  EP=(); [ -n "${AWS_ENDPOINT_URL:-}" ] && EP=(--endpoint-url "$AWS_ENDPOINT_URL")
  aws "${EP[@]}" s3 cp "$OUT" "${BACKUP_S3_URI%/}/$NAME" --only-show-errors
  echo "Uploaded to ${BACKUP_S3_URI%/}/$NAME"
  # Retention: keep newest of each of the last $KEEP_DAILY days / $KEEP_WEEKLY weeks / $KEEP_MONTHLY months.
  del_s3() { aws "${EP[@]}" s3 rm "${BACKUP_S3_URI%/}/$1" --only-show-errors && echo "Pruned $1"; }
  aws "${EP[@]}" s3 ls "${BACKUP_S3_URI%/}/" | awk '{print $4}' | node scripts/backup-prune.js | each_line del_s3
else
  echo "Neither BACKUP_GH_REPO nor BACKUP_S3_URI set: backup kept only in $DIR (copy it off this machine!)."
  del_local() { rm -f "$DIR/$1" && echo "Pruned $1"; }
  ls "$DIR" | node scripts/backup-prune.js | each_line del_local
fi
echo "Backup complete."
