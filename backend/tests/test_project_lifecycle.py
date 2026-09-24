from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

# A report enters an Incident Group (the legacy "Project") only when the
# coordinator sends it for assessment, so every report here is grouped by that
# triage decision. The header keeps the DB test client from grouping it first.
UNGROUPED = {"X-ERIS-Test-Preserve-Projectless": "1"}


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


def _send_for_assessment(client_db, headers: dict[str, str], incident_id: int, event_group: dict):
    return client_db.post(
        f"/incidents/{incident_id}/triage",
        headers={**headers, **UNGROUPED},
        json={"disposition": "ASSESSMENT_REQUIRED", "event_group": event_group},
    )


def test_project_close_reopen_and_active_incident_gate(client_db, admin_token) -> None:
    from app.db import engine

    headers = {"Authorization": f"Bearer {admin_token}"}
    first_incident_id = _create_incident(client_db, headers, "10.0")

    accepted = _send_for_assessment(client_db, headers, first_incident_id, {"mode": "CREATE_NEW", "title": f"Lifecycle Project {uuid4().hex[:8]}"})
    assert accepted.status_code == 200, accepted.text
    with engine.begin() as conn:
        project_id = int(conn.execute(text("SELECT event_group_id FROM incidents WHERE id = :iid"), {"iid": first_incident_id}).scalar())

    created = client_db.get(f"/projects/{project_id}", headers=headers)
    assert created.status_code == 200, created.text
    assert created.json()["project"]["status"] == "OPEN"
    assert int(created.json()["project"]["open_incident_count"]) == 1

    blocked = client_db.post(
        f"/projects/{project_id}/close",
        headers=headers,
        json={"notes": "Should be blocked while Incident is active."},
    )
    assert blocked.status_code == 409, blocked.text
    assert "active Incident" in str(blocked.json()["detail"])

    # The assessment workflow is not what this test is about: finish the report
    # directly so the group has no active report left.
    with engine.begin() as conn:
        conn.execute(text("UPDATE incidents SET status = 'RESOLVED' WHERE id = :iid"), {"iid": first_incident_id})

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
    closed_target = _send_for_assessment(client_db, headers, second_incident_id, {"mode": "EXISTING", "event_group_id": project_id})
    assert closed_target.status_code == 409, closed_target.text
    assert "open Incident Group" in str(closed_target.json()["detail"])

    # The same rule is enforced by MariaDB, not only by the API. A direct SQL
    # attempt cannot attach an Incident to a closed Project.
    with pytest.raises(Exception):
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE incidents SET project_id = :pid WHERE id = :iid"),
                {"pid": project_id, "iid": second_incident_id},
            )

    with engine.begin() as conn:
        stored_project_id = conn.execute(
            text("SELECT project_id FROM incidents WHERE id = :iid"),
            {"iid": second_incident_id},
        ).scalar()
    assert stored_project_id is None

    reopened = client_db.post(
        f"/projects/{project_id}/reopen",
        headers=headers,
        json={"notes": "New related Incident requires the Project to resume."},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["changed"] is True
    assert reopened.json()["project"]["status"] == "OPEN"
    assert reopened.json()["project"]["closed_at"] is None

    joined = _send_for_assessment(client_db, headers, second_incident_id, {"mode": "EXISTING", "event_group_id": project_id})
    assert joined.status_code == 200, joined.text
    with engine.begin() as conn:
        joined_project_id = conn.execute(text("SELECT project_id FROM incidents WHERE id = :iid"), {"iid": second_incident_id}).scalar()
    assert int(joined_project_id) == project_id

    # Once an active Incident belongs to the reopened Project, direct SQL cannot
    # close it behind the application's back.
    with pytest.raises(Exception):
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE projects SET status = 'CLOSED' WHERE id = :pid"),
                {"pid": project_id},
            )

    detail = client_db.get(f"/projects/{project_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["project"]["status"] == "OPEN"
    event_types = [event["event_type"] for event in detail.json()["events"]]
    assert event_types.count("PROJECT_CLOSED") == 1
    assert event_types.count("PROJECT_REOPENED") == 1
