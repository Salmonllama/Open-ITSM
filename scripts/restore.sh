#!/usr/bin/env bash
# Restores an Open ITSM backup archive (.tar.gz) into this Docker Compose installation.
#
# Usage:
#   ./scripts/restore.sh <backup-file.tar.gz> [--yes]
set -euo pipefail

YES=0
ARCHIVE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    -h|--help)
      echo "Usage: $0 <backup-file.tar.gz> [--yes]"
      exit 0
      ;;
    *)
      if [ -z "$ARCHIVE" ]; then
        ARCHIVE="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Error: pass the path to an Open ITSM .tar.gz backup file." >&2
  echo "Usage: $0 <backup-file.tar.gz> [--yes]" >&2
  exit 2
fi

if [ ! -f "compose.yml" ] || [ ! -f ".env" ]; then
  echo "Error: run this script from the Open ITSM install folder containing compose.yml and .env." >&2
  exit 1
fi

ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

# Validate archive contents before stopping anything.
STAGE="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

echo "Checking backup archive..."
tar -xzf "$ARCHIVE" -C "$STAGE"
if [ ! -f "$STAGE/database.dump" ]; then
  echo "Error: $ARCHIVE is missing database.dump and is not a valid Open ITSM backup." >&2
  exit 1
fi
if [ -f "$STAGE/manifest.json" ]; then
  cat "$STAGE/manifest.json"
fi

if [ "$YES" -ne 1 ]; then
  echo ""
  echo "WARNING: This will replace the current database and ticket attachments in this install."
  printf "Type 'restore' to continue: "
  read -r confirm
  if [ "$confirm" != "restore" ]; then
    echo "Cancelled."
    exit 1
  fi
fi

echo "Stopping app container..."
docker compose stop app

echo "Ensuring database container is running..."
docker compose up -d --wait db

echo "Resetting database 'itsm'..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U itsm -d postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'itsm' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS itsm;
CREATE DATABASE itsm OWNER itsm;
SQL

echo "Restoring database from backup..."
docker compose exec -T db pg_restore \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  -U itsm \
  -d itsm < "$STAGE/database.dump"

echo "Restoring attachments volume..."
if [ -d "$STAGE/attachments" ]; then
  tar -czf - -C "$STAGE/attachments" . | \
    docker compose run --rm --no-deps --entrypoint sh -T app \
      -c 'rm -rf /data/attachments/* /data/attachments/.[!.]* && tar -xzf - -C /data/attachments'
else
  docker compose run --rm --no-deps --entrypoint sh -T app \
    -c 'rm -rf /data/attachments/* /data/attachments/.[!.]*'
fi

echo "Starting app container..."
docker compose up -d --wait app

echo "Restore complete. Check the status page or run: docker compose logs app"
