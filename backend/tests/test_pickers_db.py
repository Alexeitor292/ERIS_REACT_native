"""The three pickers: inform, never choose (design §5, §12, W18).

Owner decision 7 keeps routing a human act, so a picker's job is to lay out what
somebody needs in order to decide — and nothing more. Concretely, and each of
these is a way an implementer's instinct goes wrong:

* **No default, no recommendation, no ``selected`` flag, and no sort key that
  reads as a ranking.** Groups are ordered by the office's own branch order,
  never by load. The two workload counts are rendered BESIDE a name, never used
  to reorder people.
* **Nobody is hidden.** A branch that accepts no
  assignments is returned WITH the flag so the client can disable it with the
  reason; a person marked ``ROTATION_OUT`` is returned with their return date and
  is neither filtered out nor moved to the end. The first implementer's instinct
  is to filter, and filtering is the picker *choosing*.
* **Two counts, because one number cannot answer the question.**
  ``open_assessment_count`` is everything this person owns; ``awaiting_action_count``
  is the subset whose next action is theirs. "4 open · 2 waiting on them" needs
  both, and a chief with work already out with an engineer is exactly the case
  where they differ.
* **The Staff picker puts the CALLER's own branch first** — the caller's, resolved
  server-side, so a chief covering another branch still gets a correct grouping.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.org_people import People

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6]
_BRANCH_PREFIX = "ZZP"

# Nothing in a picker payload may name a default or a recommendation. These are
# the field names that would do it.
FORBIDDEN_PICKER_FIELDS = {
    "default",
    "is_default",
    "default_branch_id",
    "recommended",
    "is_recommended",
    "recommendation",
    "selected",
    "is_selected",
    "preselected",
    "suggested",
    "suggestion",
    "rank",
    "score",
}


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


def _login(client_db, email: str, password: str = "password") -> str:
    resp = client_db.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, f"login {email} failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


def _incident_and_assessment(client_db, admin_token, *, district="04", county="Marin", route="1") -> dict:
    incident = client_db.post(
        "/incidents",
        json={
            "title": f"Picker fixture {_RUN}",
            "incident_type": "ROCK_FALL",
            "description": "Fixture for the picker tests",
            "first_observed_at": "2026-06-25T10:00:00",
            "latitude": 38.0,
            "longitude": -122.5,
            "district": district,
            "county": county,
            "route": route,
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
    return {"incident_id": incident_id, "assessment_id": int(triaged.json()["assessment"]["id"])}


@pytest.fixture(scope="module")
def offices(client_db, admin_token):
    resp = client_db.get("/admin/org/offices", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    return {item["code"]: item for item in resp.json()["items"]}


@pytest.fixture(scope="module")
def org(client_db, admin_token, offices):
    """Three WEST branches, each with its chief, staff in two of them, and a
    rotated-out senior specialist.

    All of it is created here and removed on teardown, because the seeded
    structure is what test_seed_shape_db.py counts and the seeded accounts are
    what every other module routes through.
    """
    west_id = int(offices["WEST"]["id"])
    placed = People(client_db, admin_token, prefix="Zzz Picker")
    created_users: dict[str, dict] = {}

    def _person(key: str, full_name: str) -> dict:
        user = placed.account(f"zzp-{key}", full_name=full_name, metadata={"office_code": "WEST", "office_location": "West Office"})
        created_users[key] = user
        return user

    def _branch(letter: str, name: str, sort_order: int, chief: dict, **extra) -> int:
        return placed.branch(
            "WEST",
            chief=chief,
            name=f"{_BRANCH_PREFIX} {name} {_RUN}",
            letter=letter,
            home_city="Oakland",
            home_district="04",
            sort_order=sort_order,
            **extra,
        )

    chief_y = _person("chiefy", f"Zzz Chief Yankee {_RUN}")
    chief_x = _person("chiefx", f"Zzz Chief Xray {_RUN}")
    chief_w = _person("chiefw", f"Zzz Chief Whiskey {_RUN}")
    # Two branches: X sorts before Y, and Y is where the calling chief sits, so
    # "own branch first" and "the office's own order" cannot be confused.
    branch_x = _branch("X", "Branch X", 970, chief_x)
    branch_y = _branch("Y", "Branch Y", 980, chief_y)
    # ...and a third that accepts nothing, like SOUTH's proposed Branch E.
    branch_w = _branch("W", "Branch W", 960, chief_w, accepts_assignments=False)

    staff_y = placed.place(_person("staffy", f"Zzz Staff Yankee {_RUN}"), "STAFF", branch_id=branch_y)
    staff_x = placed.place(_person("staffx", f"Zzz Staff Xray {_RUN}"), "STAFF", branch_id=branch_x)
    # A rotated-out Senior Specialist, with a home city of their own: a (Spec)
    # position sits away from the office home city more often than not.
    senior = placed.place(_person("senior", f"Zzz Senior Rotated {_RUN}"), "SENIOR_SPECIALIST")
    details = client_db.put(
        f"/admin/users/{senior['id']}/org",
        json={"home_city": "San Luis Obispo", "home_district": "05", "availability": "ROTATION_OUT", "available_until": "2027-02-05"},
        headers=_auth(admin_token),
    )
    assert details.status_code == 200, details.text
    for record in created_users.values():
        record["token"] = placed.login(record)["Authorization"].split(" ", 1)[1]

    yield {
        "west_id": west_id,
        "branch_x": branch_x,
        "branch_y": branch_y,
        "branch_w": branch_w,
        "chief_y": chief_y,
        "chief_x": chief_x,
        "chief_w": chief_w,
        "staff_y": staff_y,
        "staff_x": staff_x,
        "senior": senior,
        "users": created_users,
    }

    placed.cleanup()


def _forbidden_fields(payload: dict) -> set[str]:
    found: set[str] = set()
    for group in payload.get("groups", []):
        found |= FORBIDDEN_PICKER_FIELDS & set(group)
    for item in payload.get("items", []):
        found |= FORBIDDEN_PICKER_FIELDS & set(item)
    return found


# ---------------------------------------------------------------------------
# The hand-off picker
# ---------------------------------------------------------------------------


class TestBranchOptions:
    @pytest.fixture(scope="class")
    def payload(self, client_db, admin_token, org):
        case = _incident_and_assessment(client_db, admin_token)
        resp = client_db.get(
            f"/assessments/{case['assessment_id']}/branch-options", headers=_auth(admin_token)
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_it_groups_by_branch_and_names_the_office(self, payload, org):
        assert payload["office_code"] == "WEST"
        assert payload["office"]["code"] == "WEST"
        assert payload["office"]["name"] == "Office of Geotechnical Design West"
        by_key = {group["group_key"]: group for group in payload["groups"]}
        assert f"b:{org['branch_y']}" in by_key
        group = by_key[f"b:{org['branch_y']}"]
        assert group["branch_letter"] == "Y"
        assert group["home_city"] == "Oakland"
        assert group["home_district"] == "04"
        # Seeded empty: no chart states branch-to-district coverage anywhere.
        assert group["districts_covered"] == []

    def test_nothing_in_the_payload_names_a_default_or_a_recommendation(self, payload):
        assert _forbidden_fields(payload) == set()

    def test_groups_follow_the_offices_own_order_and_never_the_load(self, payload, org):
        keys = [group["group_key"] for group in payload["groups"] if group.get("branch_id")]
        assert keys.index(f"b:{org['branch_w']}") < keys.index(f"b:{org['branch_x']}")
        assert keys.index(f"b:{org['branch_x']}") < keys.index(f"b:{org['branch_y']}")
        # The seeded branches sort first (sort_order 1..6), the test branches last
        # (960/970/980) — the office's order, not anybody's workload.
        assert keys[0] != f"b:{org['branch_w']}"

    def test_a_branch_that_accepts_nothing_is_returned_with_the_flag(self, payload, org):
        group = next(g for g in payload["groups"] if g["group_key"] == f"b:{org['branch_w']}")
        # Returned, not omitted: a branch that exists on the chart and takes no
        # work must be rendered disabled WITH the reason, not silently missing.
        assert group["accepts_assignments"] is False
        assert group["is_active"] is True

    def test_the_seeded_proposed_branch_carries_the_same_flag(self, client_db, admin_token):
        # SOUTH Branch E: dashed boxes, a vacant chief and three vacant staff.
        case = _incident_and_assessment(client_db, admin_token, district="07", county="Los Angeles", route="5")
        resp = client_db.get(
            f"/assessments/{case['assessment_id']}/branch-options", headers=_auth(admin_token)
        )
        assert resp.status_code == 200, resp.text
        letters = {group["branch_letter"]: group for group in resp.json()["groups"] if group.get("branch_id")}
        assert letters["E"]["accepts_assignments"] is False
        assert {letter for letter, g in letters.items() if g["accepts_assignments"]} >= {"A", "B", "C", "D"}

    def test_every_item_points_at_a_group_the_client_was_given(self, payload):
        keys = {group["group_key"] for group in payload["groups"]}
        orphans = [item["full_name"] for item in payload["items"] if item["group_key"] not in keys]
        assert not orphans, f"picker items point at groups that were not returned: {orphans}"

    def test_items_are_ordered_by_group_then_by_name(self, payload):
        order = {group["group_key"]: index for index, group in enumerate(payload["groups"])}
        seen = [(order[item["group_key"]], (item["full_name"] or "").lower()) for item in payload["items"]]
        assert seen == sorted(seen), "items are not in group order, then by name"

    def test_each_item_carries_its_location_and_availability(self, payload, org):
        item = next(item for item in payload["items"] if int(item["id"]) == org["chief_y"]["id"])
        assert item["office_code"] == "WEST"
        assert item["office_name"] == "Office of Geotechnical Design West"
        assert item["branch_letter"] == "Y"
        assert item["home_city"] == "Oakland"
        assert item["home_district"] == "04"
        assert item["availability"] == "AVAILABLE"
        # The legacy three-key blob stays on the wire for one release, so a client
        # that has not adopted the typed fields keeps working.
        assert item["metadata"]["office_code"] == "WEST"

    def test_the_private_grouping_keys_never_reach_the_wire(self, payload):
        for item in payload["items"]:
            assert not [key for key in item if key.startswith("_")]

    def test_a_blank_office_or_district_is_absent_rather_than_the_word_null(self, payload):
        # users.metadata_json stores an explicit JSON null for every key an admin
        # left blank, and MariaDB's JSON_UNQUOTE(JSON_EXTRACT(...)) answers the
        # four-character string 'null' for one. Read that way an account with no
        # district shows "District null" in the picker and an account with no
        # office reads as an office called NULL — which then fails the
        # blank-office fallback that keeps such accounts assignable. The org SQL
        # uses JSON_VALUE, which answers SQL NULL.
        for item in payload["items"]:
            for field in ("home_district", "office_code", "home_city", "branch_letter"):
                assert item[field] is None or str(item[field]).lower() != "null", (
                    f"{item['full_name']}.{field} came back as the string 'null'"
                )


# ---------------------------------------------------------------------------
# The two workload counts
# ---------------------------------------------------------------------------


class TestWorkloadCounts:
    @pytest.fixture(scope="class")
    def loaded_chief(self, client_db, admin_token, org):
        """A chief with two open assessments, only one of them waiting on them.

        One assessment is handed to them and still needs a Staff member
        (PENDING_ENGINEER_ASSIGNMENT — theirs to act on); the other is already
        out with an engineer (DRAFT — open work they own, waiting on somebody
        else). One number cannot say that, which is the argument for two.
        """
        chief_id = org["chief_y"]["id"]
        waiting = _incident_and_assessment(client_db, admin_token)
        assigned = _incident_and_assessment(client_db, admin_token)
        for case in (waiting, assigned):
            delegated = client_db.post(
                f"/assessments/{case['assessment_id']}/delegate-branch",
                json={"branch_chief_user_id": chief_id},
                headers=_auth(admin_token),
            )
            assert delegated.status_code == 200, delegated.text
        handed_on = client_db.post(
            f"/assessments/{assigned['assessment_id']}/assign-engineer",
            json={"engineer_user_id": org["staff_y"]["id"]},
            headers=_auth(org["chief_y"]["token"]),
        )
        assert handed_on.status_code == 200, handed_on.text
        return {"chief_id": chief_id, "waiting": waiting, "assigned": assigned}

    def test_both_counts_are_present_and_they_differ(self, client_db, admin_token, org, loaded_chief):
        case = _incident_and_assessment(client_db, admin_token)
        resp = client_db.get(
            f"/assessments/{case['assessment_id']}/branch-options", headers=_auth(admin_token)
        )
        assert resp.status_code == 200, resp.text
        item = next(
            item for item in resp.json()["items"] if int(item["id"]) == loaded_chief["chief_id"]
        )
        assert item["open_assessment_count"] >= 2
        assert item["awaiting_action_count"] >= 1
        # The whole point: the chief owns work that is NOT waiting on them. One
        # number cannot say "4 open · 2 waiting on them".
        assert item["open_assessment_count"] > item["awaiting_action_count"]

    def test_the_assignee_carries_their_own_counts(self, client_db, admin_token, org, loaded_chief):
        case = _incident_and_assessment(client_db, admin_token)
        resp = client_db.get(
            f"/admin/assessment-assignment-options/{case['assessment_id']}?kind=ENGINEER",
            headers=_auth(admin_token),
        )
        assert resp.status_code == 200, resp.text
        item = next(item for item in resp.json()["items"] if int(item["id"]) == org["staff_y"]["id"])
        # A DRAFT form assigned to them is open AND waiting on them.
        assert item["open_assessment_count"] >= 1
        assert item["awaiting_action_count"] >= 1

    def test_a_count_is_never_a_sort_key(self, client_db, admin_token, org, loaded_chief):
        case = _incident_and_assessment(client_db, admin_token)
        payload = client_db.get(
            f"/assessments/{case['assessment_id']}/branch-options", headers=_auth(admin_token)
        ).json()
        order = {group["group_key"]: index for index, group in enumerate(payload["groups"])}
        # The loaded chief still sits in their branch's group, in name order — a
        # picker that sorted by load would have moved them.
        by_group: dict[str, list[str]] = {}
        for item in payload["items"]:
            by_group.setdefault(item["group_key"], []).append((item["full_name"] or "").lower())
        for names in by_group.values():
            assert names == sorted(names)
        loaded = next(i for i in payload["items"] if int(i["id"]) == loaded_chief["chief_id"])
        assert order[loaded["group_key"]] == order[f"b:{org['branch_y']}"]


# ---------------------------------------------------------------------------
# Availability: render, never filter, never sort
# ---------------------------------------------------------------------------


class TestAvailabilityIsRenderedNotApplied:
    @pytest.fixture(scope="class")
    def payload(self, client_db, admin_token, org):
        case = _incident_and_assessment(client_db, admin_token)
        resp = client_db.get(
            f"/assessments/{case['assessment_id']}/senior-engineer-options", headers=_auth(admin_token)
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_a_rotated_out_person_is_returned_with_their_return_date(self, payload, org):
        item = next(item for item in payload["items"] if int(item["id"]) == org["senior"]["id"])
        assert item["availability"] == "ROTATION_OUT"
        assert str(item["available_until"]).startswith("2027-02-05")

    def test_they_are_neither_filtered_out_nor_moved(self, payload, org):
        # Ordered like anybody else — by group, then by name. Hiding them or
        # sinking them to the bottom would be the picker deciding.
        order = {group["group_key"]: index for index, group in enumerate(payload["groups"])}
        seen = [(order[item["group_key"]], (item["full_name"] or "").lower()) for item in payload["items"]]
        assert seen == sorted(seen)
        assert org["senior"]["id"] in [int(item["id"]) for item in payload["items"]]

    def test_the_senior_picker_groups_by_home_city_and_district(self, payload, org):
        item = next(item for item in payload["items"] if int(item["id"]) == org["senior"]["id"])
        assert item["group_key"] == "loc:San Luis Obispo:05"
        group = next(g for g in payload["groups"] if g["group_key"] == item["group_key"])
        assert group["label"] == "San Luis Obispo, D05"
        # A (Spec) position has no branch, so a branch heading would be empty for
        # every one of them.
        assert group["branch_id"] is None
        assert item["branch_id"] is None

    def test_the_senior_picker_names_no_default_either(self, payload):
        assert _forbidden_fields(payload) == set()


# ---------------------------------------------------------------------------
# The Staff picker: own branch first
# ---------------------------------------------------------------------------


class TestStaffPicker:
    @pytest.fixture(scope="class")
    def case(self, client_db, admin_token, org):
        return _incident_and_assessment(client_db, admin_token)

    def _options(self, client_db, token, assessment_id):
        resp = client_db.get(
            f"/admin/assessment-assignment-options/{assessment_id}?kind=ENGINEER",
            headers=_auth(token),
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_the_callers_own_branch_comes_first(self, client_db, org, case):
        payload = self._options(client_db, org["chief_y"]["token"], case["assessment_id"])
        first = payload["groups"][0]
        assert first["branch_id"] == org["branch_y"]
        assert first["is_own_branch"] is True
        assert sum(1 for group in payload["groups"] if group.get("is_own_branch")) == 1

    def test_a_different_caller_gets_a_different_first_group(self, client_db, org, case):
        # "Own branch" is the CALLER's, resolved server-side — so a chief
        # covering a short-staffed branch still gets a correct grouping rather
        # than the assessment's.
        payload = self._options(client_db, org["chief_x"]["token"], case["assessment_id"])
        assert payload["groups"][0]["branch_id"] == org["branch_x"]
        assert payload["groups"][0]["is_own_branch"] is True

    def test_the_own_branch_group_is_first_but_its_people_are_not_ranked(self, client_db, org, case):
        payload = self._options(client_db, org["chief_y"]["token"], case["assessment_id"])
        order = {group["group_key"]: index for index, group in enumerate(payload["groups"])}
        seen = [(order[item["group_key"]], (item["full_name"] or "").lower()) for item in payload["items"]]
        assert seen == sorted(seen)
        assert int(payload["items"][0]["id"]) in {
            int(item["id"]) for item in payload["items"] if item["group_key"] == f"b:{org['branch_y']}"
        }

    def test_it_names_no_default_either(self, client_db, org, case):
        payload = self._options(client_db, org["chief_y"]["token"], case["assessment_id"])
        assert _forbidden_fields(payload) == set()

    def test_the_retired_reviewer_kind_answers_with_an_explanation(self, client_db, admin_token, case):
        resp = client_db.get(
            f"/admin/assessment-assignment-options/{case['assessment_id']}?kind=REVIEWER",
            headers=_auth(admin_token),
        )
        assert resp.status_code == 400, resp.text
        assert "CONSULTED" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Who a picker offers at all
# ---------------------------------------------------------------------------


class TestPickerEligibility:
    def test_the_hand_off_picker_offers_only_branch_chiefs_of_that_office(
        self, client_db, admin_token, org
    ):
        case = _incident_and_assessment(client_db, admin_token)
        payload = client_db.get(
            f"/assessments/{case['assessment_id']}/branch-options", headers=_auth(admin_token)
        ).json()
        offered = {int(item["id"]) for item in payload["items"]}
        assert org["chief_y"]["id"] in offered
        assert org["staff_y"]["id"] not in offered, "a Staff member is not a hand-off target"
        assert org["senior"]["id"] not in offered, "a Senior Specialist is the OTHER route"
        # Everyone offered is in the assessment's office.
        assert {item["office_code"] for item in payload["items"]} == {"WEST"}

    def test_a_deactivated_person_leaves_every_picker(self, client_db, admin_token, org):
        # is_active = 1 is the one filter every picker applies, and it is not the
        # picker choosing: a retired account cannot be handed work at all.
        # (A branch chief cannot be deactivated while leading a branch, so the
        # rotated-out senior specialist is the one who leaves here.)
        case = _incident_and_assessment(client_db, admin_token)
        senior_id = org["senior"]["id"]
        try:
            resp = client_db.patch(
                f"/admin/users/{senior_id}", json={"is_active": False}, headers=_auth(admin_token)
            )
            assert resp.status_code == 200, resp.text
            payload = client_db.get(
                f"/assessments/{case['assessment_id']}/senior-engineer-options", headers=_auth(admin_token)
            ).json()
            assert senior_id not in {int(item["id"]) for item in payload["items"]}
        finally:
            client_db.patch(
                f"/admin/users/{senior_id}", json={"is_active": True}, headers=_auth(admin_token)
            )

    def test_the_picker_is_not_open_to_the_office_it_is_not_about(self, client_db, org):
        # A WEST branch chief cannot open the hand-off picker for a SOUTH
        # assessment, and the picker is not where that is decided — the office
        # check is.
        from app.db import engine

        with engine.connect() as conn:
            south = conn.execute(
                text("SELECT id FROM assessments WHERE office_code = 'SOUTH' ORDER BY id DESC LIMIT 1")
            ).scalar()
        if south is None:
            pytest.skip("no SOUTH assessment in this database")
        resp = client_db.get(
            f"/assessments/{int(south)}/branch-options", headers=_auth(org["chief_y"]["token"])
        )
        assert resp.status_code == 403, resp.text
