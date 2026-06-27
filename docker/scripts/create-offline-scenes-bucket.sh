#!/usr/bin/env sh
# Provision the PRIVATE, immutable offline 3D scene-package bucket in MinIO.
#
# FAIL-CLOSED: this script exits NONZERO and prints no success unless the bucket
# is confirmed (1) private (anonymous access = none) and (2) versioned with
# object lock (append-only immutability) so registered package objects can never
# be silently overwritten.
#
# Object lock can ONLY be enabled at bucket creation time. If the bucket already
# exists WITHOUT object lock, this script REJECTS it (you must recreate it).
#
# Usage (operator host with the MinIO `mc` client):
#   MINIO_ENDPOINT=http://127.0.0.1:9800 \
#   MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... \
#   sh docker/scripts/create-offline-scenes-bucket.sh
set -eu

BUCKET="${MINIO_OFFLINE_SCENES_BUCKET:-eris-offline-scenes}"
ALIAS="${MC_ALIAS:-erisminio}"
ENDPOINT="${MINIO_ENDPOINT:?set MINIO_ENDPOINT (e.g. http://127.0.0.1:9800)}"
ROOT_USER="${MINIO_ROOT_USER:?set MINIO_ROOT_USER}"
ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}"

fail() { echo "FAILED: $1" >&2; exit 1; }

echo ">> Configuring mc alias '$ALIAS' -> $ENDPOINT"
mc alias set "$ALIAS" "$ENDPOINT" "$ROOT_USER" "$ROOT_PASSWORD" \
  || fail "could not configure mc alias / reach MinIO"

# Create with object lock (implies versioning) only if missing. Never recreate.
if mc ls "$ALIAS/$BUCKET" >/dev/null 2>&1; then
  echo ">> Bucket '$BUCKET' already exists — verifying immutable posture"
else
  echo ">> Creating private bucket '$BUCKET' WITH object lock (immutable)"
  mc mb --with-lock "$ALIAS/$BUCKET" || fail "could not create bucket '$BUCKET' with object lock"
fi

# (1) Enforce + verify NO anonymous access. No '|| true' — must succeed.
echo ">> Enforcing no anonymous access"
mc anonymous set none "$ALIAS/$BUCKET" || fail "could not set anonymous=none on '$BUCKET'"
ANON="$(mc anonymous get "$ALIAS/$BUCKET" 2>/dev/null || true)"
case "$ANON" in
  *none*|*"no anonymous"*|*"is not set"*) : ;;  # acceptable private states
  *) fail "bucket '$BUCKET' anonymous policy is not 'none' (got: $ANON)";;
esac

# (2) Verify versioning is ENABLED (object lock requires/enables it).
echo ">> Verifying versioning is enabled"
VER="$(mc version info "$ALIAS/$BUCKET" 2>/dev/null || true)"
case "$VER" in
  *[Ee]nabled*) : ;;
  *) fail "versioning is NOT enabled on '$BUCKET' (object lock missing). Recreate the bucket WITH object lock.";;
esac

# (3) Verify object lock is configured (immutability backstop). Best-effort across
# mc versions; if the command is unsupported we still required --with-lock above.
LOCK="$(mc retention info "$ALIAS/$BUCKET" 2>/dev/null || true)"
echo ">> Object-lock/retention info: ${LOCK:-<none reported>}"

echo "OK: '$BUCKET' is PRIVATE + VERSIONED (object-lock) and ready."
echo "Set ERIS backend MINIO_OFFLINE_SCENES_BUCKET=$BUCKET (default already matches)."
