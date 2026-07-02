from __future__ import annotations

import hashlib
import os
import uuid
from datetime import timedelta
from typing import BinaryIO
from io import BytesIO

from minio import Minio
from minio.error import S3Error

from .config import settings


def _endpoint_no_scheme(url: str) -> tuple[str, bool]:
    url = (url or "").strip()
    secure = url.startswith("https://")
    endpoint = url.replace("http://", "").replace("https://", "")
    return endpoint, secure


def _client() -> Minio:
    """Internal MinIO client for storage operations (bucket checks, upload, stat,
    hashing, object reads) against the in-cluster endpoint (MINIO_ENDPOINT)."""
    endpoint, secure = _endpoint_no_scheme(settings.MINIO_ENDPOINT)
    return Minio(
        endpoint,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=secure,
    )


def _presign_client() -> Minio:
    """MinIO client used ONLY to GENERATE presigned URLs.

    It signs against the EXTERNALLY reachable host (MINIO_PUBLIC_ENDPOINT) when
    configured, so the SigV4 signature's Host matches the host the mobile/browser
    client actually connects to. This replaces the old approach of signing against
    the internal host and rewriting the URL host afterward — rewriting the host
    after signing invalidates the signature (SignatureDoesNotMatch / AccessDenied
    through the public proxy). Falls back to the internal MINIO_ENDPOINT when no
    public endpoint is configured. Same credentials; HTTPS preserved from the
    endpoint's scheme.
    """
    public_endpoint = (settings.MINIO_PUBLIC_ENDPOINT or "").strip()
    source = public_endpoint or settings.MINIO_ENDPOINT
    endpoint, secure = _endpoint_no_scheme(source)
    return Minio(
        endpoint,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=secure,
        # Explicit region => presigning is local; no GetBucketLocation round-trip
        # to the (possibly anonymous-blocked) public endpoint at sign time.
        region=settings.MINIO_REGION,
    )


def ensure_bucket(bucket: str | None = None) -> None:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        if not client.bucket_exists(bucket_name):
            client.make_bucket(bucket_name)
    except S3Error as e:
        raise RuntimeError(f"MinIO ensure_bucket failed for bucket={bucket_name}: {e}") from e


def ensure_bucket_exists(bucket: str) -> None:
    """Ensure the named bucket exists, creating it if necessary.

    Unlike ensure_bucket(), this requires an explicit bucket name with no
    default fallback.  Raises RuntimeError if MinIO is unreachable, the
    credentials are invalid, or bucket creation fails.
    """
    client = _client()
    try:
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)
    except S3Error as e:
        raise RuntimeError(
            f"MinIO ensure_bucket_exists failed for bucket={bucket}: {e}"
        ) from e


def presign_get(object_key: str, *, bucket: str | None = None, expires_seconds: int = 900) -> str:
    """Generate a presigned GET URL signed directly against the externally reachable
    host (MINIO_PUBLIC_ENDPOINT when configured, else MINIO_ENDPOINT). No post-sign
    host rewrite — the URL is valid as-is through the public proxy."""
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _presign_client()
    try:
        return client.presigned_get_object(
            bucket_name,
            object_key,
            expires=timedelta(seconds=expires_seconds),
        )
    except S3Error as e:
        raise RuntimeError(f"MinIO presign_get failed bucket={bucket_name} key={object_key}: {e}") from e


def object_public_url(bucket: str, object_key: str) -> str:
    """Return a deterministic direct URL for the object using MINIO_PUBLIC_ENDPOINT.

    Used when STORAGE_URL_MODE=public (internal-network alpha deployments).
    Raises RuntimeError if MINIO_PUBLIC_ENDPOINT is not configured.
    """
    public_endpoint = (settings.MINIO_PUBLIC_ENDPOINT or "").strip()
    if not public_endpoint:
        raise RuntimeError(
            "STORAGE_URL_MODE=public requires MINIO_PUBLIC_ENDPOINT to be set. "
            "Set it to the client-reachable MinIO API URL (e.g. http://10.0.0.1:9800)."
        )
    base = public_endpoint.rstrip("/")
    key = object_key.lstrip("/")
    return f"{base}/{bucket}/{key}"


def object_access_url(bucket: str, object_key: str, expires_seconds: int = 900) -> str:
    """Return the appropriate access URL based on STORAGE_URL_MODE.

    presigned (default): returns a MinIO presigned GET URL signed directly against
      MINIO_PUBLIC_ENDPOINT when configured (no post-sign host rewrite).
    public: returns a deterministic direct URL via object_public_url().
    """
    if settings.STORAGE_URL_MODE == "public":
        return object_public_url(bucket, object_key)
    return presign_get(object_key, bucket=bucket, expires_seconds=expires_seconds)


def put_object_stream(
    *,
    object_key: str,
    data: BinaryIO,
    length: int,
    content_type: str,
    bucket: str | None = None,
) -> None:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        client.put_object(
            bucket_name=bucket_name,
            object_name=object_key,
            data=data,
            length=length,
            content_type=content_type,
        )
    except S3Error as e:
        raise RuntimeError(f"MinIO put_object failed bucket={bucket_name} key={object_key}: {e}") from e


def make_object_key(filename: str) -> str:
    filename = (filename or "").strip()
    _, ext = os.path.splitext(filename)
    ext = ext.lower()[:20]
    if ext and not ext.startswith("."):
        ext = "." + ext
    return f"uploads/{uuid.uuid4().hex}{ext}"

def put_object_bytes(*, object_key: str, data: bytes, content_type: str, bucket: str | None = None) -> None:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    bio = BytesIO(data)
    try:
        client.put_object(
            bucket_name,
            object_key,
            bio,
            length=len(data),
            content_type=content_type,
        )
    except S3Error as e:
        raise RuntimeError(f"MinIO put_object failed bucket={bucket_name} key={object_key}: {e}") from e


def bucket_exists(bucket: str) -> bool:
    """True if the bucket exists. Raises RuntimeError if MinIO is unreachable."""
    client = _client()
    try:
        return bool(client.bucket_exists(bucket))
    except S3Error as e:
        raise RuntimeError(f"MinIO bucket_exists failed for bucket={bucket}: {e}") from e


def stat_object(*, object_key: str, bucket: str | None = None) -> dict | None:
    """HEAD an object. Returns {"size", "etag", "version_id"} (version_id may be
    None when the bucket is unversioned) or None when the object does not exist.
    Raises RuntimeError only on non-NoSuchKey MinIO errors."""
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        st = client.stat_object(bucket_name, object_key)
        return {
            "size": int(st.size),
            "etag": str(st.etag).strip('"'),
            "version_id": getattr(st, "version_id", None),
        }
    except S3Error as e:
        if getattr(e, "code", "") in ("NoSuchKey", "NoSuchObject", "NoSuchBucket"):
            return None
        raise RuntimeError(f"MinIO stat_object failed bucket={bucket_name} key={object_key}: {e}") from e


def sha256_of_object(*, object_key: str, bucket: str | None = None, chunk_size: int = 1024 * 1024) -> str:
    """Stream an object and return its SHA-256 hex digest (no full in-memory load)."""
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    h = hashlib.sha256()
    try:
        obj = client.get_object(bucket_name, object_key)
        try:
            for chunk in obj.stream(chunk_size):
                h.update(chunk)
        finally:
            obj.close()
            obj.release_conn()
    except S3Error as e:
        raise RuntimeError(f"MinIO sha256_of_object failed bucket={bucket_name} key={object_key}: {e}") from e
    return h.hexdigest()


def get_object_bytes(*, object_key: str, bucket: str | None = None) -> tuple[bytes, str]:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        obj = client.get_object(bucket_name, object_key)
        try:
            data = obj.read()
            content_type = obj.headers.get("Content-Type", "application/octet-stream")
            return data, content_type
        finally:
            obj.close()
            obj.release_conn()
    except S3Error as e:
        raise RuntimeError(f"MinIO get_object failed bucket={bucket_name} key={object_key}: {e}") from e
