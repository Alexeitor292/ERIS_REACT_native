#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy/podman"
ERIS_BIND_IP="${ERIS_BIND_IP:-127.0.0.1}"
for file in images.env db.env storage.env app.env; do
  [[ -f "$DEPLOY/$file" ]] || { echo "Missing $DEPLOY/$file" >&2; exit 2; }
done
config_files=("$DEPLOY/images.env" "$DEPLOY/db.env" "$DEPLOY/storage.env" "$DEPLOY/app.env")
if [[ -f "$DEPLOY/bootstrap.env" ]]; then config_files+=("$DEPLOY/bootstrap.env"); fi
if awk '/^[[:space:]]*#/ {next} /CHANGE_ME|example[.]gov|00000000-0000-0000-0000-000000000000/ {found=1} END {exit !found}' "${config_files[@]}"; then
  echo "Deployment configuration still contains example values" >&2
  exit 2
fi
set -a
# images.env contains image references, not secrets.
source "$DEPLOY/images.env"
set +a
for name in ERIS_API_IMAGE ERIS_WORKER_IMAGE ERIS_WEB_IMAGE ERIS_DB_IMAGE ERIS_STORAGE_IMAGE; do
  [[ -n "${!name:-}" ]] || { echo "Missing $name" >&2; exit 2; }
done

run_tool() {
  podman run --rm --pod eris --env-file "$DEPLOY/app.env" "$ERIS_API_IMAGE" "$@"
}

case "${1:-}" in
  up)
    if podman pod exists eris; then echo "Pod eris exists; use status or an explicit stop/update." >&2; exit 2; fi
    podman volume create eris-mariadb >/dev/null
    podman volume create eris-seaweedfs >/dev/null
    podman pod create --name eris -p "${ERIS_BIND_IP}:8080:80" -p "${ERIS_BIND_IP}:9800:8333" >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-mariadb --env-file "$DEPLOY/db.env" \
      -v eris-mariadb:/var/lib/mysql -v "$ROOT/database/init:/docker-entrypoint-initdb.d:ro,Z" "$ERIS_DB_IMAGE" >/dev/null
    ready=0
    for _ in $(seq 1 90); do
      if podman exec eris-mariadb healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then ready=1; break; fi
      sleep 2
    done
    [[ "$ready" == 1 ]] || { podman logs eris-mariadb; exit 1; }
    # The entrypoint healthcheck can pass while init SQL is still finishing.
    seeded=0
    for _ in $(seq 1 60); do
      if run_tool python -c "from app.db import engine; from sqlalchemy import text; c=engine.connect(); assert c.execute(text('SELECT COUNT(*) FROM roles')).scalar() > 0; c.close()" >/dev/null 2>&1; then
        seeded=1; break
      fi
      sleep 2
    done
    [[ "$seeded" == 1 ]] || { echo "MariaDB init SQL did not seed roles" >&2; exit 1; }
    podman run -d --restart=unless-stopped --pod eris --name eris-seaweedfs --env-file "$DEPLOY/storage.env" \
      -v eris-seaweedfs:/data "$ERIS_STORAGE_IMAGE" mini -dir=/data >/dev/null
    run_tool python -m app.tools.prepare_database
    run_tool python -m app.storage_bootstrap
    if [[ -f "$DEPLOY/bootstrap.env" ]]; then
      podman run --rm --pod eris --env-file "$DEPLOY/app.env" --env-file "$DEPLOY/bootstrap.env" \
        "$ERIS_API_IMAGE" python -m app.tools.bootstrap_initial_admin
    else
      run_tool python -m app.tools.bootstrap_initial_admin
    fi
    podman run -d --restart=unless-stopped --pod eris --name eris-api --env-file "$DEPLOY/app.env" "$ERIS_API_IMAGE" >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-worker --env-file "$DEPLOY/app.env" \
      "$ERIS_WORKER_IMAGE" python -m app.worker.offline_scene_worker >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-web "$ERIS_WEB_IMAGE" >/dev/null
    echo "ERIS pod started on ${ERIS_BIND_IP}:8080 (web/API) and :9800 (S3)."
    ;;
  status)
    podman pod ps --filter name=eris
    podman ps --filter pod=eris
    ;;
  start)
    if podman pod exists eris; then podman pod start eris; else "$0" up; fi
    ;;
  logs)
    podman logs "eris-${2:-api}"
    ;;
  stop)
    podman pod stop eris
    ;;
  remove)
    podman pod rm -f eris
    echo "Pod removed. Named data volumes remain."
    ;;
  *)
    echo "Usage: $0 {up|start|status|logs [api|web|mariadb|seaweedfs|worker]|stop|remove}" >&2
    exit 2
    ;;
esac
