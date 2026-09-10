"""DB-backed integration tests for the Incident Workflow Tree read model.

Requires a live MariaDB at Alembic head, seeded with the standard dev users.
Run with: pytest -m db

Covers the required matrix:
  1  new report before triage
  2  branch route (hand-off -> engineer -> branch chief review -> approved)
  2b senior engineer route (direct assignment -> senior engineer -> office chief review)
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
        "senior_engineer": _login(client_db, "seniorengineer@local"),
        # The org model's read-only viewer: no operational role at all, so the
        # tree is readable only where the record is public.
        "viewer": _login(client_db, "viewer@local"),
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
        for key in ("OFFICE_DELEGATION", "BRANCH_ASSIGNMENT", "ENGINEER_ASSESSMENT", "ASSESSMENT_REVIEW"):
            assert _node(tree, key)["status"] == "PENDING"
        # Approval is terminal in routing v2, so there is no finalization step.
        assert "FINALIZATION" not in [n["key"] for n in tree["nodes"]]


# ---------------------------------------------------------------------------
# Full assessment-required lifecycle (2 + 7) with milestone assertions
# ---------------------------------------------------------------------------


class TestAssessmentRequiredPath:
    def test_full_lifecycle_tree(self, client_db, tokens, ids):
        admin, oc, bc, eng = (
            tokens["admin"],
            tokens["officechief"],
            tokens["branchchief"],
            tokens["engineer"],
        )
        incident_id = _create_incident(client_db, admin, district="04", county="Marin", route="1")

        # Triage -> assessment required (admin bypasses district scope).
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

        # Engineer submits. The reviewer is the branch chief this assessment was
        # handed to — known from the route, so the step is never UNASSIGNED and
        # nobody has to be appointed first.
        client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(eng))
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "COMPLETED"
        review_node = _node(tree, "ASSESSMENT_REVIEW")
        assert review_node["status"] == "CURRENT"
        assert review_node["role"] == "GEOTECH_BRANCH_CHIEF"
        assert review_node["role_title"] == "GeoTech Branch Chief"
        assert review_node["user"]["user_id"] == ids["branchchief"]
        assert tree["current_owner"]["user_id"] == ids["branchchief"]
        # The retired reviewer/approver pseudo-role is gone from the tree
        # entirely: nobody is ever "the assigned reviewer" any more.
        assert "REVIEWER_APPROVER" not in {n["role"] for n in tree["nodes"]}

        # The branch chief approves — and that ends the assessment.
        approved = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(bc)
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] == "COMPLETED"
        # No sign-off step exists any more...
        assert "FINALIZATION" not in [n["key"] for n in tree["nodes"]]
        # ...so the open step is the incident resolution, owned by the assignee.
        resolution = _node(tree, "RESOLUTION")
        assert resolution["status"] == "CURRENT"
        assert resolution["user"]["user_id"] == ids["engineer"]
        assert tree["current_owner"]["node_key"] == "RESOLUTION"

        # Finalize is retired.
        gone = client_db.post(f"/assessments/{aid}/finalize", json={}, headers=_auth(oc))
        assert gone.status_code == 410, gone.text


# ---------------------------------------------------------------------------
# 2b: the senior engineer route
# ---------------------------------------------------------------------------


class TestSeniorEngineerRoutePath:
    def test_senior_engineer_route_tree(self, client_db, tokens, ids):
        admin, oc, spec = tokens["admin"], tokens["officechief"], tokens["senior_engineer"]
        incident_id = _create_incident(client_db, admin, district="04", county="Marin", route="1")
        r = client_db.post(
            f"/incidents/{incident_id}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED", "notes": "senior engineer route"},
            headers=_auth(admin),
        )
        assert r.status_code == 200, r.text
        aid = r.json()["assessment"]["id"]

        assigned = client_db.post(
            f"/assessments/{aid}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"], "notes": "Coastal slope expertise."},
            headers=_auth(oc),
        )
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()["assessment"]["routing_path"] == "SENIOR_ENGINEER"
        assert assigned.json()["assessment"]["assigned_user_kind"] == "SENIOR_ENGINEER"

        tree = _tree(client_db, admin, incident_id)
        assert tree["assessment"]["routing_path"] == "SENIOR_ENGINEER"
        # The office chief's routing step is complete, and there is no branch
        # chief step at all on this route.
        assert _node(tree, "OFFICE_DELEGATION")["status"] == "COMPLETED"
        assert _node(tree, "BRANCH_ASSIGNMENT")["status"] == "SKIPPED"
        work = _node(tree, "ENGINEER_ASSESSMENT")
        assert work["status"] == "CURRENT"
        assert work["role"] == "GEOTECH_SENIOR_ENGINEER"
        assert work["role_title"] == "GeoTech Senior Engineer"
        assert work["user"]["user_id"] == ids["senior_engineer"]

        submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(spec))
        assert submitted.status_code == 200, submitted.text
        tree = _tree(client_db, admin, incident_id)
        review_node = _node(tree, "ASSESSMENT_REVIEW")
        assert review_node["status"] == "CURRENT"
        assert review_node["role"] == "GEOTECH_OFFICE_CHIEF"
        assert review_node["role_title"] == "GeoTech Office Chief"
        assert "REVIEWER_APPROVER" not in {n["role"] for n in tree["nodes"]}

        approved = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(oc)
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"
        tree = _tree(client_db, admin, incident_id)
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] == "COMPLETED"
        assert "FINALIZATION" not in [n["key"] for n in tree["nodes"]]
        resolution = _node(tree, "RESOLUTION")
        assert resolution["status"] == "CURRENT"
        assert resolution["role"] == "GEOTECH_SENIOR_ENGINEER"
        assert resolution["user"]["user_id"] == ids["senior_engineer"]

        # And once they close it out, the terminal label names the approval —
        # the already-resolved branch was widened with the CURRENT one, so an
        # approved-and-resolved incident does not fall through to the bare
        # "Incident resolved".
        closed = client_db.post(
            f"/incidents/{incident_id}/resolve",
            json={"comment": "Mitigation complete"},
            headers=_auth(spec),
        )
        assert closed.status_code == 200, closed.text
        tree = _tree(client_db, admin, incident_id)
        resolved_node = _node(tree, "RESOLUTION")
        assert resolved_node["status"] == "TERMINAL"
        assert resolved_node["label"] == "Assessment approved & incident resolved"
        assert tree["current_owner"] is None


# ---------------------------------------------------------------------------
# 3: needs-reporter-information loop
# ---------------------------------------------------------------------------


class TestNeedsInfoLoop:
    def test_waiting_on_reporter(self, client_db, tokens, ids):
        incident_id = _create_incident(client_db, tokens["maintenance"], district="01", county="Humboldt", route="299")
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
        for key in ("OFFICE_DELEGATION", "BRANCH_ASSIGNMENT", "ENGINEER_ASSESSMENT", "ASSESSMENT_REVIEW"):
            assert _node(tree, key)["status"] == "SKIPPED"
        assert "FINALIZATION" not in [n["key"] for n in tree["nodes"]]
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


def _drive_to_submitted_senior_engineer(client_db, tokens, ids):
    """The same, on the SENIOR_ENGINEER route: no branch chief is involved and
    the office chief holds the pending decision. Returns (incident_id, aid)."""
    admin, oc, spec = tokens["admin"], tokens["officechief"], tokens["senior_engineer"]
    incident_id = _create_incident(client_db, admin, district="04", county="Marin", route="1")
    aid = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED"},
        headers=_auth(admin),
    ).json()["assessment"]["id"]
    assigned = client_db.post(
        f"/assessments/{aid}/assign-senior-engineer",
        json={"senior_engineer_user_id": ids["senior_engineer"]},
        headers=_auth(oc),
    )
    assert assigned.status_code == 200, assigned.text
    submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(spec))
    assert submitted.status_code == 200, submitted.text
    return incident_id, aid


class TestRevisionRequested:
    def test_review_not_completed_when_revision_pending(self, client_db, tokens, ids):
        incident_id, aid = _drive_to_submitted(client_db, tokens, ids)
        # The branch chief who was handed this assessment returns it. No reviewer
        # is appointed: authority follows the route.
        returned = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "REQUEST_REVISION", "notes": "fix section 3"},
            headers=_auth(tokens["branchchief"]),
        )
        assert returned.status_code == 200, returned.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "REVISION_REQUESTED"
        # Review must NOT be marked completed while revisions are pending.
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] != "COMPLETED"
        assert tree["overall_status"] == "REVISION_REQUESTED"
        assert tree["current_owner"]["role"] == "GEOTECH_ENGINEER"
        assert tree["current_owner"]["user_id"] == ids["engineer"]


    def test_senior_engineer_route_revision_returns_to_the_senior_engineer(self, client_db, tokens, ids):
        incident_id, aid = _drive_to_submitted_senior_engineer(client_db, tokens, ids)
        # Before the decision, the review step is the office chief's and is
        # CURRENT the moment the state is SUBMITTED — the office owns it, so it
        # is never UNASSIGNED waiting for someone to be appointed.
        tree = _tree(client_db, tokens["admin"], incident_id)
        review = _node(tree, "ASSESSMENT_REVIEW")
        assert review["status"] == "CURRENT"
        assert review["role"] == "GEOTECH_OFFICE_CHIEF"
        assert _node(tree, "BRANCH_ASSIGNMENT")["status"] == "SKIPPED"

        returned = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "REQUEST_REVISION", "notes": "add the borehole log"},
            headers=_auth(tokens["officechief"]),
        )
        assert returned.status_code == 200, returned.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "REVISION_REQUESTED"
        assert _node(tree, "ASSESSMENT_REVIEW")["status"] != "COMPLETED"
        assert tree["overall_status"] == "REVISION_REQUESTED"
        assert tree["current_owner"]["role"] == "GEOTECH_SENIOR_ENGINEER"
        assert tree["current_owner"]["role_title"] == "GeoTech Senior Engineer"
        assert tree["current_owner"]["user_id"] == ids["senior_engineer"]


# ---------------------------------------------------------------------------
# FINALIZATION is legacy-only: present for a signed-off row, absent otherwise
# ---------------------------------------------------------------------------


class TestLegacyFinalization:
    def test_finalization_node_appears_only_for_a_signed_off_assessment(self, client_db, tokens, ids):
        from sqlalchemy import text

        from app.db import engine

        incident_id, aid = _drive_to_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens["branchchief"])
        )
        assert approved.status_code == 200, approved.text
        tree = _tree(client_db, tokens["admin"], incident_id)
        assert "FINALIZATION" not in [n["key"] for n in tree["nodes"]]

        # A row signed off BEFORE this release still renders its sign-off step.
        # finalized_at is stamped directly: nothing can enter the FINALIZED
        # state any more (trg_assessment_no_new_finalize), and the node keys on
        # the timestamp rather than the state precisely so legacy history keeps
        # rendering.
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE assessments SET finalized_at = NOW() WHERE id = :aid"), {"aid": aid}
            )
        tree = _tree(client_db, tokens["admin"], incident_id)
        finalization = _node(tree, "FINALIZATION")
        assert finalization["status"] == "COMPLETED"
        assert finalization["role"] == "GEOTECH_OFFICE_CHIEF"
        assert finalization["label"] == "Assessment signed off (legacy)"


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


# ---------------------------------------------------------------------------
# 11: the read-only viewer's branch of _ensure_workflow_tree_access
# ---------------------------------------------------------------------------


class TestViewerAccess:
    """A viewer reads the tree of an APPROVED record, and nothing else.

    The tree is the record's whole history — who routed it, to whom, and when —
    so it follows the same rule as the assessment itself: public once approved,
    invisible until then. Invisible means 404, not 403: a 403 would confirm that
    an in-flight incident exists and let a viewer enumerate work by probing ids.
    """

    def _approved_incident(self, client_db, tokens, ids) -> int:
        incident_id, aid = _drive_to_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens["branchchief"])
        )
        assert approved.status_code == 200, approved.text
        return incident_id

    def test_viewer_reads_the_tree_of_an_approved_record(self, client_db, tokens, ids):
        incident_id = self._approved_incident(client_db, tokens, ids)
        tree = _tree(client_db, tokens["viewer"], incident_id)
        # The whole history, not a redacted version: the same nodes an
        # operational reader gets.
        assert _node(tree, "ENGINEER_ASSESSMENT")["status"] == "COMPLETED"
        review = _node(tree, "ASSESSMENT_REVIEW")
        assert review["status"] == "COMPLETED"
        assert review["role"] == "GEOTECH_BRANCH_CHIEF"
        assert review["user"]["user_id"] == ids["branchchief"]

    def test_viewer_gets_404_before_approval(self, client_db, tokens, ids):
        incident_id, _aid = _drive_to_submitted(client_db, tokens, ids)
        resp = client_db.get(f"/incidents/{incident_id}/workflow-tree", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 404, f"{resp.status_code} {resp.text}"

    def test_viewer_gets_404_on_an_incident_with_no_assessment_at_all(self, client_db, tokens):
        fresh = _create_incident(client_db, tokens["admin"], district="04")
        resp = client_db.get(f"/incidents/{fresh}/workflow-tree", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 404, f"{resp.status_code} {resp.text}"

    def test_viewer_gets_404_on_an_incident_that_does_not_exist(self, client_db, tokens):
        # The same answer as an in-flight record, which is the point: the two
        # must be indistinguishable.
        resp = client_db.get("/incidents/99999999/workflow-tree", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 404

    def test_a_call_site_that_passes_no_session_refuses_the_viewer(self):
        # `db` is optional on the helper only so no existing call site breaks.
        # Without a session the viewer's branch cannot check whether the record
        # is public, so it refuses rather than guessing.
        import pytest as _pytest
        from fastapi import HTTPException

        from app.routes.workflow_tree import _ensure_workflow_tree_access

        with _pytest.raises(HTTPException) as excinfo:
            _ensure_workflow_tree_access(
                {"id": 1, "roles": ["CALTRANS_VIEWER"]}, {"id": 1, "reporter_user_id": 2}
            )
        assert excinfo.value.status_code == 403
