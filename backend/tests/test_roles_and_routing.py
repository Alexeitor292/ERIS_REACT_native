"""No-DB unit tests for the role model and office routing fallback.

These run without a database (default `pytest -m "not db"`). They cover the
pure authority logic and the routing service's legacy fallback path.
"""

import pytest

from app import roles
from app.services import office_routing, org_directory

RETIRED_CODES = [
    "MAINTENANCE", "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR",
    "GEOTECH_OFFICE_CHIEF", "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER",
    "GEOTECH_SENIOR_ENGINEER", "FIELD_WORKER", "CALTRANS_VIEWER", "REVIEWER",
]


# ---------------------------------------------------------------------------
# The role set: seven work roles and the Administrator, one code each
# ---------------------------------------------------------------------------


class TestTheRoleSet:
    def test_exactly_the_owners_roles_exist(self):
        assert set(roles.ALL_ROLES) == {
            "MAINTENANCE_CREW", "MAINTENANCE_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF",
            "SENIOR_SPECIALIST", "STAFF", "GUEST", "ADMIN",
        }

    def test_every_role_has_its_name(self):
        assert roles.ROLE_TITLES == {
            "MAINTENANCE_CREW": "Maintenance Crew",
            "MAINTENANCE_COORDINATOR": "Maintenance Coordinator",
            "OFFICE_CHIEF": "Office Chief",
            "BRANCH_CHIEF": "Branch Chief",
            "SENIOR_SPECIALIST": "Senior Specialist",
            "STAFF": "Staff",
            "GUEST": "Guest",
            "ADMIN": "Administrator",
        }

    @pytest.mark.parametrize("code", RETIRED_CODES)
    def test_a_retired_code_grants_nothing(self, code):
        user = {"id": 1, "roles": [code]}
        assert not roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)
        assert not roles.is_public_viewer(user)
        assert not roles.is_admin(user)
        assert code not in roles.ALL_ROLES
        assert code not in roles.GISA_AUTHOR_ROLES and code not in roles.FIELD_REPORTING_ROLES

    def test_the_alias_machinery_is_gone(self):
        for name in ("expand_roles", "ROLE_ALIASES", "has_canonical_role", "LEGACY_REVIEWER"):
            assert not hasattr(roles, name), name

    def test_the_three_categories_do_not_overlap_and_cover_every_role(self):
        assert not roles.OPERATIONAL_ROLES & roles.MAINTENANCE_REPORTING_ROLES
        assert not roles.OPERATIONAL_ROLES & roles.PUBLIC_VIEW_ROLES
        assert not roles.MAINTENANCE_REPORTING_ROLES & roles.PUBLIC_VIEW_ROLES
        assert roles.OPERATIONAL_ROLES | roles.MAINTENANCE_REPORTING_ROLES | roles.PUBLIC_VIEW_ROLES == set(roles.ALL_ROLES)

    def test_gisa_author_roles_holds_exactly_three_names(self):
        # Every GISA write guard uses this list, so a name added here silently
        # widens fourteen endpoints.
        assert set(roles.GISA_AUTHOR_ROLES) == {"ADMIN", "STAFF", "SENIOR_SPECIALIST"}

    def test_field_reporting_is_the_crew_staff_and_administrators(self):
        assert set(roles.FIELD_REPORTING_ROLES) == {"MAINTENANCE_CREW", "STAFF", "ADMIN"}


class TestHasRole:
    def test_the_role_itself_satisfies(self):
        assert roles.has_role({"id": 1, "roles": ["BRANCH_CHIEF"]}, roles.BRANCH_CHIEF)

    def test_nothing_else_does(self):
        assert not roles.has_role({"id": 1, "roles": ["ADMIN"]}, roles.STAFF)
        assert not roles.has_role({"id": 1, "roles": ["GEOTECH_BRANCH_CHIEF"]}, roles.BRANCH_CHIEF)

    def test_has_any_role(self):
        user = {"id": 1, "roles": ["STAFF"]}
        assert roles.has_any_role(user, roles.SENIOR_SPECIALIST, roles.STAFF)
        assert not roles.has_any_role(user, roles.OFFICE_CHIEF, roles.BRANCH_CHIEF)


class TestMaintenanceVsOperational:
    def test_the_crew_is_maintenance_only(self):
        user = {"id": 1, "roles": ["MAINTENANCE_CREW"]}
        assert roles.is_maintenance_only(user)
        assert not roles.is_operational_user(user)

    @pytest.mark.parametrize("code", ["MAINTENANCE_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "STAFF", "SENIOR_SPECIALIST", "ADMIN"])
    def test_every_other_work_role_is_operational(self, code):
        user = {"id": 1, "roles": [code]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)

    def test_senior_specialist_and_staff_are_separate_roles(self):
        # The two assignment-eligibility rules depend on it.
        assert not roles.has_role({"id": 1, "roles": ["SENIOR_SPECIALIST"]}, roles.STAFF)
        assert not roles.has_role({"id": 2, "roles": ["STAFF"]}, roles.SENIOR_SPECIALIST)

    def test_crew_plus_an_operational_role_is_not_maintenance_only(self):
        user = {"id": 1, "roles": ["MAINTENANCE_CREW", "MAINTENANCE_COORDINATOR"]}
        assert not roles.is_maintenance_only(user)
        assert roles.is_operational_user(user)

    def test_no_roles_is_neither(self):
        user = {"id": 1, "roles": []}
        assert not roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)


# ---------------------------------------------------------------------------
# The Guest: a third category, not an operational role (design §4.1)
# ---------------------------------------------------------------------------


class TestGuest:
    def test_a_guest_is_not_operational_and_not_maintenance_only(self):
        # OPERATIONAL_ROLES is a single flat, STATE-BLIND switch:
        # can_view_submission returns True for any operational user and
        # list_submissions hands them DRAFT rows. A guest inside it would read
        # every draft technical form in the state.
        user = {"id": 1, "roles": ["GUEST"]}
        assert not roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)
        assert roles.is_public_viewer(user)
        assert roles.is_public_only(user)

    def test_the_role_is_absent_from_the_operational_set_itself(self):
        assert roles.GUEST not in roles.OPERATIONAL_ROLES
        assert roles.GUEST not in roles.MAINTENANCE_REPORTING_ROLES
        assert roles.PUBLIC_VIEW_ROLES == {"GUEST"}

    def test_a_guest_is_not_a_gisa_author_or_a_reporter(self):
        assert roles.GUEST not in roles.GISA_AUTHOR_ROLES
        assert roles.GUEST not in roles.FIELD_REPORTING_ROLES

    @pytest.mark.parametrize(
        "companion",
        ["OFFICE_CHIEF", "BRANCH_CHIEF", "MAINTENANCE_COORDINATOR", "STAFF", "SENIOR_SPECIALIST", "ADMIN"],
    )
    def test_is_public_only_is_false_when_an_operational_role_is_also_held(self, companion):
        # A chief who is ALSO a guest keeps full chief access, because
        # require_roles is a union and the most permissive role wins. Every
        # narrowing keys on is_public_only, never on is_public_viewer.
        user = {"id": 1, "roles": ["GUEST", companion]}
        assert roles.is_public_viewer(user)
        assert not roles.is_public_only(user)
        assert roles.is_operational_user(user)

    def test_is_public_only_is_false_when_the_crew_role_is_also_held(self):
        # A reporter who is also a guest is narrowed by the maintenance rules,
        # not by the public-record rules.
        user = {"id": 1, "roles": ["GUEST", "MAINTENANCE_CREW"]}
        assert roles.is_public_viewer(user)
        assert not roles.is_public_only(user)
        assert roles.is_maintenance_only(user)

    def test_an_account_without_the_role_is_neither(self):
        for existing in (["ADMIN"], ["STAFF"], ["MAINTENANCE_CREW"], []):
            user = {"id": 1, "roles": existing}
            assert not roles.is_public_viewer(user)
            assert not roles.is_public_only(user)


# ---------------------------------------------------------------------------
# Office routing fallback (no DB)
# ---------------------------------------------------------------------------


class _RaisingDB:
    """Stand-in Session whose execute() always raises, to force the legacy
    fallback path in office_routing without a real database."""

    def execute(self, *args, **kwargs):  # noqa: D401
        raise RuntimeError("no database in unit test")


class TestOfficeRoutingFallback:
    def test_district_normalized_and_mapped(self):
        db = _RaisingDB()
        # "4" -> "04" -> WEST per the legacy fallback map.
        assert office_routing.office_for_district(db, "4") == "WEST"
        assert office_routing.office_for_district(db, "District 07") == "SOUTH"

    def test_unknown_district_returns_none(self):
        db = _RaisingDB()
        assert office_routing.office_for_district(db, "99") is None

    def test_blank_district_returns_none(self):
        db = _RaisingDB()
        assert office_routing.office_for_district(db, None) is None
        assert office_routing.office_for_district(db, "   ") is None

    def test_preview_reports_legacy_source(self):
        db = _RaisingDB()
        preview = office_routing.routing_preview(db, "05")
        assert preview["district"] == "05"
        assert preview["office_code"] == "WEST"
        assert preview["source"] == "legacy_fallback"

    def test_preview_unknown_district(self):
        db = _RaisingDB()
        preview = office_routing.routing_preview(db, "ZZ")
        assert preview["office_code"] is None
        assert preview["source"] == "none"

    @pytest.mark.parametrize(
        "district,expected",
        [
            ("01", "WEST"), ("02", "NORTH"), ("03", "NORTH"), ("04", "WEST"),
            ("05", "WEST"), ("06", "NORTH"), ("07", "SOUTH"), ("08", "SOUTH"),
            ("09", "NORTH"), ("10", "NORTH"), ("11", "SOUTH"), ("12", "SOUTH"),
        ],
    )
    def test_full_legacy_map(self, district, expected):
        # Twelve districts, the constant fallback only. The org model turned the
        # map into org_office_districts ROWS an admin owns; this constant stays
        # as the answer for a district nobody has configured yet and for a
        # pre-migration database, so it is still pinned here.
        assert office_routing.office_for_district(_RaisingDB(), district) == expected

    def test_the_constant_has_exactly_one_copy_in_the_codebase(self):
        # It used to live in three places (incidents.py, this service and an
        # Alembic revision), which is how the three copies drifted. office_routing
        # now RE-EXPORTS org_directory's single declaration rather than repeating
        # it: same object, not an equal one.
        assert office_routing.LEGACY_OFFICE_BY_DISTRICT is org_directory.LEGACY_OFFICE_BY_DISTRICT
        assert len(org_directory.LEGACY_OFFICE_BY_DISTRICT) == 12
