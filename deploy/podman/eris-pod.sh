#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy/podman"
ERIS_BIND_IP="${ERIS_BIND_IP:-127.0.0.1}"
# The volumes in use. An explicit environment value wins; otherwise
# volumes.env, which an automatic rollback writes after restoring a backup
# into new volumes, so systemd and later commands follow it.
active_volume() {
  [[ -f "$DEPLOY/volumes.env" ]] || return 0
  sed -n "s/^$1=\([A-Za-z0-9][A-Za-z0-9_.-]*\)$/\1/p" "$DEPLOY/volumes.env" | tail -n 1
}
ERIS_DB_VOLUME="${ERIS_DB_VOLUME:-$(active_volume ERIS_DB_VOLUME)}"
ERIS_DB_VOLUME="${ERIS_DB_VOLUME:-eris-mariadb}"
ERIS_STORAGE_VOLUME="${ERIS_STORAGE_VOLUME:-$(active_volume ERIS_STORAGE_VOLUME)}"
ERIS_STORAGE_VOLUME="${ERIS_STORAGE_VOLUME:-eris-seaweedfs}"
CONFIG_NAMES=(images.env db.env storage.env app.env)
for file in "${CONFIG_NAMES[@]}"; do
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
IMAGE_VARS=(ERIS_API_IMAGE ERIS_WORKER_IMAGE ERIS_WEB_IMAGE ERIS_DB_IMAGE ERIS_STORAGE_IMAGE)
for name in "${IMAGE_VARS[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Missing $name" >&2; exit 2; }
  # Production pins the five approved Harbor digests, so a re-pushed tag cannot
  # change what runs. Set ERIS_REQUIRE_DIGESTS=true in images.env to enforce it.
  if [[ "${ERIS_REQUIRE_DIGESTS:-false}" == true && "${!name}" != *@sha256:* ]]; then
    echo "$name must be pinned by digest (name@sha256:...) when ERIS_REQUIRE_DIGESTS=true" >&2
    exit 2
  fi
done
CONTAINERS=(eris-mariadb eris-seaweedfs eris-api eris-worker eris-web)
BACKUP_FORMAT=eris-backup-v1
# Files the API reads but that never belong in an env file: the Entra
# certificate and private key. Mounted read-only into the API container only.
SECRETS_DIR="$DEPLOY/secrets"
api_secret_mount=()
if [[ -d "$SECRETS_DIR" ]]; then
  if [[ -n "$(find "$SECRETS_DIR" -perm /077 2>/dev/null | head -n 1)" ]]; then
    echo "$SECRETS_DIR must be private: chmod 700 the directory and 600 its files" >&2
    exit 2
  fi
  api_secret_mount=(-v "$SECRETS_DIR:/run/secrets/eris:ro,Z")
fi

run_tool() {
  podman run --rm --pod eris --env-file "$DEPLOY/app.env" "$ERIS_API_IMAGE" "$@"
}

wait_for_api() {
  for _ in $(seq 1 "${ERIS_API_WAIT_ATTEMPTS:-90}"); do
    if curl --fail --silent "http://${ERIS_BIND_IP}:8080/api/health" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "ERIS API did not become healthy on ${ERIS_BIND_IP}:8080" >&2
  podman logs --tail 40 eris-api >&2 || true
  return 1
}

# A release file is sourced, so it must be exactly the five pinned image
# references (and optionally ERIS_REQUIRE_DIGESTS=true) and nothing else:
# no shell syntax can reach `source` from a file Jenkins sent.
check_release_file() {
  local file="$1" name
  [[ -f "$file" && -s "$file" ]] || { echo "Release file $file is missing or empty" >&2; return 1; }
  if grep -vE '^(#[^`$]*)?$|^ERIS_(API|WORKER|WEB|DB|STORAGE)_IMAGE=[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$|^ERIS_REQUIRE_DIGESTS=true$' \
      "$file" | grep -q .; then
    echo "Release file $file contains lines other than five pinned image digests" >&2
    return 1
  fi
  for name in "${IMAGE_VARS[@]}"; do
    [[ "$(grep -c "^$name=" "$file")" == 1 ]] || { echo "Release file must name $name exactly once" >&2; return 1; }
  done
}

release_log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$DEPLOY/releases.log"
}

same_file() {
  [[ "$(sha256sum < "$1")" == "$(sha256sum < "$2")" ]]
}

# Checks a backup directory written by `backup`; prints nothing secret.
verify_backup() {
  local dir="$1" file
  for file in manifest.env SHA256SUMS mariadb.tar seaweedfs.tar "${CONFIG_NAMES[@]/#/config/}"; do
    [[ -f "$dir/$file" ]] || { echo "Backup is incomplete: missing $file" >&2; return 1; }
  done
  grep -qx "format=$BACKUP_FORMAT" "$dir/manifest.env" || { echo "Not an $BACKUP_FORMAT backup" >&2; return 1; }
  (cd "$dir" && sha256sum --check --quiet SHA256SUMS) || { echo "Backup checksum mismatch" >&2; return 1; }
  for file in mariadb.tar seaweedfs.tar; do
    tar -tf "$dir/$file" >/dev/null || { echo "$file is not a readable tar archive" >&2; return 1; }
  done
}

case "${1:-}" in
  up)
    if podman pod exists eris; then echo "Pod eris exists; use status or an explicit stop/update." >&2; exit 2; fi
    podman volume exists "$ERIS_DB_VOLUME" || podman volume create "$ERIS_DB_VOLUME" >/dev/null
    podman volume exists "$ERIS_STORAGE_VOLUME" || podman volume create "$ERIS_STORAGE_VOLUME" >/dev/null
    podman pod create --name eris -p "${ERIS_BIND_IP}:8080:80" -p "${ERIS_BIND_IP}:9800:8333" >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-mariadb --env-file "$DEPLOY/db.env" \
      -v "$ERIS_DB_VOLUME:/var/lib/mysql" -v "$ROOT/database/init:/docker-entrypoint-initdb.d:ro,Z" "$ERIS_DB_IMAGE" >/dev/null
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
      -v "$ERIS_STORAGE_VOLUME:/data" "$ERIS_STORAGE_IMAGE" mini -dir=/data >/dev/null
    run_tool python -m app.tools.prepare_database
    run_tool python -m app.storage_bootstrap
    run_tool python -m app.tools.adopt_existing_admin
    if [[ -f "$DEPLOY/bootstrap.env" ]]; then
      podman run --rm --pod eris --env-file "$DEPLOY/app.env" --env-file "$DEPLOY/bootstrap.env" \
        "$ERIS_API_IMAGE" python -m app.tools.bootstrap_initial_admin
    else
      run_tool python -m app.tools.bootstrap_initial_admin
    fi
    podman run -d --restart=unless-stopped --pod eris --name eris-api --env-file "$DEPLOY/app.env" \
      "${api_secret_mount[@]}" "$ERIS_API_IMAGE" >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-worker --env-file "$DEPLOY/app.env" \
      "$ERIS_WORKER_IMAGE" python -m app.worker.offline_scene_worker >/dev/null
    podman run -d --restart=unless-stopped --pod eris --name eris-web "$ERIS_WEB_IMAGE" >/dev/null
    wait_for_api
    echo "ERIS pod started on ${ERIS_BIND_IP}:8080 (web/API) and :9800 (S3)."
    ;;
  status)
    podman pod ps --filter name=eris
    podman ps --filter pod=eris
    ;;
  start)
    if podman pod exists eris; then podman pod start eris; else bash "$0" up; fi
    wait_for_api
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
  release)
    # The whole release in one step, automatically undone if it fails:
    #   pull (signatures enforced) -> matched backup -> new images and migrations
    #   -> production verification -> done, or rollback to the previous images
    #   and the pre-release data.
    # Settings from deploy/podman/release.env (non-secret): ERIS_BACKUP_ROOT,
    # ERIS_PUBLIC_URL, ERIS_FILES_URL, ERIS_VERIFY_PROFILE.
    file="${2:?Usage: $0 release RELEASE_IMAGES_ENV}"
    if [[ -f "$DEPLOY/release.env" ]]; then set -a; source "$DEPLOY/release.env"; set +a; fi
    backup_root="${ERIS_BACKUP_ROOT:?Set ERIS_BACKUP_ROOT in release.env}"
    check_release_file "$file"
    podman pod exists eris || { echo "No running ERIS pod: use up for the first installation" >&2; exit 2; }
    if ! mkdir "$DEPLOY/.release.lock" 2>/dev/null; then
      echo "Another release is in progress ($DEPLOY/.release.lock)" >&2
      exit 2
    fi
    trap 'rmdir "$DEPLOY/.release.lock" 2>/dev/null || true' EXIT
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    new_api="$(sed -n 's/^ERIS_API_IMAGE=//p' "$file")"
    staged="$(mktemp)"
    cp "$file" "$staged"

    # 1. Every new image, through the signature policy, before anything stops.
    while IFS='=' read -r name ref; do
      if [[ "$name" == ERIS_*_IMAGE ]]; then podman pull "$ref"; fi
    done < "$staged"
    # 2. A matched backup of the current release (cold: the pod stops briefly).
    pre="$backup_root/pre-release-$stamp"
    bash "$0" backup "$pre"
    # 3. Switch and migrate.
    cp "$DEPLOY/images.env" "$DEPLOY/images.env.previous"
    cp "$staged" "$DEPLOY/images.env"
    rm -f "$staged"
    release_verified() {
      ERIS_DB_VOLUME="$ERIS_DB_VOLUME" ERIS_STORAGE_VOLUME="$ERIS_STORAGE_VOLUME" bash "$0" up || return 1
      [[ -z "${ERIS_PUBLIC_URL:-}" ]] && return 0
      ERIS_VERIFY_PROFILE="${ERIS_VERIFY_PROFILE:-production}" \
        bash "$DEPLOY/verify-rehearsal.sh" "$ERIS_PUBLIC_URL" "${ERIS_FILES_URL:-}"
    }
    podman pod rm -f eris >/dev/null
    if release_verified; then
      release_log "release OK $new_api (backup $pre)"
      echo "Released $new_api. Pre-release backup: $pre"
      exit 0
    fi

    # 4. Roll back. Migrations may have changed the data, so the previous
    # images come back with the pre-release backup restored into new volumes.
    # The volumes the failed release touched are kept for investigation.
    echo "Release FAILED; rolling back to the previous images and the pre-release data" >&2
    podman pod rm -f eris >/dev/null 2>&1 || true
    cp "$DEPLOY/images.env.previous" "$DEPLOY/images.env"
    rollback_db="eris-mariadb-rb$stamp" rollback_storage="eris-seaweedfs-rb$stamp"
    ERIS_DB_VOLUME="$rollback_db" ERIS_STORAGE_VOLUME="$rollback_storage" bash "$0" restore "$pre"
    printf 'ERIS_DB_VOLUME=%s\nERIS_STORAGE_VOLUME=%s\n' "$rollback_db" "$rollback_storage" > "$DEPLOY/volumes.env"
    if ERIS_DB_VOLUME="$rollback_db" ERIS_STORAGE_VOLUME="$rollback_storage" bash "$0" up; then
      release_log "release FAILED $new_api; rolled back (volumes $rollback_db, $rollback_storage)"
      echo "Rolled back. Now on volumes $rollback_db and $rollback_storage (recorded in volumes.env)." >&2
    else
      release_log "release FAILED $new_api; ROLLBACK FAILED, manual recovery from $pre"
      echo "ROLLBACK FAILED: recover manually from $pre (docs/operations/caltrans-podman.md, Backup and restore)" >&2
    fi
    exit 1
    ;;
  pull)
    # Fetch the five pinned images from Harbor. With the signature policy in
    # deploy/podman/signature-policy installed for this account, Podman refuses
    # any image whose cosign signature does not verify. Run before up/release.
    for name in "${IMAGE_VARS[@]}"; do podman pull "${!name}"; done
    echo "Pulled the five images named in images.env."
    ;;
  cert-check)
    # The Entra certificate as the running API sees it: thumbprint and expiry.
    podman pod exists eris || { echo "Pod eris does not exist" >&2; exit 2; }
    podman exec eris-api python -m app.tools.entra_credential_check
    ;;
  handover-check)
    # Reads the RUNNING API's settings, so it reports what is in effect, not
    # what app.env says after an edit that has not been redeployed.
    podman pod exists eris || { echo "Pod eris does not exist" >&2; exit 2; }
    result=0
    podman exec eris-api python -m app.tools.handover_status || result=$?
    if [[ -f "$DEPLOY/bootstrap.env" ]]; then
      echo "  - $DEPLOY/bootstrap.env still exists: delete it once the initial administrator is seeded."
      [[ "$result" != 0 ]] || result=1
    fi
    exit "$result"
    ;;
  backup)
    # Cold, matched backup: the database volume, the object volume, and the
    # runtime configuration that unlocks them, from one stopped moment.
    dest="${2:?Usage: $0 backup NEW_DIRECTORY}"
    [[ ! -e "$dest" ]] || { echo "$dest already exists; give each backup a new directory" >&2; exit 2; }
    podman pod exists eris || { echo "Pod eris does not exist" >&2; exit 2; }
    for volume in "$ERIS_DB_VOLUME" "$ERIS_STORAGE_VOLUME"; do
      podman volume exists "$volume" || { echo "Volume $volume does not exist" >&2; exit 2; }
    done
    case "$(podman pod inspect --format '{{.State}}' eris)" in
      Running|Degraded) was_running=Running ;;
      *) was_running=no ;;
    esac
    # Recorded so a restore can be matched to API images that understand it.
    revision="$(podman exec eris-api python -c 'from app.db import engine; from alembic.runtime.migration import MigrationContext; c = engine.connect(); print(",".join(sorted(MigrationContext.configure(c).get_current_heads()))); c.close()' 2>/dev/null)" || revision=unknown
    image_ids=()
    for container in "${CONTAINERS[@]}"; do
      image_ids+=("$container=$(podman inspect --format '{{.Image}}' "$container")")
    done
    umask 077
    mkdir -p "$dest/config"
    restart_pod() {
      if [[ "$was_running" == Running ]]; then
        podman pod start eris >/dev/null && wait_for_api
      fi
    }
    trap 'echo "Backup failed; restoring pod state" >&2; restart_pod || true' ERR
    podman pod stop eris >/dev/null
    podman volume export "$ERIS_DB_VOLUME" --output "$dest/mariadb.tar"
    podman volume export "$ERIS_STORAGE_VOLUME" --output "$dest/seaweedfs.tar"
    for file in "${CONFIG_NAMES[@]}"; do cp "$DEPLOY/$file" "$dest/config/$file"; done
    if [[ -d "$SECRETS_DIR" ]]; then cp -R "$SECRETS_DIR" "$dest/config/secrets"; fi
    {
      echo "format=$BACKUP_FORMAT"
      echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "db_volume=$ERIS_DB_VOLUME"
      echo "storage_volume=$ERIS_STORAGE_VOLUME"
      echo "alembic_revision=$revision"
      for name in "${IMAGE_VARS[@]}"; do echo "$name=${!name}"; done
      for entry in "${image_ids[@]}"; do echo "image_id.$entry"; done
    } > "$dest/manifest.env"
    (cd "$dest" && find manifest.env mariadb.tar seaweedfs.tar config -type f -print0 | sort -z       | xargs -0 sha256sum > SHA256SUMS)
    trap - ERR
    restart_pod
    verify_backup "$dest"
    echo "Backup written to $dest and verified."
    echo "It contains database, evidence and secrets: encrypt it and move it to the approved backup target."
    ;;
  verify-backup)
    dir="${2:?Usage: $0 verify-backup DIRECTORY}"
    verify_backup "$dir"
    grep -E '^(created_utc|alembic_revision|ERIS_[A-Z_]+_IMAGE)=' "$dir/manifest.env"
    echo "Backup $dir: checksums and archives verified."
    ;;
  restore)
    # Restores into NEW, empty volumes; `podman volume import` merges into an
    # existing volume, which would mix two points in time.
    dir="${2:?Usage: ERIS_DB_VOLUME=new-db ERIS_STORAGE_VOLUME=new-storage $0 restore DIRECTORY}"
    verify_backup "$dir"
    if podman pod exists eris; then
      echo "Pod eris exists. Stop and remove it first ($0 remove); its volumes are kept." >&2
      exit 2
    fi
    for volume in "$ERIS_DB_VOLUME" "$ERIS_STORAGE_VOLUME"; do
      if podman volume exists "$volume"; then
        echo "Volume $volume already exists. Restore into new names with ERIS_DB_VOLUME / ERIS_STORAGE_VOLUME." >&2
        exit 2
      fi
    done
    # The database volume holds the MariaDB credentials and the data that the
    # JWT, S3 and Entra settings refer to: restore only with the matching files.
    for file in db.env storage.env app.env; do
      if ! same_file "$dir/config/$file" "$DEPLOY/$file"; then
        echo "$DEPLOY/$file differs from the backup's copy. Restore the backup's configuration files first." >&2
        exit 2
      fi
    done
    if ! same_file "$dir/config/images.env" "$DEPLOY/images.env"; then
      echo "Warning: images.env differs from the backup. The backup was taken with:" >&2
      grep -E '^(alembic_revision|ERIS_[A-Z_]+_IMAGE)=' "$dir/manifest.env" >&2
      echo "An older API must not run against a newer schema; the reverse applies forward migrations." >&2
    fi
    podman volume create "$ERIS_DB_VOLUME" >/dev/null
    podman volume create "$ERIS_STORAGE_VOLUME" >/dev/null
    podman volume import "$ERIS_DB_VOLUME" "$dir/mariadb.tar"
    podman volume import "$ERIS_STORAGE_VOLUME" "$dir/seaweedfs.tar"
    echo "Restored into volumes $ERIS_DB_VOLUME and $ERIS_STORAGE_VOLUME."
    echo "Start with: ERIS_DB_VOLUME=$ERIS_DB_VOLUME ERIS_STORAGE_VOLUME=$ERIS_STORAGE_VOLUME bash $0 up"
    ;;
  *)
    echo "Usage: $0 {up|start|status|logs [api|web|mariadb|seaweedfs|worker]|stop|remove|release FILE|pull|handover-check|cert-check|backup DIR|verify-backup DIR|restore DIR}" >&2
    exit 2
    ;;
esac
