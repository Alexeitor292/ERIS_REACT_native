from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import BinaryIO
from io import BytesIO
from urllib.parse import urlparse, urlunparse

from minio import Minio
from minio.error import S3Error

from .config import settings


def _endpoint_no_scheme(url: str) -> tuple[str, bool]:
    url = (url or "").strip()
    secure = url.startswith("https://")
    endpoint = url.replace("http://", "").replace("https://", "")
    return endpoint, secure


def _client() -> Minio:
    endpoint, secure = _endpoint_no_scheme(settings.MINIO_ENDPOINT)
    return Minio(
        endpoint,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=secure,
    )


def ensure_bucket(bucket: str | None = None) -> None:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        if not client.bucket_exists(bucket_name):
            client.make_bucket(bucket_name)
    except S3Error as e:
        raise RuntimeError(f"MinIO ensure_bucket failed for bucket={bucket_name}: {e}") from e


def presign_get(object_key: str, *, bucket: str | None = None, expires_seconds: int = 900) -> str:
    bucket_name = bucket or settings.MINIO_BUCKET
    client = _client()
    try:
        signed = client.presigned_get_object(
            bucket_name,
            object_key,
            expires=timedelta(seconds=expires_seconds),
        )
        public_endpoint = (settings.MINIO_PUBLIC_ENDPOINT or "").strip()
        if public_endpoint:
            signed_parts = urlparse(signed)
            pub_parts = urlparse(public_endpoint)
            scheme = pub_parts.scheme or signed_parts.scheme
            netloc = pub_parts.netloc or pub_parts.path or signed_parts.netloc
            if netloc:
                signed = urlunparse((
                    scheme,
                    netloc,
                    signed_parts.path,
                    signed_parts.params,
                    signed_parts.query,
                    signed_parts.fragment,
                ))
        return signed
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

    presigned (default): returns a MinIO presigned GET URL (with MINIO_PUBLIC_ENDPOINT
      rewriting applied if configured).
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
    client.put_object(
        bucket_name,
        object_key,
        bio,
        length=len(data),
        content_type=content_type,
    )


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
