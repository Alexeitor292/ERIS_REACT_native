"""Routing v2 — the notification outbox, end to end (design §6).

Owner decision 6 is "when a GeoTech assessment is approved the maintenance
coordinator is notified in-app AND by email". Nothing in ERIS read
``incident_notifications`` before this release and nothing wrote an EMAIL row,
so all of it is new and none of it is covered anywhere else:

  * approval writes one IN_APP row and one EMAIL row PER coordinator;
  * the coordinator who actually triaged the incident is a recipient even when
    resolving by district would miss them;
  * submit tells the route's reviewer — the named branch chief, or the
    assessment's office chiefs — and nobody else;
  * REQUEST_REVISION tells the assignee, who is the only person who can act;
  * with SMTP_HOST unset and MAIL_DEV_DUMP_DIR set the whole send path runs and
    stamps ``delivered_at``, which is how CI exercises it without a relay.

Run with: pytest -m db
"""

import json
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
def tokens(client_db, admin_token, senior_engineer_token):
    return {
        "admin": admin_token,
        "senior_engineer": senior_engineer_token,
        # District 04 — the district these fixtures create in. coordinator@local
        # is district 01, so without this account every "the coordinator was
        # notified" assertion would pass vacuously against an empty list.
        "coordinator04": _login(client_db, "coordinator04@local"),
        "officechief": _login(client_db, "officechief@local"),
        "branchchief": _login(client_db, "branchchief@local"),
        "engineer": _login(client_db, "engineer@local"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {key: _me_id(client_db, token) for key, token in tokens.items()}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_incident(client_db, token, *, district="04", county="Marin", route="1", post_mile="10.0") -> int:
    resp = client_db.post(
        "/incidents",
        json={
            "title": f"Routing v2 notifications {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Integration incident for the routing v2 notification outbox",
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


def _triaged(client_db, tokens, *, by: str = "admin") -> dict:
    # Admin always reports it (a coordinator holds no reporting role); ``by``
    # is who makes the TRIAGE decision, which is what the recipient union reads.
    incident_id = _create_incident(client_db, tokens["admin"])
    resp = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "notifications"},
        headers=_auth(tokens[by]),
    )
    assert resp.status_code == 200, resp.text
    return {"incident_id": incident_id, "assessment_id": int(resp.json()["assessment"]["id"])}


def _branch_submitted(client_db, tokens, ids, *, triaged_by: str = "admin") -> dict:
    case = _triaged(client_db, tokens, by=triaged_by)
    aid = case["assessment_id"]
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
    submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
    assert submitted.status_code == 200, submitted.text
    return case


def _senior_engineer_submitted(client_db, tokens, ids) -> dict:
    case = _triaged(client_db, tokens)
    aid = case["assessment_id"]
    assigned = client_db.post(
        f"/assessments/{aid}/assign-senior-engineer",
        json={"senior_engineer_user_id": ids["senior_engineer"]},
        headers=_auth(tokens["officechief"]),
    )
    assert assigned.status_code == 200, assigned.text
    submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["senior_engineer"]))
    assert submitted.status_code == 200, submitted.text
    return case


def _notifications(incident_id: int, template_code: str) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, recipient_user_id, channel, template_code, payload_json,
                       delivered_at, delivery_attempts, last_error
                FROM incident_notifications
                WHERE incident_id = :iid AND template_code = :template
                ORDER BY id ASC
                """
            ),
            {"iid": incident_id, "template": template_code},
        ).mappings().all()
    return [dict(row) for row in rows]


def _recipients(rows: list[dict], channel: str) -> set[int]:
    return {int(row["recipient_user_id"]) for row in rows if row["channel"] == channel}


# ---------------------------------------------------------------------------
# Approval: the coordinator notice (owner decision 6)
# ---------------------------------------------------------------------------


class TestApprovalNotifiesCoordinators:
    def test_one_in_app_and_one_email_row_per_coordinator(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE", "notes": "approved"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text

        rows = _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")
        in_app = _recipients(rows, "IN_APP")
        email = _recipients(rows, "EMAIL")
        assert in_app, "no coordinator was notified at all"
        assert in_app == email, "every coordinator gets BOTH channels, not one or the other"
        assert len(rows) == 2 * len(in_app), "exactly one row per (recipient, channel)"
        # The district coordinator for this incident's district...
        assert ids["coordinator04"] in in_app
        # ...and the endpoint reports exactly what it queued.
        assert set(approved.json()["notified"]["coordinators"]) == in_app
        assert approved.json()["notified"]["channels"] == ["IN_APP", "EMAIL"]

    def test_the_triaging_coordinator_is_a_recipient(self, client_db, tokens, ids):
        # admin triages here and holds no district metadata, so resolving by
        # district alone would miss the person who actually routed the work.
        case = _branch_submitted(client_db, tokens, ids, triaged_by="admin")
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        recipients = _recipients(
            _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR"), "EMAIL"
        )
        assert ids["admin"] in recipients, "triage_decided_by_user_id must be in the union"
        assert ids["coordinator04"] in recipients, "the district coordinator is still resolved"

    def test_the_coordinator_who_routed_it_is_notified_on_the_senior_engineer_route(
        self, client_db, tokens, ids
    ):
        case = _triaged(client_db, tokens, by="coordinator04")
        aid = case["assessment_id"]
        assigned = client_db.post(
            f"/assessments/{aid}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert assigned.status_code == 200, assigned.text
        submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["senior_engineer"]))
        assert submitted.status_code == 200, submitted.text
        approved = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["officechief"]),
        )
        assert approved.status_code == 200, approved.text
        rows = _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")
        assert ids["coordinator04"] in _recipients(rows, "IN_APP")
        assert ids["coordinator04"] in _recipients(rows, "EMAIL")

    def test_the_payload_describes_the_assessment_as_approved(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        row = _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")[0]
        payload = json.loads(row["payload_json"])
        assert payload["assessment_id"] == case["assessment_id"]
        assert payload["routing_path"] == "BRANCH"
        assert payload["office_code"] == "WEST"
        assert payload["district"] == "04"
        assert payload["approved_by_role"] == "GeoTech Branch Chief"
        assert payload["approved_at"], "the approval time is recorded WITH the notice"
        assert "District 04" in payload["route_label"]

    def test_the_author_is_told_separately_and_in_app_only(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        rows = _notifications(case["incident_id"], "ASSESSMENT_APPROVED_AUTHOR")
        assert {int(r["recipient_user_id"]) for r in rows} == {ids["engineer"]}
        assert {r["channel"] for r in rows} == {"IN_APP"}


# ---------------------------------------------------------------------------
# Submit and REQUEST_REVISION: one named person, per route
# ---------------------------------------------------------------------------


class TestSubmitAndRevisionNotices:
    def test_submit_notifies_the_named_branch_chief_only(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        rows = _notifications(case["incident_id"], "ASSESSMENT_SUBMITTED_FOR_REVIEW")
        assert _recipients(rows, "IN_APP") == {ids["branchchief"]}
        assert {r["channel"] for r in rows} == {"IN_APP"}
        assert ids["officechief"] not in _recipients(rows, "IN_APP")

    def test_submit_notifies_the_office_chiefs_on_the_senior_engineer_route(self, client_db, tokens, ids):
        case = _senior_engineer_submitted(client_db, tokens, ids)
        recipients = _recipients(
            _notifications(case["incident_id"], "ASSESSMENT_SUBMITTED_FOR_REVIEW"), "IN_APP"
        )
        # The OFFICE owns the review, so every active chief of it is told.
        assert ids["officechief"] in recipients
        assert ids["branchchief"] not in recipients
        assert ids["senior_engineer"] not in recipients

    def test_senior_engineer_assignment_notifies_the_senior_engineer(self, client_db, tokens, ids):
        case = _triaged(client_db, tokens)
        assigned = client_db.post(
            f"/assessments/{case['assessment_id']}/assign-senior-engineer",
            json={"senior_engineer_user_id": ids["senior_engineer"]},
            headers=_auth(tokens["officechief"]),
        )
        assert assigned.status_code == 200, assigned.text
        rows = _notifications(case["incident_id"], "ASSESSMENT_SENIOR_ENGINEER_ASSIGNMENT")
        assert _recipients(rows, "IN_APP") == {ids["senior_engineer"]}

    def test_request_revision_notifies_the_assignee(self, client_db, tokens, ids):
        case = _branch_submitted(client_db, tokens, ids)
        returned = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "REQUEST_REVISION", "notes": "fix section 3"},
            headers=_auth(tokens["branchchief"]),
        )
        assert returned.status_code == 200, returned.text
        assert returned.json()["notified"]["assignee"] == ids["engineer"]
        rows = _notifications(case["incident_id"], "ASSESSMENT_REVISION_REQUESTED")
        assert _recipients(rows, "IN_APP") == {ids["engineer"]}
        assert {r["channel"] for r in rows} == {"IN_APP"}, "in-app only: no delivery risk added"
        assert json.loads(rows[0]["payload_json"])["notes"] == "fix section 3"

    def test_revision_on_the_senior_engineer_route_notifies_the_senior_engineer(self, client_db, tokens, ids):
        case = _senior_engineer_submitted(client_db, tokens, ids)
        returned = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "REQUEST_REVISION", "notes": "add the borehole log"},
            headers=_auth(tokens["officechief"]),
        )
        assert returned.status_code == 200, returned.text
        rows = _notifications(case["incident_id"], "ASSESSMENT_REVISION_REQUESTED")
        assert _recipients(rows, "IN_APP") == {ids["senior_engineer"]}


# ---------------------------------------------------------------------------
# Delivery: the after-commit flush, with no relay (design §6.3, §6.4)
# ---------------------------------------------------------------------------


class TestEmailDelivery:
    def test_dev_dump_writes_an_eml_and_stamps_delivered_at(
        self, client_db, tokens, ids, monkeypatch, tmp_path
    ):
        from app.config import settings

        # SMTP_HOST stays unset — the dev and CI default. MAIL_DEV_DUMP_DIR is
        # what makes the send path runnable without a mail server.
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", str(tmp_path))
        monkeypatch.setattr(settings, "WEB_BASE_URL", "https://eris.test")

        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE", "notes": "approved with delivery"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text

        rows = _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")
        email_rows = [r for r in rows if r["channel"] == "EMAIL"]
        assert email_rows, "no EMAIL row was written"
        # The flush is handed to BackgroundTasks after commit; TestClient runs
        # it before returning, so by here every row is either delivered or
        # recorded as failed.
        for row in email_rows:
            assert row["delivered_at"] is not None, f"undelivered: {row['last_error']}"
            assert int(row["delivery_attempts"]) == 1
            assert row["last_error"] is None
        in_app_rows = [r for r in rows if r["channel"] == "IN_APP"]
        assert all(r["delivered_at"] is None for r in in_app_rows), (
            "IN_APP rows are the in-app inbox's problem; the mailer must not touch them"
        )

        written = sorted(tmp_path.glob("*.eml"))
        assert len(written) == len(email_rows)
        # Parsed rather than string-matched: the subject carries an em dash and
        # is therefore RFC 2047 encoded on the wire.
        import email
        from email.header import decode_header, make_header

        message = email.message_from_bytes(written[0].read_bytes(), policy=email.policy.default)
        subject = str(make_header(decode_header(str(message["Subject"]))))
        assert "GeoTech assessment approved" in subject
        assert message["Auto-Submitted"] == "auto-generated"
        assert "@" in str(message["To"])
        body = message.get_content()
        assert "The assessment is complete. No further GeoTech action is required." in body
        assert f"https://eris.test/assessments/{case['assessment_id']}" in body

    def test_with_no_relay_and_no_dump_dir_nothing_is_attempted(
        self, client_db, tokens, ids, monkeypatch
    ):
        from app.config import settings

        monkeypatch.setattr(settings, "SMTP_HOST", None)
        monkeypatch.setattr(settings, "MAIL_DEV_DUMP_DIR", None)

        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["branchchief"]),
        )
        assert approved.status_code == 200, approved.text
        email_rows = [
            r
            for r in _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")
            if r["channel"] == "EMAIL"
        ]
        assert email_rows, "the row is still written — it is the audit record that a notice was due"
        for row in email_rows:
            assert row["delivered_at"] is None
            # No attempt is consumed, so enabling SMTP later still finds the
            # row retryable within SMTP_BACKLOG_MAX_AGE_HOURS.
            assert int(row["delivery_attempts"]) == 0
            assert row["last_error"] is None

        # And the backlog is visible to an admin rather than silent.
        undelivered = client_db.get("/admin/notifications/undelivered", headers=_auth(tokens["admin"]))
        assert undelivered.status_code == 200, undelivered.text
        listed = {int(item["id"]) for item in undelivered.json()["items"]}
        assert {int(r["id"]) for r in email_rows} <= listed
        assert all(item["channel"] == "EMAIL" for item in undelivered.json()["items"])

    def test_a_failing_relay_records_the_attempt_and_never_breaks_the_approval(
        self, client_db, tokens, ids, monkeypatch
    ):
        from app.config import settings
        from app.services import notifications as notifications_svc

        monkeypatch.setattr(settings, "SMTP_HOST", "relay.invalid.test")
        monkeypatch.setattr(settings, "SMTP_MAX_ATTEMPTS", 5)

        def _explode(*args, **kwargs):
            raise OSError("relay refused the connection")

        monkeypatch.setattr(notifications_svc, "send_email", _explode)

        case = _branch_submitted(client_db, tokens, ids)
        approved = client_db.post(
            f"/assessments/{case['assessment_id']}/review",
            json={"action": "APPROVE"},
            headers=_auth(tokens["branchchief"]),
        )
        # The approval stands: delivery is best-effort and after the commit.
        assert approved.status_code == 200, approved.text
        assert approved.json()["state"] == "APPROVED"
        email_rows = [
            r
            for r in _notifications(case["incident_id"], "ASSESSMENT_APPROVED_COORDINATOR")
            if r["channel"] == "EMAIL"
        ]
        for row in email_rows:
            assert row["delivered_at"] is None
            assert int(row["delivery_attempts"]) == 1
            assert "relay refused the connection" in str(row["last_error"])
