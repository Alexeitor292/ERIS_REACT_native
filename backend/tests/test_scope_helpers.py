"""No-DB tests for the two incident scope helpers (design §5, §12, W17).

Both helpers used to test the LEGACY role strings only, and both were wrong in
opposite directions the moment an account held a canonical name — which is what
the org model, the admin API and every new deployment now issue:

* ``_ensure_incident_scope_access`` matched none of ``MAINT_COORDINATOR`` /
  ``OFFICE_CHIEF`` / ``BRANCH_CHIEF`` for a canonically-named account, so it
  applied NO district or office narrowing at all. That is the dangerous
  direction: an unscoped read rather than a refusal.
* ``_mobile_scope_filters`` matched nothing either, fell through to its
  ``['1=0']`` tail and returned an EMPTY feed — a canonically-named coordinator
  opening the mobile app saw no incidents whatsoever.

Since 20260923_roles_consolidated each role has exactly one code, and the
retired codes grant nothing: this suite pins that every work role gets its
narrowing, and that a retired code gets no feed at all.

No database: ``_ensure_incident_scope_access`` resolves the caller's org from the
request user when it is given no session, and ``_mobile_scope_filters`` reads the
``org`` record already resolved onto the request user (``resolve_user_org``
returns that cache without querying).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import roles
from app.routes import incidents as incidents_routes


class _Rows:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self

    def all(self):
        return list(self._values)


class _UnusedSession:
    """A session that answers ONE question, the districts on the person's
    coordinator lists (``covered``, empty by default); every other query fails,
    because every other branch reads the org record cached on the request."""

    def __init__(self, covered=()):
        self.covered = covered

    def execute(self, statement, *args, **kwargs):
        if "FROM org_coordinator_coverage" in str(statement):
            return _Rows(self.covered)
        raise AssertionError("_mobile_scope_filters queried the database for a cached org")

    def begin_nested(self):  # pragma: no cover - a failure path
        raise AssertionError("_mobile_scope_filters opened a transaction for a cached org")


def _user(role: str, *, district=None, office_code=None, branch_id=None, user_id=7):
    """A request user with its org record already resolved, as a request has."""
    return {
        "id": user_id,
        "email": f"mock.{role.lower()}@dot.ca.gov",
        "roles": [role],
        "metadata": {"district": district, "office_code": office_code, "office_location": None},
        "org": {
            "user_id": user_id,
            "has_profile": True,
            "office_id": 1 if office_code else None,
            "office_code": office_code,
            "office_name": None,
            "branch_id": branch_id,
            "home_district": district,
            "home_city": None,
            "availability": "AVAILABLE",
        },
    }


def _incident(*, district="04", office_code="WEST", reporter_user_id=99, incident_id=1):
    return {
        "id": incident_id,
        "district": district,
        "office_code": office_code,
        "reporter_user_id": reporter_user_id,
    }


# One code per role since 20260923_roles_consolidated; the retired codes grant
# nothing (see test_a_retired_code_gets_no_feed).
OFFICE_CHIEF = (roles.OFFICE_CHIEF,)
BRANCH_CHIEF = (roles.BRANCH_CHIEF,)


# ---------------------------------------------------------------------------
# _ensure_incident_scope_access — incident detail
# ---------------------------------------------------------------------------


class TestIncidentScopeAccess:
    def test_maintenance_reads_only_their_own_reports(self):
        # The role alone gives no district: more comes only from a workflow (mw.can_read).
        user = _user(roles.MAINTENANCE, district="04", user_id=7)
        incidents_routes._ensure_incident_scope_access(user, _incident(district="07", reporter_user_id=7))
        with pytest.raises(HTTPException) as excinfo:
            incidents_routes._ensure_incident_scope_access(user, _incident(district="04", reporter_user_id=8))
        assert excinfo.value.status_code == 403

    @pytest.mark.parametrize("role", OFFICE_CHIEF + BRANCH_CHIEF)
    def test_chiefs_are_narrowed_to_their_office(self, role):
        user = _user(role, office_code="WEST")
        incidents_routes._ensure_incident_scope_access(user, _incident(office_code="WEST"))
        with pytest.raises(HTTPException) as excinfo:
            incidents_routes._ensure_incident_scope_access(user, _incident(district="07", office_code="SOUTH"))
        assert excinfo.value.status_code == 403
        assert "office" in excinfo.value.detail.lower()

    def test_admin_is_never_narrowed(self):
        incidents_routes._ensure_incident_scope_access(
            _user("ADMIN"), _incident(district="12", office_code="SOUTH")
        )

    def test_a_maintenance_field_worker_reads_only_their_own_report(self):
        user = _user(roles.MAINTENANCE, user_id=7)
        incidents_routes._ensure_incident_scope_access(user, _incident(reporter_user_id=7))
        with pytest.raises(HTTPException) as excinfo:
            incidents_routes._ensure_incident_scope_access(user, _incident(reporter_user_id=8))
        assert excinfo.value.status_code == 403

    def test_an_unscoped_operational_reader_is_not_narrowed(self):
        # A Senior Specialist or a Staff member holds no district or office rule
        # here; their reach is decided by assignment, not by this helper.
        incidents_routes._ensure_incident_scope_access(
            _user(roles.SENIOR_SPECIALIST), _incident(district="12", office_code="SOUTH")
        )


# ---------------------------------------------------------------------------
# _mobile_scope_filters — the mobile feed
# ---------------------------------------------------------------------------


def _filters(user, covered=()):
    return incidents_routes._mobile_scope_filters(_UnusedSession(covered), user)


class TestMobileScopeFilters:
    @pytest.mark.parametrize("role", OFFICE_CHIEF)
    def test_office_chief_gets_an_office_filter(self, role):
        where, params = _filters(_user(role, office_code="WEST"))
        assert where != ["1=0"]
        assert params["office_chief_office"] == "WEST"
        assert "OFFICE_CHIEF_REVIEW" in where[0]

    @pytest.mark.parametrize("role", BRANCH_CHIEF)
    def test_branch_chief_gets_an_office_filter(self, role):
        where, params = _filters(_user(role, office_code="WEST"))
        assert where != ["1=0"]
        assert params["branch_chief_office"] == "WEST"
        assert "BRANCH_CHIEF_REVIEW" in where[0]

    @pytest.mark.parametrize(
        "role,district,office_code",
        [
            (roles.OFFICE_CHIEF, None, "WEST"),
            (roles.BRANCH_CHIEF, None, "WEST"),
            (roles.MAINTENANCE, None, None),
            (roles.STAFF, None, None),
        ],
    )
    def test_every_work_role_has_a_feed(self, role, district, office_code):
        where, _ = _filters(_user(role, district=district, office_code=office_code))
        assert where != ["1=0"]

    @pytest.mark.parametrize(
        "code",
        ["MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF", "GEOTECH_BRANCH_CHIEF", "MAINTENANCE_CREW", "MAINTENANCE_COORDINATOR", "FIELD_WORKER", "GEOTECH_ENGINEER", "REVIEWER"],
    )
    def test_a_retired_code_gets_no_feed(self, code):
        assert _filters(_user(code, district="04", office_code="WEST"))[0] == ["1=0"]

    def test_the_senior_engineer_shares_the_staff_assignment_filter(self):
        # The Senior Specialist route reuses assignment stage ENGINEER, so the
        # EXISTS is identical; only the role guard in front of it widened.
        staff_where, _ = _filters(_user(roles.STAFF))
        senior_where, _ = _filters(_user(roles.SENIOR_SPECIALIST))
        assert staff_where == senior_where
        assert "assignment_stage = 'ENGINEER'" in staff_where[0]

    def test_a_field_worker_sees_only_their_own_reports(self):
        where, params = _filters(_user(roles.MAINTENANCE, user_id=7))
        assert "i.reporter_user_id = :mobile_uid" in where[0]
        assert params["mobile_uid"] == 7

    def test_admin_is_unfiltered(self):
        assert _filters(_user("ADMIN")) == ([], {})

    def test_a_role_with_no_org_data_still_fails_closed(self):
        # The ['1=0'] tail is correct HERE and only here: a chief with no office
        # recorded has no office feed to show. What the canonical fix changed is
        # that a chief WITH an office no longer lands in it.
        assert _filters(_user(roles.OFFICE_CHIEF, office_code=None))[0] == ["1=0"]
        assert _filters(_user("REVIEWER"))[0] == ["1=0"]

    def test_a_read_only_viewer_gets_no_mobile_feed(self):
        # The viewer holds no mobile role at all: the org model does not put a
        # read-only account into the field app.
        assert _filters(_user(roles.GUEST))[0] == ["1=0"]

    def test_several_roles_union_rather_than_override(self):
        user = _user(roles.MAINTENANCE, office_code="WEST", user_id=7)
        user["roles"] = [roles.MAINTENANCE, roles.OFFICE_CHIEF]
        where, params = _filters(user)
        assert " OR " in where[0]
        assert params["mobile_uid"] == 7
        assert params["office_chief_office"] == "WEST"