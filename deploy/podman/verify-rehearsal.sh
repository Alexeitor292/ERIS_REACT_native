#!/usr/bin/env bash
# Read-only checks for the automatically verifiable part of a staging rehearsal.
set -euo pipefail

base_url="${1:?Usage: verify-rehearsal.sh https://eris-stage.example.gov}"
base_url="${base_url%/}"
for container in eris-mariadb eris-seaweedfs eris-api eris-worker eris-web; do
  state="$(podman inspect --format '{{.State.Running}}' "$container")"
  [[ "$state" == true ]] || { echo "$container is not running" >&2; exit 1; }
done
curl --fail --silent --show-error "$base_url/healthz" >/dev/null
curl --fail --silent --show-error "$base_url/api/health" >/dev/null
podman exec eris-api python -c 'from app.migrations_check import check_migration_head; check_migration_head()'
echo "Five containers running; HTTPS web/API health passed; database is at Alembic head."
