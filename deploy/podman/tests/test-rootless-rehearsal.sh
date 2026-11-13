#!/usr/bin/env bash
# Real five-image installation and recovery on an isolated rootless CI account.
# This never reads the checkout's runtime .env files, personal servers or data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || {
  echo 'Run the rehearsal as an ordinary rootless Podman account' >&2; exit 2;
}
if podman pod exists eris; then echo 'Refusing an account with an existing eris pod' >&2; exit 2; fi
for container in eris-api eris-worker eris-web eris-mariadb eris-seaweedfs; do
  if podman container exists "$container"; then echo "Refusing existing container $container" >&2; exit 2; fi
done
for part in API WORKER WEB DB STORAGE; do
  var="ERIS_TEST_${part}_IMAGE"
  [[ -n "${!var:-}" ]] || { echo "Set $var to its loaded candidate image" >&2; exit 2; }
  podman image exists "${!var}" || { echo "$var is not loaded" >&2; exit 2; }
done

umask 077
work="$(mktemp -d)"
repo="$work/repo"
deploy="$repo/deploy/podman"
suffix="$(basename "$work" | tr '[:upper:]' '[:lower:]')"
db_volume="eris-ci-$suffix-db"; storage_volume="eris-ci-$suffix-files"
restored_db="eris-ci-$suffix-restored-db"; restored_storage="eris-ci-$suffix-restored-files"
secret_name="eris-file-$(printf 'ci-placeholder.key' | sha256sum | cut -c1-20)"
if podman secret inspect "$secret_name" >/dev/null 2>&1; then
  echo 'Refusing to replace an existing rehearsal secret' >&2; rmdir "$work"; exit 2
fi
owns_pod=0
cleanup() {
  if [[ "$owns_pod" == 1 ]]; then podman pod rm -f eris >/dev/null 2>&1 || true; fi
  podman secret rm "$secret_name" >/dev/null 2>&1 || true
  for volume in "$db_volume" "$storage_volume" "$restored_db" "$restored_storage"; do
    podman volume rm "$volume" >/dev/null 2>&1 || true
  done
  rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -p "$deploy/secrets" "$repo/database"
cp "$ROOT/deploy/podman/eris-pod.sh" "$ROOT/deploy/podman/verify-rehearsal.sh" "$deploy/"
cp -R "$ROOT/database/init" "$repo/database/"
# The MariaDB entrypoint drops to mysql before reading public init SQL; the
# surrounding fixture and runtime env/key files remain private to this account.
find "$repo/database/init" -type d -exec chmod 755 {} +
find "$repo/database/init" -type f -exec chmod 644 {} +
for part in API WORKER WEB DB STORAGE; do
  var="ERIS_TEST_${part}_IMAGE"
  printf 'ERIS_%s_IMAGE=%s\n' "$part" "${!var}" >> "$deploy/images.env"
done
echo 'ERIS_REQUIRE_DIGESTS=false' >> "$deploy/images.env"
cat > "$deploy/db.env" <<'ENV'
MARIADB_ROOT_PASSWORD=eris-ci-disposable-root
MARIADB_DATABASE=eris
MARIADB_USER=eris_user
MARIADB_PASSWORD=eris-ci-disposable-app
ENV
# Disposable credentials are generated for this isolated run and never printed.
# Hex output is safe to interpolate into these env-file heredocs.
rehearsal_s3_secret="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
cat > "$deploy/storage.env" <<ENV
AWS_ACCESS_KEY_ID=eris-ci-disposable-s3
AWS_SECRET_ACCESS_KEY=$rehearsal_s3_secret
S3_BUCKET=eris-uploads
ENV
cat > "$deploy/app.env" <<ENV
ENV=dev
API_DOCS_ENABLED=false
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=eris
DB_USER=eris_user
DB_PASS=eris-ci-disposable-app
S3_ENDPOINT=http://127.0.0.1:8333
S3_PUBLIC_ENDPOINT=http://127.0.0.1:9800
S3_BUCKET=eris-uploads
S3_OFFLINE_SCENES_BUCKET=eris-offline-scenes
S3_ACCESS_KEY=eris-ci-disposable-s3
S3_SECRET_KEY=$rehearsal_s3_secret
STORAGE_URL_MODE=presigned
OFFLINE_SCENE_DEV_MODE=false
JWT_SECRET=eris-ci-disposable-32-character-signing-value
LOCAL_LOGIN_ENABLED=true
ENTRA_ENABLED=false
WEB_BASE_URL=http://127.0.0.1:8080
CORS_ORIGINS=http://127.0.0.1:8080
ENV
cat > "$deploy/bootstrap.env" <<'ENV'
ERIS_BOOTSTRAP_ADMIN_EMAIL=handoff-smoke@example.invalid
ERIS_BOOTSTRAP_ADMIN_NAME=CI Rehearsal
ERIS_BOOTSTRAP_ADMIN_PASSWORD=Only-CI-Disposable-Password-2026!
ENV
printf 'eris-ci-private-file' > "$deploy/secrets/ci-placeholder.key"
chmod 700 "$deploy/secrets"; chmod 600 "$deploy"/*.env "$deploy/secrets/ci-placeholder.key"
export ERIS_BIND_IP=127.0.0.1 ERIS_DB_VOLUME="$db_volume" ERIS_STORAGE_VOLUME="$storage_volume"
owns_pod=1
bash "$deploy/eris-pod.sh" up

runtime_checks() {
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null
  curl -fsS http://127.0.0.1:8080/api/health >/dev/null
  curl -fsS http://127.0.0.1:8080/api/auth/config | python3 -c 'import json,sys; c=json.load(sys.stdin); assert c["local_login_enabled"] is True and c["entra_enabled"] is False'
  for container in eris-api eris-worker; do
    podman exec "$container" python -c 'import os; s=dict(line.split(":",1) for line in open("/proc/1/status") if ":" in line); assert os.geteuid()==10001; assert int(s["Uid"].split()[1])==10001; assert int(s["CapEff"].strip(),16)==0; assert s["NoNewPrivs"].strip()=="1"'
  done
  podman exec eris-web nginx -t
  podman exec eris-web sh -ec '
    test "$(id -u)" = 101
    count=0
    for status in /proc/[0-9]*/status; do
      grep -q "^Name:[[:space:]]*nginx$" "$status" || continue
      awk '\''$1=="Uid:" {if ($3!=101) exit 1; uid=1} $1=="CapEff:" {if ($2 !~ /^0+$/) exit 1; caps=1} $1=="NoNewPrivs:" {if ($2!=1) exit 1; nnp=1} END {if (!uid || !caps || !nnp) exit 1}'\'' "$status"
      count=$((count+1))
    done
    test "$count" -ge 2
  '
  podman exec eris-api python -c 'import os; p="/run/secrets/eris/ci-placeholder.key"; s=os.stat(p); assert s.st_uid==10001 and s.st_gid==10001 and (s.st_mode & 0o777)==0o400; assert open(p).read()=="eris-ci-private-file"'
  podman exec eris-worker python -c 'import os; assert not os.path.exists("/run/secrets/eris/ci-placeholder.key")'
  podman exec eris-api python -c 'from app.db import engine; from sqlalchemy import text; c=engine.connect(); assert c.execute(text("SELECT COUNT(*) FROM users WHERE email=:email"),{"email":"handoff-smoke@example.invalid"}).scalar()==1; c.close()'
}
runtime_checks
echo 'PASS five-image startup, same-origin health/auth config, nonroot posture and API-only secret'

podman exec eris-api python -c 'from minio import Minio; from app.config import settings; import io; c=Minio("127.0.0.1:8333",access_key=settings.S3_ACCESS_KEY,secret_key=settings.S3_SECRET_KEY,secure=False); data=b"ERIS rootless recovery marker"; c.put_object(settings.S3_BUCKET,"ci-recovery-marker.txt",io.BytesIO(data),len(data))'
signed_object_check() {
  # The signing endpoint is reached by the host, not from the pod network.
  # An explicit region keeps Minio from querying its location through port 9800.
  podman exec eris-api python -c 'from minio import Minio; from app.config import settings; from datetime import timedelta; c=Minio("127.0.0.1:9800",access_key=settings.S3_ACCESS_KEY,secret_key=settings.S3_SECRET_KEY,secure=False,region="us-east-1"); print(c.presigned_get_object(settings.S3_BUCKET,"ci-recovery-marker.txt",expires=timedelta(minutes=5)))' > "$work/signed-url"
  python3 - "$work/signed-url" <<'PY'
import sys, urllib.request
address = open(sys.argv[1]).read().strip()
assert urllib.request.urlopen(address, timeout=15).read() == b"ERIS rootless recovery marker"
PY
  code="$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:9800/eris-uploads/?list-type=2')"
  [[ "$code" == 401 || "$code" == 403 ]]
}
signed_object_check
echo 'PASS signed object round-trip and anonymous bucket refusal'

backup="$work/matched-backup"
bash "$deploy/eris-pod.sh" backup "$backup"
bash "$deploy/eris-pod.sh" verify-backup "$backup" >/dev/null
bash "$deploy/eris-pod.sh" remove
export ERIS_DB_VOLUME="$restored_db" ERIS_STORAGE_VOLUME="$restored_storage"
cp "$backup/config/secrets/ci-placeholder.key" "$deploy/secrets/ci-placeholder.key"
bash "$deploy/eris-pod.sh" restore "$backup"
bash "$deploy/eris-pod.sh" up
runtime_checks
signed_object_check
echo 'PASS matched backup restored into fresh volumes: administrator, object, API-only secret and healthy pod persist'
echo 'This rehearsal uses synthetic local login; it does not accept Caltrans Entra/TLS/Harbor/SSO or device policy.'
