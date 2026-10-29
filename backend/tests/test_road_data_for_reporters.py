"""Road data for maintenance-duty reporters (no database).

The road inventory manifest and mobile package let an app find a highway post
mile without a connection. A Viewer-only account is refused them, except one
that reports for a district maintenance workflow: that duty comes from the
district's workflow, not from a role.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app import deps


def _viewer(uid: int = 9) -> dict:
    return {"id": uid, "roles": ["GUEST"]}


def test_a_viewer_with_no_reporting_duty_is_refused():
    with patch("app.services.maintenance_workflows.summary", return_value=[]):
        with pytest.raises(HTTPException) as refused:
            deps.deny_public_only_unless_maintenance_reporter(_viewer(), db=None)
    assert refused.value.status_code == 403


def test_a_duty_that_only_reviews_does_not_open_it():
    reviews = [{"district": "04", "report": False, "manage": False}]
    with patch("app.services.maintenance_workflows.summary", return_value=reviews):
        with pytest.raises(HTTPException):
            deps.deny_public_only_unless_maintenance_reporter(_viewer(), db=None)


def test_a_maintenance_reporter_gets_the_road_data():
    reports = [{"district": "04", "report": True, "manage": False}]
    with patch("app.services.maintenance_workflows.summary", return_value=reports) as summary:
        user = deps.deny_public_only_unless_maintenance_reporter(_viewer(9), db=None)
    assert user["id"] == 9
    summary.assert_called_once_with(None, 9)


def test_an_operational_account_is_let_in_without_looking_up_duties():
    with patch("app.services.maintenance_workflows.summary") as summary:
        deps.deny_public_only_unless_maintenance_reporter({"id": 3, "roles": ["STAFF"]}, db=None)
    summary.assert_not_called()


def test_only_the_road_data_routes_use_the_narrowing():
    from tests.route_table import api_routes

    with patch("app.main.check_migration_head"):
        from app.main import app
    using = sorted(
        route.path
        for route in api_routes(app)
        if any(dependency.call is deps.deny_public_only_unless_maintenance_reporter for dependency in route.dependant.dependencies)
    )
    assert using == ["/road-inventory/manifest", "/road-inventory/mobile-package/download"]
