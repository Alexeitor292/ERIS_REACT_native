"""Presigned-URL host correctness (no DB / no live MinIO).

Regression for the real-device download failure: presigning against the internal
host and rewriting the URL host afterward invalidates the SigV4 signature (the
Host is signed), so the public proxy returns 403 and the client writes a tiny
error body ("got 535 bytes, expected 670547"). The URL must be signed DIRECTLY
against the externally reachable host (MINIO_PUBLIC_ENDPOINT).

minio-py generates presigned URLs locally (no network for non-AWS hosts), so these
run in the non-DB suite.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app import storage
from app.config import settings


def _presign():
    return storage.presign_get(
        "submissions/7/g20260702-1/scene.eristerrain",
        bucket="eris-offline-scenes",
        expires_seconds=900,
    )


def test_presign_signs_against_public_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "MINIO_ENDPOINT", "http://minio:9000")
    monkeypatch.setattr(settings, "MINIO_PUBLIC_ENDPOINT", "https://files.camposlabs.org")
    monkeypatch.setattr(settings, "MINIO_ACCESS_KEY", "minioadmin")
    monkeypatch.setattr(settings, "MINIO_SECRET_KEY", "minio_root_password")

    url = _presign()
    parts = urlparse(url)
    # The URL is generated for the external host, NOT the internal one rewritten.
    assert parts.scheme == "https"
    assert parts.netloc == "files.camposlabs.org"
    assert "minio:9000" not in url
    # It is a real presigned URL (signature computed for THIS host).
    q = parse_qs(parts.query)
    assert "X-Amz-Signature" in q and q["X-Amz-Signature"][0]
    assert "X-Amz-Credential" in q
    assert parts.path == "/eris-offline-scenes/submissions/7/g20260702-1/scene.eristerrain"


def test_presign_falls_back_to_internal_endpoint_when_no_public(monkeypatch):
    monkeypatch.setattr(settings, "MINIO_ENDPOINT", "http://minio:9000")
    monkeypatch.setattr(settings, "MINIO_PUBLIC_ENDPOINT", None)
    monkeypatch.setattr(settings, "MINIO_ACCESS_KEY", "minioadmin")
    monkeypatch.setattr(settings, "MINIO_SECRET_KEY", "minio_root_password")

    url = _presign()
    parts = urlparse(url)
    assert parts.scheme == "http"
    assert parts.netloc == "minio:9000"
    assert "X-Amz-Signature" in parse_qs(parts.query)


def test_presign_preserves_https_public_endpoint(monkeypatch):
    # An empty-string public endpoint is treated as unset (fallback to internal).
    monkeypatch.setattr(settings, "MINIO_ENDPOINT", "http://minio:9000")
    monkeypatch.setattr(settings, "MINIO_PUBLIC_ENDPOINT", "   ")
    monkeypatch.setattr(settings, "MINIO_ACCESS_KEY", "minioadmin")
    monkeypatch.setattr(settings, "MINIO_SECRET_KEY", "minio_root_password")
    assert urlparse(_presign()).netloc == "minio:9000"
