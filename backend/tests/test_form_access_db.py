"""Who may open a technical form while its assessment is in progress (services/form_access.py).

Seeing that an assessment exists stays open to every operational user; opening
its technical form is for the people on its route, the people it is shared
with, and administrators, until the assessment is approved.

Requires a live MariaDB at Alembic head with database/dev/030_mock_accounts.sql
loaded. Run with: pytest -m db
"""

import uuid

import pytest
from sqlalchemy import text

from tests.test_routing_v2_authority import _auth, _branch_drafting, _login, _me_id

pytestmark = pytest.mark.db


@pytest.fixture(scope="module")
def tokens(client_db, admin_token):
    return {
        "admin": admin_token,
        "officechief": _login(client_db, "mock.office.chief@dot.ca.gov"),
        "branchchief": _login(client_db, "mock.branch.chief@dot.ca.gov"),
        "engineer": _login(client_db, "mock.staff@dot.ca.gov"),
        "other_staff": _login(client_db, "mock.staff.2@dot.ca.gov"),
        "coordinator": _login(client_db, "mock.coordinator.d04@dot.ca.gov"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    return {key: _me_id(client_db, token) for key, token in tokens.items()}


def _attach(submission_id: int, owner_id: int) -> int:
    """A file on the form, straight into the tables (the upload path is not what this is about)."""
    from app.db import engine

    with engine.begin() as conn:
        attachment_id = conn.execute(
            text(
                """
                INSERT INTO attachments (created_by_user_id, storage_provider, storage_bucket, storage_key, file_name, mime_type, file_size_bytes)
                VALUES (:uid, 'minio', 'eris', :key, 'note.pdf', 'application/pdf', 8)
                """
            ),
            {"uid": owner_id, "key": f"uploads/form-access-{uuid.uuid4().hex}.pdf"},
        ).lastrowid
        conn.execute(
            text("INSERT INTO attachment_links (submission_id, attachment_id, kind) VALUES (:sid, :aid, 'DOC')"),
            {"sid": submission_id, "aid": attachment_id},
        )
    return int(attachment_id)


def _opens(client_db, token: str, submission_id: int) -> int:
    return client_db.get(f"/submissions/{submission_id}", headers=_auth(token)).status_code


def _listed(client_db, token: str, submission_id: int) -> bool:
    page = client_db.get("/submissions/page?limit=200", headers=_auth(token)).json()["items"]
    plain = client_db.get("/submissions?limit=200", headers=_auth(token)).json()["items"]
    in_page, in_plain = submission_id in [s["id"] for s in page], submission_id in [s["id"] for s in plain]
    assert in_page == in_plain
    return in_page


def test_work_in_progress_opens_only_to_its_route(client_db, tokens, ids):
    case = _branch_drafting(client_db, tokens, ids)
    sid, aid = case["submission_id"], case["assessment_id"]
    attachment = _attach(sid, ids["engineer"])

    # Everyone operational still sees the assessment and its stage.
    for who in ("other_staff", "coordinator"):
        seen = client_db.get(f"/assessments/{aid}", headers=_auth(tokens[who]))
        assert seen.status_code == 200, seen.text

    # The route opens the form: the assignee, the branch chief it was handed to,
    # the chief of its office, and administrators.
    for who in ("engineer", "branchchief", "officechief", "admin"):
        assert _opens(client_db, tokens[who], sid) == 200, who
        assert _listed(client_db, tokens[who], sid), who

    # Nobody else, and they are told why.
    for who in ("other_staff", "coordinator"):
        refused = client_db.get(f"/submissions/{sid}", headers=_auth(tokens[who]))
        assert refused.status_code == 403 and "in progress" in refused.json()["detail"], who
        assert not _listed(client_db, tokens[who], sid), who
        for path in (f"/submissions/{sid}/photo-map", f"/submissions/{sid}/drone-surveys", f"/submissions/{sid}/gisa/pdf"):
            assert client_db.get(path, headers=_auth(tokens[who])).status_code == 403, (who, path)
        file = client_db.get(f"/attachments/{attachment}/download-url", headers=_auth(tokens[who]))
        assert file.status_code == 403, (who, file.text)
    assert client_db.get(f"/attachments/{attachment}/download-url", headers=_auth(tokens["engineer"])).status_code != 403

    # Mission Center still shows the incident, with its own photos in place of the form's.
    gis = client_db.get(f"/mission-center/incidents/{case['incident_id']}/gis", headers=_auth(tokens["other_staff"]))
    assert gis.status_code == 200, gis.text
    incident = gis.json()["incident"]
    if incident["linked_submission_id"] == sid:
        assert incident["linked_submission_readable"] is False


def test_a_share_opens_it_and_approval_opens_it_to_everyone(client_db, tokens, ids):
    case = _branch_drafting(client_db, tokens, ids)
    sid, aid = case["submission_id"], case["assessment_id"]
    assert _opens(client_db, tokens["other_staff"], sid) == 403

    shared = client_db.post(f"/submissions/{sid}/share", json={"user_id": ids["other_staff"]}, headers=_auth(tokens["engineer"]))
    assert shared.status_code == 200, shared.text
    if shared.json()["share"]["status"] == "ACTIVE":
        assert _opens(client_db, tokens["other_staff"], sid) == 200
    client_db.delete(f"/submissions/{sid}/share/{ids['other_staff']}", headers=_auth(tokens["engineer"]))

    submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
    assert submitted.status_code == 200, submitted.text
    approved = client_db.post(f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens["branchchief"]))
    assert approved.status_code == 200, approved.text

    for who in ("other_staff", "coordinator"):
        assert _opens(client_db, tokens[who], sid) == 200, who
        assert _listed(client_db, tokens[who], sid), who
