"""Where one person sits, and what their classification may and may not do (W21).

Two rules are load-bearing here, and both are easy to break by accident.

**THE PROPOSAL RULE.** ``PUT /admin/users/{id}/org`` returns a
``role_suggestion`` and NEVER writes ``user_roles``. The charts themselves are
the argument: the NORTH office chief position is vacant and filled out of class,
and a SOUTH senior specialist is OOC-covered for eight months, so an admin must
be able to grant a role that contradicts a stored classification. A save that
"helpfully" granted GEOTECH_BRANCH_CHIEF because the classification said 3161
(Sup) would be an authority change made by a form field. The test therefore
compares the account's role rows byte for byte across the save.

**THE CUTOVER WRITE-THROUGH.** For one release the legacy
``PATCH /admin/users/{id}`` still accepts ``metadata.office_code`` and writes it
THROUGH to ``org_user_profiles`` in the same transaction, resolving the code
against ``org_offices`` and answering 422 if it names no office. Split across
releases — readers moved, this writer not — that gap is exactly the "chief moved
here alone and lost their review queue" window.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _rows(statement: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(statement), params or {}).mappings().all()]


def _role_rows(user_id: int) -> list[dict]:
    """The account's role grants, exactly as stored: ids and all."""
    return _rows(
        "SELECT user_id, role_id FROM user_roles WHERE user_id = :uid ORDER BY role_id",
        {"uid": int(user_id)},
    )


@pytest.fixture(scope="module")
def offices(client_db, admin_token):
    resp = client_db.get("/admin/org/offices", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    return {item["code"]: item for item in resp.json()["items"]}


@pytest.fixture(scope="module")
def staff_user(client_db, admin_token):
    """An account holding Staff and nothing else, deactivated on teardown."""
    email = f"orgadmin-staff-{_RUN}@example.test"
    created = client_db.post(
        "/admin/users",
        json={
            "email": email,
            "full_name": f"Zzz Org Model Staff {_RUN}",
            "password": "org-model-test-password",
            "roles": ["GEOTECH_ENGINEER"],
            "metadata": {"office_code": "WEST", "office_location": "West Office"},
        },
        headers=_auth(admin_token),
    )
    assert created.status_code == 201, created.text
    user_id = int(created.json()["id"])
    yield {"id": user_id, "email": email}
    client_db.patch(f"/admin/users/{user_id}", json={"is_active": False}, headers=_auth(admin_token))


# ---------------------------------------------------------------------------
# The proposal rule
# ---------------------------------------------------------------------------


class TestClassificationSuggestsAndNeverGrants:
    def test_saving_a_supervisor_classification_on_a_staff_account_grants_nothing(
        self, client_db, admin_token, staff_user, offices
    ):
        user_id = staff_user["id"]
        before = _role_rows(user_id)
        assert before, "the fixture account must hold Staff for this test to mean anything"

        resp = client_db.put(
            f"/admin/users/{user_id}/org",
            json={
                "office_id": int(offices["WEST"]["id"]),
                "classification_code": "3161",
                "classification_marker": "SUP",
                "position_number": f"559-315-3161-{_RUN[:3]}",
                "job_title": "Senior TE (Sup)",
                "level_code": "S09",
            },
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        suggestion = resp.json()["role_suggestion"]
        assert suggestion["suggested_role"] == "GEOTECH_BRANCH_CHIEF"
        assert suggestion["matches_granted"] is False
        assert suggestion["rule_kind"] == "CLASS"
        # The whole point of matches_granted: the admin UI renders
        # "Classification 3161 (Sup) suggests Branch Chief — this account holds
        # Staff" and a human decides.
        assert "GEOTECH_ENGINEER" in suggestion["granted_roles"]

        # BYTE-IDENTICAL. Not "still has Staff" — nothing was added, removed or
        # re-keyed.
        assert _role_rows(user_id) == before

    def test_the_classification_itself_was_stored(self, client_db, admin_token, staff_user):
        resp = client_db.get(f"/admin/users/{staff_user['id']}/org", headers=_auth(admin_token))
        assert resp.status_code == 200, resp.text
        org = resp.json()["org"]
        assert org["classification_code"] == "3161"
        assert org["classification_marker"] == "SUP"
        assert org["job_title"] == "Senior TE (Sup)"
        assert org["source"] == "MANUAL"
        # ...and reading it back suggests the same thing it suggested on save.
        assert resp.json()["role_suggestion"]["suggested_role"] == "GEOTECH_BRANCH_CHIEF"
        assert resp.json()["role_suggestion"]["matches_granted"] is False

    @pytest.mark.parametrize("typed", ["(Sup)", "sup", " SUP "])
    def test_a_parenthesised_marker_is_stored_normalized(
        self, client_db, admin_token, staff_user, typed
    ):
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"classification_marker": typed, "classification_code": "3161"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["org"]["classification_marker"] == "SUP"
        assert resp.json()["role_suggestion"]["suggested_role"] == "GEOTECH_BRANCH_CHIEF"

    def test_the_marker_is_read_out_of_the_job_title_when_the_field_is_empty(
        self, client_db, admin_token, staff_user
    ):
        # "Sr TE/Sr EG (SUP" is what one chart actually prints — no closing
        # parenthesis — and it is a TITLE, not a marker (the marker column holds
        # eight characters). An SSO sync or a transcription that carries only the
        # printed title must still resolve.
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={
                "classification_code": "3161",
                "classification_marker": None,
                "job_title": "Sr TE/Sr EG (SUP",
            },
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["org"]["classification_marker"] is None
        assert resp.json()["role_suggestion"]["suggested_role"] == "GEOTECH_BRANCH_CHIEF"

    def test_matches_granted_is_true_when_the_account_holds_the_suggested_role(
        self, client_db, admin_token
    ):
        # branchchief@local holds the LEGACY name BRANCH_CHIEF. The comparison
        # goes through ROLE_ALIASES, so a legacy grant satisfies a canonical
        # suggestion — otherwise every pre-org-model account would read as
        # "does not match" forever.
        user_id = int(
            _rows("SELECT id FROM users WHERE email = 'branchchief@local'")[0]["id"]
        )
        before = _role_rows(user_id)
        current = client_db.get(f"/admin/users/{user_id}/org", headers=_auth(admin_token)).json()["org"]
        try:
            resp = client_db.put(
                f"/admin/users/{user_id}/org",
                json={"classification_code": "3751", "classification_marker": "SUP"},
                headers=_auth(admin_token),
            )
            assert resp.status_code == 200, resp.text
            suggestion = resp.json()["role_suggestion"]
            assert suggestion["suggested_role"] == "GEOTECH_BRANCH_CHIEF"
            assert suggestion["matches_granted"] is True
            assert _role_rows(user_id) == before
        finally:
            client_db.put(
                f"/admin/users/{user_id}/org",
                json={
                    "classification_code": current.get("classification_code"),
                    "classification_marker": current.get("classification_marker"),
                },
                headers=_auth(admin_token),
            )

    def test_an_undecided_classification_suggests_nothing_and_says_why(
        self, client_db, admin_token, staff_user
    ):
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"classification_code": "5758", "classification_marker": None, "level_code": "R11"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        suggestion = resp.json()["role_suggestion"]
        assert suggestion["suggested_role"] is None
        assert suggestion["matches_granted"] is False
        assert "TET to RDS II" in (suggestion["notes"] or "")

    def test_a_classification_nobody_has_a_rule_for_returns_no_suggestion(
        self, client_db, admin_token, staff_user
    ):
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"classification_code": "0000", "classification_marker": None, "job_title": "Groundskeeper"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["role_suggestion"] is None


# ---------------------------------------------------------------------------
# The membership record itself
# ---------------------------------------------------------------------------


class TestUserOrgRecord:
    def test_omitted_fields_are_untouched(self, client_db, admin_token, staff_user, offices):
        user_id = staff_user["id"]
        client_db.put(
            f"/admin/users/{user_id}/org",
            json={
                "office_id": int(offices["WEST"]["id"]),
                "home_city": "Orinda",
                "home_district": "04",
                "job_title": "Transportation Engineer, Civil",
            },
            headers=_auth(admin_token),
        )
        # A PER-FIELD MERGE: an admin editing the city must not silently clear a
        # classification somebody else recorded.
        resp = client_db.put(
            f"/admin/users/{user_id}/org", json={"home_city": "Oakland"}, headers=_auth(admin_token)
        )
        assert resp.status_code == 200, resp.text
        org = resp.json()["org"]
        assert org["home_city"] == "Oakland"
        assert org["home_district"] == "04"
        assert org["job_title"] == "Transportation Engineer, Civil"

    def test_a_branch_from_another_office_is_422(self, client_db, admin_token, staff_user, offices):
        south_branch = _rows(
            """
            SELECT b.id FROM org_branches b JOIN org_offices o ON o.id = b.office_id
             WHERE o.code = 'SOUTH' AND b.letter = 'A' LIMIT 1
            """
        )[0]["id"]
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"office_id": int(offices["WEST"]["id"]), "branch_id": int(south_branch)},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 422, resp.text
        assert "different office" in resp.json()["detail"]

    def test_the_metadata_mirror_is_re_rendered_from_the_profile(
        self, client_db, admin_token, staff_user, offices
    ):
        # Both are written in ONE transaction, because for one release both are
        # read. A profile that moved without its mirror is the "chief loses their
        # queue" window.
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"office_id": int(offices["SOUTH"]["id"]), "home_district": "07"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        mirrored = _rows(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.office_code')) AS office_code, "
            "JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.district')) AS district "
            "FROM users WHERE id = :uid",
            {"uid": staff_user["id"]},
        )[0]
        assert mirrored["office_code"] == "SOUTH"
        assert mirrored["district"] == "07"
        # The free display text an admin typed is preserved, not recomputed: this
        # function does not own that field.
        location = _rows(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.office_location')) AS office_location "
            "FROM users WHERE id = :uid",
            {"uid": staff_user["id"]},
        )[0]["office_location"]
        assert location == "West Office"

    def test_availability_is_recorded_with_its_dates(self, client_db, admin_token, staff_user):
        resp = client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"availability": "ROTATION_OUT", "available_until": "2027-02-05"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["org"]["availability"] == "ROTATION_OUT"
        assert str(resp.json()["org"]["available_until"]).startswith("2027-02-05")

    def test_an_unknown_office_or_branch_is_422_and_an_unknown_user_is_404(
        self, client_db, admin_token, staff_user
    ):
        assert client_db.put(
            f"/admin/users/{staff_user['id']}/org", json={"office_id": 99999999}, headers=_auth(admin_token)
        ).status_code == 422
        assert client_db.put(
            f"/admin/users/{staff_user['id']}/org", json={"branch_id": 99999999}, headers=_auth(admin_token)
        ).status_code == 422
        assert client_db.put(
            "/admin/users/99999999/org", json={"home_city": "Oakland"}, headers=_auth(admin_token)
        ).status_code == 404

    def test_only_admins_may_read_or_write_an_org_record(self, client_db, staff_user):
        for email in ("officechief@local", "engineer@local"):
            token = client_db.post(
                "/auth/login", json={"email": email, "password": "password"}
            ).json()["access_token"]
            assert client_db.get(
                f"/admin/users/{staff_user['id']}/org", headers=_auth(token)
            ).status_code == 403
            assert client_db.put(
                f"/admin/users/{staff_user['id']}/org",
                json={"home_city": "Oakland"},
                headers=_auth(token),
            ).status_code == 403


# ---------------------------------------------------------------------------
# The cutover write-through on the legacy PATCH
# ---------------------------------------------------------------------------


class TestLegacyPatchWritesThrough:
    def test_an_office_code_moves_the_profile_row_too(self, client_db, admin_token, staff_user, offices):
        user_id = staff_user["id"]
        resp = client_db.patch(
            f"/admin/users/{user_id}",
            json={"metadata": {"office_code": "NORTH", "district": "03", "office_location": "Translab"}},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        # The profile row — the thing every reader now resolves through — moved.
        row = _rows(
            """
            SELECT o.code, p.home_district FROM org_user_profiles p
              LEFT JOIN org_offices o ON o.id = p.office_id
             WHERE p.user_id = :uid
            """,
            {"uid": user_id},
        )[0]
        assert row["code"] == "NORTH"
        assert str(row["home_district"]).strip() == "03"
        # ...and the org endpoint agrees, which is the check that matters: two
        # readers of one fact must never disagree.
        org = client_db.get(f"/admin/users/{user_id}/org", headers=_auth(admin_token)).json()["org"]
        assert org["office_code"] == "NORTH"
        assert org["office_id"] == int(offices["NORTH"]["id"])

    def test_clearing_the_office_code_clears_the_profile_office(self, client_db, admin_token, staff_user):
        resp = client_db.patch(
            f"/admin/users/{staff_user['id']}",
            json={"metadata": {"office_code": None, "district": None, "office_location": None}},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        org = client_db.get(f"/admin/users/{staff_user['id']}/org", headers=_auth(admin_token)).json()["org"]
        assert org["office_id"] is None
        assert org["office_code"] is None

    def test_a_code_that_resolves_to_no_office_is_422(self, client_db, admin_token, staff_user):
        # office_code is free text today — the admin form is an <input list=…>
        # over a datalist — so "WEST GEOTECH" and "W" are realistic values. A code
        # that resolves to nothing is never stored: it would misroute a queue
        # silently, and it is the same value the migration refuses to guess at.
        before = _rows(
            "SELECT metadata_json FROM users WHERE id = :uid", {"uid": staff_user["id"]}
        )[0]["metadata_json"]
        resp = client_db.patch(
            f"/admin/users/{staff_user['id']}",
            json={"metadata": {"office_code": "WEST GEOTECH", "district": "04"}},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 422, resp.text
        detail = resp.json()["detail"]
        assert "WEST GEOTECH" in detail
        assert "/admin/users/{id}/org" in detail
        # Nothing was written — neither the blob nor the profile row.
        after = _rows("SELECT metadata_json FROM users WHERE id = :uid", {"uid": staff_user["id"]})[0]
        assert after["metadata_json"] == before
        org = client_db.get(f"/admin/users/{staff_user['id']}/org", headers=_auth(admin_token)).json()["org"]
        assert org["office_code"] is None

    def test_a_patch_without_metadata_leaves_the_org_record_alone(
        self, client_db, admin_token, staff_user, offices
    ):
        client_db.put(
            f"/admin/users/{staff_user['id']}/org",
            json={"office_id": int(offices["WEST"]["id"]), "home_city": "Oakland"},
            headers=_auth(admin_token),
        )
        resp = client_db.patch(
            f"/admin/users/{staff_user['id']}",
            json={"full_name": f"Renamed {_RUN}"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        org = client_db.get(f"/admin/users/{staff_user['id']}/org", headers=_auth(admin_token)).json()["org"]
        assert org["office_code"] == "WEST"
        assert org["home_city"] == "Oakland"


# ---------------------------------------------------------------------------
# Coordinator coverage, and the endpoint it replaced
# ---------------------------------------------------------------------------


class TestCoordinatorCoverage:
    def test_a_coordinator_may_cover_several_districts(self, client_db, admin_token, staff_user):
        # The model's answer to open question 10: several. It changes every
        # coordinator notification query, so it is a row per district rather
        # than one district on the person.
        user_id = staff_user["id"]
        created = []
        try:
            for district in ("77", "78"):
                resp = client_db.post(
                    "/admin/org/coverage",
                    json={"district": district, "user_id": user_id, "is_primary": district == "77"},
                    headers=_auth(admin_token),
                )
                assert resp.status_code == 201, resp.text
                created.append(int(resp.json()["coverage"]["id"]))
            listed = client_db.get("/admin/org/coverage", headers=_auth(admin_token))
            assert listed.status_code == 200, listed.text
            mine = {
                item["district"]: person
                for item in listed.json()["items"]
                for person in item["users"]
                if int(person["id"]) == user_id
            }
            assert set(mine) == {"77", "78"}
            assert mine["77"]["is_primary"] is True
            assert mine["78"]["is_primary"] is False
            # The endpoint's real job: naming the districts nobody covers, which
            # is otherwise invisible until someone asks why nobody was told.
            assert "uncovered_districts" in listed.json()

            # Removing coverage deactivates the row: it is who was told, and when.
            removed = client_db.delete(
                f"/admin/org/coverage/{created[0]}", headers=_auth(admin_token)
            )
            assert removed.status_code == 204, removed.text
            assert _rows(
                "SELECT is_active FROM org_coordinator_coverage WHERE id = :cid", {"cid": created[0]}
            )[0]["is_active"] == 0
        finally:
            from app.db import engine

            with engine.begin() as conn:
                conn.execute(
                    text("DELETE FROM org_coordinator_coverage WHERE user_id = :uid"), {"uid": user_id}
                )

    def test_coverage_for_a_user_that_does_not_exist_is_404(self, client_db, admin_token):
        resp = client_db.post(
            "/admin/org/coverage",
            json={"district": "77", "user_id": 99999999},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 404, resp.text

    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/incidents/routing/assignments"),
            ("post", "/incidents/routing/assignments"),
            ("delete", "/incidents/routing/assignments/1"),
        ],
    )
    def test_the_old_routing_assignment_endpoints_are_410_with_a_forwarding_address(
        self, client_db, admin_token, method, path
    ):
        # Retired, not deleted: an old client gets an explanation and the table
        # keeps its rows as history.
        call = getattr(client_db, method)
        kwargs = {"headers": _auth(admin_token)}
        if method == "post":
            kwargs["json"] = {}
        resp = call(path, **kwargs)
        assert resp.status_code == 410, resp.text
        assert "/admin/org/coverage" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# The rules table, as an admin surface
# ---------------------------------------------------------------------------


class TestClassificationAdmin:
    def test_the_rules_are_listed_in_resolution_order(self, client_db, admin_token):
        resp = client_db.get("/admin/org/classifications", headers=_auth(admin_token))
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        assert len(items) == 16
        priorities = [int(item["priority"]) for item in items]
        assert priorities == sorted(priorities)

    def test_a_rule_can_be_decided_later_without_a_release(self, client_db, admin_token):
        # Class 5758's eris_role is NULL pending the owner's answer. The point of
        # storing the rules as DATA is that the answer is an admin edit.
        rule = next(
            item
            for item in client_db.get("/admin/org/classifications", headers=_auth(admin_token)).json()["items"]
            if item["class_code"] == "5758"
        )
        try:
            resp = client_db.put(
                f"/admin/org/classifications/{rule['id']}",
                json={"eris_role": "GEOTECH_ENGINEER"},
                headers=_auth(admin_token),
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["classification"]["eris_role"] == "GEOTECH_ENGINEER"
        finally:
            client_db.put(
                f"/admin/org/classifications/{rule['id']}",
                json={"eris_role": None},
                headers=_auth(admin_token),
            )
        restored = next(
            item
            for item in client_db.get("/admin/org/classifications", headers=_auth(admin_token)).json()["items"]
            if item["class_code"] == "5758"
        )
        assert restored["eris_role"] is None
