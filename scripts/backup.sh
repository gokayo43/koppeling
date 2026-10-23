#!/usr/bin/env bash
# Nightly Postgres backup: pg_dump -> gzip -> age -> Cloudflare R2.
#
#   sudo scripts/backup.sh
#
# Driven by scripts/backup.timer. Encryption is to a PUBLIC age key, and the
# private half is on this box as well so the weekly drill can run unattended —
# what that protects and what it does not is README, "Backups".
#
# Requires on the host: docker, age, aws (any S3-compatible client), and the
# variables below — read from the repo's .env.
set -euo pipefail

# A dump is a full copy of production. Restrict it from creation.
umask 077

# shellcheck source=scripts/stack.sh
. "$(dirname "${BASH_SOURCE[0]}")/stack.sh"
load_env_file "$REPO_DIR/.env"

STAGING_DIR="${STAGING_DIR:-$REPO_DIR/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
DB_SERVICE="${DB_SERVICE:-postgres}"
DB_USER="${DB_USER:-project_template}"
DB_NAME="${DB_NAME:-project_template}"

: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT (age public key) in .env}"
: "${BACKUP_R2_BUCKET:?set BACKUP_R2_BUCKET in .env}"
: "${BACKUP_R2_ENDPOINT:?set BACKUP_R2_ENDPOINT in .env}"

mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$STAGING_DIR/$DB_NAME-$ts.sql.gz.age"

echo "[backup] dumping $DB_NAME"
# --clean --if-exists makes the dump restorable over an existing schema. The
# pipeline is one pass: plaintext never touches the disk.
$DOCKER compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$out"

size=$(stat -c%s "$out")
# An empty or near-empty artefact means the dump failed upstream in the pipe;
# `set -o pipefail` catches most of it, an encrypted zero-row dump is the rest.
if [ "$size" -lt 1000 ]; then
  echo "[backup] ERROR: artefact is only ${size} bytes — treating as a failure" >&2
  rm -f "$out"
  exit 1
fi
echo "[backup] wrote ${size} bytes to $out"

echo "[backup] uploading to r2://$BACKUP_R2_BUCKET/$BACKUP_PREFIX"
# Under this stack's own prefix, which is the only thing the drill will read
# back: a bucket holds more than one product's archives, and a drill that took
# the newest object in the whole of it restored whatever was written last.
aws s3 cp "$out" "s3://$BACKUP_R2_BUCKET/$BACKUP_PREFIX$(basename "$out")" \
  --endpoint-url "$BACKUP_R2_ENDPOINT" \
  --only-show-errors

find "$STAGING_DIR" -name "$DB_NAME-*.sql.gz.age" -mtime "+$RETAIN_DAYS" -delete
echo "[backup] done; local staging keeps ${RETAIN_DAYS}d"
