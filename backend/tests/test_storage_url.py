"""
No-DB tests for storage URL generation helpers.

Covers:
  - object_public_url() builds the correct direct URL
  - object_public_url() raises when MINIO_PUBLIC_ENDPOINT is missing
  - object_access_url() routes to presign_get in presigned mode
  - object_access_url() routes to object_public_url in public mode
  - /attachments/{id}/download-url response shape (no real DB required; 401 expected)
"""
import pytest
from unittest.mock import MagicMock, patch


class TestObjectPublicUrl:
    def test_builds_correct_url(self):
        from app import config
        from app.storage import object_public_url

        with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", "http://10.0.0.1:9800"):
            url = object_public_url("eris-uploads", "uploads/abc123.jpg")

        assert url == "http://10.0.0.1:9800/eris-uploads/uploads/abc123.jpg"

    def test_strips_trailing_slash_from_endpoint(self):
        from app import config
        from app.storage import object_public_url

        with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", "http://10.0.0.1:9800/"):
            url = object_public_url("eris-uploads", "uploads/abc123.jpg")

        assert url == "http://10.0.0.1:9800/eris-uploads/uploads/abc123.jpg"

    def test_strips_leading_slash_from_key(self):
        from app import config
        from app.storage import object_public_url

        with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", "http://10.0.0.1:9800"):
            url = object_public_url("eris-uploads", "/uploads/abc123.jpg")

        assert url == "http://10.0.0.1:9800/eris-uploads/uploads/abc123.jpg"

    def test_raises_when_endpoint_missing(self):
        from app import config
        from app.storage import object_public_url

        with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", None):
            with pytest.raises(RuntimeError, match="MINIO_PUBLIC_ENDPOINT"):
                object_public_url("eris-uploads", "uploads/abc123.jpg")

    def test_raises_when_endpoint_empty_string(self):
        from app import config
        from app.storage import object_public_url

        with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", ""):
            with pytest.raises(RuntimeError, match="MINIO_PUBLIC_ENDPOINT"):
                object_public_url("eris-uploads", "uploads/abc123.jpg")


class TestObjectAccessUrl:
    def test_presigned_mode_delegates_to_presign_get(self):
        from app import config, storage

        with patch.object(config.settings, "STORAGE_URL_MODE", "presigned"):
            with patch.object(storage, "presign_get", return_value="https://minio/signed?X-Amz=1") as mock_pg:
                url = storage.object_access_url("my-bucket", "uploads/key.jpg", expires_seconds=600)

        mock_pg.assert_called_once_with("uploads/key.jpg", bucket="my-bucket", expires_seconds=600)
        assert url == "https://minio/signed?X-Amz=1"

    def test_public_mode_returns_direct_url(self):
        from app import config, storage

        with patch.object(config.settings, "STORAGE_URL_MODE", "public"):
            with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", "http://10.0.0.1:9800"):
                url = storage.object_access_url("my-bucket", "uploads/key.jpg", expires_seconds=600)

        assert url == "http://10.0.0.1:9800/my-bucket/uploads/key.jpg"

    def test_public_mode_raises_without_endpoint(self):
        from app import config, storage

        with patch.object(config.settings, "STORAGE_URL_MODE", "public"):
            with patch.object(config.settings, "MINIO_PUBLIC_ENDPOINT", None):
                with pytest.raises(RuntimeError, match="MINIO_PUBLIC_ENDPOINT"):
                    storage.object_access_url("my-bucket", "uploads/key.jpg")

    def test_default_mode_is_presigned(self):
        from app.config import settings
        assert settings.STORAGE_URL_MODE == "presigned"


class TestDownloadUrlEndpointShape:
    """Confirm the endpoint is reachable and returns 401 when unauthenticated (no DB)."""

    def test_requires_auth(self, client):
        resp = client.get("/attachments/1/download-url")
        assert resp.status_code == 401


class TestEnsureBucketExists:
    """Unit tests for ensure_bucket_exists() — all MinIO I/O is mocked."""

    def test_bucket_already_exists_no_make_bucket(self):
        from app.storage import ensure_bucket_exists

        with patch("app.storage._client") as mk:
            mk.return_value.bucket_exists.return_value = True
            ensure_bucket_exists("road-inventory")
            mk.return_value.make_bucket.assert_not_called()

    def test_bucket_missing_calls_make_bucket(self):
        from app.storage import ensure_bucket_exists

        with patch("app.storage._client") as mk:
            mk.return_value.bucket_exists.return_value = False
            ensure_bucket_exists("road-inventory")
            mk.return_value.make_bucket.assert_called_once_with("road-inventory")

    def test_s3error_on_bucket_exists_raises_runtime_error(self):
        from app.storage import ensure_bucket_exists
        from minio.error import S3Error

        fake_resp = MagicMock()
        fake_resp.status = 403
        fake_resp.getheader = MagicMock(return_value=None)
        s3err = S3Error(
            "AccessDenied", "Access Denied", "/road-inventory", "req-1", "host-1",
            fake_resp, bucket_name="road-inventory",
        )

        with patch("app.storage._client") as mk:
            mk.return_value.bucket_exists.side_effect = s3err
            with pytest.raises(RuntimeError, match="MinIO ensure_bucket_exists failed"):
                ensure_bucket_exists("road-inventory")

    def test_s3error_on_make_bucket_raises_runtime_error(self):
        from app.storage import ensure_bucket_exists
        from minio.error import S3Error

        fake_resp = MagicMock()
        fake_resp.status = 500
        fake_resp.getheader = MagicMock(return_value=None)
        s3err = S3Error(
            "InternalError", "Internal server error", "/road-inventory", "req-2", "host-2",
            fake_resp, bucket_name="road-inventory",
        )

        with patch("app.storage._client") as mk:
            mk.return_value.bucket_exists.return_value = False
            mk.return_value.make_bucket.side_effect = s3err
            with pytest.raises(RuntimeError, match="MinIO ensure_bucket_exists failed"):
                ensure_bucket_exists("road-inventory")
