#!/usr/bin/env bash
#
# EXP-23 AC-6. Backs up an expenses-recorder deployment into ONE archive.
#
# Both volumes, always. Since EXP-13 the receipt images live in the
# `receipts-data` volume rather than in Postgres, so a pg_dump on its own
# restores expense records that point at images which no longer exist — a
# 7-year archive whose whole purpose is producing the original document.
#
#   ./scripts/backup.sh                      # writes ./backups/<timestamp>.tar.gz
#   ./scripts/backup.sh /mnt/disk            # writes there instead
#
# Restore is documented in docs/deploy.md. An untested backup is not a backup.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${DEST}/expenses-${STAMP}.tar.gz"

cd "$(dirname "$0")/.."

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "error: $COMPOSE_FILE not found; run this from the deployment checkout" >&2
  exit 1
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# The database must be up to dump it. The API need not be.
if ! compose ps --status running --services | grep -qx postgres; then
  echo "error: the postgres service is not running; start the stack first" >&2
  exit 1
fi

mkdir -p "$DEST"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> Dumping the database"
# --clean --if-exists so the dump can be replayed into a database that already
# has a schema, which is what a restore into a fresh stack produces after
# migrations have run.
compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-expenses}" \
  --dbname "${POSTGRES_DB:-expenses}" \
  --clean --if-exists \
  > "${STAGING}/database.sql"

echo "==> Copying the receipt images"
# Borrow the api container's mounts rather than naming the volume: compose
# prefixes volume names with the project, which varies by directory name, and
# guessing it wrong would silently back up an empty directory. --volumes-from
# needs the container to exist, not to be running.
API_CONTAINER="$(compose ps -aq api)"

if [ -z "$API_CONTAINER" ]; then
  echo "error: no api container found; the receipts volume cannot be located" >&2
  exit 1
fi

docker run --rm \
  --volumes-from "$API_CONTAINER" \
  -v "${STAGING}:/out" \
  alpine:3 tar -czf /out/receipts.tar.gz -C /data/receipts .

echo "==> Writing ${ARCHIVE}"
tar -czf "$ARCHIVE" -C "$STAGING" database.sql receipts.tar.gz

# A silent zero-byte archive is the classic backup failure. Report the sizes so
# an obviously empty one is visible at the moment it is taken.
echo
echo "Wrote $ARCHIVE"
ls -lh "$ARCHIVE" | awk '{print "  archive:  " $5}'
du -h "${STAGING}/database.sql" | awk '{print "  database: " $1}'
du -h "${STAGING}/receipts.tar.gz" | awk '{print "  receipts: " $1}'
echo
echo "Restore instructions: docs/deploy.md"
