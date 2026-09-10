"""DB-backed integration tests for Assessment Routing v2.

Requires a live MariaDB stamped at Alembic head seeded with the standard dev
users from database/init/020_seed.sql (routing v2 adds seniorspecialist@local
and coordinator04@local — re-run the seed on an already-initialised database).
Run with: pytest -m db

The office chief has exactly two mutually exclusive choices, and each one is a
full lifecycle here:

  TestBranchRoute      triage -> delegate-branch (no engineer_user_id) ->
                       assign-engineer as the NAMED branch chief -> submit as
                       the engineer -> review APPROVE as that branch chief.
  TestSpecialistRoute  triage -> assign-specialist -> submit as the specialist
                       -> review APPROVE as the office chief.

APPROVED is terminal on both: there is no sign-off step, and no reviewer is
ever appointed. The negative matrix lives in test_routing_v2_authority.py.

Maps to the required test matrix (docs/assessment-routing-authority-model.md):
  1  maintenance field worker creates + sees only own reports
  2  maintenance field worker cannot read others' incidents/assessments
  3  coordinator can triage + route
  4  ASSESSMENT_REQUIRED creates/activates the Assessment
  5  routing selects a GeoTech office from district
  6  office chief hands off to a branch chief, or assigns a senior specialist
  7  branch chief assigns engineer
  8  the assignee can edit only their own assessment's technical form
  9  review authority follows the assessment's routing path
 10  unassigned users cannot approve/request revisions
 11  non-maintenance operational users get broad read (REVIEWER keeps it)
 12  timeline preserves decisions + assignments
 13  legacy GISA/submission behaviour still works
"""

import uuid

import pytest

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]


def _login(client_db, email: str, password: str = "password") -> str:
    resp = client_db.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, f"login {email} failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _me_id(client_db, token: str) -> int:
    resp = client_db.get("/auth/me", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return int(resp.json()["id"])


# ---------------------------------------------------------------------------
# Tokens / ids for the standard dev users
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def tokens(client_db):
    return {
        "admin": _login(client_db, "admin@local"),
        "maintenance": _login(client_db, "maintenance@local"),
        "coordinator": _login(client_db, "coordinator@local"),
        # District 04, the district every assessment fixture below creates in.
        # coordinator@local is district 01, so without this account the
        # coordinator-notification recipients resolve to nobody.
        "coordinator04": _login(client_db, "coordinator04@local"),
        "officechief": _login(client_db, "officechief@local"),
        "branchchief": _login(client_db, "branchchief@local"),
        "engineer": _login(client_db, "engineer@local"),
        # Kept: REVIEWER confers no authority in v2 but keeps its broad READ.
        "reviewer": _login(client_db, "reviewer@local"),
        "specialist": _login(client_db, "seniorspecialist@local"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {k: _me_id(client_db, v) for k, v in tokens.items()}


def _create_incident(client_db, token, *, district="04", county="Marin", route="1", post_mile="10.0"):
    payload = {
        "title": f"Assessment flow incident {_RUN}",
        "incident_type": "ROCK_FALL",
        "description": "Integration incident for assessment flow",
        "first_observed_at": "2026-06-25T10:00:00",
        "latitude": 38.0,
        "longitude": -122.5,
        "district": district,
        "county": county,
        "route": route,
        "post_mile": post_mile,
    }
    resp = client_db.post("/incidents", json=payload, headers=_auth(token))
    assert resp.status_code == 200, f"create incident failed: {resp.status_code} {resp.text}"
    return resp.json()["incident"]["id"]


# ---------------------------------------------------------------------------
# 1 + 2: maintenance field worker isolation
# ---------------------------------------------------------------------------


class TestFieldWorkerIsolation:
    def test_field_worker_creates_and_lists_only_own(self, client_db, tokens):
        # Admin creates an incident the field worker should NOT see.
        admin_incident = _create_incident(client_db, tokens["admin"], district="07", county="Los Angeles", route="5")
        # Field worker creates their own.
        own_incident = _create_incident(client_db, tokens["maintenance"])

        resp = client_db.get("/incidents", headers=_auth(tokens["maintenance"]))
        assert resp.status_code == 200
        ids_listed = {item["id"] for item in resp.json()["items"]}
        assert own_incident in ids_listed
        assert admin_incident not in ids_listed, "field worker must not see others' incidents"

    def test_field_worker_cannot_view_others_incident(self, client_db, tokens):
        admin_incident = _create_incident(client_db, tokens["admin"], district="08", county="San Bernardino", route="15")
        resp = client_db.get(f"/incidents/{admin_incident}", headers=_auth(tokens["maintenance"]))
        assert resp.status_code == 403

    def test_field_worker_cannot_list_assessments(self, client_db, tokens):
        resp = client_db.get("/assessments", headers=_auth(tokens["maintenance"]))
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# 5: routing preview
# ---------------------------------------------------------------------------


class TestRoutingPreview:
    def test_preview_district_to_office(self, client_db, tokens):
        resp = client_db.get("/assessments/routing/preview?district=07", headers=_auth(tokens["coordinator"]))
        assert resp.status_code == 200
        assert resp.json()["office_code"] == "SOUTH"

    def test_preview_west(self, client_db, tokens):
        resp = client_db.get("/assessments/routing/preview?district=04", headers=_auth(tokens["coordinator"]))
        assert resp.status_code == 200
        assert resp.json()["office_code"] == "WEST"


# ---------------------------------------------------------------------------
# 3 + 4 + 6 + 7 + 8 + 9 + 10 + 12: the BRANCH route, end to end
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def triaged(client_db, tokens):
    """Admin creates a district-04 (WEST) incident and triages it
    ASSESSMENT_REQUIRED, creating the Assessment with NO route chosen yet."""
    incident_id = _create_incident(client_db, tokens["admin"])
    resp = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "Needs geotech assessment"},
        headers=_auth(tokens["admin"]),
    )
    assert resp.status_code == 200, f"triage failed: {resp.status_code} {resp.text}"
    assessment = resp.json()["assessment"]
    assert assessment["state"] == "PENDING_OFFICE_DELEGATION"
    assert assessment["office_code"] == "WEST"
    assert assessment["triage_disposition"] == "ASSESSMENT_REQUIRED"
    # NULL means "the office chief has not chosen a route yet" — the honest
    # state of a fresh assessment, and the reason nobody can review it.
    assert assessment["routing_path"] is None
    assert assessment["review_owner"] is None
    return {"incident_id": incident_id, "assessment_id": assessment["id"]}


@pytest.fixture(scope="module")
def delegated(client_db, tokens, ids, triaged):
    """The office chief hands off to a branch chief — WITHOUT naming an
    engineer, which the chief may no longer do."""
    aid = triaged["assessment_id"]
    resp = client_db.post(
        f"/assessments/{aid}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"], "notes": "delegate to branch"},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, f"delegate failed: {resp.status_code} {resp.text}"
    body = resp.json()["assessment"]
    assert body["state"] == "PENDING_ENGINEER_ASSIGNMENT"
    assert body["routing_path"] == "BRANCH"
    assert body["branch_chief_user_id"] == ids["branchchief"]
    assert body["review_owner"] == {
        "kind": "BRANCH_CHIEF",
        "user_id": ids["branchchief"],
        "office_code": "WEST",
    }
    return triaged


@pytest.fixture(scope="module")
def engineer_assigned(client_db, tokens, ids, delegated):
    aid = delegated["assessment_id"]
    resp = client_db.post(
        f"/assessments/{aid}/assign-engineer",
        json={"engineer_user_id": ids["engineer"]},
        headers=_auth(tokens["branchchief"]),
    )
    assert resp.status_code == 200, f"assign engineer failed: {resp.status_code} {resp.text}"
    body = resp.json()["assessment"]
    assert body["state"] == "DRAFT"
    assert body["assigned_engineer_user_id"] == ids["engineer"]
    # Route-neutral aliases over the same column (design §3.2).
    assert body["assigned_user_id"] == ids["engineer"]
    assert body["assigned_user_kind"] == "ENGINEER"
    assert body["submission_id"] is not None
    return delegated


@pytest.fixture(scope="module")
def submitted(client_db, tokens, engineer_assigned):
    aid = engineer_assigned["assessment_id"]
    resp = client_db.post(
        f"/assessments/{aid}/submit", json={"notes": "ready for review"}, headers=_auth(tokens["engineer"])
    )
    assert resp.status_code == 200, f"submit failed: {resp.status_code} {resp.text}"
    body = resp.json()
    assert body["assessment"]["state"] == "SUBMITTED"
    # B1: the linked technical form moved with the assessment, in the same
    # transaction, so the reviewer never opens a form the assessment has locked.
    assert body["submissions_transitioned"] == [body["assessment"]["submission_id"]]
    assert body["submissions_skipped"] == []
    return engineer_assigned


class TestBranchRoute:
    def test_assessment_created_for_incident(self, client_db, tokens, triaged):
        resp = client_db.get(
            f"/incidents/{triaged['incident_id']}/assessment", headers=_auth(tokens["admin"])
        )
        assert resp.status_code == 200
        assert resp.json()["assessment"]["id"] == triaged["assessment_id"]

    def test_office_chief_queue_lists_pending(self, client_db, tokens, triaged):
        resp = client_db.get("/assessments?queue=office_chief", headers=_auth(tokens["officechief"]))
        assert resp.status_code == 200
        assert triaged["assessment_id"] in {a["id"] for a in resp.json()["items"]}

    def test_branch_delegation(self, client_db, delegated):
        # Fixture asserts the transition; presence here documents the step.
        assert delegated["assessment_id"] > 0

    def test_branch_chief_assignment_queue(self, client_db, tokens, delegated):
        # The hand-off puts it in THIS branch chief's assignment queue.
        resp = client_db.get("/assessments?queue=branch_chief", headers=_auth(tokens["branchchief"]))
        assert resp.status_code == 200
        assert delegated["assessment_id"] in {a["id"] for a in resp.json()["items"]}

    def test_engineer_assignment_links_submission(self, client_db, tokens, engineer_assigned):
        resp = client_db.get(
            f"/assessments/{engineer_assigned['assessment_id']}", headers=_auth(tokens["branchchief"])
        )
        assert resp.status_code == 200
        assert resp.json()["assessment"]["submission_id"] is not None
        # The engineer's assignment row is the ENGINEER role on this route.
        roles = {a["assignment_role"] for a in resp.json()["assignments"]}
        assert "ENGINEER" in roles

    def test_engineer_can_edit_assigned_submission(self, client_db, tokens, engineer_assigned):
        # 8: the assigned engineer is granted editor on the linked technical form.
        resp = client_db.get(
            f"/assessments/{engineer_assigned['assessment_id']}", headers=_auth(tokens["engineer"])
        )
        submission_id = resp.json()["assessment"]["submission_id"]
        patch = client_db.patch(
            f"/submissions/{submission_id}/gisa",
            json={"geotechnical_assessment_notes": "Engineer field assessment"},
            headers=_auth(tokens["engineer"]),
        )
        assert patch.status_code == 200, f"engineer edit failed: {patch.status_code} {patch.text}"

    def test_unassigned_engineer_cannot_review(self, client_db, tokens, submitted):
        # 10: the assignee is never the reviewer, on either route.
        resp = client_db.post(
            f"/assessments/{submitted['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["engineer"]),
        )
        assert resp.status_code == 403

    def test_review_queue_belongs_to_the_named_branch_chief(self, client_db, tokens, submitted):
        aid = submitted["assessment_id"]
        mine = client_db.get("/assessments?queue=branch_chief_review", headers=_auth(tokens["branchchief"]))
        assert mine.status_code == 200
        assert aid in {a["id"] for a in mine.json()["items"]}
        # The permanent `reviewer` alias resolves to the same rows for them.
        alias = client_db.get("/assessments?queue=reviewer", headers=_auth(tokens["branchchief"]))
        assert alias.status_code == 200
        assert aid in {a["id"] for a in alias.json()["items"]}
        # ...and to nothing for the legacy REVIEWER account, which My Work
        # requests unconditionally: the queue answers 200 with no rows, never 400.
        legacy = client_db.get("/assessments?queue=reviewer", headers=_auth(tokens["reviewer"]))
        assert legacy.status_code == 200
        assert aid not in {a["id"] for a in legacy.json()["items"]}

    def test_can_review_hint_matches_authority(self, client_db, tokens, submitted):
        aid = submitted["assessment_id"]
        chief = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["branchchief"]))
        assert chief.json()["assessment"]["can_review"] is True
        chief_of_office = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["officechief"]))
        assert chief_of_office.json()["assessment"]["can_review"] is False

    def test_named_branch_chief_approves_and_that_ends_it(self, client_db, tokens, ids, submitted):
        # 9: no reviewer is appointed — the branch chief this assessment was
        # handed to holds the authority, and APPROVE is terminal.
        aid = submitted["assessment_id"]
        review = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "Looks good"},
            headers=_auth(tokens["branchchief"]),
        )
        assert review.status_code == 200, f"review failed: {review.status_code} {review.text}"
        body = review.json()
        assert body["state"] == "APPROVED"
        assert body["assessment"]["state"] == "APPROVED"
        assert body["assessment"]["routing_path"] == "BRANCH"
        assert body["assessment"]["approved_at"] is not None
        assert body["assessment"]["finalized_at"] is None
        # Nothing further is required of anyone: the approved assessment is no
        # longer offered for review to its own reviewer.
        assert body["assessment"]["can_review"] is False
        # The linked technical form was approved in the same transaction.
        assert body["submissions_transitioned"] == [body["assessment"]["submission_id"]]
        # The coordinator notice is reported by the endpoint (owner decision 6).
        assert ids["coordinator04"] in body["notified"]["coordinators"]
        assert body["notified"]["channels"] == ["IN_APP", "EMAIL"]
        assert body["notified"]["author"] == ids["engineer"]

    def test_approved_is_terminal(self, client_db, tokens, submitted):
        # Runs after the approve test (definition order shares the module state).
        aid = submitted["assessment_id"]
        again = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "second time"},
            headers=_auth(tokens["branchchief"]),
        )
        assert again.status_code == 409
        # There is no sign-off step after approval any more.
        gone = client_db.post(
            f"/assessments/{aid}/finalize",
            json={"notes": "Closing out"},
            headers=_auth(tokens["officechief"]),
        )
        assert gone.status_code == 410, gone.text
        assert "retired" in gone.json()["detail"]

    def test_timeline_preserves_decisions(self, client_db, tokens, submitted):
        # 12: the immutable timeline records every decision/assignment.
        resp = client_db.get(f"/assessments/{submitted['assessment_id']}", headers=_auth(tokens["reviewer"]))
        assert resp.status_code == 200
        event_types = {e["event_type"] for e in resp.json()["events"]}
        assert "TRIAGE_DECISION" in event_types
        assert "OFFICE_DELEGATED" in event_types
        assert "ENGINEER_ASSIGNED" in event_types
        assert "SUBMITTED" in event_types
        assert "APPROVED" in event_types


# ---------------------------------------------------------------------------
# The SENIOR SPECIALIST route, end to end (the office chief's other choice)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def specialist_assigned(client_db, tokens, ids):
    """Triage a fresh district-04 incident and assign a senior specialist
    directly — no branch chief is ever involved."""
    incident_id = _create_incident(client_db, tokens["admin"])
    triage = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "Coastal slope expertise needed"},
        headers=_auth(tokens["admin"]),
    )
    assert triage.status_code == 200, triage.text
    aid = int(triage.json()["assessment"]["id"])

    options = client_db.get(f"/assessments/{aid}/specialist-options", headers=_auth(tokens["officechief"]))
    assert options.status_code == 200, options.text
    assert options.json()["office_code"] == "WEST"
    assert ids["specialist"] in {int(item["id"]) for item in options.json()["items"]}

    resp = client_db.post(
        f"/assessments/{aid}/assign-specialist",
        json={"specialist_user_id": ids["specialist"], "notes": "Direct assignment"},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, f"assign specialist failed: {resp.status_code} {resp.text}"
    body = resp.json()["assessment"]
    assert body["state"] == "DRAFT"
    assert body["routing_path"] == "SENIOR_SPECIALIST"
    assert body["branch_chief_user_id"] is None
    assert body["assigned_engineer_user_id"] == ids["specialist"]
    assert body["assigned_user_id"] == ids["specialist"]
    assert body["assigned_user_kind"] == "SENIOR_SPECIALIST"
    assert body["submission_id"] is not None
    assert resp.json()["submission_id"] == body["submission_id"]
    # The office owns the review, not one named chief.
    assert body["review_owner"] == {"kind": "OFFICE_CHIEF", "user_id": None, "office_code": "WEST"}
    return {"incident_id": incident_id, "assessment_id": aid}


class TestSpecialistRoute:
    def test_specialist_can_read_the_incident_behind_their_assessment(
        self, client_db, tokens, specialist_assigned
    ):
        # The incident endpoints carry literal role lists rather than following
        # OPERATIONAL_ROLES, so a specialist-only account would be 403'd from
        # the report behind their own assessment unless the new role was added
        # to each of them by hand.
        incident_id = specialist_assigned["incident_id"]
        detail = client_db.get(f"/incidents/{incident_id}", headers=_auth(tokens["specialist"]))
        assert detail.status_code == 200, detail.text
        listed = client_db.get("/incidents", headers=_auth(tokens["specialist"]))
        assert listed.status_code == 200, listed.text
        assert incident_id in {item["id"] for item in listed.json()["items"]}
        mission = client_db.get("/mission-center/incidents", headers=_auth(tokens["specialist"]))
        assert mission.status_code == 200, mission.text
        tree = client_db.get(f"/incidents/{incident_id}/workflow-tree", headers=_auth(tokens["specialist"]))
        assert tree.status_code == 200, tree.text
        # ...and the map/3D config, without which the specialist cannot work.
        runtime = client_db.get("/arcgis/runtime-config", headers=_auth(tokens["specialist"]))
        assert runtime.status_code == 200, runtime.text

    def test_specialist_can_edit_the_technical_form(self, client_db, tokens, specialist_assigned):
        aid = specialist_assigned["assessment_id"]
        detail = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["specialist"]))
        assert detail.status_code == 200, detail.text
        submission_id = detail.json()["assessment"]["submission_id"]
        patch = client_db.patch(
            f"/submissions/{submission_id}/gisa",
            json={"geotechnical_assessment_notes": "Specialist field assessment"},
            headers=_auth(tokens["specialist"]),
        )
        assert patch.status_code == 200, f"specialist edit failed: {patch.status_code} {patch.text}"
        # The specialist's assignment row carries the 17-character role name.
        roles = {a["assignment_role"] for a in detail.json()["assignments"]}
        assert "SENIOR_SPECIALIST" in roles

    def test_specialist_sees_the_work_in_their_own_queue(self, client_db, tokens, specialist_assigned):
        resp = client_db.get("/assessments?queue=assignee", headers=_auth(tokens["specialist"]))
        assert resp.status_code == 200
        assert specialist_assigned["assessment_id"] in {a["id"] for a in resp.json()["items"]}

    def test_specialist_submits_and_office_chief_approves(self, client_db, tokens, ids, specialist_assigned):
        aid = specialist_assigned["assessment_id"]
        submitted = client_db.post(
            f"/assessments/{aid}/submit",
            json={"notes": "specialist assessment ready"},
            headers=_auth(tokens["specialist"]),
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["assessment"]["state"] == "SUBMITTED"
        assert submitted.json()["submissions_transitioned"] == [
            submitted.json()["assessment"]["submission_id"]
        ]

        # It lands in the office chief's review queue, not a branch chief's.
        queue = client_db.get("/assessments?queue=office_chief_review", headers=_auth(tokens["officechief"]))
        assert queue.status_code == 200
        assert aid in {a["id"] for a in queue.json()["items"]}
        branch_queue = client_db.get(
            "/assessments?queue=branch_chief_review", headers=_auth(tokens["branchchief"])
        )
        assert aid not in {a["id"] for a in branch_queue.json()["items"]}

        approved = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "Approved by the office chief"},
            headers=_auth(tokens["officechief"]),
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"
        assert approved.json()["assessment"]["routing_path"] == "SENIOR_SPECIALIST"
        assert approved.json()["assessment"]["finalized_at"] is None
        assert approved.json()["notified"]["author"] == ids["specialist"]

        events = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["admin"])).json()["events"]
        event_types = {e["event_type"] for e in events}
        assert "SPECIALIST_ASSIGNED" in event_types
        assert "OFFICE_DELEGATED" not in event_types
        assert "APPROVED" in event_types

    def test_the_specialist_closes_the_incident_out(self, client_db, tokens, specialist_assigned):
        # Approval ends the ASSESSMENT; the incident stays open until someone
        # resolves it, and on this route that someone is the specialist — who
        # holds the incident's ENGINEER-stage assignment. Runs after the approve
        # test (definition order shares the module state).
        resolved = client_db.post(
            f"/incidents/{specialist_assigned['incident_id']}/resolve",
            json={"comment": "Mitigation complete"},
            headers=_auth(tokens["specialist"]),
        )
        assert resolved.status_code == 200, resolved.text
        incident = client_db.get(
            f"/incidents/{specialist_assigned['incident_id']}", headers=_auth(tokens["admin"])
        )
        assert incident.json()["incident"]["status"] == "RESOLVED"


# ---------------------------------------------------------------------------
# 3: coordinator triages within their own district
# ---------------------------------------------------------------------------


class TestCoordinatorTriage:
    def test_coordinator_triage_in_own_district(self, client_db, tokens):
        # coordinator@local is district 01; create + triage there.
        incident_id = _create_incident(
            client_db, tokens["admin"], district="01", county="Del Norte", route="101"
        )
        resp = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED", "notes": "route it"},
            headers=_auth(tokens["coordinator"]),
        )
        assert resp.status_code == 200, f"coordinator triage failed: {resp.status_code} {resp.text}"
        assert resp.json()["assessment"]["office_code"] == "WEST"

    def test_coordinator_triage_no_assessment(self, client_db, tokens):
        incident_id = _create_incident(
            client_db, tokens["admin"], district="01", county="Humboldt", route="299"
        )
        resp = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "minor, no assessment"},
            headers=_auth(tokens["coordinator"]),
        )
        assert resp.status_code == 200
        assert resp.json()["disposition"] == "NO_ASSESSMENT_REQUIRED"
        assert resp.json()["status"] == "RESOLVED"
        # The report is preserved (not deleted) and no assessment exists.
        check = client_db.get(f"/incidents/{incident_id}/assessment", headers=_auth(tokens["admin"]))
        assert check.status_code == 404
        # Explicit terminal outcome: it leaves the coordinator-review queue.
        inc = client_db.get(f"/incidents/{incident_id}", headers=_auth(tokens["admin"])).json()["incident"]
        assert inc["status"] == "RESOLVED"
        assert inc["current_stage"] == "RESOLVED"
        assert inc["triage_disposition"] == "NO_ASSESSMENT_REQUIRED"


# ---------------------------------------------------------------------------
# Items 2 + 3: non-assessment dispositions get real outcomes WITHOUT clobbering
# location-review metadata.
# ---------------------------------------------------------------------------


def _create_and_link(client_db, token, *, district="04", county="Marin", route="1"):
    """Create an incident and link a (new) location so location_match_metadata is
    populated by the location-review flow. Returns (incident_id, metadata)."""
    incident_id = _create_incident(client_db, token, district=district, county=county, route=route)
    link = client_db.post(
        f"/incidents/{incident_id}/location-link",
        json={"mode": "CREATE_NEW", "comment": "linked at review"},
        headers=_auth(token),
    )
    assert link.status_code == 200, f"location-link failed: {link.status_code} {link.text}"
    inc = client_db.get(f"/incidents/{incident_id}", headers=_auth(token)).json()["incident"]
    assert inc["location_match_metadata"] is not None
    return incident_id, inc["location_match_metadata"]


class TestTriageOutcomes:
    def test_no_assessment_preserves_location_metadata(self, client_db, tokens):
        incident_id, before = _create_and_link(client_db, tokens["admin"])
        assert before.get("mode") == "CREATE_NEW"
        resp = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "n/a"},
            headers=_auth(tokens["admin"]),
        )
        assert resp.status_code == 200
        inc = client_db.get(f"/incidents/{incident_id}", headers=_auth(tokens["admin"])).json()["incident"]
        # location-review metadata is fully preserved (NOT overwritten by triage).
        assert inc["location_match_metadata"].get("mode") == "CREATE_NEW"
        assert inc["location_match_metadata"].get("comment") == "linked at review"
        # The disposition lives in dedicated triage columns.
        assert inc["triage_disposition"] == "NO_ASSESSMENT_REQUIRED"
        assert inc["status"] == "RESOLVED"

    def test_duplicate_links_target_and_preserves_metadata(self, client_db, tokens):
        target_id = _create_incident(client_db, tokens["admin"], district="04", county="Marin", route="1")
        incident_id, _ = _create_and_link(client_db, tokens["admin"])
        resp = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={
                "disposition": "DUPLICATE_OR_LINKED",
                "notes": "dup of earlier report",
                "target_incident_id": target_id,
            },
            headers=_auth(tokens["admin"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["target_incident_id"] == target_id
        inc = client_db.get(f"/incidents/{incident_id}", headers=_auth(tokens["admin"])).json()["incident"]
        assert inc["location_match_metadata"].get("mode") == "CREATE_NEW"  # preserved
        assert inc["triage_disposition"] == "DUPLICATE_OR_LINKED"
        assert inc["duplicate_of_incident_id"] == target_id
        assert inc["status"] == "RESOLVED"

    def test_duplicate_invalid_target_rejected(self, client_db, tokens):
        incident_id = _create_incident(client_db, tokens["admin"], district="04", county="Marin", route="1")
        resp = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "DUPLICATE_OR_LINKED", "target_incident_id": 99999999},
            headers=_auth(tokens["admin"]),
        )
        assert resp.status_code == 404

    def test_needs_info_merges_metadata_and_enables_resubmit(self, client_db, tokens):
        # Reporter creates so they can resubmit; admin triages (bypasses district).
        incident_id = _create_incident(client_db, tokens["maintenance"], district="04", county="Marin", route="1")
        link = client_db.post(
            f"/incidents/{incident_id}/location-link",
            json={"mode": "CREATE_NEW", "comment": "linked"},
            headers=_auth(tokens["admin"]),
        )
        assert link.status_code == 200
        triage = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={
                "disposition": "NEEDS_REPORTER_INFORMATION",
                "notes": "please clarify description",
                "revision_fields": ["description"],
            },
            headers=_auth(tokens["admin"]),
        )
        assert triage.status_code == 200, triage.text
        assert triage.json()["revision_fields"] == ["description"]
        inc = client_db.get(f"/incidents/{incident_id}", headers=_auth(tokens["admin"])).json()["incident"]
        assert inc["location_match_status"] == "NEEDS_REVISION"
        assert inc["triage_disposition"] == "NEEDS_REPORTER_INFORMATION"
        # Merged metadata is well-formed: the reporter-revision channel is armed.
        assert inc["location_match_metadata"].get("revision_fields") == ["description"]
        # The reporter can see and resubmit (only the requested field changed).
        resubmit = client_db.patch(
            f"/incidents/{incident_id}",
            json={
                "title": "Assessment flow incident " + _RUN,
                "incident_type": "ROCK_FALL",
                "description": "Clarified description after coordinator request",
                "first_observed_at": "2026-06-25T10:00:00",
                "latitude": 38.0,
                "longitude": -122.5,
                "district": "04",
                "county": "Marin",
                "route": "1",
                "post_mile": "10.0",
            },
            headers=_auth(tokens["maintenance"]),
        )
        assert resubmit.status_code == 200, f"reporter resubmit failed: {resubmit.status_code} {resubmit.text}"

    def test_triage_blocked_after_routing(self, client_db, tokens):
        # Once ASSESSMENT_REQUIRED routes the incident out of coordinator review,
        # it can no longer be re-triaged.
        incident_id = _create_incident(client_db, tokens["admin"], district="04", county="Marin", route="1")
        first = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED"},
            headers=_auth(tokens["admin"]),
        )
        assert first.status_code == 200
        second = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED"},
            headers=_auth(tokens["admin"]),
        )
        assert second.status_code == 409


# ---------------------------------------------------------------------------
# 11: broad operational read
# ---------------------------------------------------------------------------


class TestBroadRead:
    def test_reviewer_can_list_assessments(self, client_db, tokens, triaged):
        resp = client_db.get("/assessments", headers=_auth(tokens["reviewer"]))
        assert resp.status_code == 200
        assert "items" in resp.json()

    def test_engineer_can_list_assessments(self, client_db, tokens):
        # Legacy FIELD_WORKER == GeoTech engineer == operational -> broad read.
        resp = client_db.get("/assessments", headers=_auth(tokens["engineer"]))
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 13: legacy submission/GISA path still works
# ---------------------------------------------------------------------------


class TestLegacyCompatibility:
    def test_legacy_submission_create_and_patch(self, client_db, tokens):
        create = client_db.post(
            "/submissions", json={"title": f"Legacy compat {_RUN}"}, headers=_auth(tokens["admin"])
        )
        assert create.status_code == 200
        sid = create.json()["submission_id"]
        patch = client_db.patch(
            f"/submissions/{sid}/gisa",
            json={"district": "04", "county": "Marin", "route": "1", "post_mile": "5.0"},
            headers=_auth(tokens["admin"]),
        )
        assert patch.status_code == 200
        assert patch.json()["gisa"]["district"] == "04"


# ---------------------------------------------------------------------------
# Multiple technical submissions per assessment (assessment_submissions)
# ---------------------------------------------------------------------------


class TestMultipleSubmissions:
    def test_engineer_adds_supplemental_submission(self, client_db, tokens, ids):
        # Fresh lifecycle up to DRAFT so this test does not depend on module state.
        incident_id = _create_incident(client_db, tokens["admin"], district="04", county="Marin", route="1")
        triage = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED"},
            headers=_auth(tokens["admin"]),
        )
        assert triage.status_code == 200, triage.text
        aid = triage.json()["assessment"]["id"]
        assert triage.json()["assessment"]["submission_ids"] == []

        # Two steps, two people: the office chief hands off, and only then does
        # the branch chief name the engineer. The chief's one-step shortcut
        # (engineer_user_id on delegate-branch) is gone in v2.
        delegated = client_db.post(
            f"/assessments/{aid}/delegate-branch",
            json={"branch_chief_user_id": ids["branchchief"], "notes": "hand-off"},
            headers=_auth(tokens["officechief"]),
        )
        assert delegated.status_code == 200, delegated.text
        assert delegated.json()["assessment"]["state"] == "PENDING_ENGINEER_ASSIGNMENT"

        assigned = client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"], "notes": "assigned by the branch chief"},
            headers=_auth(tokens["branchchief"]),
        )
        assert assigned.status_code == 200, assigned.text
        body = assigned.json()["assessment"]
        assert body["state"] == "DRAFT"
        assert body["assigned_engineer_user_id"] == ids["engineer"]
        assert body["submission_id"] is not None
        assert body["submission_ids"] == [body["submission_id"]]
        primary = body["submission_id"]

        # Only the assigned engineer may add a supplemental form.
        denied = client_db.post(
            f"/assessments/{aid}/submissions", json={}, headers=_auth(tokens["branchchief"])
        )
        assert denied.status_code in (401, 403)

        added = client_db.post(
            f"/assessments/{aid}/submissions",
            json={"notes": "Supplemental survey"},
            headers=_auth(tokens["engineer"]),
        )
        assert added.status_code == 200, added.text
        supplemental = added.json()["submission_id"]
        assert supplemental != primary
        assessment = added.json()["assessment"]
        assert assessment["submission_ids"] == [primary, supplemental]
        assert assessment["submission_id"] == supplemental, "latest draft becomes the primary pointer"

        # The supplemental draft is pre-filled from the incident and editable by the engineer.
        detail = client_db.get(f"/submissions/{supplemental}", headers=_auth(tokens["engineer"]))
        assert detail.status_code == 200, detail.text
        assert detail.json()["gisa"]["district"] == "04"
        assert detail.json()["context"]["incident_id"] == incident_id
        assert detail.json()["context"]["assessment_id"] == aid
        patch = client_db.patch(
            f"/submissions/{supplemental}/gisa",
            json={"observations_notes": "Supplemental notes"},
            headers=_auth(tokens["engineer"]),
        )
        assert patch.status_code == 200, patch.text

        # Both forms are visible on the assessment detail and in the list.
        listed = client_db.get("/assessments", headers=_auth(tokens["reviewer"]))
        assert listed.status_code == 200
        row = next(item for item in listed.json()["items"] if item["id"] == aid)
        assert row["submission_ids"] == [primary, supplemental]

        events = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["reviewer"])).json()["events"]
        assert "SUBMISSION_CREATED" in {e["event_type"] for e in events}

        submitted = client_db.post(
            f"/assessments/{aid}/submit", json={"notes": "both forms ready"}, headers=_auth(tokens["engineer"])
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["assessment"]["state"] == "SUBMITTED"
        # B1 moves BOTH linked forms with the assessment, in one transaction.
        assert sorted(submitted.json()["submissions_transitioned"]) == sorted([primary, supplemental])
        assert submitted.json()["submissions_skipped"] == []

        # And the branch chief this assessment was handed to — nobody else —
        # approves both records together.
        approved = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "both forms accepted"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        assert sorted(approved.json()["submissions_transitioned"]) == sorted([primary, supplemental])
        for sid in (primary, supplemental):
            form = client_db.get(f"/submissions/{sid}", headers=_auth(tokens["engineer"]))
            assert form.json()["submission"]["status"] == "APPROVED"
