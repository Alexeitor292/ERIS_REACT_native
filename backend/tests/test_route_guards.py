"""The route-guard census, as CI (design §4.5, §12, W21).

The previous revision of the org model design claimed "fail-closed by
construction: any endpoint nobody remembers to touch simply 403s the viewer".
**That was false.** A census of every route under ``backend/app`` found 39 of 137
carrying no ``require_roles`` at all — 36 authenticated-only, three
unauthenticated — and eleven of the 39 were writes. Three of those writes
authorized nothing beyond being logged in: ``POST /terrain-cross-sections/projects``,
``POST /terrain-cross-sections`` and ``PUT /terrain-cross-sections/{id}`` would
have made a read-only ``GUEST`` account a writer on day one.

This module is what makes the claim TRUE rather than asserted. It walks the live
route table and requires every route to be in exactly one of three groups:

1. it carries ``require_roles`` somewhere in its dependency tree; or
2. it carries ``deps.deny_public_only``; or
3. it is listed in ``services.public_visibility.VIEWER_READABLE_ROUTES``, the
   explicit, reviewed allow list whose values NAME the in-body predicate that
   does the narrowing (``viewer_can_read_public_submission``, and so on).

A new route with no guard fails the build here. So does an allow-list entry for a
route that no longer exists, because a stale allow list is a hole nobody sees.

No database.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.routing import APIRoute

from app import deps
from app.roles import OPERATIONAL_ROLES
from app.services.public_visibility import VIEWER_READABLE_ROUTES


@pytest.fixture(scope="module")
def app_routes():
    with patch("app.main.check_migration_head"):
        from app.main import app
    return [route for route in app.routes if isinstance(route, APIRoute)]


def _guards(route: APIRoute) -> set[str]:
    """Every guard in a route's dependency tree, by kind.

    ``require_roles`` is recognised by the closure it returns rather than by a
    name substring, so an unrelated helper called ``_guard`` cannot be mistaken
    for one; ``deny_public_only`` is recognised by identity.
    """
    found: set[str] = set()
    stack = list(route.dependant.dependencies)
    while stack:
        dependency = stack.pop()
        call = dependency.call
        if call is deps.deny_public_only:
            found.add("deny_public_only")
        elif getattr(call, "__qualname__", "").startswith("require_roles."):
            found.add("require_roles")
        stack.extend(dependency.dependencies)
    return found


def _route_keys(route: APIRoute) -> list[tuple[str, str]]:
    return [(method, route.path) for method in sorted(route.methods - {"HEAD", "OPTIONS"})]


def _find(app_routes, method: str, path: str) -> APIRoute:
    for route in app_routes:
        if route.path == path and method in route.methods:
            return route
    raise AssertionError(f"{method} {path} is not mounted; the census cannot check it")


# ---------------------------------------------------------------------------
# The census itself
# ---------------------------------------------------------------------------


class TestEveryRouteIsGuarded:
    def test_no_route_is_left_unguarded(self, app_routes):
        unguarded = []
        for route in app_routes:
            guards = _guards(route)
            if guards:
                continue
            for key in _route_keys(route):
                if key not in VIEWER_READABLE_ROUTES:
                    unguarded.append(f"{key[0]} {key[1]}  ({route.endpoint.__name__})")
        assert not unguarded, (
            "These routes carry neither require_roles nor deny_public_only and are not on the "
            "reviewed viewer allow list. Add a guard, or add the route to "
            "services/public_visibility.VIEWER_READABLE_ROUTES with the name of the in-body "
            "predicate that narrows it:\n  " + "\n  ".join(sorted(unguarded))
        )

    def test_the_census_actually_walked_the_whole_table(self, app_routes):
        # A guard-detection bug that returned "guarded" for everything would make
        # the test above vacuous. The route table is large; assert that.
        assert len(app_routes) > 100
        assert sum(1 for route in app_routes if _guards(route)) > 100

    def test_the_allow_list_has_no_stale_entries(self, app_routes):
        mounted = {key for route in app_routes for key in _route_keys(route)}
        stale = sorted(key for key in VIEWER_READABLE_ROUTES if key not in mounted)
        assert not stale, (
            "VIEWER_READABLE_ROUTES names routes that are no longer mounted. A stale allow "
            f"list is a hole nobody sees: {stale}"
        )

    def test_every_allow_list_entry_names_its_predicate(self):
        # The value is not decoration: it is the reviewed reason the route is
        # allowed without a role guard, and it has to name something a reader can
        # go and look at.
        for key, reason in VIEWER_READABLE_ROUTES.items():
            assert isinstance(reason, str) and reason.strip(), f"{key} has no stated reason"

    def test_the_allow_list_admits_no_writes(self, app_routes):
        # Every writing method must be guarded by a role list or an explicit
        # refusal — never by an allow-list entry. The two POSTs that are listed
        # are the login itself and nothing else.
        allowed_writes = {
            key for key in VIEWER_READABLE_ROUTES if key[0] in {"POST", "PUT", "PATCH", "DELETE"}
        }
        assert allowed_writes == {("POST", "/auth/login")}, allowed_writes


# ---------------------------------------------------------------------------
# The three routes that authorized nothing, and their siblings
# ---------------------------------------------------------------------------


TERRAIN_CROSS_SECTION_ROUTES = [
    ("GET", "/terrain-cross-sections/projects"),
    ("POST", "/terrain-cross-sections/projects"),
    ("GET", "/terrain-cross-sections/projects/{project_id}/cross-sections"),
    ("GET", "/terrain-cross-sections/{cross_section_id}"),
    ("POST", "/terrain-cross-sections"),
    ("PUT", "/terrain-cross-sections/{cross_section_id}"),
]


class TestTerrainCrossSectionsAreRoleGuarded:
    @pytest.mark.parametrize("method,path", TERRAIN_CROSS_SECTION_ROUTES)
    def test_all_six_carry_require_roles(self, app_routes, method, path):
        # Three of these six — POST /projects, POST '' and PUT /{id} — used to
        # authorize NOTHING beyond authentication: a straight INSERT INTO
        # caltrans_projects, a straight INSERT INTO terrain_cross_sections and an
        # UPDATE that checked only that the project was ACTIVE. The router is
        # live (routes/__init__ mounts it inside the incidents router), so a
        # viewer account would have been a writer on day one.
        assert "require_roles" in _guards(_find(app_routes, method, path))

    def test_the_role_list_is_the_operational_set(self, app_routes):
        # Matching the client gate that already exists on that page. Read from
        # the route's own OpenAPI-visible dependency rather than restated, so a
        # narrowed list here would show up as a failure rather than as drift.
        route = _find(app_routes, "POST", "/terrain-cross-sections")
        names: set[str] = set()
        stack = list(route.dependant.dependencies)
        while stack:
            dependency = stack.pop()
            closure = getattr(dependency.call, "__closure__", None) or ()
            for cell in closure:
                if isinstance(cell.cell_contents, list):
                    names |= {str(value) for value in cell.cell_contents}
            stack.extend(dependency.dependencies)
        assert names == set(OPERATIONAL_ROLES)


# ---------------------------------------------------------------------------
# The deny list of design §4.5, route by route
# ---------------------------------------------------------------------------


DENY_LIST_ROUTES = [
    # A write behind a read gate: it renders a PDF and inserts an attachment.
    ("POST", "/submissions/{submission_id}/gisa/pdf"),
    # Personnel data — who else can see this record — not the record.
    ("GET", "/submissions/{submission_id}/shared-with"),
    ("GET", "/submissions/{submission_id}/permissions"),
    ("PUT", "/submissions/{submission_id}/permissions"),
    # The offline-scene-package six: a bounded 3D field package and its job
    # control. Field capture, not the record.
    ("GET", "/submissions/{submission_id}/gisa/offline-scene-package"),
    ("GET", "/submissions/{submission_id}/gisa/offline-scene-package/download"),
    ("GET", "/submissions/{submission_id}/gisa/offline-scene-package/job"),
    ("POST", "/submissions/{submission_id}/gisa/offline-scene-package/generate"),
    ("POST", "/submissions/{submission_id}/gisa/offline-scene-package/job/cancel"),
    ("POST", "/submissions/{submission_id}/gisa/offline-scene-package/job/retry"),
    # Writes.
    ("POST", "/submissions/{submission_id}/gisa/elevation-profile"),
    ("POST", "/submissions/{submission_id}/gisa/terrain-grid"),
    ("PUT", "/submissions/{submission_id}/photo-map/photos/{attachment_id}/correction"),
    # A second, photo-centric submission list that the narrowed GET /submissions
    # replaces.
    ("GET", "/submissions/page"),
    # An outbound geocoding proxy.
    ("GET", "/geo/enrich-point"),
    # Bulk field datasets: the viewer reads the road-inventory snapshot already
    # stored on the submission.
    ("GET", "/road-inventory/package"),
    ("GET", "/road-inventory/manifest"),
    ("GET", "/road-inventory/lookup"),
    ("GET", "/road-inventory/mobile-package/download"),
    # Pickers: personnel directories for a routing decision a viewer never makes.
    ("GET", "/assessments/{assessment_id}/branch-options"),
    ("GET", "/assessments/{assessment_id}/senior-engineer-options"),
    ("GET", "/admin/assessment-assignment-options/{assessment_id}"),
    # Every workflow write.
    ("POST", "/incidents/{incident_id}/triage"),
    ("POST", "/assessments/{assessment_id}/delegate-branch"),
    ("POST", "/assessments/{assessment_id}/assign-engineer"),
    ("POST", "/assessments/{assessment_id}/assign-senior-engineer"),
    ("POST", "/assessments/{assessment_id}/submit"),
    ("POST", "/assessments/{assessment_id}/review"),
    ("POST", "/incidents/{incident_id}/resolve"),
] + TERRAIN_CROSS_SECTION_ROUTES


class TestTheDenyListIsGuarded:
    @pytest.mark.parametrize("method,path", DENY_LIST_ROUTES)
    def test_each_denied_route_carries_a_guard(self, app_routes, method, path):
        guards = _guards(_find(app_routes, method, path))
        assert guards, f"{method} {path} is on the deny list but carries no guard"
        assert (method, path) not in VIEWER_READABLE_ROUTES

    def test_every_admin_route_is_guarded_by_a_role_list(self, app_routes):
        # /admin/* is ADMIN, except GET /admin/assessment-assignment-options/{id},
        # which is chiefs + ADMIN. Either way it is a ROLE list, never the
        # weaker "not a viewer" refusal.
        for route in app_routes:
            if not route.path.startswith("/admin"):
                continue
            assert "require_roles" in _guards(route), f"{route.path} is not role-guarded"


# ---------------------------------------------------------------------------
# The allow list of design §4.5, route by route
# ---------------------------------------------------------------------------


class TestTheAllowListCoversTheViewersRecord:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("GET", "/auth/me"),
            ("GET", "/gisa/lookups"),
            ("GET", "/submissions"),
            ("GET", "/submissions/{submission_id}"),
            ("GET", "/submissions/{submission_id}/geometry"),
            ("GET", "/submissions/{submission_id}/gisa/pdf"),
            ("GET", "/submissions/{submission_id}/photo-map"),
            ("GET", "/attachments/{attachment_id}/download-url"),
            ("GET", "/attachments/{attachment_id}/content"),
            ("GET", "/photos/{photo_id}/download"),
            ("GET", "/photos/{photo_id}/content"),
            ("GET", "/incidents/{incident_id}/workflow-tree"),
        ],
    )
    def test_the_record_reads_are_listed_rather_than_role_guarded(self, app_routes, method, path):
        # These carry no role list ON PURPOSE: "approved only" is a statement
        # about a RECORD's state, and require_roles is a flat set intersection
        # with no notion of state. The narrowing happens in the handler, and the
        # allow list is where that decision is written down and reviewed.
        _find(app_routes, method, path)  # it must exist
        assert (method, path) in VIEWER_READABLE_ROUTES

    @pytest.mark.parametrize(
        "method,path",
        [
            ("GET", "/incidents"),
            ("GET", "/incidents/{incident_id}"),
            ("GET", "/mission-center/incidents"),
            ("GET", "/assessments"),
            ("GET", "/assessments/{assessment_id}"),
            ("GET", "/incidents/{incident_id}/assessment"),
            ("GET", "/arcgis/runtime-config"),
            ("POST", "/incident-classifications/query"),
            ("GET", "/incidents/{incident_id}/classification"),
        ],
    )
    def test_the_role_listed_reads_name_the_viewer_in_their_role_list(self, app_routes, method, path):
        # The other half of the allow list: these routes DO carry a role list,
        # and GUEST was added to it. The row set is then narrowed in
        # the handler. Both halves are needed — neither one alone expresses
        # "this role, and only approved rows".
        route = _find(app_routes, method, path)
        assert "require_roles" in _guards(route)
        names: set[str] = set()
        stack = list(route.dependant.dependencies)
        while stack:
            dependency = stack.pop()
            for cell in getattr(dependency.call, "__closure__", None) or ():
                if isinstance(cell.cell_contents, (list, set)):
                    names |= {str(value) for value in cell.cell_contents}
            stack.extend(dependency.dependencies)
        assert "GUEST" in names, f"{method} {path} does not admit the viewer"


# ---------------------------------------------------------------------------
# One code per role (20260923_roles_consolidated)
# ---------------------------------------------------------------------------

RETIRED_ROLE_CODES = {
    "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF",
    "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER",
    "FIELD_WORKER", "CALTRANS_VIEWER",
}


def _required_roles(route: APIRoute) -> list[set[str]]:
    """The role list of every require_roles guard in a route's dependency tree."""
    import inspect

    found: list[set[str]] = []
    stack = list(route.dependant.dependencies)
    while stack:
        dependency = stack.pop()
        call = dependency.call
        if getattr(call, "__qualname__", "").startswith("require_roles."):
            found.append(set(inspect.getclosurevars(call).nonlocals["required"]))
        stack.extend(dependency.dependencies)
    return found


class TestGuardsNameOnlyRealRoles:
    def test_every_guard_names_only_roles_that_exist(self, app_routes):
        from app.roles import ALL_ROLES

        unknown = []
        for route in app_routes:
            for required in _required_roles(route):
                if not required:
                    unknown.append(f"{route.path}: an empty role list admits nobody")
                for role in sorted(required - set(ALL_ROLES)):
                    unknown.append(f"{sorted(route.methods)} {route.path}: {role}")
        assert not unknown, "Guards naming a role ERIS does not have:\n  " + "\n  ".join(unknown)

    def test_the_census_found_role_lists_to_check(self, app_routes):
        assert sum(len(_required_roles(route)) for route in app_routes) > 100

    def test_no_retired_role_code_survives_in_backend_code(self):
        """Comments may name the old codes as history; no string may."""
        import io
        import pathlib
        import tokenize

        app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
        hits = []
        for path in sorted(app_dir.rglob("*.py")):
            tokens = tokenize.generate_tokens(io.StringIO(path.read_text(encoding="utf-8")).readline)
            for token in tokens:
                if token.type != tokenize.STRING:
                    continue
                if token.string.lstrip("rRbBuUfF").startswith(('"""', "'''")):
                    continue  # docstrings are prose
                for code in RETIRED_ROLE_CODES:
                    if code in token.string:
                        hits.append(f"{path.relative_to(app_dir)}:{token.start[0]}: {code}")
        assert not hits, "Retired role codes still used in code:\n  " + "\n  ".join(hits)
