"""DB-backed integration tests for the Incident Workflow Tree read model.

Requires a live MariaDB at Alembic head, seeded with the standard dev users.
Run with: pytest -m db

Covers the required matrix:
  1  new report before triage
  2  assessment-required path (delegation -> engineer -> review -> finalization)
  3  needs-reporter-information loop
  4  no-assessment-required terminal
  5  duplicate/linked terminal with linked target
  6  revision-requested path (review NOT marked completed)
  7  correct current-owner resolution (asserted throughout)
  8  maintenance field worker cannot read another user's tree
  9  operational users get broad workflow data
 10  historical nodes keep the original actor after reassignment
"""

import uuid

import pytest

pytestmark = pytest.mark.db


def _associate_project(client_db, headers: dict[str, str], incident_id: int) -> None:
    response = client_db.post(
        f"/incidents/{incident_id}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Integration Project {incident_id}",
            "notes": "Legacy DB fixture Project association.",
        },
    )
    assert response.status_code == 200, f"Project association failed: {response.status_code} {response.text}"

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
        "title": f"Workflow tree incident {_RUN}",
        "incident_type": "ROCK_FALL",
        "description": "Integration incident for workflow tree tests",
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


def _tree(client_db, token, incident_id):
    resp = client_db.get(f"/incidents/{incident_id}/workflow-tree", headers=_auth(token))
    assert resp.status_code == 200, f"workflow-tree failed: {resp.status_code} {resp.text}"
    return resp.json()


def _node(tree, key):
    for n in tree["nodes"]:
        if n["key"] == key:
            return n
    raise AssertionError(f"node {key} not found in {[n['key'] for n in tree['nodes']]}")


# ---------------------------------------------------------------------------
# 1: new report before triage
# ---------------------------------------------------------------------------


class TestNewReport:
    def test_pending_triage_tree(self, client_db, tokens, ids):
        incident_id = _create_incident(client_db, tokens["maintenance"], district="01", county="Del Norte", route="101")
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert tree["path_type"] == "PENDING_TRIAGE"
        assert _node(tree, "REPORTER_SUBMISSION")["status"] == "COMPLETED"
        assert _node(tree, "REPORTER_SUBMISSION")["user"]["user_id"] == ids["maintenance"]
        triage = _node(tree, "COORDINATOR_TRIAGE")
        # A district-01 coordinator is auto-assigned at creation.
        assert triage["status"] in ("CURRENT", "UNASSIGNED")
        if triage["status"] == "CURRENT":
            assert triage["user"]["user_id"] == ids["coordinator"]
            assert tree["current_owner"]["role"] == "MAINTENANCE_COORDINATOR"
        for key in ("OFFICE_DELEGATION", "BRANCH_ASSIGNMENT", "ENGINEER_ASSESSMENT", "ASSESSMENT_REVIEW", "FINALIZATION"):
            assert _node(tree, key)["status"] == "PENDING"


# ---------------------------------------------------------------------------
# Full assessment-required lifecycle (2 + 7) with milestone assertions
# ---------------------------------------------------------------------------


class TestAssessmentRequiredPath:
    def test_full_lifecycle_tree(self, client_db, tokens, ids):
        admin, oc, bc, eng, rev = (
            tokens["admin"],
            tokens["officechief"],
            tokens["branchchief"],
            tokens["engineer"],
            tokens["reviewer"],
        )
        incident_id = _create_incident(client_db, admin, district="04", county="Marin", route="1")

        # Triage -> assessment required (admin bypasses district scope).
        _associate_project(client_db, _auth(tokens["admin"]), incident_id)
        r = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED", "notes": "needs geotech"},
            headers=_auth(admin),
        )
        assert r.status_code == 200, r.text
        aid = r.json()["assessment"]["id"]

        tree = _tree(client_db, admin, incident_id)
        assert tree["path_type"] == "ASSESSMENT_REQUIRED"
        assert _node(tree, "COORDINATOR_TRIAGE")["status"] == "COMPLETED"
        assert _node(tree, "OFFICE_DELEGATION")["status"] == "CURRENT"
        assert tree["current_owner"]["role"] == "GEOTECH_OFFICE_CHIEF"

        # Office chief delegates to branch chief.
        d = client_db.post(
            f"/assessments/{aid}/delegate-branch",
            json={"branch_chief_user_id": ids["branchchief"]},
            headers=_auth(oc),
        )
        assert d.status_code == 200, d.text
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "OFFICE_DELEGATION")["status"] == "COMPLETED"
        assert _node(tree, "BRANCH_ASSIGNMENT")["status"] == "CURRENT"
        assert _node(tree, "BRANCH_ASSIGNMENT")["user"]["user_id"] == ids["branchchief"]
        assert tree["current_owner"]["role"] == "GEOTECH_BRANCH_CHIEF"

        # Branch chief assigns engineer.
        client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(bc),
        )
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "BRANCH_ASSIGNMENT")["status"] == "COMPLETED"
        eng_node = _node(tree, "ENGINEER_ASSESSMENT")
        assert eng_node["status"] == "CURRENT"
        assert eng_node["user"]["user_id"] == ids["engineer"]
        assert tree["current_owner"]["user_id"] == ids["engineer"]

        # Engineer submits.
        client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(eng))
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "COMPLETED"
        review_node = _node(tree, "ASSESSMENT_REVIEW")
        # No reviewer assigned yet -> UNASSIGNED bottleneck.
        assert review_node["status"] == "UNASSIGNED"

        # Assign a reviewer, then that reviewer is the current owner.
        client_db.post(
            f"/assessments/{aid}/assignments",
            json={"user_id": ids["reviewer"], "assignment_role": "REVIEWER"},
            headers=_auth(oc),
        )
        tree = _tree(client_db, admin, incident_id)
        review_node = _node(tree, "ASSESSMENT_REVIEW")
        assert review_node["status"] == "CURRENT"
        assert review_node["user"]["user_id"] == ids["reviewer"]
        assert tree["current_owner"]["user_id"] == ids["reviewer"]

        # Reviewer approves.
        client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(rev)
        )
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] == "COMPLETED"
        assert _node(tree, "FINALIZATION")["status"] == "CURRENT"

        # Office chief finalizes.
        client_db.post(f"/assessments/{aid}/finalize", json={}, headers=_auth(oc))
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "FINALIZATION")["status"] == "COMPLETED"
        # Finalized but not resolved -> resolution is the open step.
        assert _node(tree, "RESOLUTION")["status"] in ("CURRENT", "TERMINAL")


# ---------------------------------------------------------------------------
# 3: needs-reporter-information loop
# ---------------------------------------------------------------------------


class TestNeedsInfoLoop:
    def test_waiting_on_reporter(self, client_db, tokens, ids):
        incident_id = _create_incident(client_db, tokens["maintenance"], district="01", county="Humboldt", route="299")
        _associate_project(client_db, _auth(tokens["admin"]), incident_id)
        r = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "NEEDS_REPORTER_INFORMATION", "notes": "clarify location", "revision_fields": ["description"]},
            headers=_auth(tokens["coordinator"]),
        )
        assert r.status_code == 200, r.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert tree["path_type"] == "NEEDS_REPORTER_INFORMATION"
        triage = _node(tree, "COORDINATOR_TRIAGE")
        assert triage["status"] == "WAITING_ON_REPORTER"
        assert tree["overall_status"] == "WAITING_ON_REPORTER"
        # The bottleneck owner is the reporter (maintenance field worker).
        assert tree["current_owner"]["role"] == "MAINTENANCE_FIELD_WORKER"
        assert tree["current_owner"]["user_id"] == ids["maintenance"]
        # Downstream not falsely advanced.
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "PENDING"


# ---------------------------------------------------------------------------
# 4: no-assessment-required terminal
# ---------------------------------------------------------------------------


class TestNoAssessment:
    def test_terminal_disposition(self, client_db, tokens):
        incident_id = _create_incident(client_db, tokens["maintenance"], district="01", county="Lassen", route="36")
        _associate_project(client_db, _auth(tokens["admin"]), incident_id)
        r = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "minor"},
            headers=_auth(tokens["coordinator"]),
        )
        assert r.status_code == 200, r.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert tree["path_type"] == "NO_ASSESSMENT_REQUIRED"
        assert tree["overall_status"] == "TERMINAL"
        assert tree["current_owner"] is None
        assert _node(tree, "COORDINATOR_TRIAGE")["status"] == "COMPLETED"
        for key in ("OFFICE_DELEGATION", "BRANCH_ASSIGNMENT", "ENGINEER_ASSESSMENT", "ASSESSMENT_REVIEW", "FINALIZATION"):
            assert _node(tree, key)["status"] == "SKIPPED"
        res = _node(tree, "RESOLUTION")
        assert res["status"] == "TERMINAL"
        assert res["label"] == "No assessment required"


# ---------------------------------------------------------------------------
# 5: duplicate / linked terminal with linked target
# ---------------------------------------------------------------------------


class TestDuplicate:
    def test_linked_terminal(self, client_db, tokens):
        target_id = _create_incident(client_db, tokens["admin"], district="01", county="Modoc", route="395")
        incident_id = _create_incident(client_db, tokens["maintenance"], district="01", county="Modoc", route="395")
        _associate_project(client_db, _auth(tokens["admin"]), incident_id)
        r = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "DUPLICATE_OR_LINKED", "notes": "dup", "target_incident_id": target_id},
            headers=_auth(tokens["coordinator"]),
        )
        assert r.status_code == 200, r.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert tree["path_type"] == "DUPLICATE_OR_LINKED"
        assert tree["linked_incident_id"] == target_id
        res = _node(tree, "RESOLUTION")
        assert res["status"] == "TERMINAL"
        assert res["label"] == "Linked / duplicate report"
        assert res["linked_incident_id"] == target_id
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "SKIPPED"


# ---------------------------------------------------------------------------
# 6 + 10: revision-requested path + historical actor preserved
# ---------------------------------------------------------------------------


def _drive_to_submitted(client_db, tokens, ids):
    """Create an incident and drive it to a SUBMITTED assessment by the engineer.
    Returns (incident_id, assessment_id)."""
    admin, oc, bc, eng = tokens["admin"], tokens["officechief"], tokens["branchchief"], tokens["engineer"]
    incident_id = _create_incident(client_db, admin, district="04", county="Marin", route="1")
    _associate_project(client_db, _auth(tokens["admin"]), incident_id)
    aid = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED"},
        headers=_auth(admin),
    ).json()["assessment"]["id"]
    client_db.post(
        f"/assessments/{aid}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"]},
        headers=_auth(oc),
    )
    client_db.post(
        f"/assessments/{aid}/assign-engineer",
        json={"engineer_user_id": ids["engineer"]},
        headers=_auth(bc),
    )
    client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(eng))
    return incident_id, aid


class TestRevisionRequested:
    def test_review_not_completed_when_revision_pending(self, client_db, tokens, ids):
        incident_id, aid = _drive_to_submitted(client_db, tokens, ids)
        # Assign reviewer and request revision.
        client_db.post(
            f"/assessments/{aid}/assignments",
            json={"user_id": ids["reviewer"], "assignment_role": "REVIEWER"},
            headers=_auth(tokens["officechief"]),
        )
        client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "REQUEST_REVISION", "notes": "fix section 3"},
            headers=_auth(tokens["reviewer"]),
        )
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "REVISION_REQUESTED"
        # Review must NOT be marked completed while revisions are pending.
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] != "COMPLETED"
        assert tree["overall_status"] == "REVISION_REQUESTED"
        assert tree["current_owner"]["role"] == "GEOTECH_ENGINEER"
        assert tree["current_owner"]["user_id"] == ids["engineer"]


class TestHistoricalActor:
    def test_completed_node_keeps_original_actor_after_reassignment(self, client_db, tokens, ids):
        # Engineer E1 (engineer@local) submits; then reassign engineer to E2 (admin).
        incident_id, aid = _drive_to_submitted(client_db, tokens, ids)
        # Reassign the engineer while SUBMITTED (assign-engineer is allowed pre-approval).
        resp = client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["admin"]},
            headers=_auth(tokens["branchchief"]),
        )
        assert resp.status_code == 200, resp.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        eng_node = _node(tree, "ENGINEER_ASSESSMENT")
        # COMPLETED submission node keeps the ORIGINAL submitter (E1), not E2.
        assert eng_node["status"] == "COMPLETED"
        assert eng_node["user"]["user_id"] == ids["engineer"]
        # But the assessment's current engineer is now E2.
        assert tree["assessment"]["assigned_engineer_user_id"] == ids["admin"]


# ---------------------------------------------------------------------------
# 8 + 9: access control
# ---------------------------------------------------------------------------


class TestAccess:
    def test_field_worker_cannot_read_others_tree(self, client_db, tokens):
        others = _create_incident(client_db, tokens["admin"], district="07", county="Los Angeles", route="5")
        resp = client_db.get(f"/incidents/{others}/workflow-tree", headers=_auth(tokens["maintenance"]))
        assert resp.status_code == 403

    def test_field_worker_can_read_own_tree(self, client_db, tokens):
        own = _create_incident(client_db, tokens["maintenance"], district="04", county="Marin", route="1")
        resp = client_db.get(f"/incidents/{own}/workflow-tree", headers=_auth(tokens["maintenance"]))
        assert resp.status_code == 200

    def test_operational_users_get_broad_access(self, client_db, tokens):
        any_incident = _create_incident(client_db, tokens["admin"], district="08", county="San Bernardino", route="15")
        for who in ("reviewer", "engineer", "officechief"):
            resp = client_db.get(f"/incidents/{any_incident}/workflow-tree", headers=_auth(tokens[who]))
            assert resp.status_code == 200, f"{who} got {resp.status_code}"

    def test_unauthenticated_rejected(self, client_db, tokens):
        any_incident = _create_incident(client_db, tokens["admin"], district="04")
        resp = client_db.get(f"/incidents/{any_incident}/workflow-tree")
        assert resp.status_code == 401
