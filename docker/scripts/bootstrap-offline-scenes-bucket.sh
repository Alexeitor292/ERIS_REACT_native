#!/bin/sh
# One-shot in-compose bootstrap for the PRIVATE, immutable offline 3D scene bucket.
# Runs inside a `minio/mc` init container BEFORE backend + offline-scene-worker.
#
# FAIL-CLOSED: exits NONZERO (blocking the dependent services) unless the bucket
# is confirmed (1) present, (2) private (anonymous = none), and (3) versioned via
# object lock (append-only immutability). Object lock can only be set at creation,
# so an existing bucket WITHOUT it is REJECTED (recreate it) rather than silently
# accepted. The uploads bucket (MINIO_BUCKET) is NOT touched.
set -eu

BUCKET="${MINIO_OFFLINE_SCENES_BUCKET:-eris-offline-scenes}"
ALIAS="erisminio"
ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
ROOT_USER="${MINIO_ROOT_USER:?set MINIO_ROOT_USER}"
ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}"

fail() { echo "FAILED: $1" >&2; exit 1; }

# Wait for MinIO to accept the alias (it may still be starting).
echo ">> Waiting for MinIO at $ENDPOINT"
i=0
until mc alias set "$ALIAS" "$ENDPOINT" "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && fail "MinIO not reachable at $ENDPOINT after 60 tries"
  sleep 2
done

# Create WITH object lock (implies versioning) only if missing. Never recreate.
if mc ls "$ALIAS/$BUCKET" >/dev/null 2>&1; then
  echo ">> Bucket '$BUCKET' exists — verifying immutable posture"
else
  echo ">> Creating private bucket '$BUCKET' WITH object lock"
  mc mb --with-lock "$ALIAS/$BUCKET" || fail "could not create '$BUCKET' with object lock"
fi

# (1) No anonymous access — enforce + verify (no '|| true').
mc anonymous set none "$ALIAS/$BUCKET" || fail "could not set anonymous=none on '$BUCKET'"
ANON="$(mc anonymous get "$ALIAS/$BUCKET" 2>/dev/null || true)"
case "$ANON" in
  *none*|*"no anonymous"*|*"is not set"*) : ;;
  *) fail "bucket '$BUCKET' anonymous policy is not 'none' (got: $ANON)";;
esac

# (2) Versioning must be ENABLED (object lock requires it).
VER="$(mc version info "$ALIAS/$BUCKET" 2>/dev/null || true)"
case "$VER" in
  *[Ee]nabled*) : ;;
  *) fail "versioning NOT enabled on '$BUCKET' (object lock missing). Recreate WITH object lock.";;
esac

echo "OK: '$BUCKET' is PRIVATE + VERSIONED (object-lock). Dependent services may start."
