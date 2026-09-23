"""Only a report sent for assessment enters the incident record.

The owner's rule. A field report gets its permanent ERIS number and joins an
Event Group — the real-world site GeoTech work is tracked against, and what the
Event Groups page and the Mission Center show — only when the Maintenance
Coordinator decides it needs an assessment:

  * "Assessment required" names the Event Group in the triage request itself,
    and the group and the decision commit together or not at all;
  * "No assessment required" and "Duplicate or linked" close the report at
    triage. It is kept, but with no ERIS number and no Event Group — even one
    the old triage flow picked beforehand;
  * "Needs more from the reporter" keeps it a temporary field report, outside
    any group, until the coordinator decides;
  * nothing can put a report in a group ahead of that decision.

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


def _accept_into_new_group(client_db, token: str, incident_id: int) -> int:
    resp = _triage(client_db, token, incident_id, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "CREATE_NEW"}})
    assert resp.status_code == 200, resp.text
    return int(_incident(client_db, token, incident_id)["event_group_id"])


def _group_status(group_id: int) -> str:
    from app.db import engine

    with engine.connect() as conn:
        return str(conn.execute(text("SELECT status FROM event_groups WHERE id = :id"), {"id": group_id}).scalar())


def _pregroup_the_old_way(incident_id: int, group_id: int) -> None:
    """What the old triage flow did: a group chosen before any decision."""
    from app.db import engine

    with engine.begin() as conn:
        conn.execute(text("UPDATE incidents SET event_group_id = :g WHERE id = :iid"), {"g": group_id, "iid": incident_id})


def _new_group_holding(incident_id: int) -> int:
    """A fresh open Event Group containing only this (unaccepted) report."""
    from app.db import engine
    from app.routes import event_groups

    with engine.begin() as conn:
        incident = event_groups._incident_row(conn, incident_id)  # type: ignore[arg-type]
        group_id = event_groups._create_event_group_for_incident(conn, incident=incident, actor_user_id=int(incident["reporter_user_id"]))  # type: ignore[arg-type]
        conn.execute(text("UPDATE incidents SET event_group_id = :g WHERE id = :iid"), {"g": group_id, "iid": incident_id})
    return group_id


class TestAClosedReportNeverEntersTheRecord:
    def test_no_assessment_required_closes_it_without_a_number_or_a_group(self, client_db, coordinator_token, new_report):
        incident_id = new_report("No assessment")
        resp = _triage(client_db, coordinator_token, incident_id, {"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Shoulder debris only."})
        assert resp.status_code == 200, resp.text

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["status"] == "RESOLVED"
        assert incident["triage_disposition"] == "NO_ASSESSMENT_REQUIRED"
        assert incident["event_group_id"] is None
        assert incident["incident_key"] is None, "a report closed at triage gets no ERIS number"

    def test_a_duplicate_closes_without_a_number_or_a_group_and_keeps_its_link(self, client_db, coordinator_token, new_report):
        original = new_report("Original")
        duplicate = new_report("Duplicate")
        resp = _triage(client_db, coordinator_token, duplicate, {"disposition": "DUPLICATE_OR_LINKED", "target_incident_id": original})
        assert resp.status_code == 200, resp.text

        incident = _incident(client_db, coordinator_token, duplicate)
        assert incident["status"] == "RESOLVED"
        assert incident["event_group_id"] is None
        assert incident["incident_key"] is None
        assert incident["duplicate_of_incident_id"] == original

    def test_a_group_picked_by_the_old_flow_is_left_and_archived_when_empty(self, client_db, coordinator_token, new_report):
        incident_id = new_report("Pre-grouped, then closed")
        group_id = _new_group_holding(incident_id)
        assert _triage(client_db, coordinator_token, incident_id, {"disposition": "NO_ASSESSMENT_REQUIRED"}).status_code == 200

        assert _incident(client_db, coordinator_token, incident_id)["event_group_id"] is None
        assert _group_status(group_id) == "ARCHIVED", "a group with no report in the record is no longer a site"
        listed = client_db.get("/mission-center/event-groups", headers=_auth(coordinator_token))
        assert listed.status_code == 200, listed.text
        assert group_id not in {item["id"] for item in listed.json()["items"]}

    def test_a_group_that_still_holds_accepted_reports_stays_open(self, client_db, coordinator_token, new_report):
        accepted = new_report("Accepted at the site")
        group_id = _accept_into_new_group(client_db, coordinator_token, accepted)
        stray = new_report("Pre-grouped duplicate")
        _pregroup_the_old_way(stray, group_id)

        resp = _triage(client_db, coordinator_token, stray, {"disposition": "DUPLICATE_OR_LINKED", "target_incident_id": accepted})
        assert resp.status_code == 200, resp.text
        assert _incident(client_db, coordinator_token, stray)["event_group_id"] is None
        assert _group_status(group_id) == "OPEN"
        detail = client_db.get(f"/event-groups/{group_id}", headers=_auth(coordinator_token))
        assert [row["id"] for row in detail.json()["incidents"]] == [accepted]

    def test_the_database_refuses_to_group_a_report_closed_at_triage(self, client_db, coordinator_token, new_report):
        from sqlalchemy.exc import DBAPIError

        from app.db import engine

        closed = new_report("Closed")
        assert _triage(client_db, coordinator_token, closed, {"disposition": "NO_ASSESSMENT_REQUIRED"}).status_code == 200
        group_id = _accept_into_new_group(client_db, coordinator_token, new_report("Accepted"))
        with pytest.raises(DBAPIError, match="does not enter the incident record"):
            _pregroup_the_old_way(closed, group_id)

    def test_a_closed_report_can_still_be_written_to(self, client_db, coordinator_token, new_report):
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


class TestAReportWaitingOnItsReporterIsTemporary:
    def test_sending_it_back_takes_it_out_of_a_group(self, client_db, coordinator_token, new_report):
        incident_id = new_report("Needs more")
        group_id = _new_group_holding(incident_id)
        resp = _triage(client_db, coordinator_token, incident_id, {"disposition": "NEEDS_REPORTER_INFORMATION", "revision_fields": ["post_mile"]})
        assert resp.status_code == 200, resp.text

        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["current_stage"] == "COORDINATOR_REVIEW"
        assert incident["event_group_id"] is None
        assert incident["incident_key"] is None
        assert _group_status(group_id) == "ARCHIVED"

    def test_it_can_still_be_sent_for_assessment_afterwards(self, client_db, coordinator_token, new_report):
        incident_id = new_report("Answered")
        assert _triage(client_db, coordinator_token, incident_id, {"disposition": "NEEDS_REPORTER_INFORMATION", "notes": "Which lane?"}).status_code == 200
        from app.db import engine

        with engine.begin() as conn:  # the reporter's resubmission clears the revision request
            conn.execute(text("UPDATE incidents SET location_match_status = 'PENDING_REVIEW' WHERE id = :iid"), {"iid": incident_id})
        group_id = _accept_into_new_group(client_db, coordinator_token, incident_id)
        incident = _incident(client_db, coordinator_token, incident_id)
        assert incident["incident_key"] and incident["event_group_id"] == group_id


class TestNothingGroupsAReportBeforeItIsAccepted:
    def test_the_association_endpoint_refuses_a_report_awaiting_triage(self, client_db, coordinator_token, new_report):
        incident_id = new_report("Too early")
        resp = client_db.post(
            f"/incidents/{incident_id}/event-group-association",
            json={"mode": "CREATE_NEW"},
            headers=_auth(coordinator_token),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "A report joins an Event Group when the coordinator sends it for assessment"
        assert _incident(client_db, coordinator_token, incident_id)["event_group_id"] is None


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
        assert incident["incident_key"], "only an accepted report gets its ERIS number"
        group = client_db.get(f"/event-groups/{incident['event_group_id']}", headers=_auth(coordinator_token))
        assert group.status_code == 200, group.text
        assert group.json()["event_group"]["title"] == title

    def test_an_existing_group_can_be_joined(self, client_db, coordinator_token, new_report):
        group_id = _accept_into_new_group(client_db, coordinator_token, new_report("First at the site"))
        second = new_report("Second at the site")
        resp = _triage(client_db, coordinator_token, second, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "EXISTING", "event_group_id": group_id}})
        assert resp.status_code == 200, resp.text
        assert _incident(client_db, coordinator_token, second)["event_group_id"] == group_id

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

        # A group whose only report is finished, so the group itself may close.
        accepted = new_report("Finished site")
        group_id = _accept_into_new_group(client_db, coordinator_token, accepted)
        with engine.begin() as conn:
            conn.execute(text("UPDATE incidents SET status = 'RESOLVED' WHERE id = :iid"), {"iid": accepted})
            conn.execute(text("UPDATE event_groups SET status = 'CLOSED' WHERE id = :id"), {"id": group_id})

        late = new_report("Late report")
        resp = _triage(client_db, coordinator_token, late, {"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "EXISTING", "event_group_id": group_id}})
        assert resp.status_code == 409, resp.text
        assert _incident(client_db, coordinator_token, late)["current_stage"] == "COORDINATOR_REVIEW"
