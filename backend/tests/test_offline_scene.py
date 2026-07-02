"""
Offline 3D scene-package catalog + descriptor + download + ADMIN registration
DB tests. MinIO is patched (no live object store needed).

Requires a live MariaDB at Alembic head. Run: pytest -m db tests/test_offline_scene.py
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.db


def _create_submission_with_gisa(client_db, admin_token, lat=37.7, lon=-122.4) -> tuple[int, int]:
    payload = {
        "first_observed_at": "2026-06-10T00:00:00",
        "latitude": lat, "longitude": lon,
        "district": "04", "county": "ALA", "route": "080", "post_mile": "5.0",
    }
    resp = client_db.post("/incidents", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    incident_id = resp.json()["incident"]["id"]
    client_db.post(f"/incidents/{incident_id}/location-link", json={"mode": "CREATE_NEW"},
                   headers={"Authorization": f"Bearer {admin_token}"})
    fwd = client_db.post(f"/incidents/{incident_id}/coordinator/forward", json={"comment": "osp"},
                         headers={"Authorization": f"Bearer {admin_token}"})
    assert fwd.status_code == 200, fwd.text
    return incident_id, fwd.json()["linked_submission_id"]


def _cleanup(incident_id):
    from app.db import engine
    from sqlalchemy import text
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})


def _insert_ready(sub_id, version="v1", size=123456, sha="a" * 64, object_key=None, version_id="ver-1"):
    from app.db import engine
    from sqlalchemy import text
    key = object_key or f"submissions/{sub_id}/{version}/scene.mspk"
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO offline_scene_packages
              (submission_id, status, package_version, minio_bucket, object_key, sha256, size_bytes,
               object_version_id, object_etag,
               min_lat, min_lon, max_lat, max_lon, center_lat, center_lon, radius_m,
               elevation_source, elevation_dataset, elevation_version, elevation_resolution,
               basemap_or_imagery_source, content_signature, uploaded_at)
            VALUES
              (:s, 'READY', :v, 'eris-offline-scenes', :k, :sha, :size,
               :vid, 'etag-1',
               38.48, -121.52, 38.52, -121.48, 38.5, -121.5, 1500,
               'USGS_3DEP', '3DEP 1m', '2024', '1m', 'Caltrans imagery', :sig, NOW())
        """), {"s": sub_id, "v": version, "k": key, "sha": sha, "size": size, "vid": version_id, "sig": f"sig-{version}"})


def _stat(size, version_id="ver-1", etag="etag-1"):
    return {"size": size, "etag": etag, "version_id": version_id}


_DESC = "/submissions/{sid}/gisa/offline-scene-package"
_DL = "/submissions/{sid}/gisa/offline-scene-package/download"
_REG = "/admin/offline-scene-packages"


class TestDescriptor:
    def test_requires_auth(self, client_db):
        assert client_db.get(_DESC.format(sid=1)).status_code == 401

    def test_no_catalog_record_unavailable(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            r = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 200, r.text
            assert r.json()["available"] is False
            assert "prepared" in r.json()["reason"].lower()
        finally:
            _cleanup(incident_id)

    def test_record_but_missing_object_unavailable(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id)
            with patch("app.main.stat_object", return_value=None):
                r = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 200
            assert r.json()["available"] is False
            assert "missing" in r.json()["reason"].lower()
        finally:
            _cleanup(incident_id)

    def test_valid_record_and_object_available_with_real_metadata(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id, size=123456)
            with patch("app.main.stat_object", return_value=_stat(123456)):
                r = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 200, r.text
            b = r.json()
            assert b["available"] is True
            assert b["package"]["version"] == "v1"
            assert b["package"]["size_bytes"] == 123456
            assert b["package"]["elevation_source"] == "USGS_3DEP"
            assert b["package"]["download_path"].endswith("/offline-scene-package/download")
            # No raw MinIO URL leaked in the descriptor.
            assert "http" not in str(b["package"]["download_path"])
        finally:
            _cleanup(incident_id)

    def test_size_mismatch_treated_as_unavailable(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id, size=123456)
            with patch("app.main.stat_object", return_value=_stat(999)):
                r = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.json()["available"] is False
        finally:
            _cleanup(incident_id)


class TestDownload:
    def test_download_mints_presigned_url(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id, size=123456)
            with patch("app.main.stat_object", return_value=_stat(123456)), \
                 patch("app.main.presign_get", return_value="http://minio.local/eris-offline-scenes/key?sig=abc"):
                r = client_db.get(_DL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["url"].startswith("http")
            assert body["expires_in_seconds"] > 0
            assert body["package_version"] == "v1"
            assert body["sha256"] == "a" * 64
        finally:
            _cleanup(incident_id)

    def test_download_404_without_package(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            r = client_db.get(_DL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 404
        finally:
            _cleanup(incident_id)

    def test_download_409_when_object_missing(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id)
            with patch("app.main.stat_object", return_value=None):
                r = client_db.get(_DL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 409
        finally:
            _cleanup(incident_id)


def _reg_body(sub_id, version="v1", size=500, sha="b" * 64):
    return {
        "submission_id": sub_id, "package_version": version,
        "size_bytes": size, "sha256": sha,
        "min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48,
        "center_lat": 38.5, "center_lon": -121.5, "radius_m": 1500,
        "elevation_source": "USGS_3DEP", "elevation_dataset": "3DEP 1m", "elevation_version": "2024",
        "elevation_resolution": "1m", "basemap_or_imagery_source": "Caltrans imagery",
        "content_signature": "sig-v1", "notes": "test",
    }


class TestRegistration:
    def test_requires_admin(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            login = client_db.post("/auth/login", json={"email": "reviewer@local", "password": "password"})
            assert login.status_code == 200, login.text
            reviewer = login.json()["access_token"]
            r = client_db.post(_REG, json=_reg_body(sub_id), headers={"Authorization": f"Bearer {reviewer}"})
            assert r.status_code == 403
        finally:
            _cleanup(incident_id)

    def test_object_missing_rejected(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=None):
                r = client_db.post(_REG, json=_reg_body(sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 404
        finally:
            _cleanup(incident_id)

    def test_size_mismatch_rejected(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=_stat(999)):
                r = client_db.post(_REG, json=_reg_body(sub_id, size=500), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 409
            assert "size" in r.text.lower()
        finally:
            _cleanup(incident_id)

    def test_hash_mismatch_rejected(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=_stat(500)), \
                 patch("app.services.offline_scene_catalog.sha256_of_object", return_value="c" * 64):
                r = client_db.post(_REG, json=_reg_body(sub_id, sha="b" * 64, size=500), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 409
            assert "sha" in r.text.lower()
        finally:
            _cleanup(incident_id)

    def test_invalid_bounds_rejected(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            body = _reg_body(sub_id)
            body["min_lat"], body["max_lat"] = 38.9, 38.4  # min > max
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True):
                r = client_db.post(_REG, json=body, headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 422
        finally:
            _cleanup(incident_id)

    def test_success_and_immutable_replacement(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Register v1.
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=_stat(500)), \
                 patch("app.services.offline_scene_catalog.sha256_of_object", return_value="b" * 64):
                r1 = client_db.post(_REG, json=_reg_body(sub_id, version="v1", sha="b" * 64, size=500),
                                    headers={"Authorization": f"Bearer {admin_token}"})
            assert r1.status_code == 200, r1.text
            assert r1.json()["package"]["status"] == "READY"

            # Duplicate v1 rejected (immutable).
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=_stat(500)), \
                 patch("app.services.offline_scene_catalog.sha256_of_object", return_value="b" * 64):
                rdup = client_db.post(_REG, json=_reg_body(sub_id, version="v1", sha="b" * 64, size=500),
                                      headers={"Authorization": f"Bearer {admin_token}"})
            assert rdup.status_code == 409

            # Register v2 -> v1 retired, descriptor uses v2.
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
                 patch("app.services.offline_scene_catalog.stat_object", return_value=_stat(600)), \
                 patch("app.services.offline_scene_catalog.sha256_of_object", return_value="d" * 64):
                r2 = client_db.post(_REG, json=_reg_body(sub_id, version="v2", sha="d" * 64, size=600),
                                    headers={"Authorization": f"Bearer {admin_token}"})
            assert r2.status_code == 200, r2.text

            from app.db import engine
            from sqlalchemy import text
            with engine.connect() as conn:
                rows = conn.execute(text("""
                    SELECT package_version, status FROM offline_scene_packages
                    WHERE submission_id=:s ORDER BY id
                """), {"s": sub_id}).mappings().all()
            statuses = {r["package_version"]: r["status"] for r in rows}
            assert statuses == {"v1": "RETIRED", "v2": "READY"}

            with patch("app.main.stat_object", return_value=_stat(600)):
                d = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert d.json()["package"]["version"] == "v2"
        finally:
            _cleanup(incident_id)

    def test_bucket_missing_fails_closed(self, client_db, admin_token):
        """Backend must NOT silently create the bucket; missing bucket -> 409."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=False):
                r = client_db.post(_REG, json=_reg_body(sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 409
            assert "bucket" in r.text.lower()
        finally:
            _cleanup(incident_id)

    def test_wrong_object_key_rejected(self, client_db, admin_token):
        """A supplied object_key that differs from the canonical key is rejected."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            body = _reg_body(sub_id, version="v1")
            body["object_key"] = f"submissions/{sub_id}/v1/WRONG.mspk"
            with patch("app.services.offline_scene_catalog.bucket_exists", return_value=True):
                r = client_db.post(_REG, json=body, headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 422
            assert "canonical" in r.text.lower()
        finally:
            _cleanup(incident_id)

    def test_provenance_required(self, client_db, admin_token):
        """READY registration requires elevation dataset/version/resolution + basemap,
        and elevation_source is server-enforced to USGS_3DEP."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Missing elevation_dataset -> 422.
            body = _reg_body(sub_id)
            del body["elevation_dataset"]
            r = client_db.post(_REG, json=body, headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 422
            # Wrong elevation_source -> 422 (server-enforced literal).
            body2 = _reg_body(sub_id)
            body2["elevation_source"] = "SRTM"
            r2 = client_db.post(_REG, json=body2, headers={"Authorization": f"Bearer {admin_token}"})
            assert r2.status_code == 422
            # Empty basemap -> 422.
            body3 = _reg_body(sub_id)
            body3["basemap_or_imagery_source"] = ""
            r3 = client_db.post(_REG, json=body3, headers={"Authorization": f"Bearer {admin_token}"})
            assert r3.status_code == 422
        finally:
            _cleanup(incident_id)


class TestObjectIdentity:
    def test_identity_mismatch_same_size_unavailable(self, client_db, admin_token):
        """Same byte size but a different immutable version id => replacement
        detected => descriptor unavailable."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            _insert_ready(sub_id, size=123456, version_id="ver-1")
            # Object now reports the SAME size but a DIFFERENT version id.
            with patch("app.main.stat_object", return_value=_stat(123456, version_id="ver-2")):
                r = client_db.get(_DESC.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 200
            assert r.json()["available"] is False
        finally:
            _cleanup(incident_id)
