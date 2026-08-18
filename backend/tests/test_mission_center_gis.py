from __future__ import annotations

import json
from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client, email: str, password: str = "password") -> str:
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def test_mission_center_project_to_incident_gis_drilldown(client_db, admin_token, monkeypatch):
    from app.db import engine
    from app.routes import mission_center_gis, photo_map

    admin_headers = _headers(admin_token)
    maintenance_token = _login(client_db, "maintenance@local")
    maintenance_headers = _headers(maintenance_token)
    unique = uuid4().hex

    created = client_db.post(
        "/incidents",
        headers=admin_headers,
        json={
            "title": f"Mission Center GIS {unique}",
            "description": "GIS drill-down test incident",
            "first_observed_at": "2026-08-17T17:00:00",
            "latitude": 38.5816,
            "longitude": -121.4944,
            "district": "03",
            "county": "SAC",
            "route": "50",
            "post_mile": "1.25",
        },
    )
    assert created.status_code == 200, created.text
    incident_id = int(created.json()["incident"]["id"])

    associated = client_db.post(
        f"/incidents/{incident_id}/project-association",
        headers=admin_headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Mission Center Project {unique}",
            "description": "Statewide GIS test Project",
        },
    )
    assert associated.status_code == 200, associated.text
    project_id = int(associated.json()["project"]["id"])

    # Maintenance reporting accounts do not get statewide operational GIS access.
    assert client_db.get("/mission-center/projects", headers=maintenance_headers).status_code == 403
    assert client_db.get(f"/mission-center/incidents/{incident_id}/gis", headers=maintenance_headers).status_code == 403

    statewide = client_db.get("/mission-center/projects?limit=1", headers=admin_headers)
    assert statewide.status_code == 200, statewide.text
    body = statewide.json()
    assert len(body["items"]) == 1
    assert isinstance(body["has_more"], bool)
    if body["has_more"]:
        assert isinstance(body["next_cursor"], int)

    # Insert a Maintenance-style Incident photo with quality-gated map telemetry.
    # Object URL creation is patched; no MinIO process is required for this DB test.
    monkeypatch.setattr(mission_center_gis, "object_access_url", lambda *args, **kwargs: "https://example.test/incident-photo.jpg")
    monkeypatch.setattr(photo_map, "object_access_url", lambda *args, **kwargs: "https://example.test/incident-photo.jpg")

    with engine.begin() as conn:
        admin_user_id = int(conn.execute(text("SELECT id FROM users WHERE email='admin@local' LIMIT 1")).scalar())
        attachment_result = conn.execute(
            text(
                """
                INSERT INTO attachments
                  (created_by_user_id, storage_provider, storage_bucket, storage_key,
                   file_name, mime_type, file_size_bytes, captured_at, uploaded_at)
                VALUES
                  (:uid, 'minio', 'eris-uploads', :key,
                   'incident-photo.jpg', 'image/jpeg', 1234,
                   '2026-08-17 17:01:00', NOW())
                """
            ),
            {"uid": admin_user_id, "key": f"mission-center/{unique}/incident-photo.jpg"},
        )
        attachment_id = int(attachment_result.lastrowid)
        conn.execute(
            text(
                """
                INSERT INTO incident_attachments (incident_id, attachment_id, kind)
                VALUES (:iid, :aid, 'PHOTO')
                """
            ),
            {"iid": incident_id, "aid": attachment_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO attachment_capture_metadata
                  (attachment_id, captured_at, latitude, longitude,
                   horizontal_accuracy_m, altitude_m,
                   camera_heading_deg, camera_heading_accuracy_code,
                   heading_reference, location_source, heading_source)
                VALUES
                  (:aid, '2026-08-17 17:01:00', 38.5817000, -121.4943000,
                   4.0, 18.0,
                   92.0, 3,
                   'TRUE_NORTH', 'DEVICE_AT_CAPTURE', 'DEVICE_TRUE_HEADING')
                """
            ),
            {"aid": attachment_id},
        )

    before_submission = client_db.get(f"/mission-center/incidents/{incident_id}/gis", headers=admin_headers)
    assert before_submission.status_code == 200, before_submission.text
    before = before_submission.json()
    assert int(before["incident"]["project_id"]) == project_id
    assert before["incident"]["linked_submission_id"] is None
    assert before["geometry"] is None
    assert before["photo_summary"]["photos_total"] == 1
    assert before["photo_summary"]["photos_geotagged"] == 1
    assert before["photo_summary"]["photos_with_heading"] == 1
    assert before["photos"][0]["attachment_id"] == attachment_id
    assert before["photos"][0]["camera_heading_deg"] == 92.0
    assert before["photos"][0]["download_url"] == "https://example.test/incident-photo.jpg"

    # Once assessment routing creates a technical submission, Mission Center adds
    # the saved submission geometry but continues to include Incident photo evidence.
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [-121.4946, 38.5815],
            [-121.4941, 38.5815],
            [-121.4941, 38.5819],
            [-121.4946, 38.5819],
            [-121.4946, 38.5815],
        ]],
    }
    with engine.begin() as conn:
        admin_user_id = int(conn.execute(text("SELECT id FROM users WHERE email='admin@local' LIMIT 1")).scalar())
        submission_result = conn.execute(
            text(
                """
                INSERT INTO submissions
                  (created_by_user_id, status, client_submission_uuid, title)
                VALUES
                  (:uid, 'DRAFT', :uuid, :title)
                """
            ),
            {"uid": admin_user_id, "uuid": f"mission-center-{unique}", "title": f"Mission Center submission {unique}"},
        )
        submission_id = int(submission_result.lastrowid)
        conn.execute(
            text(
                """
                INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id)
                VALUES (:iid, :sid, :uid)
                """
            ),
            {"iid": incident_id, "sid": submission_id, "uid": admin_user_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO submission_gisa (submission_id, geometry_json, updated_by_user_id)
                VALUES (:sid, :geometry_json, :uid)
                """
            ),
            {"sid": submission_id, "geometry_json": json.dumps(geometry), "uid": admin_user_id},
        )

    after_submission = client_db.get(f"/mission-center/incidents/{incident_id}/gis", headers=admin_headers)
    assert after_submission.status_code == 200, after_submission.text
    after = after_submission.json()
    assert int(after["incident"]["linked_submission_id"]) == submission_id
    assert after["geometry"] == geometry
    assert after["geometry_source"] == "SUBMISSION_GISA"
    assert after["photo_summary"]["photos_total"] == 1
    assert after["photos"][0]["attachment_id"] == attachment_id
