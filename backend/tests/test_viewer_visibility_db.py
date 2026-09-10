"""What a read-only Viewer can see, and everything they cannot (design §4, W18/W21).

Owner decision 4: everyone else in Caltrans gets the APPROVED record — the whole
record, statewide — and nothing else. Three properties carry that, and each one
is a way the obvious implementation goes wrong:

**Approved means approved.** ``OPERATIONAL_ROLES`` is a flat, STATE-BLIND switch:
``can_view_submission`` returns True for every operational user and
``list_submissions`` hands them DRAFT rows. A viewer added to that list would
read every draft technical form in the state. So the viewer is a third category
and "approved only" is applied per handler.

**404, never 403, for a record in flight.** A 403 confirms the record exists, and
a viewer who can probe ids can enumerate in-flight work. The answer is the same
one a nonexistent id gets.

**Fail closed everywhere else, and prove it route by route.** The previous
revision of this design claimed the viewer would simply 403 on anything nobody
remembered to touch. That was false — 39 of 137 routes carried no role guard at
all, eleven of them writes. The exhaustive class at the bottom of this module
walks the LIVE route table and refuses to let that be true again: every route not
on the reviewed allow list is called as a viewer and must be refused.

Requires a live MariaDB at Alembic head with database/init/020_seed.sql applied
(the org model adds viewer@local). Run with: pytest -m db
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import text

from app.services.public_visibility import VIEWER_READABLE_ROUTES

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client_db, email: str, password: str = "password") -> str:
    resp = client_db.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, f"login {email} failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


def _exec(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.begin() as conn:
        return conn.execute(text(statement), params or {})


def _rows(statement: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(statement), params or {}).mappings().all()]


@pytest.fixture(scope="module")
def tokens(client_db, admin_token, viewer_token):
    return {
        "admin": admin_token,
        "viewer": viewer_token,
        "officechief": _login(client_db, "officechief@local"),
        "branchchief": _login(client_db, "branchchief@local"),
        "engineer": _login(client_db, "engineer@local"),
    }


@pytest.fixture(scope="module")
def ids(client_db, tokens):
    out = {}
    for key in ("viewer", "branchchief", "engineer"):
        resp = client_db.get("/auth/me", headers=_auth(tokens[key]))
        assert resp.status_code == 200, resp.text
        out[key] = int(resp.json()["id"])
    return out


def _new_assessment(client_db, tokens, *, district="04") -> dict:
    incident = client_db.post(
        "/incidents",
        json={
            "title": f"Viewer visibility {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Fixture for the viewer visibility tests",
            "first_observed_at": "2026-06-25T10:00:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": district,
            "county": "Marin",
            "route": "1",
            "post_mile": "10.0",
        },
        headers=_auth(tokens["admin"]),
    )
    assert incident.status_code == 200, incident.text
    incident_id = int(incident.json()["incident"]["id"])
    triaged = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED"},
        headers=_auth(tokens["admin"]),
    )
    assert triaged.status_code == 200, triaged.text
    return {"incident_id": incident_id, "assessment_id": int(triaged.json()["assessment"]["id"])}


def _drive(client_db, tokens, ids, *, to: str) -> dict:
    """Drive one incident to a named assessment state on the branch route."""
    case = _new_assessment(client_db, tokens)
    aid = case["assessment_id"]
    delegated = client_db.post(
        f"/assessments/{aid}/delegate-branch",
        json={"branch_chief_user_id": ids["branchchief"]},
        headers=_auth(tokens["officechief"]),
    )
    assert delegated.status_code == 200, delegated.text
    if to == "PENDING_ENGINEER_ASSIGNMENT":
        return case
    assigned = client_db.post(
        f"/assessments/{aid}/assign-engineer",
        json={"engineer_user_id": ids["engineer"]},
        headers=_auth(tokens["branchchief"]),
    )
    assert assigned.status_code == 200, assigned.text
    case["submission_id"] = int(assigned.json()["assessment"]["submission_id"])
    if to == "DRAFT":
        return case
    submitted = client_db.post(f"/assessments/{aid}/submit", json={}, headers=_auth(tokens["engineer"]))
    assert submitted.status_code == 200, submitted.text
    if to == "SUBMITTED":
        return case
    if to == "REVISION_REQUESTED":
        returned = client_db.post(
            f"/assessments/{aid}/review",
            json={"action": "REQUEST_REVISION", "notes": "fix section 3"},
            headers=_auth(tokens["branchchief"]),
        )
        assert returned.status_code == 200, returned.text
        return case
    approved = client_db.post(
        f"/assessments/{aid}/review", json={"action": "APPROVE"}, headers=_auth(tokens["branchchief"])
    )
    assert approved.status_code == 200, approved.text
    assert _rows("SELECT state FROM assessments WHERE id = :aid", {"aid": aid})[0]["state"] == "APPROVED"
    return case


@pytest.fixture(scope="module")
def approved(client_db, tokens, ids):
    """An APPROVED assessment with a photo attached to its submission."""
    case = _drive(client_db, tokens, ids, to="APPROVED")
    _exec(
        """
        INSERT INTO attachments
          (created_by_user_id, storage_provider, storage_bucket, storage_key,
           file_name, mime_type, file_size_bytes, sha256, uploaded_at)
        VALUES (:uid, 'MINIO', 'eris-uploads', :key, :name, 'image/jpeg', 1024, :sha, NOW())
        """,
        {
            "name": f"viewer-photo-{_RUN}.jpg",
            "sha": f"{_RUN}{'0' * (64 - len(_RUN))}",
            "key": f"tests/viewer/{_RUN}.jpg",
            "uid": ids["engineer"],
        },
    )
    attachment_id = int(
        _rows("SELECT id FROM attachments WHERE storage_key = :k", {"k": f"tests/viewer/{_RUN}.jpg"})[0]["id"]
    )
    _exec(
        "INSERT INTO attachment_links (attachment_id, submission_id, kind) VALUES (:aid, :sid, 'PHOTO')",
        {"aid": attachment_id, "sid": case["submission_id"]},
    )
    case["attachment_id"] = attachment_id
    yield case
    _exec("DELETE FROM attachment_links WHERE attachment_id = :aid", {"aid": attachment_id})
    _exec("DELETE FROM attachments WHERE id = :aid", {"aid": attachment_id})


@pytest.fixture(scope="module")
def in_flight(client_db, tokens, ids):
    return {
        state: _drive(client_db, tokens, ids, to=state)
        for state in ("DRAFT", "SUBMITTED", "REVISION_REQUESTED")
    }


# ---------------------------------------------------------------------------
# The approved record: the whole thing, statewide
# ---------------------------------------------------------------------------


class TestTheApprovedRecordIsReadable:
    def test_the_assessment(self, client_db, tokens, approved):
        resp = client_db.get(f"/assessments/{approved['assessment_id']}", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["assessment"]["state"] == "APPROVED"

    def test_the_assessment_through_its_incident(self, client_db, tokens, approved):
        resp = client_db.get(
            f"/incidents/{approved['incident_id']}/assessment", headers=_auth(tokens["viewer"])
        )
        assert resp.status_code == 200, resp.text
        assert int(resp.json()["assessment"]["id"]) == approved["assessment_id"]

    def test_the_incident(self, client_db, tokens, approved):
        resp = client_db.get(f"/incidents/{approved['incident_id']}", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text
        assert int(resp.json()["incident"]["id"]) == approved["incident_id"]

    def test_the_incident_list_and_the_mission_center_list(self, client_db, tokens, approved):
        for path in ("/incidents", "/mission-center/incidents"):
            resp = client_db.get(path, headers=_auth(tokens["viewer"]))
            assert resp.status_code == 200, f"{path}: {resp.text}"
            listed = {int(item["id"]) for item in resp.json()["items"]}
            assert approved["incident_id"] in listed, f"{path} hid an approved incident"

    def test_the_submission(self, client_db, tokens, approved):
        resp = client_db.get(f"/submissions/{approved['submission_id']}", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text

    def test_the_submission_list(self, client_db, tokens, approved):
        resp = client_db.get("/submissions", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text
        assert approved["submission_id"] in {int(item["id"]) for item in resp.json()["items"]}

    def test_the_photo(self, client_db, tokens, approved):
        # Owner decision 4 says "photos", and §4.5 reads that as the FILES. The
        # file endpoints carry no assessment context of their own, so the walk
        # attachment -> link -> submission -> assessment -> state happens in
        # public_visibility. Note the is_admin/is_operational short-circuit in
        # these handlers does NOT fire for a viewer, so the predicate is reached.
        for path in (
            f"/attachments/{approved['attachment_id']}/download-url",
            f"/photos/{approved['attachment_id']}/download",
        ):
            resp = client_db.get(path, headers=_auth(tokens["viewer"]))
            assert resp.status_code == 200, f"{path}: {resp.text}"

    def test_the_classification(self, client_db, tokens, approved):
        # Without this the viewer's only page cannot load: the incidents page
        # fires this query unconditionally alongside the assessments call.
        single = client_db.get(
            f"/incidents/{approved['incident_id']}/classification", headers=_auth(tokens["viewer"])
        )
        assert single.status_code == 200, single.text
        batch = client_db.post(
            "/incident-classifications/query",
            json={"incident_ids": [approved["incident_id"]]},
            headers=_auth(tokens["viewer"]),
        )
        assert batch.status_code == 200, batch.text
        assert [int(item["incident_id"]) for item in batch.json()["items"]] == [approved["incident_id"]]

    def test_the_workflow_tree(self, client_db, tokens, approved):
        resp = client_db.get(
            f"/incidents/{approved['incident_id']}/workflow-tree", headers=_auth(tokens["viewer"])
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["nodes"]

    def test_the_assessment_list(self, client_db, tokens, approved):
        resp = client_db.get("/assessments", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text
        states = {item["state"] for item in resp.json()["items"]}
        assert states <= {"APPROVED", "FINALIZED"}, f"a viewer was handed in-flight work: {states}"
        assert approved["assessment_id"] in {int(item["id"]) for item in resp.json()["items"]}

    def test_the_supporting_reads_the_page_needs(self, client_db, tokens):
        # Neither grants a record: a base-map config and a static label
        # dictionary. Without them the viewer's record renders raw codes on a
        # blank canvas.
        for path in ("/arcgis/runtime-config", "/gisa/lookups", "/auth/me"):
            assert client_db.get(path, headers=_auth(tokens["viewer"])).status_code == 200, path

    def test_the_site_timeline_is_filtered_rather_than_simply_opened(
        self, client_db, tokens, approved, in_flight
    ):
        # The one endpoint in the allow table whose ROW SET had to be narrowed
        # rather than its role list widened: it returns EVERY incident at a site,
        # approved or not, so adding the viewer to the guard alone would hand
        # them exactly the in-flight work the incident list hides.
        _exec(
            """
            INSERT INTO incident_locations (display_name, district, county, route, post_mile_raw, latitude, longitude)
            VALUES (:name, '04', 'Marin', '1', '10.0', 38.0, -122.5)
            """,
            {"name": f"Viewer timeline site {_RUN}"},
        )
        location_id = int(
            _rows(
                "SELECT id FROM incident_locations WHERE display_name = :n", {"n": f"Viewer timeline site {_RUN}"}
            )[0]["id"]
        )
        hidden_id = in_flight["SUBMITTED"]["incident_id"]
        try:
            _exec(
                "UPDATE incidents SET location_id = :lid WHERE id IN (:a, :b)",
                {"lid": location_id, "a": approved["incident_id"], "b": hidden_id},
            )
            resp = client_db.get(
                f"/incident-locations/{location_id}/timeline", headers=_auth(tokens["viewer"])
            )
            assert resp.status_code == 200, resp.text
            listed = {int(item["id"]) for item in resp.json()["incidents"]}
            assert approved["incident_id"] in listed
            assert hidden_id not in listed, "the site history leaked an in-flight incident"
            # An operational reader still sees the whole site history.
            full = client_db.get(
                f"/incident-locations/{location_id}/timeline", headers=_auth(tokens["officechief"])
            )
            assert full.status_code == 200, full.text
            assert hidden_id in {int(item["id"]) for item in full.json()["incidents"]}
        finally:
            _exec(
                "UPDATE incidents SET location_id = NULL WHERE id IN (:a, :b)",
                {"a": approved["incident_id"], "b": hidden_id},
            )
            _exec("DELETE FROM incident_locations WHERE id = :lid", {"lid": location_id})

    def test_the_reach_is_statewide(self, client_db, tokens, ids):
        # The viewer account has no office and no district ON PURPOSE, and their
        # reach is not narrowed by one. A district-07 record reads exactly like a
        # district-04 one.
        south = _drive(client_db, tokens, ids, to="APPROVED")
        _exec(
            "UPDATE incidents SET district = '07', office_code = 'SOUTH' WHERE id = :iid",
            {"iid": south["incident_id"]},
        )
        resp = client_db.get(f"/incidents/{south['incident_id']}", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Everything in flight: 404, not 403
# ---------------------------------------------------------------------------


class TestInFlightWorkIsInvisible:
    @pytest.mark.parametrize("state", ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"])
    def test_the_assessment_is_404(self, client_db, tokens, in_flight, state):
        case = in_flight[state]
        resp = client_db.get(f"/assessments/{case['assessment_id']}", headers=_auth(tokens["viewer"]))
        # 404, not 403: a 403 confirms the record exists and lets a viewer
        # enumerate in-flight work by probing ids.
        assert resp.status_code == 404, f"{state}: {resp.status_code} {resp.text}"

    @pytest.mark.parametrize("state", ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"])
    def test_the_incident_is_404(self, client_db, tokens, in_flight, state):
        case = in_flight[state]
        assert client_db.get(
            f"/incidents/{case['incident_id']}", headers=_auth(tokens["viewer"])
        ).status_code == 404
        assert client_db.get(
            f"/incidents/{case['incident_id']}/assessment", headers=_auth(tokens["viewer"])
        ).status_code == 404

    @pytest.mark.parametrize("state", ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"])
    def test_the_submission_is_404(self, client_db, tokens, in_flight, state):
        case = in_flight[state]
        assert client_db.get(
            f"/submissions/{case['submission_id']}", headers=_auth(tokens["viewer"])
        ).status_code == 404

    @pytest.mark.parametrize("state", ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"])
    def test_the_workflow_tree_is_404(self, client_db, tokens, in_flight, state):
        case = in_flight[state]
        assert client_db.get(
            f"/incidents/{case['incident_id']}/workflow-tree", headers=_auth(tokens["viewer"])
        ).status_code == 404

    @pytest.mark.parametrize("state", ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"])
    def test_the_classification_is_404_and_the_batch_simply_omits_it(
        self, client_db, tokens, in_flight, state
    ):
        case = in_flight[state]
        assert client_db.get(
            f"/incidents/{case['incident_id']}/classification", headers=_auth(tokens["viewer"])
        ).status_code == 404
        # The BATCH drops it instead of 404-ing the whole call: a 404 naming the
        # batch would blank the page AND tell the viewer that an id they cannot
        # see exists.
        batch = client_db.post(
            "/incident-classifications/query",
            json={"incident_ids": [case["incident_id"]]},
            headers=_auth(tokens["viewer"]),
        )
        assert batch.status_code == 200, batch.text
        assert batch.json()["items"] == []

    def test_a_mixed_batch_returns_only_the_public_half(
        self, client_db, tokens, approved, in_flight
    ):
        resp = client_db.post(
            "/incident-classifications/query",
            json={
                "incident_ids": [approved["incident_id"], in_flight["SUBMITTED"]["incident_id"]],
            },
            headers=_auth(tokens["viewer"]),
        )
        assert resp.status_code == 200, resp.text
        assert [int(item["incident_id"]) for item in resp.json()["items"]] == [approved["incident_id"]]

    def test_in_flight_work_is_absent_from_every_list(self, client_db, tokens, in_flight):
        hidden = {case["incident_id"] for case in in_flight.values()}
        for path in ("/incidents", "/mission-center/incidents"):
            listed = {
                int(item["id"])
                for item in client_db.get(path, headers=_auth(tokens["viewer"])).json()["items"]
            }
            assert not (listed & hidden), f"{path} leaked in-flight incidents"
        assessments = {
            int(item["id"])
            for item in client_db.get("/assessments", headers=_auth(tokens["viewer"])).json()["items"]
        }
        assert not (assessments & {case["assessment_id"] for case in in_flight.values()})

    def test_an_unlinked_photo_is_404(self, client_db, tokens, ids):
        # A file with no link to an approved submission is not part of any
        # approved record, so it is not readable — and the answer is 404.
        key = f"tests/viewer/orphan-{_RUN}.jpg"
        _exec(
            """
            INSERT INTO attachments
              (created_by_user_id, storage_provider, storage_bucket, storage_key,
               file_name, mime_type, file_size_bytes, sha256, uploaded_at)
            VALUES (:uid, 'MINIO', 'eris-uploads', :key, 'orphan.jpg', 'image/jpeg', 10, :sha, NOW())
            """,
            {"sha": f"f{_RUN}{'0' * (63 - len(_RUN))}", "key": key, "uid": ids["engineer"]},
        )
        attachment_id = int(_rows("SELECT id FROM attachments WHERE storage_key = :k", {"k": key})[0]["id"])
        try:
            for path in (
                f"/attachments/{attachment_id}/download-url",
                f"/photos/{attachment_id}/download",
                f"/attachments/{attachment_id}/content",
                f"/photos/{attachment_id}/content",
            ):
                resp = client_db.get(path, headers=_auth(tokens["viewer"]))
                assert resp.status_code == 404, f"{path}: {resp.status_code} {resp.text}"
        finally:
            _exec("DELETE FROM attachments WHERE id = :aid", {"aid": attachment_id})


# ---------------------------------------------------------------------------
# A viewer has no work, so they have no queue
# ---------------------------------------------------------------------------


class TestAViewerHasNoQueue:
    @pytest.mark.parametrize(
        "queue",
        ["office_chief", "office_chief_review", "branch_chief", "branch_chief_review",
         "assignee", "engineer", "reviewer"],
    )
    def test_every_queue_value_is_400(self, client_db, tokens, queue):
        resp = client_db.get(f"/assessments?queue={queue}", headers=_auth(tokens["viewer"]))
        # 400, not 403: the parameter is MEANINGLESS for this account, not
        # forbidden for this record.
        assert resp.status_code == 400, f"{queue}: {resp.status_code} {resp.text}"
        assert resp.json()["detail"] == "Viewers have no work queue"

    def test_the_refusal_comes_before_any_other_filter(self, client_db, tokens):
        resp = client_db.get(
            "/assessments?queue=branch_chief&state=APPROVED&office_code=WEST",
            headers=_auth(tokens["viewer"]),
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "Viewers have no work queue"

    def test_asking_for_a_non_public_state_returns_nothing_rather_than_the_rows(
        self, client_db, tokens, in_flight
    ):
        resp = client_db.get("/assessments?state=SUBMITTED", headers=_auth(tokens["viewer"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["items"] == []


# ---------------------------------------------------------------------------
# A viewer is never a notification recipient
# ---------------------------------------------------------------------------


class TestAViewerIsNeverNotified:
    def test_no_recipient_list_ever_names_them(self, client_db, tokens, ids, approved):
        """Even with an office and a district recorded, and for every list.

        The mechanism, written down so a later recipient query cannot quietly
        break it: every recipient list resolves through ``_routing_users_for``,
        whose candidate roles come from ``_ROUTING_ROLE_NAMES`` — coordinator,
        office chief, branch chief, senior engineer — and none of them is the
        viewer. ``_approval_coordinator_recipients`` adds only the triaging
        coordinator's own id.
        """
        from app.db import engine
        from app.routes import assessments as assessments_routes
        from app.routes import incidents as incidents_routes

        viewer_id = ids["viewer"]
        offices = client_db.get("/admin/org/offices", headers=_auth(tokens["admin"])).json()["items"]
        west_id = next(int(item["id"]) for item in offices if item["code"] == "WEST")
        try:
            placed = client_db.put(
                f"/admin/users/{viewer_id}/org",
                json={"office_id": west_id, "home_district": "04"},
                headers=_auth(tokens["admin"]),
            )
            assert placed.status_code == 200, placed.text
            with engine.connect() as conn:
                for assignment_type, kwargs in (
                    ("DISTRICT_COORDINATOR", {"district": "04"}),
                    ("OFFICE_CHIEF", {"office_code": "WEST"}),
                    ("BRANCH_CHIEF", {"office_code": "WEST"}),
                    ("SENIOR_ENGINEER", {"office_code": "WEST"}),
                ):
                    recipients = incidents_routes._routing_users_for(
                        db=conn, assignment_type=assignment_type, **kwargs
                    )
                    assert viewer_id not in recipients, f"the viewer is a {assignment_type} recipient"
                coordinators = assessments_routes._approval_coordinator_recipients(
                    conn, approved["incident_id"]
                )
                assert viewer_id not in coordinators
        finally:
            client_db.put(
                f"/admin/users/{viewer_id}/org",
                json={"office_id": None, "home_district": None},
                headers=_auth(tokens["admin"]),
            )

    def test_no_notification_row_was_ever_addressed_to_them(self, client_db, ids, approved):
        rows = _rows(
            "SELECT COUNT(*) AS n FROM incident_notifications WHERE recipient_user_id = :uid",
            {"uid": ids["viewer"]},
        )
        assert int(rows[0]["n"]) == 0


# ---------------------------------------------------------------------------
# A chief who is ALSO a viewer keeps being a chief
# ---------------------------------------------------------------------------


class TestViewerCombinesRatherThanNarrows:
    @pytest.fixture(scope="class")
    def chief_plus_viewer(self, client_db, tokens):
        email = f"viewer-and-chief-{_RUN}@example.test"
        created = client_db.post(
            "/admin/users",
            json={
                "email": email,
                "full_name": f"Zzz Chief And Viewer {_RUN}",
                "password": "org-model-test-password",
                "roles": ["GEOTECH_OFFICE_CHIEF", "CALTRANS_VIEWER"],
                "metadata": {"office_code": "WEST", "office_location": "West Office"},
            },
            headers=_auth(tokens["admin"]),
        )
        assert created.status_code == 201, created.text
        user_id = int(created.json()["id"])
        yield {"id": user_id, "token": _login(client_db, email, "org-model-test-password")}
        client_db.patch(
            f"/admin/users/{user_id}", json={"is_active": False}, headers=_auth(tokens["admin"])
        )
        # The grant goes too: viewer@local is meant to be the only account
        # holding CALTRANS_VIEWER, and test_seed_shape_db.py says so.
        _exec("DELETE FROM user_roles WHERE user_id = :uid", {"uid": user_id})

    def test_they_still_read_work_in_flight(self, client_db, chief_plus_viewer, in_flight):
        # require_roles is a union and the most permissive role wins. The
        # narrowing predicate fires only when Viewer is the account's ONLY role.
        case = in_flight["SUBMITTED"]
        resp = client_db.get(
            f"/assessments/{case['assessment_id']}", headers=_auth(chief_plus_viewer["token"])
        )
        assert resp.status_code == 200, resp.text

    def test_they_still_have_a_work_queue(self, client_db, chief_plus_viewer):
        resp = client_db.get("/assessments?queue=office_chief", headers=_auth(chief_plus_viewer["token"]))
        assert resp.status_code == 200, resp.text

    def test_they_still_reach_the_hand_off_picker(self, client_db, chief_plus_viewer, in_flight):
        resp = client_db.get(
            f"/assessments/{in_flight['SUBMITTED']['assessment_id']}/branch-options",
            headers=_auth(chief_plus_viewer["token"]),
        )
        assert resp.status_code == 200, resp.text

    def test_they_are_not_stopped_by_the_public_only_refusal(self, client_db, chief_plus_viewer):
        # deny_public_only is the explicit half of the gate, and it must fire for
        # a viewer-ONLY account and nobody else.
        resp = client_db.get("/geo/enrich-point?lat=38.0&lon=-122.5", headers=_auth(chief_plus_viewer["token"]))
        assert resp.status_code != 403, resp.text


# ---------------------------------------------------------------------------
# The deny list, route by route — driven by the live route table
# ---------------------------------------------------------------------------


def _names_the_viewer(route: APIRoute) -> bool:
    """True when the route's own ``require_roles`` list admits CALTRANS_VIEWER.

    Design §4.5's allow table has two halves and this is the second one: these
    routes DO carry a role list, the viewer's name is in it, and the row set is
    narrowed in the handler. The first half — the routes with no role list at
    all — is ``VIEWER_READABLE_ROUTES``.
    """
    stack = list(route.dependant.dependencies)
    while stack:
        dependency = stack.pop()
        for cell in getattr(dependency.call, "__closure__", None) or ():
            contents = cell.cell_contents
            if isinstance(contents, (list, set, tuple)) and "CALTRANS_VIEWER" in {
                str(value) for value in contents
            }:
                return True
        stack.extend(dependency.dependencies)
    return False


def _mounted_routes() -> list[tuple[str, str]]:
    from unittest.mock import patch

    with patch("app.main.check_migration_head"):
        from app.main import app
    out: list[tuple[str, str]] = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if _names_the_viewer(route):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            if (method, route.path) in VIEWER_READABLE_ROUTES:
                continue
            out.append((method, route.path))
    return sorted(set(out))


DENIED_ROUTES = _mounted_routes()


def _fill(path: str, ids: dict[str, object]) -> str:
    filled = path
    for name, value in ids.items():
        filled = filled.replace("{" + name + "}", str(value))
    while "{" in filled:
        start = filled.index("{")
        end = filled.index("}", start)
        filled = filled[:start] + "1" + filled[end + 1 :]
    return filled


class TestEveryDeniedRouteRefusesAViewer:
    """One assertion per route, and the route list comes from the app itself.

    This is the check that makes "fail closed" a fact rather than a claim: a new
    endpoint added tomorrow is refused by default, and the only way to make it
    readable is to put it on the reviewed allow list — which is a code review,
    not an oversight. A route that answers anything other than 403 here is either
    a hole or an allow-list entry somebody forgot to write down.
    """

    @pytest.fixture(scope="class")
    def path_ids(self, approved, ids):
        return {
            "submission_id": approved["submission_id"],
            "assessment_id": approved["assessment_id"],
            "incident_id": approved["incident_id"],
            "attachment_id": approved["attachment_id"],
            "photo_id": approved["attachment_id"],
            "user_id": ids["viewer"],
        }

    @pytest.mark.parametrize("method,path", DENIED_ROUTES, ids=lambda value: str(value))
    def test_the_viewer_is_refused(self, client_db, tokens, path_ids, method, path):
        url = _fill(path, path_ids)
        call = getattr(client_db, method.lower())
        kwargs = {"headers": _auth(tokens["viewer"])}
        if method in {"POST", "PUT", "PATCH"}:
            kwargs["json"] = {}
        resp = call(url, **kwargs)
        assert resp.status_code == 403, (
            f"{method} {path} answered {resp.status_code} to a read-only viewer. Guard it with "
            "require_roles or deps.deny_public_only, or add it to "
            f"services/public_visibility.VIEWER_READABLE_ROUTES with its predicate. {resp.text[:200]}"
        )

    def test_the_deny_list_is_most_of_the_application(self):
        # A filling bug that produced an empty list would make the parametrized
        # test above vacuous.
        assert len(DENIED_ROUTES) > 100
