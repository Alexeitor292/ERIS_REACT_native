from __future__ import annotations

from uuid import uuid4

import pytest

pytestmark = pytest.mark.db


def _create_incident(client_db, headers: dict[str, str], post_mile: str) -> int:
    response = client_db.post(
        "/incidents",
        headers=headers,
        json={
            "title": f"Project lifecycle {uuid4().hex[:8]}",
            "first_observed_at": "2026-08-17T12:00:00",
            "latitude": 38.5816,
            "longitude": -121.4944,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": post_mile,
        },
    )
    assert response.status_code == 200, response.text
    return int(response.json()["incident"]["id"])


def test_project_close_reopen_and_active_incident_gate(client_db, admin_token) -> None:
    headers = {"Authorization": f"Bearer {admin_token}"}
    first_incident_id = _create_incident(client_db, headers, "10.0")

    created = client_db.post(
        f"/incidents/{first_incident_id}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Lifecycle Project {uuid4().hex[:8]}",
            "notes": "Create lifecycle test Project.",
        },
    )
    assert created.status_code == 200, created.text
    project_id = int(created.json()["project"]["id"])
    assert created.json()["project"]["status"] == "OPEN"
    assert int(created.json()["project"]["open_incident_count"]) == 1

    blocked = client_db.post(
        f"/projects/{project_id}/close",
        headers=headers,
        json={"notes": "Should be blocked while Incident is active."},
    )
    assert blocked.status_code == 409, blocked.text
    assert "active Incident" in str(blocked.json()["detail"])

    resolved = client_db.post(
        f"/incidents/{first_incident_id}/triage",
        headers=headers,
        json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Resolve lifecycle test Incident."},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "RESOLVED"

    closed = client_db.post(
        f"/projects/{project_id}/close",
        headers=headers,
        json={"notes": "All Project Incidents are resolved."},
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["changed"] is True
    assert closed.json()["project"]["status"] == "CLOSED"
    assert closed.json()["project"]["closed_at"] is not None

    # Idempotent close keeps the already-closed Project stable and does not add
    # a second lifecycle event.
    closed_again = client_db.post(f"/projects/{project_id}/close", headers=headers, json={})
    assert closed_again.status_code == 200, closed_again.text
    assert closed_again.json()["changed"] is False

    second_incident_id = _create_incident(client_db, headers, "10.2")
    closed_target = client_db.post(
        f"/incidents/{second_incident_id}/project-association",
        headers=headers,
        json={"mode": "EXISTING", "project_id": project_id},
    )
    assert closed_target.status_code == 409, closed_target.text
    assert "open Project" in str(closed_target.json()["detail"])

    reopened = client_db.post(
        f"/projects/{project_id}/reopen",
        headers=headers,
        json={"notes": "New related Incident requires the Project to resume."},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["changed"] is True
    assert reopened.json()["project"]["status"] == "OPEN"
    assert reopened.json()["project"]["closed_at"] is None

    joined = client_db.post(
        f"/incidents/{second_incident_id}/project-association",
        headers=headers,
        json={"mode": "EXISTING", "project_id": project_id, "notes": "Join after reopen."},
    )
    assert joined.status_code == 200, joined.text
    assert int(joined.json()["project"]["id"]) == project_id

    detail = client_db.get(f"/projects/{project_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    event_types = [event["event_type"] for event in detail.json()["events"]]
    assert event_types.count("PROJECT_CLOSED") == 1
    assert event_types.count("PROJECT_REOPENED") == 1
