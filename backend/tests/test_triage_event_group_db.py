"""Triage asks for an Event Group only when the report needs an assessment.

An Event Group is the real-world site GeoTech work is tracked against. The
coordinator used to have to place every report in one before any decision could
be recorded — including a report they were about to close as "nothing" or as a
duplicate — because ``trg_incident_identity_bu`` refused every exit from
coordinator review without one.

Now:
  * "Assessment required" names the Event Group in the triage request itself,
    and the group and the decision commit together or not at all;
  * "No assessment required" and "Duplicate or linked" close the report with no
    Event Group, and the database allows exactly that;
  * naming an Event Group with any other decision is refused, not ignored.

Every triage here sends ``X-ERIS-Test-Preserve-Projectless`` so the DB test
client does not quietly group the report first (see conftest).
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

UNGROUPED = {"X-ERIS-Test-Preserve-Projectless": "1"}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client_db, email: str) -> str:
    resp = client_db.post("/auth/login", json={"email": email, "password": "password"})
    assert resp.status_code == 200, f"{email} login failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


@pytest.fixture(scope="module")
def coordinator_token(client_db):
    return _login(client_db, "coordinator@local")


@pytest.fixture(scope="module")
def reporter_token(client_db):
    return _login(client_db, "maintenance@local")


@pytest.fixture
def new_report(client_db, reporter_token):
    """A fresh district-01 report awaiting triage — coordinator@local's district."""

    def make(title: str = "Triage fixture") -> int:
        resp = client_db.post(
            "/incidents",
            json={
                "title": f"{title} {uuid4().hex[:8]}",
                "description": "Cracking across both lanes.",
                "first_observed_at": "2026-09-21T07:30:00",
                "latitude": 40.61,
                "longitude": -124.14,
                "district": "01",
                "county": "HUM",
                "route": "101",
                "post_mile": "84.90",
            },
            headers=_auth(reporter_token),
        )
        assert resp.status_code == 200, f"create incident failed: {resp.status_code} {resp.text}"
        return int(resp.json()["incident"]["id"])

    return make


def _triage(client_db, token: str, incident_id: int, body: dict):
    return client_db.post(f"/incidents/{incident_id}/triage", json=body, headers={**_auth(token), **UNGROUPED})


def _incident(client_db, token: str, incident_id: int) -> dict:
    resp = client_db.get(f"/incidents/{incident_id}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["incident"]


class TestClosingAReportNeedsNoEventGroup:
    def test_no_assessment_required_closes_it_ungrouped(self, client_db, coordinator_token, new_report):
        incident_id = new_report("No assessment")
        resp = _triage(client_db, coordinator_token, incident_id, {"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Shoulder debris only."})
        assert resp.status_code == 200, resp.text

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["status"] == "RESOLVED"
        assert incident["event_group_id"] is None
        assert incident["triage_disposition"] == "NO_ASSESSMENT_REQUIRED"
        # Still accepted into the record: the permanent number is minted as before.
        assert incident["incident_key"]

    def test_duplicate_closes_it_ungrouped_and_keeps_the_link(self, client_db, coordinator_token, new_report):
        original = new_report("Original")
        duplicate = new_report("Duplicate")
        resp = _triage(client_db, coordinator_token, duplicate, {"disposition": "DUPLICATE_OR_LINKED", "target_incident_id": original})
        assert resp.status_code == 200, resp.text

        incident = _incident(client_db, coordinator_token, duplicate)
        assert incident["status"] == "RESOLVED"
        assert incident["event_group_id"] is None
        assert incident["duplicate_of_incident_id"] == original

    def test_a_closed_ungrouped_report_can_still_be_written_to(self, client_db, coordinator_token, new_report):
        """The trigger's exemption covers later updates, not only the closing one."""
        from app.db import engine

        incident_id = new_report("Later update")
        assert _triage(client_db, coordinator_token, incident_id, {"disposition": "NO_ASSESSMENT_REQUIRED"}).status_code == 200
        with engine.begin() as conn:
            conn.execute(text("UPDATE incidents SET updated_at = NOW() WHERE id = :iid"), {"iid": incident_id})

    def test_an_event_group_is_refused_with_any_other_decision(self, client_db, coordinator_token, new_report):
        incident_id = new_report("Refused group")
        resp = _triage(
            client_db,
            coordinator_token,
            incident_id,
            {"disposition": "NO_ASSESSMENT_REQUIRED", "event_group": {"mode": "CREATE_NEW", "title": "Should not exist"}},
        )
        assert resp.status_code == 400, resp.text
        assert "only when the report needs an assessment" in resp.json()["detail"]

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["current_stage"] == "COORDINATOR_REVIEW"
        assert incident["event_group_id"] is None


class TestAssessmentRequiredNamesItsEventGroup:
    def test_without_a_group_it_is_refused_in_plain_words(self, client_db, coordinator_token, new_report):
        incident_id = new_report("No group chosen")
        resp = _triage(client_db, coordinator_token, incident_id, {"disposition": "ASSESSMENT_REQUIRED"})
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "Choose the Event Group this report belongs to before sending it for assessment"
        assert _incident(client_db, coordinator_token, incident_id)["current_stage"] == "COORDINATOR_REVIEW"

    def test_a_new_group_and_the_decision_are_saved_together(self, client_db, coordinator_token, new_report):
        incident_id = new_report("New group")
        title = f"Slide at PM 84.9 {uuid4().hex[:8]}"
        resp = _triage(
            client_db,
            coordinator_token,
            incident_id,
            {"disposition": "ASSESSMENT_REQUIRED", "notes": "Needs a geotech look.", "event_group": {"mode": "CREATE_NEW", "title": title, "description": "Cut slope failure."}},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["assessment"]["id"]

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["current_stage"] == "OFFICE_CHIEF_REVIEW"
        assert incident["incident_key"]
        group = client_db.get(f"/event-groups/{incident['event_group_id']}", headers=_auth(coordinator_token))
        assert group.status_code == 200, group.text
        assert group.json()["event_group"]["title"] == title

    def test_an_existing_group_can_be_joined(self, client_db, coordinator_token, new_report):
        first = new_report("First at the site")
        resp = _triage(client_db, coordinator_token, first, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "CREATE_NEW"}})
        assert resp.status_code == 200, resp.text
        group_id = _incident(client_db, coordinator_token, first)["event_group_id"]

        second = new_report("Second at the site")
        resp = _triage(client_db, coordinator_token, second, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "EXISTING", "event_group_id": group_id}})
        assert resp.status_code == 200, resp.text
        assert _incident(client_db, coordinator_token, second)["event_group_id"] == group_id

    def test_a_report_grouped_beforehand_still_goes_through(self, client_db, coordinator_token, new_report):
        """Older clients group first and triage second; that path keeps working."""
        incident_id = new_report("Grouped first")
        grouped = client_db.post(
            f"/incidents/{incident_id}/event-group-association",
            json={"mode": "CREATE_NEW"},
            headers=_auth(coordinator_token),
        )
        assert grouped.status_code == 200, grouped.text
        resp = _triage(client_db, coordinator_token, incident_id, {"disposition": "ASSESSMENT_REQUIRED"})
        assert resp.status_code == 200, resp.text

    def test_a_decision_that_fails_leaves_the_report_ungrouped(self, client_db, coordinator_token, new_report):
        """The group is written first; when routing then refuses, both roll back."""
        incident_id = new_report("Rolled back")
        title = f"Must not survive {uuid4().hex[:8]}"
        resp = _triage(
            client_db,
            coordinator_token,
            incident_id,
            # An office override without a reason is refused after the group is written.
            {"disposition": "ASSESSMENT_REQUIRED", "office_code_override": "WEST", "event_group": {"mode": "CREATE_NEW", "title": title}},
        )
        assert resp.status_code == 400, resp.text
        assert "override_reason" in resp.json()["detail"]

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["event_group_id"] is None
        assert incident["current_stage"] == "COORDINATOR_REVIEW"
        groups = client_db.get(f"/event-groups?status=ALL&q={title}", headers=_auth(coordinator_token))
        assert groups.status_code == 200, groups.text
        assert groups.json()["items"] == []

    def test_a_closed_group_cannot_be_joined(self, client_db, coordinator_token, new_report):
        from app.db import engine

        # A group whose only report is closed, so the group itself may close.
        first = new_report("Closed site")
        grouped = client_db.post(f"/incidents/{first}/event-group-association", json={"mode": "CREATE_NEW"}, headers=_auth(coordinator_token))
        assert grouped.status_code == 200, grouped.text
        group_id = grouped.json()["event_group"]["id"]
        assert _triage(client_db, coordinator_token, first, {"disposition": "NO_ASSESSMENT_REQUIRED"}).status_code == 200
        with engine.begin() as conn:
            conn.execute(text("UPDATE event_groups SET status = 'CLOSED' WHERE id = :id"), {"id": group_id})

        second = new_report("Late report")
        resp = _triage(client_db, coordinator_token, second, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "EXISTING", "event_group_id": group_id}})
        assert resp.status_code == 409, resp.text
        assert _incident(client_db, coordinator_token, second)["current_stage"] == "COORDINATOR_REVIEW"
