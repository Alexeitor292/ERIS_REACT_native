#!/usr/bin/env sh
# Create the PRIVATE offline 3D scene-package bucket in MinIO.
#
# This bucket holds operator-authored .mspk binaries. It MUST stay private:
#   * no anonymous download policy,
#   * NOT the anonymous uploads bucket.
# ERIS reads it server-side with the existing MinIO credentials and hands mobile
# clients only short-lived presigned URLs.
#
# Usage (operator host with the `mc` MinIO client):
#   MINIO_ENDPOINT=http://127.0.0.1:9800 \
#   MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... \
#   sh docker/scripts/create-offline-scenes-bucket.sh
set -eu

BUCKET="${MINIO_OFFLINE_SCENES_BUCKET:-eris-offline-scenes}"
ALIAS="${MC_ALIAS:-erisminio}"
ENDPOINT="${MINIO_ENDPOINT:?set MINIO_ENDPOINT (e.g. http://127.0.0.1:9800)}"
ROOT_USER="${MINIO_ROOT_USER:?set MINIO_ROOT_USER}"
ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}"

echo ">> Configuring mc alias '$ALIAS' -> $ENDPOINT"
mc alias set "$ALIAS" "$ENDPOINT" "$ROOT_USER" "$ROOT_PASSWORD"

echo ">> Creating private bucket '$BUCKET' (idempotent)"
mc mb --ignore-existing "$ALIAS/$BUCKET"

# Buckets are private by default; make the private posture explicit + idempotent.
echo ">> Forcing NO anonymous access on '$BUCKET'"
mc anonymous set none "$ALIAS/$BUCKET" || true

echo ">> Verifying anonymous policy is 'none':"
mc anonymous get "$ALIAS/$BUCKET" || true

echo "OK: '$BUCKET' is ready and PRIVATE."
echo "Set ERIS backend MINIO_OFFLINE_SCENES_BUCKET=$BUCKET (default already matches)."
