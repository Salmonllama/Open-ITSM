#!/usr/bin/env bash
# Builds the image from this checkout, starts the full stack on https://localhost
# with throwaway secrets, and checks /healthz through Caddy. Used by CI.
set -euo pipefail

cd "$(dirname "$0")/.."
env_file="$(mktemp)"
compose=(docker compose --env-file "$env_file" -f compose.yml -f compose.build.yml)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" ps || true
    "${compose[@]}" logs --no-color || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

cat >"$env_file" <<ENV
OPEN_ITSM_VERSION=smoke
APP_HOSTNAME=localhost
CADDY_GLOBAL_OPTIONS=
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_SECRET_KEY=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 48)
LOG_LEVEL=info
ENV

"${compose[@]}" up -d --build --wait --wait-timeout 180

# Caddy issues the localhost certificate from its internal CA, so skip verification here.
body=""
for _ in $(seq 1 30); do
  if body="$(curl -fsSk https://localhost/healthz)"; then
    break
  fi
  sleep 2
done
echo "healthz: $body"
echo "$body" | grep -q '"status":"ok"'
