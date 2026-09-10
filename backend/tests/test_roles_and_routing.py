"""No-DB unit tests for the canonical role model and office routing fallback.

These run without a database (default `pytest -m "not db"`). They cover the
pure authority/aliasing logic and the routing service's legacy fallback path.
"""

import pytest

from app import roles
from app.services import office_routing, org_directory


# ---------------------------------------------------------------------------
# Role aliasing
# ---------------------------------------------------------------------------


class TestExpandRoles:
    def test_expand_includes_canonical_and_legacy(self):
        expanded = set(roles.expand_roles(roles.MAINTENANCE_COORDINATOR))
        assert roles.MAINTENANCE_COORDINATOR in expanded
        assert roles.LEGACY_MAINT_COORDINATOR in expanded

    def test_expand_engineer_maps_to_legacy_field_worker(self):
        expanded = set(roles.expand_roles(roles.GEOTECH_ENGINEER))
        assert "FIELD_WORKER" in expanded
        assert "GEOTECH_ENGINEER" in expanded

    def test_expand_multiple(self):
        expanded = set(roles.expand_roles(roles.GEOTECH_OFFICE_CHIEF, roles.GEOTECH_BRANCH_CHIEF))
        assert {"OFFICE_CHIEF", "BRANCH_CHIEF", "GEOTECH_OFFICE_CHIEF", "GEOTECH_BRANCH_CHIEF"} <= expanded

    def test_senior_engineer_expands_to_itself_only(self):
        # Routing v2's new role has NO legacy alias: inventing one would make
        # expand_roles() accept a name no database contains.
        assert roles.expand_roles(roles.GEOTECH_SENIOR_ENGINEER) == ["GEOTECH_SENIOR_ENGINEER"]

    def test_gisa_author_roles_holds_exactly_four_names(self):
        # Every GISA write guard uses this list, so a name added here silently
        # widens fourteen endpoints.
        assert set(roles.GISA_AUTHOR_ROLES) == {
            "ADMIN",
            "FIELD_WORKER",
            "GEOTECH_ENGINEER",
            "GEOTECH_SENIOR_ENGINEER",
        }

    def test_viewer_expands_to_itself_only(self):
        # The org model's viewer has NO legacy alias, for the same reason the
        # senior engineer has none: inventing one would make expand_roles()
        # accept a name no database contains. In particular REVIEWER is not it —
        # REVIEWER is operational and reads drafts, which is the opposite.
        assert roles.expand_roles(roles.CALTRANS_VIEWER) == ["CALTRANS_VIEWER"]


class TestHasCanonicalRole:
    def test_legacy_role_satisfies_canonical(self):
        user = {"id": 1, "roles": ["MAINT_COORDINATOR"]}
        assert roles.has_canonical_role(user, roles.MAINTENANCE_COORDINATOR)

    def test_canonical_role_satisfies_canonical(self):
        user = {"id": 1, "roles": ["GEOTECH_BRANCH_CHIEF"]}
        assert roles.has_canonical_role(user, roles.GEOTECH_BRANCH_CHIEF)

    def test_unrelated_role_does_not_satisfy(self):
        user = {"id": 1, "roles": ["ADMIN"]}
        assert not roles.has_canonical_role(user, roles.GEOTECH_ENGINEER)


class TestMaintenanceVsOperational:
    def test_legacy_maintenance_is_maintenance_only(self):
        user = {"id": 1, "roles": ["MAINTENANCE"]}
        assert roles.is_maintenance_only(user)
        assert not roles.is_operational_user(user)

    def test_canonical_field_worker_is_maintenance_only(self):
        user = {"id": 1, "roles": ["MAINTENANCE_FIELD_WORKER"]}
        assert roles.is_maintenance_only(user)

    def test_legacy_field_worker_engineer_is_operational(self):
        # Legacy FIELD_WORKER means the GeoTech engineer -> operational (broad read).
        user = {"id": 1, "roles": ["FIELD_WORKER"]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)

    def test_coordinator_is_operational(self):
        user = {"id": 1, "roles": ["MAINT_COORDINATOR"]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)

    def test_reviewer_is_operational(self):
        # REVIEWER keeps its broad READ in v2. Only its AUTHORITY is retired,
        # and that is decided on the assessment, never from this role string.
        user = {"id": 1, "roles": ["REVIEWER"]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)

    def test_senior_engineer_is_operational_and_not_maintenance_only(self):
        user = {"id": 1, "roles": ["GEOTECH_SENIOR_ENGINEER"]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)
        assert roles.has_canonical_role(user, roles.GEOTECH_SENIOR_ENGINEER)
        # ...and it is its own role: a senior engineer does not hold
        # GEOTECH_ENGINEER, and Staff do not hold GEOTECH_SENIOR_ENGINEER. The
        # two eligibility rules depend on it.
        assert not roles.has_canonical_role(user, roles.GEOTECH_ENGINEER)
        assert not roles.has_canonical_role({"id": 2, "roles": ["FIELD_WORKER"]}, roles.GEOTECH_SENIOR_ENGINEER)

    def test_admin_is_operational_not_maintenance_only(self):
        user = {"id": 1, "roles": ["ADMIN"]}
        assert roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)

    def test_maintenance_plus_operational_is_not_maintenance_only(self):
        # A user who is both a field worker and a coordinator gets broad access.
        user = {"id": 1, "roles": ["MAINTENANCE", "MAINT_COORDINATOR"]}
        assert not roles.is_maintenance_only(user)
        assert roles.is_operational_user(user)

    def test_no_roles_is_neither(self):
        user = {"id": 1, "roles": []}
        assert not roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)


# ---------------------------------------------------------------------------
# The read-only viewer: a third category, not an operational role (design §4.1)
# ---------------------------------------------------------------------------


class TestPublicViewer:
    def test_viewer_is_not_operational_and_not_maintenance_only(self):
        # OPERATIONAL_ROLES is a single flat, STATE-BLIND switch:
        # can_view_submission returns True for any operational user and
        # list_submissions hands them DRAFT rows. A viewer inside it would read
        # every draft technical form in the state.
        user = {"id": 1, "roles": ["CALTRANS_VIEWER"]}
        assert not roles.is_operational_user(user)
        assert not roles.is_maintenance_only(user)
        assert roles.is_public_viewer(user)
        assert roles.is_public_only(user)

    def test_the_role_is_absent_from_the_operational_set_itself(self):
        assert roles.CALTRANS_VIEWER not in roles.OPERATIONAL_ROLES
        assert roles.CALTRANS_VIEWER not in roles.MAINTENANCE_REPORTING_ROLES
        assert roles.PUBLIC_VIEW_ROLES == {"CALTRANS_VIEWER"}
        # No legacy name aliases INTO the viewer either, so no existing account
        # is silently granted it by the migration.
        assert roles.ROLE_ALIASES[roles.CALTRANS_VIEWER] == {"CALTRANS_VIEWER"}

    def test_viewer_is_not_a_gisa_author(self):
        # test_gisa_author_roles_holds_exactly_four_names above is the guard;
        # this states the consequence the guard exists for.
        assert roles.CALTRANS_VIEWER not in roles.GISA_AUTHOR_ROLES

    @pytest.mark.parametrize(
        "companion",
        ["OFFICE_CHIEF", "GEOTECH_OFFICE_CHIEF", "BRANCH_CHIEF", "MAINT_COORDINATOR",
         "FIELD_WORKER", "GEOTECH_SENIOR_ENGINEER", "REVIEWER", "ADMIN"],
    )
    def test_is_public_only_is_false_when_an_operational_role_is_also_held(self, companion):
        # The composition question, answered explicitly: a chief who is ALSO
        # granted Viewer keeps full chief access, because require_roles is a
        # union and the most permissive role wins. Every narrowing keys on
        # is_public_only, never on is_public_viewer.
        user = {"id": 1, "roles": ["CALTRANS_VIEWER", companion]}
        assert roles.is_public_viewer(user)
        assert not roles.is_public_only(user)
        assert roles.is_operational_user(user)

    def test_is_public_only_is_false_when_a_maintenance_role_is_also_held(self):
        # Mirrors is_maintenance_only's shape: a reporter who is also a viewer is
        # narrowed by the maintenance rules, not by the public-record rules.
        for companion in ("MAINTENANCE", "MAINTENANCE_FIELD_WORKER"):
            user = {"id": 1, "roles": ["CALTRANS_VIEWER", companion]}
            assert roles.is_public_viewer(user)
            assert not roles.is_public_only(user)
            assert roles.is_maintenance_only(user)

    def test_an_account_without_the_role_is_neither(self):
        for existing in (["ADMIN"], ["FIELD_WORKER"], ["MAINTENANCE"], ["REVIEWER"], []):
            user = {"id": 1, "roles": existing}
            assert not roles.is_public_viewer(user)
            assert not roles.is_public_only(user)

    def test_the_legacy_reviewer_is_not_the_viewer(self):
        # REVIEWER keeps its broad operational read and is deprecated where it
        # stands; migrating it to Viewer would NARROW it (drafts it reads today
        # would vanish). They are two different things.
        reviewer = {"id": 1, "roles": ["REVIEWER"]}
        assert roles.is_operational_user(reviewer)
        assert not roles.is_public_viewer(reviewer)
        assert roles.LEGACY_REVIEWER in roles.OPERATIONAL_ROLES


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
