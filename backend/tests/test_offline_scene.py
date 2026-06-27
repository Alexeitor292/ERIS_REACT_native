"""
Offline 3D scene-package descriptor endpoint DB tests.

Requires a live MariaDB at Alembic head.
Run with: pytest -m db -v tests/test_offline_scene.py
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.db


def _create_submission_with_gisa(client_db, admin_token, lat=37.7, lon=-122.4) -> tuple[int, int]:
    payload = {
        "first_observed_at": "2026-06-10T00:00:00",
        "latitude": lat,
        "longitude": lon,
        "district": "04",
        "county": "ALA",
        "route": "080",
        "post_mile": "5.0",
    }
    resp = client_db.post("/incidents", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    incident_id = resp.json()["incident"]["id"]
    client_db.post(
        f"/incidents/{incident_id}/location-link",
        json={"mode": "CREATE_NEW"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    fwd = client_db.post(
        f"/incidents/{incident_id}/coordinator/forward",
        json={"comment": "offline-scene-test"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert fwd.status_code == 200, fwd.text
    return incident_id, fwd.json()["linked_submission_id"]


def _cleanup(incident_id):
    from app.db import engine
    from sqlalchemy import text
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})


_URL = "/submissions/{sid}/gisa/offline-scene-package"


class TestOfflineScenePackage:
    def test_requires_auth(self, client_db):
        assert client_db.get(_URL.format(sid=1)).status_code == 401

    def test_unavailable_without_host_but_returns_bounds(self, client_db, admin_token, monkeypatch):
        from app.config import settings
        monkeypatch.setattr(settings, "ARCGIS_SCENE_PACKAGE_BASE_URL", None)
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            resp = client_db.get(_URL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["available"] is False
            assert body["reason"]
            # Bounds + size estimate still provided so the UI can show the scope.
            assert body["area"]["radius_m"] > 0
            assert body["package"]["estimated_size_mb"] > 0
            assert body["package"]["download_url"] is None
        finally:
            _cleanup(incident_id)

    def test_available_with_host_builds_download_url(self, client_db, admin_token, monkeypatch):
        from app.config import settings
        monkeypatch.setattr(settings, "ARCGIS_SCENE_PACKAGE_BASE_URL", "https://pkg.example.gov")
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            resp = client_db.get(
                _URL.format(sid=sub_id) + "?radius_m=1200",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["available"] is True
            assert body["area"]["radius_m"] == 1200.0
            assert body["package"]["format"] == "mspk"
            assert body["package"]["download_url"].startswith(
                f"https://pkg.example.gov/submissions/{sub_id}/scene.mspk?sig="
            )
            assert body["content_signature"]
        finally:
            _cleanup(incident_id)

    def test_no_coordinates_unavailable(self, client_db, admin_token, monkeypatch):
        from app.config import settings
        from app.db import engine
        from sqlalchemy import text
        monkeypatch.setattr(settings, "ARCGIS_SCENE_PACKAGE_BASE_URL", "https://pkg.example.gov")
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with engine.begin() as conn:
                conn.execute(text("UPDATE submission_gisa SET latitude=NULL, longitude=NULL WHERE submission_id=:s"), {"s": sub_id})
            resp = client_db.get(_URL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["available"] is False
            assert "coordinates" in body["reason"].lower()
        finally:
            _cleanup(incident_id)
