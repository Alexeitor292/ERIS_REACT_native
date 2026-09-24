"""The organization as an editable surface: offices, branches, districts (W18).

Owner decision 8 makes flexibility a goal in itself — nothing organizational is
hard-coded, roles are never bound to named people, and deactivating or renaming a
unit must not break history. That is easy to say and has four sharp edges, which
are what this module tests:

* **The office code is immutable.** ``assessments.office_code`` and
  ``incidents.office_code`` join on it as a string, so a rename would silently
  re-point — or orphan — every historical record. ``PATCH`` answers 422 with that
  reason rather than accepting the field or dropping it quietly.
* **One district, one active office OF A GIVEN TYPE.** The database enforces it
  through a generated unique key; the API catches the collision first and answers
  409 NAMING the other office, because "Duplicate entry 'GEOTECH:04'" is not an
  answer an admin can act on. A MAINTENANCE office covering district 04 while
  WEST also covers it is legal — that is what scoping the key to ``org_type``
  buys.
* **Two letterless yard units in one office both insert.** Owner decision 3
  says the maintenance hierarchy must fit this schema without a change, and a
  yard has no letter. A single uniqueness key over ``(office_id, letter)`` would
  produce ``'<office_id>:'`` for every letterless unit and make the second yard
  un-insertable. Two active ``Branch D`` rows in one office still must not.
* **Deactivating a branch changes no history.** It disappears from every picker
  and the assessments routed through it keep the branch NAME they froze.

Every row this module creates is removed in teardown, so the seed-shape counts in
test_seed_shape_db.py stay true.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import uuid

import pytest

from tests.org_people import People
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6].upper()

# Every office this module creates carries this prefix, and teardown deletes by
# it. Test districts are 77/78/79 — valid CHAR(2) values that no real Caltrans
# district uses, so a stray row can never shadow WEST, NORTH or SOUTH.
_CODE_PREFIX = "ZZT"
_TEST_DISTRICTS = ("77", "78", "79")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _exec(statement: str, params: dict | None = None):
    from app.db import engine

    with engine.begin() as conn:
        return conn.execute(text(statement), params or {})


def _rows(statement: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(statement), params or {}).mappings().all()]


_PEOPLE: list = []


def _chief(client_db, admin_token) -> int:
    """A fresh account to lead a test office or branch (they never exist without one)."""
    if not _PEOPLE:
        _PEOPLE.append(People(client_db, admin_token, prefix="Zzz Org API"))
    return _PEOPLE[0].account(f"chief-{uuid.uuid4().hex[:6]}")["id"]


@pytest.fixture(scope="module", autouse=True)
def cleanup_test_org_rows(client_db):
    """Remove every row this module created, however it ended.

    The API deactivates and never deletes — correct for production, and exactly
    why a test module has to clean up after itself with SQL. Children first:
    org_branches -> org_offices is ON DELETE RESTRICT.
    """
    yield
    for people in _PEOPLE:
        people.cleanup()
    _exec(
        "UPDATE org_user_profiles SET office_id = NULL, branch_id = NULL, tree_position = NULL WHERE office_id IN "
        "(SELECT id FROM org_offices WHERE code LIKE :prefix)",
        {"prefix": f"{_CODE_PREFIX}%"},
    )
    _exec(
        "DELETE FROM org_branches WHERE office_id IN "
        "(SELECT id FROM org_offices WHERE code LIKE :prefix)",
        {"prefix": f"{_CODE_PREFIX}%"},
    )
    _exec("DELETE FROM org_offices WHERE code LIKE :prefix", {"prefix": f"{_CODE_PREFIX}%"})
    districts = ", ".join(f"'{d}'" for d in _TEST_DISTRICTS)
    _exec(f"DELETE FROM org_office_districts WHERE district IN ({districts})")
    _exec(f"DELETE FROM geotech_office_routing WHERE district IN ({districts})")


def _create_office(client_db, admin_token, *, suffix: str, org_type: str = "GEOTECH", **overrides):
    payload = {
        "code": f"{_CODE_PREFIX}{suffix}{_RUN}"[:16],
        "org_type": org_type,
        "name": f"Test office {suffix} {_RUN}",
        "short_name": f"Test {suffix}",
        "home_city": "Oakland",
        "home_district": "77",
        "is_routing_target": True,
        "sort_order": 900,
    }
    if org_type == "GEOTECH":
        payload["chief_user_id"] = _chief(client_db, admin_token)
    payload.update(overrides)
    resp = client_db.post("/admin/org/offices", json=payload, headers=_auth(admin_token))
    assert resp.status_code == 201, resp.text
    return resp.json()["office"]


def _create_branch(client_db, admin_token, office_id: int, **overrides):
    payload = {"office_id": office_id, "unit_type": "BRANCH", "letter": "A", "name": "Branch A"}
    if overrides.get("unit_type", "BRANCH") == "BRANCH":
        payload["chief_user_id"] = _chief(client_db, admin_token)
    payload.update(overrides)
    return client_db.post("/admin/org/branches", json=payload, headers=_auth(admin_token))


# ---------------------------------------------------------------------------
# Offices
# ---------------------------------------------------------------------------


class TestOfficeCrud:
    def test_create_read_patch_deactivate(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="A")
        office_id = int(office["id"])
        assert office["is_active"] is True
        assert office["is_routing_target"] is True

        listed = client_db.get("/admin/org/offices", headers=_auth(admin_token))
        assert listed.status_code == 200, listed.text
        assert office_id in [int(item["id"]) for item in listed.json()["items"]]

        # Per-field merge: the omitted fields are untouched, not cleared.
        patched = client_db.patch(
            f"/admin/org/offices/{office_id}",
            json={"name": f"Renamed {_RUN}"},
            headers=_auth(admin_token),
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["office"]["name"] == f"Renamed {_RUN}"
        assert patched.json()["office"]["short_name"] == "Test A"
        assert patched.json()["office"]["home_city"] == "Oakland"

        # Retire, never delete: the row stays and history keeps its name.
        gone = client_db.post(f"/admin/org/offices/{office_id}/deactivate", json={}, headers=_auth(admin_token))
        assert gone.status_code == 200, gone.text
        assert gone.json()["office"]["is_active"] is False
        assert gone.json()["affected_assessments"] == 0
        assert _rows("SELECT id FROM org_offices WHERE id = :oid", {"oid": office_id})

    def test_a_duplicate_code_is_409_not_a_second_office(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="B")
        resp = client_db.post(
            "/admin/org/offices",
            json={"code": office["code"], "name": "Another one"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 409, resp.text
        assert office["code"] in resp.json()["detail"]

    def test_patching_the_code_is_422_with_the_reason(self, client_db, admin_token):
        # Declared on the model ONLY so the handler can refuse it: an undeclared
        # field would be dropped silently and the admin would believe the rename
        # had happened.
        office = _create_office(client_db, admin_token, suffix="C")
        resp = client_db.patch(
            f"/admin/org/offices/{office['id']}",
            json={"code": "SOMETHINGELSE"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 422, resp.text
        detail = resp.json()["detail"]
        assert "immutable" in detail
        assert "history" in detail
        # ...and nothing moved.
        assert _rows("SELECT code FROM org_offices WHERE id = :oid", {"oid": office["id"]})[0]["code"] == office["code"]

    def test_a_code_change_smuggled_in_beside_a_legal_field_is_still_refused(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="D")
        resp = client_db.patch(
            f"/admin/org/offices/{office['id']}",
            json={"name": "New name", "code": "SNEAKY"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 422, resp.text
        row = _rows("SELECT code, name FROM org_offices WHERE id = :oid", {"oid": office["id"]})[0]
        assert row["code"] == office["code"]
        assert row["name"] != "New name", "the refusal must not half-apply the patch"

    def test_a_missing_office_is_404(self, client_db, admin_token):
        assert client_db.patch(
            "/admin/org/offices/99999999", json={"name": "x"}, headers=_auth(admin_token)
        ).status_code == 404


# ---------------------------------------------------------------------------
# Districts: one active office of a given type per district
# ---------------------------------------------------------------------------


class TestOfficeDistricts:
    def test_replacing_the_served_set(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="E")
        resp = client_db.put(
            f"/admin/org/offices/{office['id']}/districts",
            json={"districts": ["78", "77"], "primary_district": "77"},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        districts = {row["district"]: row for row in resp.json()["districts"]}
        assert set(districts) == {"77", "78"}
        assert districts["77"]["is_primary"] is True
        assert districts["78"]["is_primary"] is False

        # The legacy mirror follows, for one release, and org_directory is its
        # only writer.
        mirrored = _rows("SELECT office_code, is_active FROM geotech_office_routing WHERE district = '77'")
        assert mirrored and mirrored[0]["office_code"] == office["code"]

        # Replace, not merge: 78 stops being served when it is left out. The row
        # itself stays, badged inactive — deactivate, never delete, so a later
        # reader can still see that this office once served it.
        resp = client_db.put(
            f"/admin/org/offices/{office['id']}/districts",
            json={"districts": ["77"]},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        served = {row["district"]: row["is_active"] for row in resp.json()["districts"]}
        assert served == {"77": True, "78": False}
        # ...and the legacy mirror was switched off for the district it lost.
        assert _rows("SELECT is_active FROM geotech_office_routing WHERE district = '78'")[0]["is_active"] == 0

    def test_taking_a_district_from_another_office_is_409_naming_it(self, client_db, admin_token):
        first = _create_office(client_db, admin_token, suffix="F")
        second = _create_office(client_db, admin_token, suffix="G")
        assert client_db.put(
            f"/admin/org/offices/{first['id']}/districts",
            json={"districts": ["79"]},
            headers=_auth(admin_token),
        ).status_code == 200
        resp = client_db.put(
            f"/admin/org/offices/{second['id']}/districts",
            json={"districts": ["79"]},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 409, resp.text
        # NAMING the other office: "Duplicate entry 'GEOTECH:79'" is not an
        # answer an admin can act on.
        assert "79" in resp.json()["detail"]
        assert first["name"] in resp.json()["detail"]

    def test_moving_a_real_district_off_west_is_refused_by_the_same_rule(self, client_db, admin_token):
        # District 04 is WEST's on the seeded map. A second ACTIVE GeoTech office
        # may not take it while WEST holds it.
        office = _create_office(client_db, admin_token, suffix="H")
        resp = client_db.put(
            f"/admin/org/offices/{office['id']}/districts",
            json={"districts": ["04"]},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 409, resp.text
        assert "West" in resp.json()["detail"]
        # WEST still serves it, and the legacy mirror was not touched.
        assert _rows(
            """
            SELECT 1 AS held FROM org_office_districts d JOIN org_offices o ON o.id = d.office_id
             WHERE o.code = 'WEST' AND d.district = '04' AND d.is_active = 1
            """
        )

    def test_a_maintenance_office_may_cover_a_district_west_already_covers(self, client_db, admin_token):
        # The whole point of scoping the uniqueness key to org_type: the
        # maintenance hierarchy is a SECOND organization over the same
        # geography, not a competitor for the same rows (owner decision 3).
        office = _create_office(client_db, admin_token, suffix="M", org_type="MAINTENANCE")
        resp = client_db.put(
            f"/admin/org/offices/{office['id']}/districts",
            json={"districts": ["04"]},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert [row["district"] for row in resp.json()["districts"]] == ["04"]
        # WEST is untouched, and the GeoTech routing answer is unchanged.
        assert _rows(
            """
            SELECT 1 AS held FROM org_office_districts d JOIN org_offices o ON o.id = d.office_id
             WHERE o.code = 'WEST' AND d.district = '04' AND d.is_active = 1
            """
        )
        resolved = client_db.get("/org/districts/04/office", headers=_auth(admin_token))
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["office"]["code"] == "WEST"
        # Clean the borrowed district row rather than leaving 04 double-listed.
        _exec(
            "DELETE FROM org_office_districts WHERE office_id = :oid",
            {"oid": int(office["id"])},
        )

    def test_the_database_refuses_two_active_rows_even_without_the_api(self, client_db, admin_token):
        # The API's 409 is the readable answer; this is the guarantee underneath
        # it. A direct INSERT must still be refused, or the check is advisory.
        office = _create_office(client_db, admin_token, suffix="K")
        with pytest.raises(Exception) as excinfo:
            _exec(
                """
                INSERT INTO org_office_districts (office_id, org_type, district, is_primary, is_active)
                VALUES (:oid, 'GEOTECH', '04', 1, 1)
                """,
                {"oid": int(office["id"])},
            )
        assert "uk_org_district_active" in str(excinfo.value) or "Duplicate" in str(excinfo.value)

    def test_an_inactive_row_does_not_hold_a_district(self, client_db, admin_token):
        # The generated key is NULL when is_active = 0, and UNIQUE ignores NULLs,
        # so a retired coverage row keeps its history without blocking the next
        # office. Two of them in the same office are fine too.
        office = _create_office(client_db, admin_token, suffix="L")
        _exec(
            """
            INSERT INTO org_office_districts (office_id, org_type, district, is_primary, is_active)
            VALUES (:oid, 'GEOTECH', '04', 1, 0)
            """,
            {"oid": int(office["id"])},
        )
        rows = _rows(
            "SELECT active_district_key FROM org_office_districts WHERE office_id = :oid",
            {"oid": int(office["id"])},
        )
        assert rows and rows[0]["active_district_key"] is None
        _exec("DELETE FROM org_office_districts WHERE office_id = :oid", {"oid": int(office["id"])})

    def test_nonsense_districts_are_422(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="N")
        resp = client_db.put(
            f"/admin/org/offices/{office['id']}/districts",
            json={"districts": ["not a district"]},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# Branches, and the two uniqueness keys
# ---------------------------------------------------------------------------


class TestBranches:
    def test_create_patch_and_list(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="P")
        created = _create_branch(
            client_db, admin_token, int(office["id"]), letter="A", name="Branch A", home_city="Oakland"
        )
        assert created.status_code == 201, created.text
        branch = created.json()["branch"]
        assert branch["letter"] == "A"
        assert branch["accepts_assignments"] is True

        patched = client_db.patch(
            f"/admin/org/branches/{branch['id']}",
            json={"accepts_assignments": False},
            headers=_auth(admin_token),
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["branch"]["accepts_assignments"] is False
        assert patched.json()["branch"]["name"] == "Branch A", "an omitted field must be untouched"

        listed = client_db.get(
            f"/admin/org/branches?office_id={office['id']}", headers=_auth(admin_token)
        )
        assert listed.status_code == 200, listed.text
        assert [item["letter"] for item in listed.json()["items"]] == ["A"]

    def test_two_active_branch_d_rows_in_one_office_are_refused(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="Q")
        assert _create_branch(client_db, admin_token, int(office["id"]), letter="D", name="Branch D").status_code == 201
        clash = _create_branch(client_db, admin_token, int(office["id"]), letter="D", name="Branch D again")
        assert clash.status_code == 409, clash.text
        assert "Branch D already exists" in clash.json()["detail"]

    def test_the_database_refuses_the_second_branch_d_too(self, client_db, admin_token):
        office = _create_office(client_db, admin_token, suffix="R")
        assert _create_branch(client_db, admin_token, int(office["id"]), letter="D", name="Branch D").status_code == 201
        with pytest.raises(Exception) as excinfo:
            _exec(
                """
                INSERT INTO org_branches (office_id, unit_type, letter, name, accepts_assignments, is_active)
                VALUES (:oid, 'BRANCH', 'D', 'Branch D smuggled in', 1, 1)
                """,
                {"oid": int(office["id"])},
            )
        assert "uk_org_branch_active_letter" in str(excinfo.value) or "Duplicate" in str(excinfo.value)

    def test_a_deactivated_letter_frees_itself(self, client_db, admin_token):
        # active_key is NULL on a retired row, so the letter is available again
        # and the retired branch keeps its history.
        office = _create_office(client_db, admin_token, suffix="S")
        first = _create_branch(client_db, admin_token, int(office["id"]), letter="D", name="Branch D").json()["branch"]
        assert client_db.patch(
            f"/admin/org/branches/{first['id']}", json={"is_active": False}, headers=_auth(admin_token)
        ).status_code == 200
        second = _create_branch(client_db, admin_token, int(office["id"]), letter="D", name="Branch D, mark two")
        assert second.status_code == 201, second.text
        assert _rows(
            "SELECT COUNT(*) AS n FROM org_branches WHERE office_id = :oid AND letter = 'D'",
            {"oid": int(office["id"])},
        )[0]["n"] == 2

    def test_two_letterless_yard_units_in_one_office_both_insert(self, client_db, admin_token):
        # THE regression guard for owner decision 3. A single uniqueness key over
        # (office_id, letter) yields '<office_id>:' for EVERY letterless unit, so
        # the second yard in an office would be un-insertable — a schema change
        # forced by the maintenance hierarchy, which decision 3 forbids. Two
        # keys: active_key for the lettered rows, active_unit_key for these.
        office = _create_office(client_db, admin_token, suffix="Y", org_type="MAINTENANCE")
        first = _create_branch(
            client_db, admin_token, int(office["id"]), unit_type="YARD", letter=None, name="Redding Yard"
        )
        second = _create_branch(
            client_db, admin_token, int(office["id"]), unit_type="YARD", letter=None, name="Weaverville Yard"
        )
        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text
        yards = _rows(
            "SELECT name, letter, active_key, active_unit_key FROM org_branches "
            "WHERE office_id = :oid AND unit_type = 'YARD' ORDER BY name",
            {"oid": int(office["id"])},
        )
        assert [row["name"] for row in yards] == ["Redding Yard", "Weaverville Yard"]
        # Both letterless rows are outside the letter key and inside the unit key.
        assert all(row["active_key"] is None for row in yards)
        assert len({row["active_unit_key"] for row in yards}) == 2

    def test_two_yards_with_the_same_name_under_the_same_parent_are_refused(self, client_db, admin_token):
        # The letterless key is not "anything goes": one active unit of a given
        # name, under a given parent, per office.
        office = _create_office(client_db, admin_token, suffix="Z", org_type="MAINTENANCE")
        assert _create_branch(
            client_db, admin_token, int(office["id"]), unit_type="YARD", letter=None, name="Twin Yard"
        ).status_code == 201
        with pytest.raises(Exception) as excinfo:
            _exec(
                """
                INSERT INTO org_branches (office_id, unit_type, letter, name, accepts_assignments, is_active)
                VALUES (:oid, 'YARD', NULL, 'Twin Yard', 1, 1)
                """,
                {"oid": int(office["id"])},
            )
        assert "uk_org_branch_active_unit" in str(excinfo.value) or "Duplicate" in str(excinfo.value)

    def test_a_branch_needs_an_office_that_exists(self, client_db, admin_token):
        assert _create_branch(client_db, admin_token, 99999999).status_code == 404


# ---------------------------------------------------------------------------
# Deactivating a branch: gone from the pickers, unchanged in history
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def west_office_id(client_db, admin_token):
    resp = client_db.get("/admin/org/offices", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    return next(int(item["id"]) for item in resp.json()["items"] if item["code"] == "WEST")


@pytest.fixture(scope="module")
def retiring_branch(client_db, admin_token, west_office_id):
    """A real WEST branch with a real chief in it, created and then removed.

    A seeded branch cannot be used: retiring one would change what every other
    module sees, and the whole point of the test is to retire it.
    """
    # A branch never exists without its chief: the chief comes first.
    placed = People(client_db, admin_token, prefix="Zzz Retiring")
    chief = placed.account("retiring-chief", full_name=f"Zzz Retiring Branch Chief {_RUN}")
    created = client_db.post(
        "/admin/org/branches",
        json={
            "office_id": west_office_id,
            "unit_type": "BRANCH",
            "letter": "Z",
            "name": f"ZZT Branch Z {_RUN}",
            "home_city": "Oakland",
            "home_district": "04",
            "sort_order": 990,
            "chief_user_id": chief["id"],
        },
        headers=_auth(admin_token),
    )
    assert created.status_code == 201, created.text
    branch = created.json()["branch"]
    placed.branches.append(int(branch["id"]))

    yield {"branch": branch, "user_id": chief["id"]}

    placed.cleanup()


def _assessment_in_west(client_db, admin_token) -> int:
    incident = client_db.post(
        "/incidents",
        json={
            "title": f"Org model branch retirement {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Fixture for the branch deactivation test",
            "first_observed_at": "2026-06-25T10:00:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": "10.0",
        },
        headers=_auth(admin_token),
    )
    assert incident.status_code == 200, incident.text
    incident_id = int(incident.json()["incident"]["id"])
    triaged = client_db.post(
        f"/incidents/{incident_id}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED"},
        headers=_auth(admin_token),
    )
    assert triaged.status_code == 200, triaged.text
    return int(triaged.json()["assessment"]["id"])


class TestBranchDeactivationAndHistory:
    def test_it_leaves_the_picker_and_leaves_history_alone(
        self, client_db, admin_token, retiring_branch, west_office_id
    ):
        branch_id = int(retiring_branch["branch"]["id"])
        chief_id = int(retiring_branch["user_id"])
        group_key = f"b:{branch_id}"

        # 1. While the branch is active it is a group in the hand-off picker, and
        #    its chief sits inside that group.
        assessment_id = _assessment_in_west(client_db, admin_token)
        options = client_db.get(
            f"/assessments/{assessment_id}/branch-options", headers=_auth(admin_token)
        )
        assert options.status_code == 200, options.text
        assert group_key in {group["group_key"] for group in options.json()["groups"]}
        listed = [item for item in options.json()["items"] if int(item["id"]) == chief_id]
        assert listed and listed[0]["group_key"] == group_key

        # 2. Hand the work off. The branch NAME is frozen onto the assessment at
        #    that moment — that is the whole reason the snapshot columns exist.
        delegated = client_db.post(
            f"/assessments/{assessment_id}/delegate-branch",
            json={"branch_chief_user_id": chief_id},
            headers=_auth(admin_token),
        )
        assert delegated.status_code == 200, delegated.text
        frozen = _rows(
            "SELECT routed_branch_id, routed_branch_name, routed_branch_letter FROM assessments WHERE id = :aid",
            {"aid": assessment_id},
        )[0]
        assert int(frozen["routed_branch_id"]) == branch_id
        assert frozen["routed_branch_name"] == retiring_branch["branch"]["name"]
        assert frozen["routed_branch_letter"] == "Z"

        # 3. Retire the branch.
        retired = client_db.patch(
            f"/admin/org/branches/{branch_id}", json={"is_active": False}, headers=_auth(admin_token)
        )
        assert retired.status_code == 200, retired.text
        assert retired.json()["branch"]["is_active"] is False

        # 4. It stops being an OFFERED branch for new work. It may still appear
        #    as a trailing group badged inactive, because its chief is still
        #    eligible and an item must never point at a group the client was not
        #    given (the next test); what it must never be again is a live choice.
        next_assessment_id = _assessment_in_west(client_db, admin_token)
        after = client_db.get(
            f"/assessments/{next_assessment_id}/branch-options", headers=_auth(admin_token)
        )
        assert after.status_code == 200, after.text
        offered = {
            group["group_key"]
            for group in after.json()["groups"]
            if group.get("branch_id") is not None and group.get("is_active")
        }
        assert group_key not in offered

        # 5. ...and the assessment already routed through it reads exactly as it
        #    did. A rename or a retirement must never rewrite what happened.
        unchanged = _rows(
            "SELECT routed_branch_id, routed_branch_name, routed_branch_letter FROM assessments WHERE id = :aid",
            {"aid": assessment_id},
        )[0]
        assert unchanged == frozen

    def test_the_retired_branchs_chief_leaves_with_it(self, client_db, admin_token, retiring_branch):
        # A branch never exists without its chief, and a chief never without a
        # branch: retiring the branch takes its chief out of the tree (a guest
        # until placed again), so they are no longer offered for new work.
        chief_id = int(retiring_branch["user_id"])
        roles = _rows(
            "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :uid", {"uid": chief_id}
        )
        assert [row["name"] for row in roles] == ["GUEST"]
        assessment_id = _assessment_in_west(client_db, admin_token)
        options = client_db.get(
            f"/assessments/{assessment_id}/branch-options", headers=_auth(admin_token)
        )
        assert options.status_code == 200, options.text
        assert chief_id not in {int(item["id"]) for item in options.json()["items"]}
