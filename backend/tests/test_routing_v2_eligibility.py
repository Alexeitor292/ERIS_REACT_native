"""Routing v2 — the database boundary (design §7.2, §7.3, §7.4).

The rules in this module are enforced by triggers and column definitions, not
by Python, so they hold for direct SQL and for any future client. Four of them
are pinned nowhere else:

  * the six eligibility triggers became route-aware, so the SAME column
    (assessments.assigned_engineer_user_id) is checked against the Staff rule
    on the branch route and the Senior Specialist rule on the other;
  * trg_assessment_no_new_finalize closes FINALIZED to everything, including
    direct SQL, while leaving already-FINALIZED rows fully updatable;
  * the backfill is non-destructive ONLY because those triggers fire on a
    CHANGE of assignee — a SENIOR_ENGINEER-route row still holding a legacy
    FIELD_WORKER assignee keeps working, which is what backfill (b) produces;
  * assignment_role is VARCHAR(24), widened from VARCHAR(16) so the role
    vocabulary has room to grow.

Run with: pytest -m db
"""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]

# Copied from 20260817_engineer_assignment_eligibility.py via
# 20260910_routing_v2.py. test_db_smoke.py pins the engineer text verbatim;
# these are the substrings that tell the two rules apart.
_ENGINEER_MESSAGE = "must be an active Staff member or administrator"
_SENIOR_ENGINEER_MESSAGE = "must be an active Senior Specialist or administrator"


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
        "officechief": _login(client_db, "mock.office.chief@dot.ca.gov"),
        "branchchief": _login(client_db, "mock.branch.chief@dot.ca.gov"),
        "engineer": _login(client_db, "mock.staff@dot.ca.gov"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {key: _me_id(client_db, token) for key, token in tokens.items()}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _create_incident(client_db, token, *, district="04", county="Marin", route="1", post_mile="10.0") -> int:
    resp = client_db.post(
        "/incidents",
        json={
            "title": f"Routing v2 eligibility {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Integration incident for the routing v2 DB boundary",
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
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "eligibility"},
        headers=_auth(tokens["admin"]),
    )
    assert resp.status_code == 200, resp.text
    return {"incident_id": incident_id, "assessment_id": int(resp.json()["assessment"]["id"])}


def _branch_routed(client_db, tokens, ids) -> dict:
    case = _triaged(client_db, tokens)
    resp = client_db.post(
        f"/assessments/{case['assessment_id']}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"]},
        headers=_auth(tokens["officechief"]),
    )
    assert resp.status_code == 200, resp.text
    return case


def _execute(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.begin() as conn:
        return conn.execute(text(statement), params or {})


def _scalar(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.connect() as conn:
        return conn.execute(text(statement), params or {}).scalar()


# ---------------------------------------------------------------------------
# Route-aware eligibility (design §7.3)
# ---------------------------------------------------------------------------


class TestAssigneeEligibility:
    def test_senior_engineer_cannot_be_a_branch_route_engineer(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-engineer",
            json={"engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["branchchief"]),
        )
        assert resp.status_code == 400, resp.text
        assert _ENGINEER_MESSAGE in str(resp.json().get("detail", ""))
        assert _SENIOR_ENGINEER_MESSAGE not in str(resp.json().get("detail", ""))
        # The refusal rolled the whole assignment back.
        assert _scalar(
            "SELECT assigned_engineer_user_id FROM assessments WHERE id = :aid",
            {"aid": case["assessment_id"]},
        ) is None

    def test_engineer_cannot_be_assigned_through_the_senior_engineer_route(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        # The picker guard answers first and more usefully than the trigger; the
        # trigger below is the boundary that holds for direct SQL.
        assert resp.status_code == 400, resp.text
        assert "not a Senior Specialist for this office" in resp.json()["detail"]
        assert _scalar(
            "SELECT routing_path FROM assessments WHERE id = :aid", {"aid": case["assessment_id"]}
        ) is None

    def test_senior_engineer_assignment_row_rejects_an_engineer(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                """
                INSERT INTO assessment_assignments
                  (assessment_id, user_id, assignment_role, assigned_by_user_id)
                VALUES (:aid, :uid, 'SENIOR_ENGINEER', :by)
                """,
                {"aid": case["assessment_id"], "uid": ids["engineer"], "by": ids["officechief"]},
            )
        assert _SENIOR_ENGINEER_MESSAGE in str(excinfo.value)

    def test_engineer_assignment_row_rejects_a_senior_engineer(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                """
                INSERT INTO assessment_assignments
                  (assessment_id, user_id, assignment_role, assigned_by_user_id)
                VALUES (:aid, :uid, 'ENGINEER', :by)
                """,
                {"aid": case["assessment_id"], "uid": ids["senior_engineer"], "by": ids["branchchief"]},
            )
        assert _ENGINEER_MESSAGE in str(excinfo.value)

    def test_incident_stage_assignment_follows_the_assessment_route(self, client_db, tokens, ids):
        # The Senior Specialist route reuses incident stage ENGINEER, so the
        # incident-level trigger cannot read a role off its own row: it reads
        # the incident's assessment. Both routes are exercised on the SAME
        # table to prove the branch is the routing path and nothing else.
        senior_engineer_case = _triaged(client_db, tokens)
        assigned = client_db.post(
            f"/assessments/{senior_engineer_case['assessment_id']}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert assigned.status_code == 200, assigned.text
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                """
                INSERT INTO incident_assignments
                  (incident_id, assignee_user_id, assigned_by_user_id, assignment_stage, assignment_mode, is_active)
                VALUES (:iid, :uid, :by, 'ENGINEER', 'ASSIGN', 1)
                """,
                {
                    "iid": senior_engineer_case["incident_id"],
                    "uid": ids["engineer"],
                    "by": ids["officechief"],
                },
            )
        assert _SENIOR_ENGINEER_MESSAGE in str(excinfo.value)

        branch_case = _branch_routed(client_db, tokens, ids)
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                """
                INSERT INTO incident_assignments
                  (incident_id, assignee_user_id, assigned_by_user_id, assignment_stage, assignment_mode, is_active)
                VALUES (:iid, :uid, :by, 'ENGINEER', 'ASSIGN', 1)
                """,
                {"iid": branch_case["incident_id"], "uid": ids["senior_engineer"], "by": ids["branchchief"]},
            )
        assert _ENGINEER_MESSAGE in str(excinfo.value)


# ---------------------------------------------------------------------------
# FINALIZED is closed, including to direct SQL (design §3.4)
# ---------------------------------------------------------------------------


class TestNoNewFinalize:
    def test_direct_update_to_finalized_signals_45000(self, client_db, tokens, ids):
        case = _branch_routed(client_db, tokens, ids)
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                "UPDATE assessments SET state = 'FINALIZED' WHERE id = :aid",
                {"aid": case["assessment_id"]},
            )
        assert "finalization was retired" in str(excinfo.value)
        # 1644 is how SIGNAL SQLSTATE '45000' reaches the driver.
        assert int(excinfo.value.orig.args[0]) == 1644
        assert _scalar(
            "SELECT state FROM assessments WHERE id = :aid", {"aid": case["assessment_id"]}
        ) == "PENDING_ENGINEER_ASSIGNMENT"

    def test_an_already_finalized_row_still_updates(self, client_db, tokens, ids):
        # Legacy history stays fully writable: the trigger fires only on the
        # TRANSITION into FINALIZED (NEW.state = 'FINALIZED' AND OLD.state <>
        # 'FINALIZED'), never on a row that is already there. Such a row cannot
        # be produced through the v2 API at all, so it is inserted directly —
        # the BEFORE INSERT trigger guards the assignee, not the state.
        incident_id = _create_incident(client_db, tokens["admin"])
        _execute(
            """
            INSERT INTO assessments
              (assessment_uuid, incident_id, district, office_code, state,
               triage_disposition, created_by_user_id, approved_at, finalized_at)
            VALUES
              (:uuid, :iid, '04', 'WEST', 'FINALIZED',
               'ASSESSMENT_REQUIRED', :actor, NOW(), NOW())
            """,
            {"uuid": uuid.uuid4().hex, "iid": incident_id, "actor": ids["admin"]},
        )
        assessment_id = int(
            _scalar("SELECT id FROM assessments WHERE incident_id = :iid", {"iid": incident_id})
        )
        _execute(
            "UPDATE assessments SET notes = :notes, state = 'FINALIZED' WHERE id = :aid",
            {"notes": "legacy row corrected", "aid": assessment_id},
        )
        assert _scalar("SELECT notes FROM assessments WHERE id = :aid", {"aid": assessment_id}) == (
            "legacy row corrected"
        )
        # ...and it is still readable, filterable history through the API.
        listed = client_db.get("/assessments?state=FINALIZED", headers=_auth(tokens["admin"]))
        assert listed.status_code == 200, listed.text
        assert assessment_id in {item["id"] for item in listed.json()["items"]}


# ---------------------------------------------------------------------------
# The backfill is non-destructive (design §7.4 (b))
# ---------------------------------------------------------------------------


class TestBackfilledRowKeepsWorking:
    def test_senior_engineer_route_row_with_a_legacy_engineer_still_completes(
        self, client_db, tokens, ids
    ):
        # Exactly the shape backfill (b) produces: an assessment past office
        # delegation with no branch chief, stamped SENIOR_ENGINEER, still
        # holding the FIELD_WORKER engineer it was assigned before the release.
        case = _branch_routed(client_db, tokens, ids)
        aid = case["assessment_id"]
        assigned = client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["branchchief"]),
        )
        assert assigned.status_code == 200, assigned.text
        _execute(
            """
            UPDATE assessments
               SET routing_path = 'SENIOR_ENGINEER', branch_chief_user_id = NULL
             WHERE id = :aid
            """,
            {"aid": aid},
        )

        # The triggers fire only when assigned_engineer_user_id CHANGES, so
        # every later write on this row is untouched by the Senior Specialist rule.
        submitted = client_db.post(
            f"/assessments/{aid}/submit", json={"notes": "legacy engineer submits"},
            headers=_auth(tokens["engineer"]),
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["assessment"]["state"] == "SUBMITTED"
        assert submitted.json()["assessment"]["assigned_user_kind"] == "SENIOR_ENGINEER"

        # And the office chief — the Senior Specialist route's reviewer — approves it,
        # so the row is not stranded.
        approved = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "backfilled row approved"},
            headers=_auth(tokens["officechief"]),
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"

    def test_reassigning_that_row_does_apply_the_senior_engineer_rule(self, client_db, tokens, ids):
        # The other half of the same fact: the moment the assignee CHANGES, the
        # Senior Specialist rule applies, so the backfill is forgiving of history and
        # strict about new work.
        case = _branch_routed(client_db, tokens, ids)
        aid = case["assessment_id"]
        client_db.post(
            f"/assessments/{aid}/assign-engineer",
            json={"engineer_user_id": ids["engineer"]},
            headers=_auth(tokens["branchchief"]),
        )
        _execute(
            "UPDATE assessments SET routing_path = 'SENIOR_ENGINEER' WHERE id = :aid", {"aid": aid}
        )
        with pytest.raises(DBAPIError) as excinfo:
            _execute(
                "UPDATE assessments SET assigned_engineer_user_id = :uid WHERE id = :aid",
                {"uid": ids["branchchief"], "aid": aid},
            )
        assert _SENIOR_ENGINEER_MESSAGE in str(excinfo.value)


# ---------------------------------------------------------------------------
# assignment_role is wide enough for the new value (design §7.2 step 3)
# ---------------------------------------------------------------------------


class TestAssignmentRoleWidth:
    def test_the_route_role_is_stored_untruncated(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        aid = case["assessment_id"]
        assigned = client_db.post(
            f"/assessments/{aid}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert assigned.status_code == 200, assigned.text
        stored = _scalar(
            """
            SELECT assignment_role FROM assessment_assignments
             WHERE assessment_id = :aid AND is_active = 1 AND user_id = :uid
             ORDER BY id DESC LIMIT 1
            """,
            {"aid": aid, "uid": ids["senior_engineer"]},
        )
        # Round-trip, not a character count: the value the route writes must come
        # back byte for byte, whatever the CHECK vocabulary is called next.
        assert stored == "SENIOR_ENGINEER"

    def test_column_is_widened_to_twenty_four(self, client_db):
        width = _scalar(
            """
            SELECT CHARACTER_MAXIMUM_LENGTH
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'assessment_assignments'
               AND COLUMN_NAME = 'assignment_role'
            """
        )
        assert int(width) == 24

    def test_reassigning_a_senior_engineer_retires_the_previous_row(self, client_db, tokens, ids):
        # _perform_engineer_assignment deactivates by the SAME role it inserts,
        # so a Senior Specialist reassignment cannot leave two active rows behind.
        case = _triaged(client_db, tokens)
        aid = case["assessment_id"]
        for _ in range(2):
            resp = client_db.post(
                f"/assessments/{aid}/assign-senior-engineer",
                json={"senior_engineer_user_id": ids["senior_engineer"]},
                headers=_auth(tokens["officechief"]),
            )
            assert resp.status_code == 200, resp.text
        active = _scalar(
            """
            SELECT COUNT(*) FROM assessment_assignments
             WHERE assessment_id = :aid AND assignment_role = 'SENIOR_ENGINEER' AND is_active = 1
            """,
            {"aid": aid},
        )
        assert int(active) == 1
