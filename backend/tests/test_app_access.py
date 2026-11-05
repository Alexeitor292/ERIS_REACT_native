"""The phone apps are for people placed in the organization, and administrators."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import deps
from app.services import app_access, maintenance_workflows
from app.sessions import CLIENT_BEARER, CLIENT_WEB


def person(*roles):
    return {"id": 7, "email": "p@dot.ca.gov", "full_name": "P", "metadata_json": None, "roles": list(roles)}


@pytest.fixture
def no_duties(monkeypatch):
    monkeypatch.setattr(maintenance_workflows, "summary", lambda db, uid: [])


@pytest.mark.parametrize(
    "role",
    ["ADMIN", "OFFICE_CHIEF", "BRANCH_CHIEF", "SENIOR_SPECIALIST", "STAFF"],
)
def test_everyone_placed_and_administrators_may(no_duties, role):
    assert app_access.may_use_app(None, person(role))


def test_a_guest_with_a_chiefs_role_keeps_it(no_duties):
    assert app_access.may_use_app(None, person("GUEST", "BRANCH_CHIEF"))


@pytest.mark.parametrize("roles", [["GUEST"], []])
def test_someone_placed_nowhere_may_not(no_duties, roles):
    assert not app_access.may_use_app(None, person(*roles))


def test_a_guest_with_a_maintenance_duty_may(monkeypatch):
    monkeypatch.setattr(maintenance_workflows, "summary", lambda db, uid: [{"district": "04", "report": True, "manage": False}])
    assert app_access.may_use_app(None, person("GUEST"))


def sign_in(monkeypatch, *roles, client, path):
    """Runs the session dependency for one request and returns its user."""
    user = person(*roles)
    monkeypatch.setattr(deps, "authenticate", lambda request, db, token: (user, SimpleNamespace(client=client)))
    monkeypatch.setattr(deps, "user_with_roles", lambda db, u: u)
    monkeypatch.setattr(deps, "may_use_app", app_access.may_use_app)
    request = SimpleNamespace(url=SimpleNamespace(path=path), method="GET", headers={})
    return deps.current_session(request, None, None)[0]


def test_a_guest_app_is_refused_on_every_request(no_duties, monkeypatch):
    with pytest.raises(HTTPException) as refused:
        sign_in(monkeypatch, "GUEST", client=CLIENT_BEARER, path="/auth/me")
    assert refused.value.status_code == 403
    assert refused.value.detail == app_access.APP_ACCESS_DETAIL


@pytest.mark.parametrize("path", ["/auth/logout", "/notifications/devices/unregister"])
def test_a_guest_app_can_still_leave(no_duties, monkeypatch, path):
    assert sign_in(monkeypatch, "GUEST", client=CLIENT_BEARER, path=path)["roles"] == ["GUEST"]


def test_a_guest_keeps_the_web(no_duties, monkeypatch):
    assert sign_in(monkeypatch, "GUEST", client=CLIENT_WEB, path="/auth/me")["roles"] == ["GUEST"]


def test_a_move_takes_effect_at_the_next_request(no_duties, monkeypatch):
    assert sign_in(monkeypatch, "STAFF", client=CLIENT_BEARER, path="/auth/me")["roles"] == ["STAFF"]
    with pytest.raises(HTTPException):
        sign_in(monkeypatch, "GUEST", client=CLIENT_BEARER, path="/auth/me")
