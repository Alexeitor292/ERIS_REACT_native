"""Project-domain integration tests.

These tests exercise the real MariaDB-backed API contract:
- maintenance intake is intentionally unclassified
- a coordinator may request corrected reporter information before Project choice
- routing/terminal triage is blocked until Project association
- a coordinator can create a Project from an Incident
- nearby Project discovery returns map-ready Project + Incident geography
- a second Incident can join the same Project
- maintenance reporters cannot browse the operational Project directory/map
- once associated, coordinator triage may advance/close the Incident
"""

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


def _login(client, email: str, password: str) -> dict[str, str]:
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _create_user(client, admin_headers: dict[str, str], *, email: str, password: str, roles: list[str], district: str | None = None) -> int:
    payload: dict = {
        "email": email,
        "full_name": email.split("@")[0].replace("-", " ").title(),
        "password": password,
        "roles": roles,
    }
    if district is not None:
        payload["metadata"] = {"district": district}
    response = client.post("/admin/users", headers=admin_headers, json=payload)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def _create_incident(client, headers: dict[str, str], *, title: str, latitude: float, longitude: float, post_mile: str):
    response = client.post(
        "/incidents",
        headers=headers,
        json={
            "title": title,
            # Legacy clients may still send this field. Intake MUST discard it;
            # classification belongs to the completed on-site assessment.
            "incident_type": "ROCK_FALL",
            "description": "Maintenance observation awaiting coordinator review.",
            "first_observed_at": "2026-08-17T12:00:00",
            "latitude": latitude,
            "longitude": longitude,
            "district": "03",
            "county": "SAC",
            "route": "50",
            "post_mile": post_mile,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["incident"]


def test_project_is_parent_authority_for_incident_intake_and_triage(client_db, admin_token):
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    password = "project-domain-test-password"
    maintenance_email = f"project-maint-{unique}@example.test"
    coordinator_email = f"project-coord-{unique}@example.test"

    maintenance_id = _create_user(
        client_db,
        admin_headers,
        email=maintenance_email,
        password=password,
        roles=["MAINTENANCE"],
        district="03",
    )
    coordinator_id = _create_user(
        client_db,
        admin_headers,
        email=coordinator_email,
        password=password,
        roles=["MAINT_COORDINATOR"],
        district="03",
    )

    maintenance_headers = _login(client_db, maintenance_email, password)
    coordinator_headers = _login(client_db, coordinator_email, password)

    incident_a = _create_incident(
        client_db,
        maintenance_headers,
        title=f"Project intake A {unique}",
        latitude=38.58160,
        longitude=-121.49440,
        post_mile="1.00",
    )
    incident_a_id = int(incident_a["id"])

    # Maintenance intake is intentionally unclassified. Project state belongs to
    # the coordinator context API rather than the reporter-facing legacy payload.
    assert incident_a["incident_type"] is None
    assert incident_a["current_stage"] == "COORDINATOR_REVIEW"

    maintenance_project_browse = client_db.get(
        f"/incidents/{incident_a_id}/nearby-projects",
        headers=maintenance_headers,
    )
    assert maintenance_project_browse.status_code == 403
    maintenance_project_list = client_db.get("/projects", headers=maintenance_headers)
    assert maintenance_project_list.status_code == 403

    context_before = client_db.get(
        f"/incidents/{incident_a_id}/project-context",
        headers=coordinator_headers,
    )
    assert context_before.status_code == 200, context_before.text
    assert context_before.json()["project"] is None
    assert context_before.json()["requires_project_association"] is True
    assert context_before.json()["incident"]["incident_type"] is None

    # Reporter-information correction may still be requested before Project
    # choice, because the corrected location/postmile can be needed to make that
    # association decision. This disposition does not leave coordinator review.
    needs_info = client_db.post(
        f"/incidents/{incident_a_id}/triage",
        headers=coordinator_headers,
        json={
            "disposition": "NEEDS_REPORTER_INFORMATION",
            "notes": "Confirm the reported post mile before Project association.",
            "revision_fields": ["post_mile"],
        },
    )
    assert needs_info.status_code == 200, needs_info.text
    assert needs_info.json()["disposition"] == "NEEDS_REPORTER_INFORMATION"

    # Any outcome that would leave coordinator review is blocked by the database
    # invariant until Project ownership is known. Existing triage code currently
    # normalizes SQL invariant failures to 400; a future route-level precheck may
    # promote this to 409 without changing the authority contract.
    blocked_triage = client_db.post(
        f"/incidents/{incident_a_id}/triage",
        headers={**coordinator_headers, "X-ERIS-Test-Preserve-Projectless": "1"},
        json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Project association intentionally missing."},
    )
    assert blocked_triage.status_code in {400, 409}, blocked_triage.text
    assert "Project" in str(blocked_triage.json().get("detail", ""))

    created_project = client_db.post(
        f"/incidents/{incident_a_id}/project-association",
        headers=coordinator_headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"US 50 Corridor Project {unique}",
            "description": "Coordinator-created operational Project.",
            "notes": "No suitable existing Project was present near the report.",
        },
    )
    assert created_project.status_code == 200, created_project.text
    project_a = created_project.json()["project"]
    project_id = int(project_a["id"])
    assert created_project.json()["created"] is True
    assert created_project.json()["changed"] is True
    assert project_a["status"] == "OPEN"
    assert project_a["title"] == f"US 50 Corridor Project {unique}"

    context_after = client_db.get(
        f"/incidents/{incident_a_id}/project-context",
        headers=coordinator_headers,
    )
    assert context_after.status_code == 200, context_after.text
    assert int(context_after.json()["project"]["id"]) == project_id
    assert context_after.json()["project"]["title"] == project_a["title"]
    assert context_after.json()["requires_project_association"] is False
    assert context_after.json()["incident"]["incident_type"] is None

    incident_b = _create_incident(
        client_db,
        maintenance_headers,
        title=f"Project intake B {unique}",
        latitude=38.58210,
        longitude=-121.49390,
        post_mile="1.10",
    )
    incident_b_id = int(incident_b["id"])
    assert incident_b["incident_type"] is None

    nearby = client_db.get(
        f"/incidents/{incident_b_id}/nearby-projects?radius_m=5000&limit=25",
        headers=coordinator_headers,
    )
    assert nearby.status_code == 200, nearby.text
    nearby_body = nearby.json()
    assert int(nearby_body["incident"]["id"]) == incident_b_id
    assert nearby_body["incident"]["project_id"] is None

    matching = [item for item in nearby_body["items"] if int(item["id"]) == project_id]
    assert matching, nearby_body
    candidate = matching[0]
    assert candidate["nearest_distance_m"] >= 0
    assert candidate["nearest_distance_m"] < 5000
    assert int(candidate["incident_count"]) == 1
    assert any(int(item["id"]) == incident_a_id for item in candidate["incidents"])

    joined = client_db.post(
        f"/incidents/{incident_b_id}/project-association",
        headers=coordinator_headers,
        json={
            "mode": "EXISTING",
            "project_id": project_id,
            "notes": "Nearby Project map and incident history show the same operational area.",
        },
    )
    assert joined.status_code == 200, joined.text
    assert int(joined.json()["project"]["id"]) == project_id
    assert joined.json()["created"] is False
    assert joined.json()["changed"] is True

    project_detail = client_db.get(f"/projects/{project_id}", headers=coordinator_headers)
    assert project_detail.status_code == 200, project_detail.text
    project_detail_body = project_detail.json()
    assert int(project_detail_body["project"]["incident_count"]) == 2
    incident_ids = {int(item["id"]) for item in project_detail_body["incidents"]}
    assert {incident_a_id, incident_b_id}.issubset(incident_ids)
    event_types = [item["event_type"] for item in project_detail_body["events"]]
    assert "PROJECT_CREATED" in event_types
    assert "INCIDENT_LINKED" in event_types

    triage = client_db.post(
        f"/incidents/{incident_b_id}/triage",
        headers=coordinator_headers,
        json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "No GeoTech assessment required for this report."},
    )
    assert triage.status_code == 200, triage.text
    assert triage.json()["status"] == "RESOLVED"

    resolved_context = client_db.get(
        f"/incidents/{incident_b_id}/project-context",
        headers=coordinator_headers,
    )
    assert resolved_context.status_code == 200
    assert resolved_context.json()["incident"]["status"] == "RESOLVED"
    assert int(resolved_context.json()["incident"]["project_id"]) == project_id
    assert resolved_context.json()["incident"]["incident_type"] is None

    for user_id in (maintenance_id, coordinator_id):
        response = client_db.patch(
            f"/admin/users/{user_id}",
            headers=admin_headers,
            json={"is_active": False},
        )
        assert response.status_code == 200


def test_incident_classification_is_discarded_until_assessment_is_approved(client_db, admin_token):
    """The DB boundary, not just the Web form, owns classification timing."""
    from app.db import engine

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    incident = _create_incident(
        client_db,
        admin_headers,
        title=f"Classification boundary {unique}",
        latitude=38.5900,
        longitude=-121.4900,
        post_mile="2.00",
    )
    incident_id = int(incident["id"])
    assert incident["incident_type"] is None

    # Direct SQL cannot bypass the application and classify intake prematurely.
    # Compatibility posture is non-disruptive: the write succeeds but the trigger
    # restores the authoritative pre-assessment value (NULL here).
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE incidents SET incident_type = 'ROCK_FALL' WHERE id = :iid"),
            {"iid": incident_id},
        )
        stored_type = conn.execute(
            text("SELECT incident_type FROM incidents WHERE id = :iid"),
            {"iid": incident_id},
        ).scalar()
    assert stored_type is None

    refreshed = client_db.get(f"/incidents/{incident_id}", headers=admin_headers)
    assert refreshed.status_code == 200
    assert refreshed.json()["incident"]["incident_type"] is None
