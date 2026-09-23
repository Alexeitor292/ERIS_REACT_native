"""Routing v2 — B1's transaction boundary (design §3.5, §11).

``submit`` and ``review`` drive every linked technical submission in the SAME
transaction as the assessment. Both used to call ``db.commit()`` bare, and B1
puts a helper inside their loops that raises 409 on a concurrent writer — so
without the ``try / except HTTPException: rollback; raise`` wrapper the two
endpoints gained, a mid-loop conflict would leave a PARTIALLY transitioned set
of submissions behind a failed request. That is the regression this module
exists for, and nothing else covers it.

The second fact it pins is the other half of §3.5: a row in an unexpected
state is SKIPPED and reported, never a reason to fail the whole request.

Run with: pytest -m db
"""

import uuid

import pytest
from sqlalchemy import text

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
def tokens(client_db, admin_token):
    return {
        "admin": admin_token,
        "officechief": _login(client_db, "mock.office.chief@dot.ca.gov"),
        "branchchief": _login(client_db, "mock.branch.chief@dot.ca.gov"),
        "engineer": _login(client_db, "mock.staff@dot.ca.gov"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {key: _me_id(client_db, token) for key, token in tokens.items()}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _execute(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.begin() as conn:
        return conn.execute(text(statement), params or {})


def _scalar(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.connect() as conn:
        return conn.execute(text(statement), params or {}).scalar()


def _status(submission_id: int) -> str:
    return str(_scalar("SELECT status FROM submissions WHERE id = :sid", {"sid": submission_id}))


def _two_form_draft(client_db, tokens, ids) -> dict:
    """A branch-route assessment in DRAFT with TWO linked technical forms."""
    incident = client_db.post(
        "/incidents",
        json={
            "title": f"Routing v2 transactions {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Integration incident for B1's transaction boundary",
            "first_observed_at": "2026-06-25T10:00:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": "10.0",
        },
        headers=_auth(tokens["admin"]),
    )
    assert incident.status_code == 200, incident.text
    incident_id = int(incident.json()["incident"]["id"])

    triage = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED"},
        headers=_auth(tokens["admin"]),
    )
    assert triage.status_code == 200, triage.text
    aid = int(triage.json()["assessment"]["id"])

    delegated = client_db.post(
        f"/assessments/{aid}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"]},
        headers=_auth(tokens["officechief"]),
    )
    assert delegated.status_code == 200, delegated.text
    assigned = client_db.post(
        f"/assessments/{aid}/assign-engineer",
        json={"engineer_user_id": ids["engineer"]},
        headers=_auth(tokens["branchchief"]),
    )
    assert assigned.status_code == 200, assigned.text
    primary = int(assigned.json()["assessment"]["submission_id"])

    added = client_db.post(
        f"/assessments/{aid}/submissions",
        json={"notes": "Supplemental survey"},
        headers=_auth(tokens["engineer"]),
    )
    assert added.status_code == 200, added.text
    supplemental = int(added.json()["submission_id"])
    # B1 walks them oldest first, so the supplemental is the SECOND row.
    assert added.json()["assessment"]["submission_ids"] == [primary, supplemental]
    return {
        "incident_id": incident_id,
        "assessment_id": aid,
        "primary": primary,
        "supplemental": supplemental,
    }


def _report_stale_status(monkeypatch, *, submission_id: int, stale_status: str) -> None:
    """Make B1 read a stale status for ONE submission.

    This is what a concurrent writer looks like from inside the loop: the
    status is read, another transaction moves the row, and the guarded UPDATE
    then matches no rows. ``_drive_linked_submissions`` imports the helper from
    app.main at call time, so patching the module attribute reaches it.
    """
    from app import main as main_module

    real = main_module.get_submission_status

    def _patched(db, sid):
        if int(sid) == int(submission_id):
            return stale_status
        return real(db, sid)

    monkeypatch.setattr(main_module, "get_submission_status", _patched)


# ---------------------------------------------------------------------------
# A mid-loop 409 must take the whole request with it
# ---------------------------------------------------------------------------


class TestPartialTransitionRollback:
    def test_submit_conflict_leaves_the_assessment_and_the_first_form_untouched(
        self, client_db, tokens, ids, monkeypatch
    ):
        case = _two_form_draft(client_db, tokens, ids)
        # The first row is a genuine DRAFT and transitions; the second is read
        # as REJECTED while it is really DRAFT, so its guarded UPDATE matches
        # nothing and the helper raises 409 with the first row already moved.
        _report_stale_status(monkeypatch, submission_id=case["supplemental"], stale_status="REJECTED")

        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/submit",
            json={"notes": "both forms ready"},
            headers=_auth(tokens["engineer"]),
        )
        assert resp.status_code == 409, resp.text
        assert "expected status REJECTED" in resp.json()["detail"]

        # Nothing survived the failed request — this is the whole point.
        assert _scalar(
            "SELECT state FROM assessments WHERE id = :aid", {"aid": case["assessment_id"]}
        ) == "DRAFT"
        assert _status(case["primary"]) == "DRAFT", "the first row must not stay transitioned"
        assert _status(case["supplemental"]) == "DRAFT"
        assert _scalar(
            "SELECT COUNT(*) FROM workflow_events WHERE submission_id = :sid AND event_type = 'SUBMIT'",
            {"sid": case["primary"]},
        ) == 0
        assert _scalar(
            "SELECT submitted_at FROM assessments WHERE id = :aid", {"aid": case["assessment_id"]}
        ) is None

    def test_the_same_assessment_submits_cleanly_once_the_conflict_is_gone(
        self, client_db, tokens, ids, monkeypatch
    ):
        case = _two_form_draft(client_db, tokens, ids)
        _report_stale_status(monkeypatch, submission_id=case["supplemental"], stale_status="REJECTED")
        failed = client_db.post(
            f"/assessments/{case['assessment_id']}/submit", json={}, headers=_auth(tokens["engineer"])
        )
        assert failed.status_code == 409, failed.text

        monkeypatch.undo()
        retried = client_db.post(
            f"/assessments/{case['assessment_id']}/submit", json={}, headers=_auth(tokens["engineer"])
        )
        assert retried.status_code == 200, retried.text
        assert sorted(retried.json()["submissions_transitioned"]) == sorted(
            [case["primary"], case["supplemental"]]
        )
        assert _status(case["primary"]) == "SUBMITTED"
        assert _status(case["supplemental"]) == "SUBMITTED"

    def test_review_conflict_leaves_the_assessment_submitted(
        self, client_db, tokens, ids, monkeypatch
    ):
        case = _two_form_draft(client_db, tokens, ids)
        aid = case["assessment_id"]
        submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
        assert submitted.status_code == 200, submitted.text

        # A real concurrent writer: the second form is moved out from under the
        # review while B1 still reads the status it had a moment ago.
        _execute(
            "UPDATE submissions SET status = 'APPROVED' WHERE id = :sid",
            {"sid": case["supplemental"]},
        )
        _report_stale_status(monkeypatch, submission_id=case["supplemental"], stale_status="SUBMITTED")

        resp = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "approve both"},
            headers=_auth(tokens["branchchief"]),
        )
        assert resp.status_code == 409, resp.text

        assert _scalar("SELECT state FROM assessments WHERE id = :aid", {"aid": aid}) == "SUBMITTED"
        assert _scalar("SELECT approved_at FROM assessments WHERE id = :aid", {"aid": aid}) is None
        assert _status(case["primary"]) == "SUBMITTED", "the first row must not stay approved"
        # ...and no approval notice was written for a decision that did not happen.
        assert _scalar(
            """
            SELECT COUNT(*) FROM incident_notifications
             WHERE incident_id = :iid AND template_code = 'ASSESSMENT_APPROVED_COORDINATOR'
            """,
            {"iid": case["incident_id"]},
        ) == 0


# ---------------------------------------------------------------------------
# An unexpected state is reported, not fatal (design §3.5)
# ---------------------------------------------------------------------------


class TestSkippedSubmissions:
    def test_submit_skips_an_already_approved_supplemental(self, client_db, tokens, ids):
        case = _two_form_draft(client_db, tokens, ids)
        # An APPROVED supplemental from a previous round — a shape B1 must step
        # over rather than 409 the engineer's whole submission for.
        _execute(
            "UPDATE submissions SET status = 'APPROVED' WHERE id = :sid",
            {"sid": case["supplemental"]},
        )

        resp = client_db.post(
            f"/assessments/{case['assessment_id']}/submit",
            json={"notes": "one new form"},
            headers=_auth(tokens["engineer"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["assessment"]["state"] == "SUBMITTED"
        assert resp.json()["submissions_transitioned"] == [case["primary"]]
        # Reported, so a desync is visible in the API instead of inferred from
        # the database.
        assert resp.json()["submissions_skipped"] == [
            {"submission_id": case["supplemental"], "status": "APPROVED"}
        ]
        assert _status(case["primary"]) == "SUBMITTED"
        assert _status(case["supplemental"]) == "APPROVED"

    def test_approve_skips_a_draft_supplemental_and_still_completes(self, client_db, tokens, ids):
        case = _two_form_draft(client_db, tokens, ids)
        aid = case["assessment_id"]
        # Submit with only the primary attached to the transition, then attach a
        # brand-new draft the reviewer never saw.
        _execute(
            "UPDATE submissions SET status = 'APPROVED' WHERE id = :sid",
            {"sid": case["supplemental"]},
        )
        submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
        assert submitted.status_code == 200, submitted.text
        _execute(
            "UPDATE submissions SET status = 'DRAFT' WHERE id = :sid", {"sid": case["supplemental"]}
        )

        approved = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE", "notes": "the draft is not part of this decision"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"
        assert approved.json()["submissions_transitioned"] == [case["primary"]]
        assert approved.json()["submissions_skipped"] == [
            {"submission_id": case["supplemental"], "status": "DRAFT"}
        ]

    def test_revision_and_resubmit_round_trip_moves_both_records(self, client_db, tokens, ids):
        case = _two_form_draft(client_db, tokens, ids)
        aid = case["assessment_id"]
        assert client_db.post(
            f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"])
        ).status_code == 200

        returned = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "REQUEST_REVISION", "notes": "fix section 3"},
            headers=_auth(tokens["branchchief"]),
        )
        assert returned.status_code == 200, returned.text
        assert sorted(returned.json()["submissions_transitioned"]) == sorted(
            [case["primary"], case["supplemental"]]
        )
        assert _status(case["primary"]) == "REJECTED"

        # The revision cycle re-enters through REJECTED, which is exactly why
        # the source status is read per row instead of being a single literal.
        resubmitted = client_db.post(
            f"/assessments/{aid}/submit", json={"notes": "section 3 revised"},
            headers=_auth(tokens["engineer"]),
        )
        assert resubmitted.status_code == 200, resubmitted.text
        assert sorted(resubmitted.json()["submissions_transitioned"]) == sorted(
            [case["primary"], case["supplemental"]]
        )
        assert _status(case["primary"]) == "SUBMITTED"
        assert _scalar(
            """
            SELECT COUNT(*) FROM workflow_events
             WHERE submission_id = :sid AND event_type = 'RESUBMIT'
            """,
            {"sid": case["primary"]},
        ) == 1
