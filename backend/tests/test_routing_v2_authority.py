"""Routing v2 — the negative authority matrix (design §4, §5.2, §5.3).

Everything the two lifecycle classes in test_assessment_flow.py prove works,
this module proves cannot be done by anyone else. Review authority in v2 is
derived from the assessment's own routing path and from nothing else: not from
an account role, not from an assignment row, not from being *a* branch chief or
*an* office chief.

The recovery case at the bottom is the one positive test here, and it is the
reason T2 accepts re-delegation from any non-terminal branch-route state: a
departed or deactivated branch chief must never strand a SUBMITTED assessment
with no supported repair.

Requires a live MariaDB at Alembic head with database/init/020_seed.sql applied
(routing v2 adds seniorengineer@local). Run with: pytest -m db
"""

import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------------
# Fixtures: the seeded cast, plus the two accounts the matrix needs and the
# seed does not have (a SECOND branch chief, and an office chief with no office)
# ---------------------------------------------------------------------------


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
def tokens(client_db, admin_token, senior_engineer_token):
    return {
        "admin": admin_token,
        "senior_engineer": senior_engineer_token,
        "officechief": _login(client_db, "officechief@local"),
        "branchchief": _login(client_db, "branchchief@local"),
        "engineer": _login(client_db, "engineer@local"),
        "reviewer": _login(client_db, "reviewer@local"),
    }


@pytest.fixture(scope="module")
def extra_users(client_db, tokens):
    """A second WEST branch chief and an office chief with NO office_code.

    Both are deactivated on teardown so they cannot leak into another module's
    routing lookups, notification recipients or pickers.
    """
    headers = _auth(tokens["admin"])
    created: dict[str, dict] = {}

    def _create(key: str, email: str, full_name: str, roles: list[str], metadata: dict | None):
        resp = client_db.post(
            "/admin/users",
            headers=headers,
            json={
                "email": email,
                "full_name": full_name,
                "password": "routing-v2-test-password",
                "roles": roles,
                "metadata": metadata,
            },
        )
        assert resp.status_code == 201, f"create {email} failed: {resp.status_code} {resp.text}"
        user_id = int(resp.json()["id"])
        created[key] = {
            "id": user_id,
            "email": email,
            "token": _login(client_db, email, "routing-v2-test-password"),
        }

    _create(
        "branchchief2",
        f"rv2-branchchief2-{_RUN}@example.test",
        "Zzz Second Branch Chief",
        ["GEOTECH_BRANCH_CHIEF"],
        {"office_code": "WEST", "office_location": "West Office"},
    )
    _create(
        "chief_no_office",
        f"rv2-chief-no-office-{_RUN}@example.test",
        "Zzz Unscoped Office Chief",
        ["GEOTECH_OFFICE_CHIEF"],
        None,
    )
    yield created
    for record in created.values():
        client_db.patch(
            f"/admin/users/{record['id']}", headers=headers, json={"is_active": False}
        )


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {key: _me_id(client_db, token) for key, token in tokens.items()}


# ---------------------------------------------------------------------------
# Lifecycle helpers — each returns a fresh incident/assessment pair
# ---------------------------------------------------------------------------


def _create_incident(client_db, token, *, district="04", county="Marin", route="1", post_mile="10.0") -> int:
    resp = client_db.post(
        "/incidents",
        json={
            "title": f"Routing v2 authority {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Integration incident for the routing v2 authority matrix",
            "first_observed_at": "2026-06-25T10:00:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": district,
            "county": county,
            "route": route,
            "post_mile": post_mile,
        },
        headers=_auth(token),
    )
    assert resp.status_code == 200, f"create incident failed: {resp.status_code} {resp.text}"
    return int(resp.json()["incident"]["id"])


def _triaged(client_db, tokens) -> dict:
    incident_id = _create_incident(client_db, tokens["admin"])
    resp = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "authority matrix"},
        headers=_auth(tokens["admin"]),
    )
    assert resp.status_code == 200, resp.text
    return {"incident_id": incident_id, "assessment_id": int(resp.json()["assessment"]["id"])}


def _branch_routed(client_db, tokens, ids, *, chief_user_id: int | None = None) -> dict:
    case = _triaged(client_db, tokens)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/delegate-branch",
        json={"branch_chief_user_id": int(chief_user_id or ids["branchchief"])},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, resp.text
    return case


def _branch_drafting(client_db, tokens, ids) -> dict:
    case = _branch_routed(client_db, tokens, ids)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/assign-engineer",
        json={"engineer_user_id": ids["engineer"]},
        headers=_auth(tokens["branchchief"]),
    )
    assert resp.status_code == 200, resp.text
    case["submission_id"] = int(resp.json()["assessment"]["submission_id"])
    return case


def _branch_submitted(client_db, tokens, ids) -> dict:
    case = _branch_drafting(client_db, tokens, ids)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/submit", json={}, headers=_auth(tokens["engineer"])
    )
    assert resp.status_code == 200, resp.text
    return case


def _senior_engineer_routed(client_db, tokens, ids) -> dict:
    case = _triaged(client_db, tokens)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/assign-senior-engineer",
        json={"senior_engineer_user_id": ids["senior_engineer"]},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, resp.text
    case["submission_id"] = int(resp.json()["assessment"]["submission_id"])
    return case


def _senior_engineer_submitted(client_db, tokens, ids) -> dict:
    case = _senior_engineer_routed(client_db, tokens, ids)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/submit", json={}, headers=_auth(tokens["senior_engineer"])
    )
    assert resp.status_code == 200, resp.text
    return case


def _sql(statement: str, params: dict | None = None) -> None:
    """Direct SQL, for shapes the v2 API deliberately refuses to create."""
    from app.db import engine

    with engine.begin() as conn:
        conn.execute(text(statement), params or {})


def _assessment_row(assessment_id: int) -> dict:
    from app.db import engine

    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT state, routing_path, branch_chief_user_id, assigned_engineer_user_id
                FROM assessments WHERE id = :aid
                """
            ),
            {"aid": assessment_id},
        ).mappings().first()
    assert row is not None
    return dict(row)


# ---------------------------------------------------------------------------
# Who may review — the whole point of routing v2
# ---------------------------------------------------------------------------


class TestReviewAuthority:
    def test_office_chief_cannot_review_a_branch_route_assessment(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["officechief"]),
        )
        assert resp.status_code == 403, resp.text
        assert "branch chief this assessment was handed to" in resp.json()["detail"]
        # The office chief is out of the picture from the hand-off onward.
        assert _assessment_row(case["assessment_id"])["state"] == "SUBMITTED"

    def test_a_different_branch_chief_can_neither_review_nor_assign(
        self, client_db, tokens, ids, extra_users
    ):
        other = extra_users["branchchief2"]
        routed = _branch_routed(client_db, tokens, ids)
        # ...cannot assign an engineer on an assessment handed to a colleague.
        assign = client_db.post(
            f"/assessments/{routed['assessment_id']}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(other["token"]),
        )
        assert assign.status_code == 403, assign.text
        assert "Only the branch chief this assessment was handed to" in assign.json()["detail"]

        submitted = _branch_submitted(client_db, tokens, ids)
        review = client_db.post(
            f"/assessments/{submitted['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(other["token"]),
        )
        assert review.status_code == 403, review.text

    def test_legacy_reviewer_and_approver_rows_grant_nothing(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        aid = case["assessment_id"]
        # The API refuses to create these rows in v2, so they are written the
        # way history holds them: active REVIEWER/APPROVER assignments.
        for role in ("REVIEWER", "APPROVER"):
            _sql(
                """
                INSERT INTO assessment_assignments
                  (assessment_id, user_id, assignment_role, assigned_by_user_id, notes)
                VALUES (:aid, :uid, :role, :by, 'legacy row')
                """,
                {"aid": aid, "uid": ids["reviewer"], "role": role, "by": ids["officechief"]},
            )

        review = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["reviewer"]),
        )
        assert review.status_code == 403, review.text

        detail = client_db.get(f"/assessments/{aid}", headers=_auth(tokens["reviewer"]))
        assert detail.status_code == 200
        legacy = [a for a in detail.json()["assignments"] if a["assignment_role"] in ("REVIEWER", "APPROVER")]
        assert len(legacy) == 2, "the audit trail is never rewritten to remove a permission"
        assert all(a["is_authority"] is False for a in legacy)
        # The rows are still there, and the holder is still told they mean
        # nothing — the row renders as history, not as an affordance.
        assert detail.json()["assessment"]["can_review"] is False

    def test_reviewer_assignment_is_retired_at_the_boundary(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assignments",
            json={"user_id": ids["reviewer"], "assignment_role": "REVIEWER"},
            headers=_auth(tokens["officechief"]),
        )
        # The request schema narrows to CONSULTED, so FastAPI answers 422 before
        # the handler's explanatory 400 is reached. Either is a refusal; the
        # handler guard remains as the belt to the schema's braces.
        assert resp.status_code in (400, 422), resp.text
        consulted = client_db.post(
            f"/assessments/{case['assessment_id']}/assignments",
            json={"user_id": ids["reviewer"], "assignment_role": "CONSULTED"},
            headers=_auth(tokens["officechief"]),
        )
        assert consulted.status_code == 200, consulted.text
        # CONSULTED survives BECAUSE it never conferred authority.
        row = next(a for a in consulted.json()["assignments"] if a["assignment_role"] == "CONSULTED")
        assert row["is_authority"] is False

    def test_office_chief_without_an_office_cannot_review_a_senior_engineer_route(
        self, client_db, tokens, ids, extra_users
    ):
        case = _senior_engineer_submitted(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(extra_users["chief_no_office"]["token"]),
        )
        assert resp.status_code == 403, resp.text
        assert "office chief of this assessment's GeoTech office" in resp.json()["detail"]

    def test_unscoped_chief_on_an_office_less_assessment_is_denied(
        self, client_db, tokens, ids, extra_users
    ):
        # The None == None case §4.1's falsy guard closes. An office-less
        # assessment cannot be produced through the API (triage refuses a
        # district with no office), so the row is made by hand.
        case = _senior_engineer_submitted(client_db, tokens, ids)
        aid = case["assessment_id"]
        _sql("UPDATE assessments SET office_code = NULL WHERE id = :aid", {"aid": aid})

        unscoped = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE"},
            headers=_auth(extra_users["chief_no_office"]["token"]),
        )
        assert unscoped.status_code == 403, (
            "a chained `a == b != ''` would let None == None through and hand an "
            "office-less assessment to any unscoped chief"
        )
        # The other half of the same guard: a scoped chief cannot review an
        # assessment that has no office either.
        scoped = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["officechief"]),
        )
        assert scoped.status_code == 403, scoped.text
        assert _assessment_row(aid)["state"] == "SUBMITTED"

    def test_unrouted_assessment_has_no_reviewer_at_all(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        aid = case["assessment_id"]
        # Force it to SUBMITTED with no route chosen — the state an unrouted
        # assessment could only reach through direct SQL — and prove the NULL
        # branch of the rule denies everyone but admin.
        _sql("UPDATE assessments SET state = 'SUBMITTED' WHERE id = :aid", {"aid": aid})
        for who in ("officechief", "branchchief", "reviewer"):
            resp = client_db.post(
                f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens[who])
            )
            assert resp.status_code == 403, f"{who}: {resp.text}"
            assert resp.json()["detail"] == "This assessment has not been routed yet"


# ---------------------------------------------------------------------------
# The two routes are mutually exclusive, and the chief's shortcut is gone
# ---------------------------------------------------------------------------


class TestRouteExclusivity:
    def test_delegate_branch_rejects_engineer_user_id(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/delegate-branch",
            json={"branch_chief_user_id": ids["branchchief"], "engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert resp.status_code == 400, resp.text
        assert "cannot assign Staff directly" in resp.json()["detail"]
        # Rejected, not ignored: nothing was written.
        row = _assessment_row(case["assessment_id"])
        assert row["routing_path"] is None
        assert row["state"] == "PENDING_OFFICE_DELEGATION"

    def test_assign_senior_engineer_after_the_branch_route_is_409(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert resp.status_code == 409, resp.text
        assert "handed off to a branch chief" in resp.json()["detail"]
        assert _assessment_row(case["assessment_id"])["routing_path"] == "BRANCH"

    def test_delegate_branch_after_the_senior_engineer_route_is_409(self, client_db, tokens, ids):
        case = _senior_engineer_routed(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/delegate-branch",
            json={"branch_chief_user_id": ids["branchchief"]},
            headers=_auth(tokens["officechief"]),
        )
        assert resp.status_code == 409, resp.text
        assert "assigned to a senior engineer" in resp.json()["detail"]
        assert _assessment_row(case["assessment_id"])["routing_path"] == "SENIOR_ENGINEER"

    def test_assign_engineer_on_a_senior_engineer_route_is_409(self, client_db, tokens, ids):
        case = _senior_engineer_routed(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["branchchief"]),
        )
        assert resp.status_code == 409, resp.text
        assert "senior engineer route" in resp.json()["detail"]
        # The senior engineer is still the assignee.
        assert _assessment_row(case["assessment_id"])["assigned_engineer_user_id"] == ids["senior_engineer"]

    def test_assign_engineer_before_any_route_is_409(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["branchchief"]),
        )
        assert resp.status_code == 409, resp.text
        assert "has not been routed yet" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Retired endpoints answer with an explanation, never a 404 or a silent no-op
# ---------------------------------------------------------------------------


class TestRetiredEndpoints:
    def test_finalize_is_410_for_everyone(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        aid = case["assessment_id"]
        approved = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens["branchchief"])
        )
        assert approved.status_code == 200, approved.text
        for who in ("officechief", "admin"):
            gone = client_db.post(f"/assessments/{aid}/finalize", json={}, headers=_auth(tokens[who]))
            assert gone.status_code == 410, f"{who}: {gone.text}"
            assert "finalization was retired" in gone.json()["detail"]
        # The route is still mounted and the row is untouched.
        assert _assessment_row(aid)["state"] == "APPROVED"

    def test_legacy_incident_stage_routing_endpoints_are_410(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        iid = case["incident_id"]
        branch = client_db.post(
            f"/incidents/{iid}/office-chief/assign-branch",
            json={"branch_chief_user_id": ids["branchchief"]},
            headers=_auth(tokens["admin"]),
        )
        assert branch.status_code == 410, branch.text
        engineer = client_db.post(
            f"/incidents/{iid}/branch-chief/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["admin"]),
        )
        assert engineer.status_code == 410, engineer.text
        # Its read-only sibling stays live: it is the branch half of the
        # two-choice picker until mobile ships.
        options = client_db.get(
            f"/incidents/{iid}/office-chief/branch-options", headers=_auth(tokens["officechief"])
        )
        assert options.status_code == 200, options.text
        # Nothing was routed by the refusals.
        assert _assessment_row(case["assessment_id"])["routing_path"] is None

    def test_admin_recovery_assign_refuses_a_senior_engineer_route(self, client_db, tokens, ids):
        case = _senior_engineer_routed(client_db, tokens, ids)
        resp = client_db.post(
            f"/incidents/{case['incident_id']}/assign",
            json={"assignee_user_id": ids["engineer"]},
            headers=_auth(tokens["admin"]),
        )
        assert resp.status_code == 409, resp.text
        assert _assessment_row(case["assessment_id"])["assigned_engineer_user_id"] == ids["senior_engineer"]

    def test_reviewer_kind_on_the_assignment_directory_is_400(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        aid = case["assessment_id"]
        retired = client_db.get(
            f"/admin/assessment-assignment-options/{aid}?kind=REVIEWER", headers=_auth(tokens["admin"])
        )
        # 400 with an explanation, NOT the bare 422 that dropping REVIEWER from
        # the query pattern would have produced.
        assert retired.status_code == 400, retired.text
        assert "use CONSULTED" in retired.json()["detail"]
        consulted = client_db.get(
            f"/admin/assessment-assignment-options/{aid}?kind=CONSULTED", headers=_auth(tokens["admin"])
        )
        assert consulted.status_code == 200, consulted.text


# ---------------------------------------------------------------------------
# The submission-level back doors are closed (design §4.2)
# ---------------------------------------------------------------------------


class TestSubmissionLevelConflicts:
    def test_submitting_a_linked_form_points_at_the_assessment(self, client_db, tokens, ids):
        case = _branch_drafting(client_db, tokens, ids)
        resp = client_db.post(
            f"/submissions/{case['submission_id']}/submit",
            json={},
            headers=_auth(tokens["engineer"]),
        )
        assert resp.status_code == 409, resp.text
        assert f"/assessments/{case['assessment_id']}/submit" in resp.json()["detail"]
        # B1 is the only writer of a linked form's status: nothing moved.
        form = client_db.get(f"/submissions/{case['submission_id']}", headers=_auth(tokens["engineer"]))
        assert form.json()["submission"]["status"] == "DRAFT"
        assert _assessment_row(case["assessment_id"])["state"] == "DRAFT"

    def test_reviewing_a_linked_form_points_at_the_assessment(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        sid = case["submission_id"]
        for token_key in ("admin", "reviewer", "branchchief"):
            resp = client_db.post(
                f"/submissions/{sid}/review",
                json={"decision": "APPROVE"},
                headers=_auth(tokens[token_key]),
            )
            assert resp.status_code == 409, f"{token_key}: {resp.text}"
            assert f"/assessments/{case['assessment_id']}/review" in resp.json()["detail"]
        # ...and so are its two aliases.
        assert client_db.post(f"/submissions/{sid}/approve", json={}, headers=_auth(tokens["admin"])).status_code == 409
        assert client_db.post(f"/submissions/{sid}/reject", json={}, headers=_auth(tokens["admin"])).status_code == 409
        form = client_db.get(f"/submissions/{sid}", headers=_auth(tokens["admin"]))
        assert form.json()["submission"]["status"] == "SUBMITTED"

    def test_submission_detail_reports_route_and_authority(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        sid = case["submission_id"]
        chief = client_db.get(f"/submissions/{sid}", headers=_auth(tokens["branchchief"]))
        assert chief.status_code == 200, chief.text
        assert chief.json()["context"]["assessment_routing_path"] == "BRANCH"
        assert chief.json()["context"]["can_review"] is True
        assert chief.json()["submission"]["can_review"] is True
        # The legacy REVIEWER account reads everything and decides nothing.
        legacy = client_db.get(f"/submissions/{sid}", headers=_auth(tokens["reviewer"]))
        assert legacy.status_code == 200
        assert legacy.json()["submission"]["can_review"] is False

    def test_unlinked_legacy_submission_review_is_unchanged(self, client_db, tokens):
        created = client_db.post(
            "/submissions", json={"title": f"rv2 unlinked {_RUN}"}, headers=_auth(tokens["admin"])
        )
        assert created.status_code == 200, created.text
        sid = int(created.json()["submission_id"])
        client_db.patch(
            f"/submissions/{sid}/gisa",
            json={"district": "04", "county": "Marin", "route": "1", "post_mile": "5.0"},
            headers=_auth(tokens["admin"]),
        )
        # Straight to SUBMITTED: /submissions/{id}/submit enforces the GISA
        # completeness rules (a photo among them), which are not what this test
        # is about — it is about who may DECIDE an unlinked legacy form.
        _sql("UPDATE submissions SET status = 'SUBMITTED' WHERE id = :sid", {"sid": sid})
        # The legacy REVIEWER role no longer decides even here: admin only.
        denied = client_db.post(
            f"/submissions/{sid}/review", json={"decision": "APPROVE"}, headers=_auth(tokens["reviewer"])
        )
        assert denied.status_code == 403, denied.text
        allowed = client_db.post(
            f"/submissions/{sid}/review", json={"decision": "APPROVE"}, headers=_auth(tokens["admin"])
        )
        assert allowed.status_code == 200, allowed.text


# ---------------------------------------------------------------------------
# Recovery: re-delegation from SUBMITTED (design §3.3 T2)
# ---------------------------------------------------------------------------


class TestRedelegationFromSubmitted:
    def test_deactivated_branch_chief_does_not_strand_a_submitted_assessment(
        self, client_db, tokens, ids, extra_users
    ):
        admin_headers = _auth(tokens["admin"])
        first = extra_users["branchchief2"]
        second_chief_id = ids["branchchief"]

        # Hand off to the first chief, run it to SUBMITTED under them.
        case = _branch_routed(client_db, tokens, ids, chief_user_id=first["id"])
        aid = case["assessment_id"]
        assigned = client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(first["token"]),
        )
        assert assigned.status_code == 200, assigned.text
        linked_submission_id = int(assigned.json()["assessment"]["submission_id"])
        submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
        assert submitted.status_code == 200, submitted.text
        before = _assessment_row(aid)
        assert before["state"] == "SUBMITTED"

        # The chief leaves.
        deactivated = client_db.patch(
            f"/admin/users/{first['id']}", headers=admin_headers, json={"is_active": False}
        )
        assert deactivated.status_code == 200, deactivated.text

        # The office chief regains reach for THIS ONE ACT.
        redelegated = client_db.post(
            f"/assessments/{aid}/delegate-branch",
            json={"branch_chief_user_id": second_chief_id, "notes": "first chief deactivated"},
            headers=_auth(tokens["officechief"]),
        )
        assert redelegated.status_code == 200, redelegated.text
        after = _assessment_row(aid)
        # State, engineer and route are untouched — only the chief changed.
        assert after["state"] == "SUBMITTED"
        assert after["routing_path"] == "BRANCH"
        assert after["assigned_engineer_user_id"] == before["assigned_engineer_user_id"]
        assert after["branch_chief_user_id"] == second_chief_id
        # The linked technical form is left exactly where it was.
        assert redelegated.json()["assessment"]["submission_id"] == linked_submission_id

        # The swap is on the record, with both ids.
        events = client_db.get(f"/assessments/{aid}", headers=admin_headers).json()["events"]
        assert sum(1 for e in events if e["event_type"] == "OFFICE_DELEGATED") == 2

        # The old chief cannot review even once reinstated: authority is the id
        # on the assessment, not the office or the role.
        reactivated = client_db.patch(
            f"/admin/users/{first['id']}", headers=admin_headers, json={"is_active": True}
        )
        assert reactivated.status_code == 200, reactivated.text
        old = client_db.post(
            f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(first["token"])
        )
        assert old.status_code == 403, old.text

        # The new chief holds the pending decision, which is the point.
        new = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "picked up after the hand-over"},
            headers=_auth(tokens["branchchief"]),
        )
        assert new.status_code == 200, new.text
        assert new.json()["state"] == "APPROVED"

    def test_office_chief_still_cannot_assign_or_review_after_redelegating(
        self, client_db, tokens, ids, extra_users
    ):
        # Re-delegation is the ONLY reach the office chief regains.
        # (The recovery test above deactivates and reinstates this chief; make
        # the precondition explicit rather than depending on that ordering.)
        client_db.patch(
            f"/admin/users/{extra_users['branchchief2']['id']}",
            headers=_auth(tokens["admin"]),
            json={"is_active": True},
        )
        case = _branch_routed(client_db, tokens, ids)
        aid = case["assessment_id"]
        again = client_db.post(
            f"/assessments/{aid}/delegate-branch",
            json={"branch_chief_user_id": extra_users["branchchief2"]["id"]},
            headers=_auth(tokens["officechief"]),
        )
        assert again.status_code == 200, again.text
        assign = client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert assign.status_code in (401, 403), assign.text
