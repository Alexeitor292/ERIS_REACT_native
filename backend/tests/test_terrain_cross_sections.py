from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


def test_save_and_restore_cross_section_under_caltrans_project(client_db, admin_token):
    from app.db import engine

    suffix = uuid4().hex[:8]
    project_id = None
    cross_section_id = None
    headers = {"Authorization": f"Bearer {admin_token}"}

    try:
        project_response = client_db.post(
            "/terrain-cross-sections/projects",
            headers=headers,
            json={
                "project_number": f"03-TEST-{suffix}",
                "title": f"Cross section test project {suffix}",
                "description": "Temporary integration-test project",
                "district": "03",
            },
        )
        assert project_response.status_code == 201, project_response.text
        project = project_response.json()["project"]
        project_id = int(project["id"])
        assert project["source_system"] == "ERIS_MANUAL"
        assert project["cross_section_count"] == 0

        payload = {
            "project_id": project_id,
            "name": "Existing ground transverse section",
            "notes": "Saved from the terrain cross-section workspace",
            "preferred_spacing_m": 10,
            "actual_spacing_m": 10,
            "dem_source": "ARCGIS_WORLD_ELEVATION",
            "control_points": [
                {"latitude": 38.7000000, "longitude": -121.3000000, "distance_m": 0, "elevation_m": 101.2},
                {"latitude": 38.7001000, "longitude": -121.2999000, "distance_m": 14.1, "elevation_m": 102.7},
                {"latitude": 38.7002000, "longitude": -121.2998000, "distance_m": 28.2, "elevation_m": 100.9},
            ],
            "profile_snapshot": {
                "samples": [
                    {"index": 0, "distance_m": 0, "longitude": -121.3, "latitude": 38.7, "elevation_m": 101.2, "grade_percent": None},
                    {"index": 1, "distance_m": 14.1, "longitude": -121.2999, "latitude": 38.7001, "elevation_m": 102.7, "grade_percent": 10.64},
                ],
                "stats": {
                    "total_distance_m": 14.1,
                    "min_elevation_m": 101.2,
                    "max_elevation_m": 102.7,
                    "elevation_range_m": 1.5,
                    "elevation_gain_m": 1.5,
                    "elevation_loss_m": 0,
                    "sample_count": 2,
                },
            },
        }

        save_response = client_db.post(
            "/terrain-cross-sections",
            headers=headers,
            json=payload,
        )
        assert save_response.status_code == 201, save_response.text
        saved = save_response.json()["cross_section"]
        cross_section_id = int(saved["id"])
        assert saved["project_id"] == project_id
        assert saved["point_count"] == 3
        assert len(saved["control_points"]) == 3
        assert saved["control_points"][0]["sequence_number"] == 1
        assert saved["control_points"][2]["sequence_number"] == 3
        assert saved["profile_snapshot"]["stats"]["sample_count"] == 2

        project_list = client_db.get(
            "/terrain-cross-sections/projects",
            headers=headers,
        )
        assert project_list.status_code == 200, project_list.text
        matching_projects = [item for item in project_list.json()["items"] if item["id"] == project_id]
        assert len(matching_projects) == 1
        assert matching_projects[0]["cross_section_count"] == 1

        section_list = client_db.get(
            f"/terrain-cross-sections/projects/{project_id}/cross-sections",
            headers=headers,
        )
        assert section_list.status_code == 200, section_list.text
        assert [item["id"] for item in section_list.json()["items"]] == [cross_section_id]

        detail_response = client_db.get(
            f"/terrain-cross-sections/{cross_section_id}",
            headers=headers,
        )
        assert detail_response.status_code == 200, detail_response.text
        detail = detail_response.json()["cross_section"]
        assert detail["project"]["id"] == project_id
        assert detail["project"]["project_number"] == f"03-TEST-{suffix}"
        assert [point["sequence_number"] for point in detail["control_points"]] == [1, 2, 3]
        assert detail["profile_snapshot"]["samples"][1]["elevation_m"] == 102.7

        payload["name"] = "Updated transverse section"
        payload["control_points"] = payload["control_points"][:2]
        update_response = client_db.put(
            f"/terrain-cross-sections/{cross_section_id}",
            headers=headers,
            json=payload,
        )
        assert update_response.status_code == 200, update_response.text
        updated = update_response.json()["cross_section"]
        assert updated["name"] == "Updated transverse section"
        assert updated["point_count"] == 2
        assert len(updated["control_points"]) == 2

    finally:
        with engine.begin() as conn:
            if cross_section_id is not None:
                conn.execute(text("DELETE FROM terrain_cross_sections WHERE id=:id"), {"id": cross_section_id})
            if project_id is not None:
                conn.execute(text("DELETE FROM caltrans_projects WHERE id=:id"), {"id": project_id})
