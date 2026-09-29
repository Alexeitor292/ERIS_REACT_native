"""Notices that ask for a step say when the step is done, and read by name.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""
from __future__ import annotations

import re
import uuid

import pytest

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6]
_KEY = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client, email: str) -> dict:
    resp = client.post("/auth/login", json={"email": email, "password": "password"})
    assert resp.status_code == 200, resp.text
    return _auth(resp.json()["access_token"])


def _feed(client, headers) -> list[dict]:
    resp = client.get("/notifications?limit=50", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _unread(client, headers) -> int:
    return client.get("/notifications/unread", headers=headers).json()["unread"]


def _about(items: list[dict], kind: str, assessment_id: int) -> list[dict]:
    return [n for n in items if n["kind"] == kind and n["link"] == f"/my-work?assessment={assessment_id}"]


@pytest.fixture(scope="module")
def routed(client_db, admin_token):
    """A report triaged for assessment (by the admin), so the office chief is asked to route it."""
    incident = client_db.post(
        "/incidents",
        json={
            "title": f"Notification tasks {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Integration incident for task notifications",
            "first_observed_at": "2026-09-28T07:15:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": "10.0",
        },
        headers=_auth(admin_token),
    )
    assert incident.status_code == 200, incident.text
    incident_id = int(incident.json()["incident"]["id"])
    triage = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "task notifications"},
        headers=_auth(admin_token),
    )
    assert triage.status_code == 200, triage.text
    return {
        "incident_id": incident_id,
        "assessment_id": int(triage.json()["assessment"]["id"]),
        "office_chief": _login(client_db, "mock.office.chief@dot.ca.gov"),
        "branch_chief": _login(client_db, "mock.branch.chief@dot.ca.gov"),
    }


def test_a_step_reads_as_a_step_by_the_incident_name_until_it_is_taken(client_db, routed):
    chief = routed["office_chief"]
    [asked] = _about(_feed(client_db, chief), "ASSESSMENT_OFFICE_DELEGATION", routed["assessment_id"])
    assert asked["done"] is None
    # It opens with the incident's name, never the internal incident key.
    assert not _KEY.match(asked["body"] or ""), asked["body"]
    name = client_db.get(f"/incidents/{routed['incident_id']}", headers=chief).json()["incident"]["title"]
    assert name and asked["body"].startswith(name), (name, asked["body"])


def test_once_routed_the_step_is_done_and_leaves_the_badge(client_db, routed):
    chief, aid = routed["office_chief"], routed["assessment_id"]
    unread_before = _unread(client_db, chief)
    me = client_db.get("/auth/me", headers=routed["branch_chief"]).json()["id"]
    resp = client_db.post(f"/assessments/{aid}/delegate-branch", json={"branch_chief_user_id": me}, headers=chief)
    assert resp.status_code == 200, resp.text

    [asked] = _about(_feed(client_db, chief), "ASSESSMENT_OFFICE_DELEGATION", aid)
    done = asked["done"]
    assert done is not None
    assert done["by_you"] is True and done["action"] == "OFFICE_DELEGATED"
    assert done["state"] == "PENDING_ENGINEER_ASSIGNMENT" and done["at"]
    assert not asked["read"]  # still unread, but it no longer needs the chief
    assert _unread(client_db, chief) == unread_before - 1

    # The branch chief's own step is waiting on them.
    [handed] = _about(_feed(client_db, routed["branch_chief"]), "ASSESSMENT_BRANCH_DELEGATION", aid)
    assert handed["done"] is None


def test_handing_it_to_the_chief_who_has_it_is_refused(client_db, routed):
    chief, aid = routed["office_chief"], routed["assessment_id"]
    me = client_db.get("/auth/me", headers=routed["branch_chief"]).json()["id"]
    before = len(_about(_feed(client_db, routed["branch_chief"]), "ASSESSMENT_BRANCH_DELEGATION", aid))
    history = client_db.get(f"/assessments/{aid}", headers=chief).json()
    events_before = len(history.get("events") or [])

    again = client_db.post(f"/assessments/{aid}/delegate-branch", json={"branch_chief_user_id": me}, headers=chief)
    assert again.status_code == 409, again.text
    assert "already has this assessment" in again.json()["detail"]

    # No second notice, no history entry.
    assert len(_about(_feed(client_db, routed["branch_chief"]), "ASSESSMENT_BRANCH_DELEGATION", aid)) == before
    assert len(client_db.get(f"/assessments/{aid}", headers=chief).json().get("events") or []) == events_before


def test_a_triage_step_is_done_once_the_report_is_decided(client_db, admin_token):
    crew = _login(client_db, "mock.maintenance.crew@dot.ca.gov")
    coordinator = _login(client_db, "mock.coordinator.d01@dot.ca.gov")
    report = client_db.post(
        "/incidents",
        json={
            "incident_type": "ROCK_FALL", "description": f"Triage task {_RUN}", "first_observed_at": "2026-09-28T08:00:00",
            "latitude": 40.8, "longitude": -124.1, "district": "01", "county": "HUM", "route": "101", "post_mile": "80.00",
        },
        headers=crew,
    )
    assert report.status_code == 200, report.text
    incident_id = int(report.json()["incident"]["id"])
    title = report.json()["incident"].get("title") or ""

    def asked() -> dict:
        return next(n for n in _feed(client_db, coordinator) if n["kind"] == "INCIDENT_COORDINATOR_REVIEW" and title and title in (n["body"] or ""))

    assert asked()["done"] is None
    decided = client_db.post(
        f"/incidents/{incident_id}/triage", json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "task test"}, headers=coordinator
    )
    assert decided.status_code == 200, decided.text
    done = asked()["done"]
    assert done is not None and done["by_you"] is True and done["action"] == "NO_ASSESSMENT_REQUIRED"
