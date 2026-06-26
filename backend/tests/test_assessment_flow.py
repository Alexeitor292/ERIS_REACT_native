"""DB-backed integration tests for the Assessment Routing & Authority Model.

Requires a live MariaDB stamped at Alembic head (migration 0008) seeded with the
standard dev users from database/init/020_seed.sql. Run with: pytest -m db

Maps to the required test matrix (docs/assessment-routing-authority-model.md):
  1  maintenance field worker creates + sees only own reports
  2  maintenance field worker cannot read others' incidents/assessments
  3  coordinator can triage + route
  4  ASSESSMENT_REQUIRED creates/activates the Assessment
  5  routing selects a GeoTech office from district
  6  office chief delegates to branch chief
  7  branch chief assigns engineer
  8  engineer can edit only the assigned assessment's technical form
  9  a user WITHOUT a permanent reviewer role can be assigned + review
 10  unassigned users cannot approve/request revisions
 11  non-maintenance operational users get broad read
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
        "officechief": _login(client_db, "officechief@local"),
        "branchchief": _login(client_db, "branchchief@local"),
        "engineer": _login(client_db, "engineer@local"),
        "reviewer": _login(client_db, "reviewer@local"),
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
# 3 + 4 + 6 + 7 + 8 + 9 + 10 + 12: full happy-path lifecycle
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def triaged(client_db, tokens):
    """Admin creates a district-04 (WEST) incident and triages it
    ASSESSMENT_REQUIRED, creating the Assessment."""
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
    return {"incident_id": incident_id, "assessment_id": assessment["id"]}


@pytest.fixture(scope="module")
def delegated(client_db, tokens, ids, triaged):
    aid = triaged["assessment_id"]
    resp = client_db.post(
        f"/assessments/{aid}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"], "notes": "delegate to branch"},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, f"delegate failed: {resp.status_code} {resp.text}"
    assert resp.json()["assessment"]["state"] == "PENDING_ENGINEER_ASSIGNMENT"
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
    assert body["submission_id"] is not None
    return delegated


@pytest.fixture(scope="module")
def submitted(client_db, tokens, engineer_assigned):
    aid = engineer_assigned["assessment_id"]
    resp = client_db.post(
        f"/assessments/{aid}/submit", json={"notes": "ready for review"}, headers=_auth(tokens["engineer"])
    )
    assert resp.status_code == 200, f"submit failed: {resp.status_code} {resp.text}"
    assert resp.json()["assessment"]["state"] == "SUBMITTED"
    return engineer_assigned


class TestLifecycle:
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

    def test_engineer_assignment_links_submission(self, client_db, tokens, engineer_assigned):
        resp = client_db.get(
            f"/assessments/{engineer_assigned['assessment_id']}", headers=_auth(tokens["branchchief"])
        )
        assert resp.status_code == 200
        assert resp.json()["assessment"]["submission_id"] is not None

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
        # 10: the assigned engineer holds no REVIEWER/APPROVER assignment.
        resp = client_db.post(
            f"/assessments/{submitted['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["engineer"]),
        )
        assert resp.status_code == 403

    def test_assign_reviewer_without_permanent_role_then_review(self, client_db, tokens, ids, submitted):
        # 9: branch chief has no REVIEWER role but can be assigned reviewer for
        # THIS assessment and then approve it.
        aid = submitted["assessment_id"]
        assign = client_db.post(
            f"/assessments/{aid}/assignments",
            json={"user_id": ids["branchchief"], "assignment_role": "REVIEWER"},
            headers=_auth(tokens["officechief"]),
        )
        assert assign.status_code == 200, f"assign reviewer failed: {assign.status_code} {assign.text}"

        review = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "Looks good"},
            headers=_auth(tokens["branchchief"]),
        )
        assert review.status_code == 200, f"review failed: {review.status_code} {review.text}"
        assert review.json()["assessment"]["state"] == "APPROVED"

    def test_office_chief_finalizes_after_approval(self, client_db, tokens, submitted):
        # End of the lifecycle: an APPROVED assessment is finalized by the office
        # chief. Runs after the approve test (definition order shares the state).
        aid = submitted["assessment_id"]
        resp = client_db.post(
            f"/assessments/{aid}/finalize",
            json={"notes": "Closing out"},
            headers=_auth(tokens["officechief"]),
        )
        assert resp.status_code == 200, f"finalize failed: {resp.status_code} {resp.text}"
        assert resp.json()["assessment"]["state"] == "FINALIZED"

    def test_timeline_preserves_decisions(self, client_db, tokens, submitted):
        # 12: the immutable timeline records every decision/assignment.
        resp = client_db.get(f"/assessments/{submitted['assessment_id']}", headers=_auth(tokens["reviewer"]))
        assert resp.status_code == 200
        event_types = {e["event_type"] for e in resp.json()["events"]}
        assert "TRIAGE_DECISION" in event_types
        assert "OFFICE_DELEGATED" in event_types
        assert "ENGINEER_ASSIGNED" in event_types
        assert "SUBMITTED" in event_types


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
