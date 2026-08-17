"""
Terrain grid build endpoint DB tests.

Requires a live MariaDB at Alembic head (0010_gisa_terrain_grid).
Run with: pytest -m db -v tests/test_terrain_grid.py

All tests mock app.services.terrain_grid.fetch_terrain_grid so no real network
calls are made.
"""

from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.db


def _associate_project(client_db, headers: dict[str, str], incident_id: int) -> None:
    response = client_db.post(
        f"/incidents/{incident_id}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Integration Project {incident_id}",
            "notes": "Legacy DB fixture Project association.",
        },
    )
    assert response.status_code == 200, f"Project association failed: {response.status_code} {response.text}"

_PATCH_TARGET = "app.services.terrain_grid.fetch_terrain_grid"


def _mock_terrain(bearing=90.0, source_label="ROAD_GEOMETRY"):
    return {
        "source": "USGS_EPQS_3DEP",
        "checked_at": "2026-06-26T00:00:00",
        "road_bearing_deg_used": bearing,
        "road_bearing_source": None,  # filled by endpoint
        "grid": {
            "rows": 11,
            "columns": 11,
            "along_road_spacing_m": 20.0,
            "cross_road_spacing_m": 20.0,
            "extent_along_m": 200.0,
            "extent_cross_m": 200.0,
            "sample_count": 121,
            "valid_sample_count": 121,
            "points": [{"row": 0, "column": 0, "lat": 37.7, "lon": -122.4, "elevation_ft": 100.0}],
        },
        "error": None,
    }


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
    _associate_project(client_db, {"Authorization": f"Bearer {admin_token}"}, int(incident_id))
    link = client_db.post(
        f"/incidents/{incident_id}/location-link",
        json={"mode": "CREATE_NEW"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert link.status_code == 200, link.text
    fwd = client_db.post(
        f"/incidents/{incident_id}/coordinator/forward",
        json={"comment": "terrain-test"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert fwd.status_code == 200, fwd.text
    return incident_id, fwd.json()["linked_submission_id"]


def _cleanup(incident_id):
    from app.db import engine
    from sqlalchemy import text
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})


class TestTerrainGrid:
    def test_requires_auth(self, client_db):
        resp = client_db.post("/submissions/1/gisa/terrain-grid", json={})
        assert resp.status_code == 401

    def test_400_without_lat_lon(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with engine.begin() as conn:
                conn.execute(text("UPDATE submission_gisa SET latitude=NULL, longitude=NULL WHERE submission_id=:s"), {"s": sub_id})
            resp = client_db.post(
                f"/submissions/{sub_id}/gisa/terrain-grid",
                json={}, headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 400
        finally:
            _cleanup(incident_id)

    def test_builds_and_persists(self, client_db, admin_token):
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_mock_terrain()):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={"road_bearing_deg": 90.0, "force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["cached"] is False
            t = body["terrain"]
            assert t["source"] == "USGS_EPQS_3DEP"
            assert t["grid"]["rows"] == 11 and t["grid"]["valid_sample_count"] == 121
            # endpoint injects the resolved bearing source
            assert t["road_bearing_source"] == "request"
            with engine.connect() as conn:
                row = conn.execute(text("""
                    SELECT elevation_terrain_source, elevation_terrain_checked_at, elevation_terrain_grid_json
                    FROM submission_gisa WHERE submission_id=:s
                """), {"s": sub_id}).mappings().first()
            assert row["elevation_terrain_source"] == "USGS_EPQS_3DEP"
            assert row["elevation_terrain_checked_at"] is not None
            assert row["elevation_terrain_grid_json"] is not None
        finally:
            _cleanup(incident_id)

    def test_cache_prevents_repeat_usgs(self, client_db, admin_token):
        """Second open without force returns the cached grid and does NOT re-query USGS."""
        from unittest.mock import patch, MagicMock

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_mock_terrain()):
                first = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={"road_bearing_deg": 90.0, "force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert first.status_code == 200

            never = MagicMock()
            with patch(_PATCH_TARGET, never):
                second = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={},  # no force
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert second.status_code == 200
            never.assert_not_called()
            assert second.json()["cached"] is True
            assert second.json()["terrain"]["grid"]["rows"] == 11
        finally:
            _cleanup(incident_id)

    def test_snapshot_bearing_reaches_sampling(self, client_db, admin_token):
        """A derivable bearing (here: from the road-inventory snapshot) reaches sampling."""
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa SET road_inventory_snapshot_json=:s WHERE submission_id=:sid
                """), {"sid": sub_id, "s": json.dumps({"route_name": "080", "road_bearing_deg": 245.0})})

            with patch(_PATCH_TARGET, return_value=_mock_terrain(bearing=245.0)) as mock_fetch:
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={"force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            _, kwargs = mock_fetch.call_args
            assert kwargs.get("road_bearing_deg") == 245.0
            assert resp.json()["terrain"]["road_bearing_source"] == "road_inventory_snapshot"
        finally:
            _cleanup(incident_id)

    def test_auto_derived_bearing_reaches_sampling(self, client_db, admin_token):
        """When request + snapshot are absent, a postmile-derived bearing reaches sampling."""
        from unittest.mock import patch

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with patch(_PATCH_TARGET, return_value=_mock_terrain(bearing=77.0)) as mock_fetch, \
                 patch("app.main._derive_road_bearing_from_postmile_layer", return_value=77.0):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={"force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 200, resp.text
            _, kwargs = mock_fetch.call_args
            assert kwargs.get("road_bearing_deg") == 77.0
            assert resp.json()["terrain"]["road_bearing_source"] == "arcgis_postmile_geometry"
        finally:
            _cleanup(incident_id)

    def test_get_submission_returns_terrain(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            grid = _mock_terrain()
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE submission_gisa
                    SET elevation_terrain_source='USGS_EPQS_3DEP',
                        elevation_terrain_checked_at=NOW(),
                        elevation_terrain_grid_json=:g
                    WHERE submission_id=:s
                """), {"s": sub_id, "g": json.dumps(grid)})
            resp = client_db.get(f"/submissions/{sub_id}", headers={"Authorization": f"Bearer {admin_token}"})
            assert resp.status_code == 200
            terr = resp.json()["gisa"]["elevation_terrain"]
            assert terr is not None
            assert terr["source"] == "USGS_EPQS_3DEP"
            assert terr["grid"]["rows"] == 11
        finally:
            _cleanup(incident_id)

    def test_even_dimensions_rejected_422(self, client_db, admin_token):
        """Even rows/columns are rejected before any USGS work (odd-only)."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            for body in ({"rows": 10, "force": True}, {"columns": 8, "force": True}):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json=body,
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
                assert resp.status_code == 422, resp.text
                assert "odd" in resp.text.lower()
        finally:
            _cleanup(incident_id)

    def test_busy_returns_503(self, client_db, admin_token):
        """A second simultaneous build (process-wide guard held) gets a controlled
        503 — not a multi-second wait behind the in-flight build."""
        from unittest.mock import patch
        from app.services.terrain_grid import TerrainBuildBusyError

        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            busy = TerrainBuildBusyError(
                "Terrain sampling is already in progress. Please try again shortly."
            )
            with patch(_PATCH_TARGET, side_effect=busy):
                resp = client_db.post(
                    f"/submissions/{sub_id}/gisa/terrain-grid",
                    json={"road_bearing_deg": 90.0, "force": True},
                    headers={"Authorization": f"Bearer {admin_token}"},
                )
            assert resp.status_code == 503, resp.text
            assert "already in progress" in resp.text.lower()
        finally:
            _cleanup(incident_id)

    def test_permission_denied_for_non_editor(self, client_db, admin_token):
        """A user who is not owner/editor/admin cannot build the terrain grid (403),
        matching existing submission edit access rules."""
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            login = client_db.post("/auth/login", json={"email": "reviewer@local", "password": "password"})
            assert login.status_code == 200, login.text
            other = login.json()["access_token"]
            resp = client_db.post(
                f"/submissions/{sub_id}/gisa/terrain-grid",
                json={"force": True},
                headers={"Authorization": f"Bearer {other}"},
            )
            assert resp.status_code == 403
        finally:
            _cleanup(incident_id)
