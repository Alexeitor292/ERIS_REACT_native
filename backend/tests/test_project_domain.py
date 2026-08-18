"""Event Group / permanent Incident identity integration tests."""

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


def _login(client, email: str, password: str) -> dict[str, str]:
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _create_user(client, admin_headers: dict[str, str], *, email: str, password: str, roles: list[str], metadata: dict | None = None) -> int:
    payload: dict = {
        "email": email,
        "full_name": email.split("@")[0].replace("-", " ").title(),
        "password": password,
        "roles": roles,
    }
    if metadata is not None:
        payload["metadata"] = metadata
    response = client.post("/admin/users", headers=admin_headers, json=payload)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def _create_incident(client, headers: dict[str, str], *, title: str, post_mile: str) -> dict:
    response = client.post(
        "/incidents",
        headers=headers,
        json={
            "title": title,
            "description": "Provisional maintenance observation.",
            "first_observed_at": "2026-08-18T12:00:00",
            "latitude": 38.5816,
            "longitude": -121.4944,
            "district": "03",
            "county": "SAC",
            "route": "50",
            "post_mile": post_mile,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["incident"]


def _link_location(client, coordinator_headers: dict[str, str], incident_id: int) -> None:
    response = client.post(
        f"/incidents/{incident_id}/location-link",
        headers=coordinator_headers,
        json={"mode": "CREATE_NEW", "comment": "Coordinator confirmed location."},
    )
    assert response.status_code == 200, response.text


def test_incident_is_root_and_approval_mints_permanent_identity(client_db, admin_token):
    from app.db import engine

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    password = "event-group-domain-test-password"
    maintenance_email = f"event-maint-{unique}@example.test"
    coordinator_email = f"event-coord-{unique}@example.test"
    office_email = f"event-office-{unique}@example.test"

    user_ids = [
        _create_user(client_db, admin_headers, email=maintenance_email, password=password, roles=["MAINTENANCE"], metadata={"district": "03"}),
        _create_user(client_db, admin_headers, email=coordinator_email, password=password, roles=["MAINT_COORDINATOR"], metadata={"district": "03"}),
        _create_user(client_db, admin_headers, email=office_email, password=password, roles=["OFFICE_CHIEF"], metadata={"office_code": "NORTH"}),
    ]

    maintenance_headers = _login(client_db, maintenance_email, password)
    coordinator_headers = _login(client_db, coordinator_email, password)

    incident = _create_incident(client_db, maintenance_headers, title=f"Provisional {unique}", post_mile="1.00")
    incident_id = int(incident["id"])
    assert incident["current_stage"] == "COORDINATOR_REVIEW"

    context = client_db.get(f"/incidents/{incident_id}/event-group-context", headers=coordinator_headers)
    assert context.status_code == 200, context.text
    assert context.json()["event_group"] is None
    assert context.json()["incident"]["incident_key"] is None
    assert context.json()["incident"]["is_permanent"] is False

    _link_location(client_db, coordinator_headers, incident_id)

    # No Event Group is chosen. Approval must create one by default and mint the
    # permanent Incident identity in the same transaction.
    approved = client_db.post(
        f"/incidents/{incident_id}/coordinator/approve",
        headers=coordinator_headers,
        json={"comment": "No existing Event Group applies; approve as a new event."},
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["created_event_group"] is True
    assert body["current_stage"] == "OFFICE_CHIEF_REVIEW"
    assert body["incident"]["is_permanent"] is True
    assert body["incident"]["incident_key"]
    assert body["incident"]["approved_at"] is not None
    assert body["incident"]["approved_by_user_id"] is not None
    assert int(body["incident"]["event_group_id"]) == int(body["event_group"]["id"])
    permanent_key = body["incident"]["incident_key"]
    event_group_id = int(body["event_group"]["id"])

    # Approved Incidents are historical and can no longer be discarded.
    discarded = client_db.delete(f"/incidents/{incident_id}/provisional", headers=coordinator_headers)
    assert discarded.status_code == 409, discarded.text

    # Database boundary owns key immutability; an application bug cannot rewrite it.
    with pytest.raises(Exception):
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE incidents SET incident_key = UUID() WHERE id = :iid"),
                {"iid": incident_id},
            )

    with engine.begin() as conn:
        stored = conn.execute(
            text("SELECT incident_key, event_group_id, project_id FROM incidents WHERE id = :iid"),
            {"iid": incident_id},
        ).mappings().one()
    assert stored["incident_key"] == permanent_key
    assert int(stored["event_group_id"]) == event_group_id
    # Deprecated compatibility alias mirrors canonical event_group_id; it is not
    # the domain parent relation.
    assert int(stored["project_id"]) == event_group_id

    for user_id in user_ids:
        response = client_db.patch(f"/admin/users/{user_id}", headers=admin_headers, json={"is_active": False})
        assert response.status_code == 200


def test_multiple_incidents_share_event_group_attribute_without_sharing_identity(client_db, admin_token):
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    unique = uuid4().hex
    password = "event-group-sharing-test-password"
    coordinator_email = f"event-share-coord-{unique}@example.test"
    office_email = f"event-share-office-{unique}@example.test"

    user_ids = [
        _create_user(client_db, admin_headers, email=coordinator_email, password=password, roles=["MAINT_COORDINATOR"], metadata={"district": "03"}),
        _create_user(client_db, admin_headers, email=office_email, password=password, roles=["OFFICE_CHIEF"], metadata={"office_code": "NORTH"}),
    ]
    coordinator_headers = _login(client_db, coordinator_email, password)

    first = _create_incident(client_db, admin_headers, title=f"Shared A {unique}", post_mile="2.00")
    first_id = int(first["id"])
    _link_location(client_db, coordinator_headers, first_id)
    approved_first = client_db.post(f"/incidents/{first_id}/coordinator/approve", headers=coordinator_headers, json={})
    assert approved_first.status_code == 200, approved_first.text
    first_body = approved_first.json()
    group_id = int(first_body["event_group"]["id"])
    first_key = first_body["incident"]["incident_key"]

    second = _create_incident(client_db, admin_headers, title=f"Shared B {unique}", post_mile="2.10")
    second_id = int(second["id"])
    _link_location(client_db, coordinator_headers, second_id)
    association = client_db.post(
        f"/incidents/{second_id}/event-group-association",
        headers=coordinator_headers,
        json={"mode": "EXISTING", "event_group_id": group_id},
    )
    assert association.status_code == 200, association.text

    approved_second = client_db.post(f"/incidents/{second_id}/coordinator/approve", headers=coordinator_headers, json={})
    assert approved_second.status_code == 200, approved_second.text
    second_body = approved_second.json()
    assert int(second_body["incident"]["event_group_id"]) == group_id
    assert second_body["incident"]["incident_key"]
    assert second_body["incident"]["incident_key"] != first_key

    detail = client_db.get(f"/event-groups/{group_id}", headers=coordinator_headers)
    assert detail.status_code == 200, detail.text
    ids = {int(item["id"]) for item in detail.json()["incidents"]}
    assert {first_id, second_id}.issubset(ids)

    # Regrouping a permanent Incident changes only its grouping attribute. The
    # historical Incident key must survive unchanged.
    regrouped = client_db.post(
        f"/incidents/{second_id}/event-group-association",
        headers=admin_headers,
        json={"mode": "CREATE_NEW", "title": f"Replacement Event Group {unique}"},
    )
    assert regrouped.status_code == 200, regrouped.text
    refreshed = client_db.get(f"/incidents/{second_id}/event-group-context", headers=admin_headers)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["incident"]["incident_key"] == second_body["incident"]["incident_key"]
    assert int(refreshed.json()["incident"]["event_group_id"]) != group_id

    for user_id in user_ids:
        response = client_db.patch(f"/admin/users/{user_id}", headers=admin_headers, json={"is_active": False})
        assert response.status_code == 200


def test_provisional_incident_can_be_discarded(client_db, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    incident = _create_incident(client_db, headers, title=f"Disposable {uuid4().hex}", post_mile="3.00")
    incident_id = int(incident["id"])

    discarded = client_db.delete(f"/incidents/{incident_id}/provisional", headers=headers)
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["discarded"] is True

    missing = client_db.get(f"/incidents/{incident_id}/event-group-context", headers=headers)
    assert missing.status_code == 404
