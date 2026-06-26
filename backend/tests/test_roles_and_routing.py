"""No-DB unit tests for the canonical role model and office routing fallback.

These run without a database (default `pytest -m "not db"`). They cover the
pure authority/aliasing logic and the routing service's legacy fallback path.
"""

import pytest

from app import roles
from app.services import office_routing


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
        user = {"id": 1, "roles": ["REVIEWER"]}
        assert roles.is_operational_user(user)

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
        [("01", "WEST"), ("02", "NORTH"), ("07", "SOUTH"), ("11", "SOUTH"), ("09", "NORTH")],
    )
    def test_full_legacy_map(self, district, expected):
        assert office_routing.office_for_district(_RaisingDB(), district) == expected
