"""
Elevation profile enrichment endpoint DB tests.

Requires a live MariaDB at Alembic head (0007_gisa_elevation_profile).
Run with: pytest -m db -v tests/test_elevation_profile.py

All tests mock app.services.elevation_profile.fetch_elevation_profile so
no real network calls are made.
"""

from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.db

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MOCK_PROFILE = {
    "source": "USGS_EPQS_3DEP",
    "checked_at": "2026-06-10T00:00:00",
    "classification": "LEFT_HIGH",
    "confidence": 0.80,
    "profile": {"points": [
        {"offset_m": -10.0, "lat": 37.701, "lon": -122.4, "elevation_ft": 80.0, "source": "USGS_EPQS_3DEP"},
        {"offset_m": 0.0,   "lat": 37.7,   "lon": -122.4, "elevation_ft": 50.0, "source": "USGS_EPQS_3DEP"},
        {"offset_m": 10.0,  "lat": 37.699, "lon": -122.4, "elevation_ft": 30.0, "source": "USGS_EPQS_3DEP"},
    ]},
    "error": None,
}

_PATCH_TARGET = "app.services.elevation_profile.fetch_elevation_profile"


def _create_submission_with_gisa(client_db, admin_token, lat: float | None = 37.7, lon: float | None = -122.4) -> tuple[int, int]:
    """Create incident → link location → forward. Returns (incident_id, submission_id)."""
    incident_payload = {
        "first_observed_at": "2026-06-10T00:00:00",
        "latitude": lat if lat is not None else 37.7,
        "longitude": lon if lon is not None else -122.4,
        "district": "04",
        "county": "ALA",
        "route": "080",
        "post_mile": "5.0",
    }
    resp = client_db.post(
        "/incidents",
        json=incident_payload,
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, resp.text
    incident_id = resp.json()["incident"]["id"]

    link_resp = client_db.post(
        f"/incidents/{incident_id}/location-link",
        json={"mode": "CREATE_NEW"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert link_resp.status_code == 200, link_resp.text

    fwd_resp = client_db.post(
        f"/incidents/{incident_id}/coordinator/forward",
        json={"comment": "elev-test"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert fwd_resp.status_code == 200, fwd_resp.text
    sub_id = fwd_resp.json()["linked_submission_id"]
    return incident_id, sub_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestElevationProfile:

    def test_elevation_profile_requires_auth(self, client_db):
        resp = client_db.post("/submissions/1/gisa/elevation-profile", json={})
        assert resp.status_code == 401

    def test_elevation_profile_returns_400_if_no_lat_lon(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Wipe lat/lon from GISA
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa SET latitude = NULL, longitude = NULL
                    WHERE submission_id = :sid
                """), {"sid": sub_id})

            resp = client_db.post(
                f"/submissions/{sub_id}/gisa/elevation-profile",
                json={},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 400
            detail = resp.json()["detail"].lower()
            assert "latitude" in detail or "location" in detail or "lat" in detail
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_elevation_profile_stores_profile_on_success(self, client_db, admin_token):
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_MOCK_PROFILE):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/elevation-profile",
                    json={"road_bearing_deg": 90.0},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            data = resp.json()
            ep = data["elevation_profile"]
            assert ep["classification"] == "LEFT_HIGH"
            assert ep["source"] == "USGS_EPQS_3DEP"
            assert abs(float(ep["confidence"]) - 0.80) < 0.01
            assert ep["error"] is None

            # Verify DB columns were persisted
            with engine.connect() as conn:
                row = conn.execute(text("""
                    SELECT elevation_profile_classification,
                           elevation_profile_source,
                           elevation_profile_confidence,
                           elevation_profile_checked_at
                    FROM submission_gisa WHERE submission_id = :sid
                """), {"sid": sub_id}).mappings().first()
            assert row is not None
            assert row["elevation_profile_classification"] == "LEFT_HIGH"
            assert row["elevation_profile_source"] == "USGS_EPQS_3DEP"
            assert abs(float(row["elevation_profile_confidence"]) - 0.80) < 0.01
            assert row["elevation_profile_checked_at"] is not None
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_get_submission_returns_gisa_elevation_profile(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Directly seed elevation profile into GISA
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa
                    SET elevation_profile_source         = 'USGS_EPQS_3DEP',
                        elevation_profile_checked_at     = NOW(),
                        elevation_profile_classification = 'CROWN',
                        elevation_profile_confidence     = 0.75,
                        elevation_profile_json           = :profile_json
                    WHERE submission_id = :sid
                """), {
                    "sid": sub_id,
                    "profile_json": json.dumps({"points": []}),
                })

            resp = client_db.get(
                f"/submissions/{sub_id}",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200
            ep = resp.json()["gisa"]["elevation_profile"]
            assert ep is not None
            assert ep["classification"] == "CROWN"
            assert ep["source"] == "USGS_EPQS_3DEP"
            assert abs(float(ep["confidence"]) - 0.75) < 0.01
            assert ep["profile"] == {"points": []}
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_gisa_patch_does_not_wipe_elevation_profile(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Seed elevation profile
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa
                    SET elevation_profile_source         = 'USGS_EPQS_3DEP',
                        elevation_profile_classification = 'FLAT',
                        elevation_profile_confidence     = 0.90,
                        elevation_profile_json           = :profile_json
                    WHERE submission_id = :sid
                """), {
                    "sid": sub_id,
                    "profile_json": json.dumps({"points": []}),
                })

            # Patch unrelated GISA field
            patch_resp = client_db.patch(
                f"/submissions/{sub_id}/gisa",
                json={"observations_notes": "Test note after elev patch"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert patch_resp.status_code == 200

            # Elevation profile must still be intact
            with engine.connect() as conn:
                row = conn.execute(text("""
                    SELECT elevation_profile_classification, elevation_profile_confidence
                    FROM submission_gisa WHERE submission_id = :sid
                """), {"sid": sub_id}).mappings().first()
            assert row["elevation_profile_classification"] == "FLAT"
            assert abs(float(row["elevation_profile_confidence"]) - 0.90) < 0.01
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_bearing_from_request_passed_to_service(self, client_db, admin_token):
        """Explicit road_bearing_deg in payload is forwarded to the elevation service."""
        from unittest.mock import patch

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_MOCK_PROFILE) as mock_fetch:
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/elevation-profile",
                    json={"road_bearing_deg": 135.0, "force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            _, kwargs = mock_fetch.call_args
            assert kwargs.get("road_bearing_deg") == 135.0
        finally:
            from app.db import engine
            from sqlalchemy import text
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_bearing_from_snapshot_used_when_payload_missing(self, client_db, admin_token):
        """When snapshot has road_bearing_deg and payload omits it, snapshot bearing is used."""
        import json as _json
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa
                    SET road_inventory_snapshot_json = :snap
                    WHERE submission_id = :sid
                """), {
                    "sid": sub_id,
                    "snap": _json.dumps({"county_code": "ALA", "route_name": "080", "road_bearing_deg": 270.0}),
                })

            with patch(_PATCH_TARGET, return_value=_MOCK_PROFILE) as mock_fetch:
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/elevation-profile",
                    json={"force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            _, kwargs = mock_fetch.call_args
            assert kwargs.get("road_bearing_deg") == 270.0
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_no_bearing_service_called_with_none(self, client_db, admin_token):
        """Without any bearing source, service receives road_bearing_deg=None."""
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        _unknown_profile = {**_MOCK_PROFILE, "classification": "UNKNOWN", "confidence": None,
                            "profile": {"points": [], "metadata": {"road_bearing_deg_used": None,
                            "road_bearing_source": None, "half_width_m": 60.0, "spacing_m": 10.0,
                            "classification_requires_bearing": True}}}
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_unknown_profile) as mock_fetch:
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/elevation-profile",
                    json={"force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            _, kwargs = mock_fetch.call_args
            assert kwargs.get("road_bearing_deg") is None
            assert resp.json()["elevation_profile"]["classification"] == "UNKNOWN"
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_invalid_explicit_bearing_returns_422(self, client_db, admin_token):
        """Pydantic rejects road_bearing_deg >= 360 before business logic runs."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            resp = client_db.post(
                f"/submissions/{sub_id}/gisa/elevation-profile",
                json={"road_bearing_deg": 400.0},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 422
        finally:
            from app.db import engine
            from sqlalchemy import text
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_elevation_profile_skips_fetch_when_exists_and_no_force(self, client_db, admin_token):
        from unittest.mock import patch, MagicMock
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            # Seed an existing profile
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa
                    SET elevation_profile_source         = 'USGS_EPQS_3DEP',
                        elevation_profile_checked_at     = NOW(),
                        elevation_profile_classification = 'BOWL'
                    WHERE submission_id = :sid
                """), {"sid": sub_id})

            mock_fetch = MagicMock()
            with patch(_PATCH_TARGET, mock_fetch):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/elevation-profile",
                    json={"force": False},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200
            # USGS service must NOT have been called
            mock_fetch.assert_not_called()
            assert resp.json()["elevation_profile"]["classification"] == "BOWL"
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})
