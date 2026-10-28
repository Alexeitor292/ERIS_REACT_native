"""Server-side sessions: HttpOnly cookies for browsers, CSRF and origin checks,
idle/absolute expiry, revocation, and Entra failures that stay in the web app.

No database: a small fake session answers the handful of queries each path makes.
"""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException
from jose import jwt
from starlette.requests import Request
from starlette.testclient import TestClient

from app import entra, sessions
from app.auth import hash_password
from app.config import Settings, settings

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"
OBJECT = "33333333-3333-4333-8333-333333333333"
WEB = "https://eris.example.test"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)

    def scalars(self):
        return self

    def scalar(self):
        row = self.first()
        if isinstance(row, dict):
            return next(iter(row.values()))
        return row


class FakeDb:
    """Answers by the first matching SQL fragment; records every statement."""

    def __init__(self, answers):
        self.answers = answers
        self.statements = []
        self.committed = False

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        self.statements.append((sql, params))
        for fragment, rows in self.answers:
            if fragment in sql:
                return _Result(rows)
        return _Result([])

    def commit(self):
        self.committed = True

    def rollback(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ran(self, fragment):
        return [params for sql, params in self.statements if fragment in sql]


@pytest.fixture(autouse=True)
def https_site(monkeypatch):
    monkeypatch.setattr(settings, "WEB_BASE_URL", WEB)
    monkeypatch.setattr(settings, "CORS_ORIGINS", WEB)
    monkeypatch.setattr(settings, "SESSION_IDLE_MINUTES", 30)
    monkeypatch.setattr(settings, "SESSION_ABSOLUTE_MINUTES", 720)


def _request(method="GET", headers=None, cookies=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    if cookies:
        raw.append((b"cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()).encode()))
    return Request({"type": "http", "method": method, "path": "/", "query_string": b"",
                    "headers": raw, "client": ("10.0.0.9", 5555)})


def _session_db(token="credential", *, client="web", idle_minutes=1, revoked=False, expired=False, active=1):
    now = sessions._now()
    row = {"id": 11, "user_id": 7, "client": client, "last_seen_at": now - timedelta(minutes=idle_minutes),
           "expires_at": now - timedelta(minutes=1) if expired else now + timedelta(hours=8),
           "revoked_at": now if revoked else None, "email": "a@dot.ca.gov", "full_name": "A",
           "is_active": active, "metadata_json": None}
    return FakeDb([
        ("FROM user_sessions s JOIN users u", [row] if token else []),
        ("FROM user_roles", ["ADMIN"]),
    ])


def _cookie(token="credential"):
    return {sessions.session_cookie_name(): token}


def _csrf(token="credential"):
    return {sessions.CSRF_HEADER: sessions.csrf_token_for(sessions.hash_token(token))}


# ---------------------------------------------------------------------------
# authenticate()
# ---------------------------------------------------------------------------

def test_a_web_session_cookie_signs_the_user_in():
    user, session = sessions.authenticate(_request(cookies=_cookie()), _session_db(), None)
    assert user["id"] == 7 and session.id == 11


def test_the_database_is_queried_by_hash_never_by_the_credential():
    db = _session_db()
    sessions.authenticate(_request(cookies=_cookie()), db, None)
    params = db.ran("FROM user_sessions s JOIN users u")[0]
    assert params == {"hash": sessions.hash_token("credential")}
    assert "credential" not in str(db.statements)


@pytest.mark.parametrize("state", [{"revoked": True}, {"expired": True}, {"active": 0}])
def test_revoked_expired_or_disabled_sessions_are_refused(state):
    with pytest.raises(HTTPException) as error:
        sessions.authenticate(_request(cookies=_cookie()), _session_db(**state), None)
    assert error.value.status_code == 401


def test_an_idle_web_session_expires_and_is_revoked():
    db = _session_db(idle_minutes=31)
    with pytest.raises(HTTPException) as error:
        sessions.authenticate(_request(cookies=_cookie()), db, None)
    assert error.value.status_code == 401
    assert db.ran("SET revoked_at")[0]["reason"] == "idle"


def test_native_bearer_sessions_have_no_idle_timeout():
    user, _ = sessions.authenticate(_request(), _session_db(client="bearer", idle_minutes=600), "credential")
    assert user["id"] == 7


def test_a_web_cookie_value_cannot_be_replayed_as_a_bearer_token():
    with pytest.raises(HTTPException):
        sessions.authenticate(_request(), _session_db(client="web"), "credential")


def test_a_bearer_token_cannot_be_planted_as_a_cookie():
    with pytest.raises(HTTPException):
        sessions.authenticate(_request(cookies=_cookie()), _session_db(client="bearer"), None)


def test_no_credential_is_refused():
    with pytest.raises(HTTPException) as error:
        sessions.authenticate(_request(), _session_db(token=None), None)
    assert error.value.status_code == 401


@pytest.mark.parametrize("headers", [{}, {sessions.CSRF_HEADER: "forged"}])
def test_cookie_writes_need_the_sessions_csrf_token(headers):
    with pytest.raises(HTTPException) as error:
        sessions.authenticate(_request("POST", headers=headers, cookies=_cookie()), _session_db(), None)
    assert error.value.status_code == 403


def test_cookie_writes_with_the_csrf_token_pass():
    user, _ = sessions.authenticate(_request("DELETE", headers=_csrf(), cookies=_cookie()), _session_db(), None)
    assert user["id"] == 7


def test_another_sessions_csrf_token_is_refused():
    with pytest.raises(HTTPException):
        sessions.authenticate(_request("POST", headers=_csrf("other"), cookies=_cookie()), _session_db(), None)


def test_bearer_writes_need_no_csrf_token():
    sessions.authenticate(_request("POST"), _session_db(client="bearer"), "credential")


def test_last_seen_is_written_at_most_once_a_minute():
    fresh = _session_db(idle_minutes=0)
    sessions.authenticate(_request(cookies=_cookie()), fresh, None)
    assert not fresh.ran("SET last_seen_at")
    stale = _session_db(idle_minutes=2)
    sessions.authenticate(_request(cookies=_cookie()), stale, None)
    assert stale.ran("SET last_seen_at")


# ---------------------------------------------------------------------------
# Cross-site writes
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("headers", [
    {"origin": "https://evil.example"},
    {"origin": "null"},
    {"sec-fetch-site": "cross-site"},
])
def test_cross_site_writes_are_refused(headers):
    with pytest.raises(HTTPException) as error:
        sessions.check_origin(_request("POST", headers=headers))
    assert error.value.status_code == 403


@pytest.mark.parametrize("method,headers", [
    ("POST", {"origin": WEB, "sec-fetch-site": "same-origin"}),
    ("POST", {}),  # native clients send no Origin
    ("GET", {"origin": "https://evil.example"}),  # reads are not refused here
])
def test_same_site_native_and_read_requests_pass(method, headers):
    sessions.check_origin(_request(method, headers=headers))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    with patch("app.main.check_migration_head"):
        from app.main import app
    return TestClient(app, base_url=WEB)


@pytest.fixture
def use_db():
    from app.db import get_db
    from app.main import app

    def install(db):
        app.dependency_overrides[get_db] = lambda: db
        return db

    yield install
    app.dependency_overrides.pop(get_db, None)


def _password_db():
    return FakeDb([("FROM users WHERE email", [{"id": 7, "email": "a@dot.ca.gov", "is_active": 1,
                                                 "password_hash": hash_password("correct horse battery")}])])


def _set_cookies(response):
    return [v for k, v in response.headers.multi_items() if k == "set-cookie"]


def test_the_middleware_refuses_a_cross_site_login(client):
    response = client.post("/auth/login", json={"email": "a@dot.ca.gov", "password": "x"},
                           headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


def test_a_browser_login_gets_httponly_cookies_and_no_token(client, use_db, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_LOGIN_ENABLED", True)
    db = use_db(_password_db())
    response = client.post("/auth/login", json={"email": "a@dot.ca.gov", "password": "correct horse battery"},
                           headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    cookies = _set_cookies(response)
    session = next(c for c in cookies if c.startswith("__Host-eris_session="))
    csrf = next(c for c in cookies if c.startswith("__Host-eris_csrf="))
    for attribute in ("HttpOnly", "Secure", "SameSite=strict", "Path=/"):
        assert attribute.lower() in session.lower()
    assert "httponly" not in csrf.lower() and "secure" in csrf.lower()
    assert "max-age" not in session.lower(), "a browser-session cookie, not a persistent one"
    stored = db.ran("INSERT INTO user_sessions")[0]
    credential = session.split(";")[0].split("=", 1)[1]
    assert stored["hash"] == sessions.hash_token(credential) and stored["client"] == "web"
    assert credential not in str(db.statements)


def test_an_older_browser_that_identifies_itself_gets_cookies(client, use_db, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_LOGIN_ENABLED", True)
    use_db(_password_db())
    response = client.post("/auth/login", json={"email": "a@dot.ca.gov", "password": "correct horse battery"},
                           headers={"X-ERIS-Client": "web"})
    assert response.json() == {"ok": True}
    assert any(c.startswith("__Host-eris_session=") for c in _set_cookies(response))


def test_a_native_login_gets_a_bearer_token_and_no_cookie(client, use_db, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_LOGIN_ENABLED", True)
    db = use_db(_password_db())
    response = client.post("/auth/login", json={"email": "a@dot.ca.gov", "password": "correct horse battery"})
    body = response.json()
    assert body["token_type"] == "bearer" and len(body["access_token"]) >= 43
    assert not _set_cookies(response)
    assert db.ran("INSERT INTO user_sessions")[0]["client"] == "bearer"


def test_password_login_is_refused_when_disabled(client, use_db, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_LOGIN_ENABLED", False)
    use_db(_password_db())
    assert client.post("/auth/login", json={"email": "a@dot.ca.gov", "password": "x"}).status_code == 404


def test_logout_ends_only_this_session_and_clears_cookies(client, use_db):
    db = use_db(_session_db())
    response = client.post("/auth/logout", headers=_csrf(), cookies=_cookie())
    assert response.status_code == 200
    assert db.ran("WHERE id = :id AND revoked_at IS NULL")[0]["id"] == 11
    assert not db.ran("WHERE user_id = :uid")
    assert any(c.startswith("__Host-eris_session=") and "max-age=0" in c.lower() for c in _set_cookies(response))


def test_logout_without_the_csrf_token_is_refused(client, use_db):
    db = use_db(_session_db())
    assert client.post("/auth/logout", cookies=_cookie()).status_code == 403
    assert not db.ran("SET revoked_at")


def test_sign_out_everywhere_ends_every_session(client, use_db):
    db = use_db(_session_db())
    assert client.post("/auth/sessions/revoke-all", headers=_csrf(), cookies=_cookie()).status_code == 200
    assert db.ran("WHERE user_id = :uid AND revoked_at IS NULL")[0]["uid"] == 7


def test_tokens_in_urls_are_not_accepted(client, use_db):
    use_db(_session_db(client="bearer"))
    assert client.get("/attachments/1/content?access_token=credential").status_code == 401


def test_auth_config_reports_the_sign_in_methods(client, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_LOGIN_ENABLED", False)
    monkeypatch.setattr(settings, "ENTRA_ENABLED", True)
    assert client.get("/auth/config").json() == {
        "local_login_enabled": False, "entra_enabled": True,
        "session_idle_minutes": 30, "session_absolute_minutes": 720, "entra_mobile": None,
    }


# ---------------------------------------------------------------------------
# Production settings
# ---------------------------------------------------------------------------

def _settings(**overrides):
    values = {"DB_PASS": "x", "S3_ACCESS_KEY": "x", "S3_SECRET_KEY": "x", "ENV": "prod",
              "JWT_SECRET": "a" * 64, "WEB_BASE_URL": WEB}
    values.update(overrides)
    return Settings(**values)


def test_production_accepts_a_strong_key_and_bounded_sessions():
    assert _settings().SESSION_ABSOLUTE_MINUTES == 720


@pytest.mark.parametrize("overrides", [
    {"JWT_SECRET": "short"},
    {"JWT_SECRET": "CHANGE_ME_AT_LEAST_32_RANDOM_BYTES"},
    {"SESSION_ABSOLUTE_MINUTES": 60 * 24 * 30},
    {"SESSION_IDLE_MINUTES": 2},
    {"SESSION_IDLE_MINUTES": 800},
    {"WEB_BASE_URL": "http://eris.example.test"},
])
def test_production_refuses_weak_session_settings(overrides):
    with pytest.raises(ValueError):
        _settings(**overrides)


def test_development_keeps_its_placeholder_key():
    assert _settings(ENV="dev", JWT_SECRET="ci_placeholder_secret", WEB_BASE_URL="http://localhost:5173").ENV == "dev"


# ---------------------------------------------------------------------------
# Entra callback
# ---------------------------------------------------------------------------

@pytest.fixture
def entra_settings(monkeypatch):
    for name, value in {
        "ENTRA_ENABLED": True, "ENTRA_TENANT_ID": TENANT, "ENTRA_CLIENT_ID": CLIENT,
        "ENTRA_CLIENT_SECRET": "secret", "ENTRA_REDIRECT_URI": f"{WEB}/api/auth/entra/callback",
        "ENTRA_AUTHORITY_HOST": "login.microsoftonline.com", "ENV": "dev",
    }.items():
        monkeypatch.setattr(entra.settings, name, value)


def _reason(response):
    assert response.status_code == 303
    location = urlparse(response.headers["location"])
    assert location.path == "/login"
    return parse_qs(location.query)["entra"][0]


def _state_cookie(state="s1", nonce="n1"):
    return jwt.encode({"state": state, "nonce": nonce, "verifier": "v" * 43, "exp": 4102444800},
                      settings.JWT_SECRET, algorithm="HS256")


class _TokenEndpoint:
    def __init__(self, **_): pass
    def __enter__(self): return self
    def __exit__(self, *_): pass

    def post(self, *_args, **_kwargs):
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"id_token": "id"})


def _callback(**kwargs):
    values = {"code": "c", "state": "s1", "error": None, "eris_entra_state": _state_cookie()}
    values.update(kwargs)
    return entra.callback(_request(headers={"sec-fetch-mode": "navigate"}), **values)


def test_cancelled_sign_in_returns_to_login(entra_settings):
    assert _reason(_callback(code=None, state=None, error="access_denied", eris_entra_state=None)) == "cancelled"


def test_misconfigured_entra_returns_to_login_not_a_json_error(entra_settings, monkeypatch):
    monkeypatch.setattr(entra.settings, "ENTRA_CLIENT_SECRET", "")
    assert _reason(_callback()) == "unavailable"
    assert _reason(entra.start()) == "unavailable"


def test_forged_state_returns_to_login(entra_settings):
    assert _reason(_callback(state="other")) == "failed"


def test_unverifiable_identity_returns_to_login(entra_settings, monkeypatch):
    monkeypatch.setattr(entra.httpx, "Client", _TokenEndpoint)

    def refuse(*_args, **_kwargs):
        raise HTTPException(401, "Entra identity could not be verified")

    monkeypatch.setattr(entra, "_validate_id_token", refuse)
    assert _reason(_callback()) == "failed"


@pytest.mark.parametrize("row", [None, {"id": 7, "is_active": 0}])
def test_unlinked_or_disabled_accounts_return_to_login(entra_settings, monkeypatch, row):
    monkeypatch.setattr(entra.httpx, "Client", _TokenEndpoint)
    monkeypatch.setattr(entra, "_validate_id_token", lambda *_a, **_k: {"oid": OBJECT})
    db = FakeDb([("user_external_identities i", [row] if row else [])])
    monkeypatch.setattr(entra, "SessionLocal", lambda: db)
    assert _reason(_callback()) == "not_linked"
    assert not db.ran("INSERT INTO user_sessions")


def test_a_linked_account_gets_a_cookie_session_never_a_token_in_the_url(entra_settings, monkeypatch):
    monkeypatch.setattr(entra.httpx, "Client", _TokenEndpoint)
    monkeypatch.setattr(entra, "_validate_id_token", lambda *_a, **_k: {"oid": OBJECT})
    db = FakeDb([("user_external_identities i", [{"id": 7, "is_active": 1}])])
    monkeypatch.setattr(entra, "SessionLocal", lambda: db)
    response = _callback()
    assert response.status_code == 303
    assert response.headers["location"] == f"{WEB}/auth/entra/complete"
    stored = db.ran("INSERT INTO user_sessions")[0]
    assert stored["client"] == "web" and stored["method"] == "entra"
    cookie = next(v for k, v in response.raw_headers
                  if k == b"set-cookie" and v.startswith(b"__Host-eris_session=")).decode()
    assert "httponly" in cookie.lower()
    assert sessions.hash_token(cookie.split(";")[0].split("=", 1)[1]) == stored["hash"]
    assert db.committed
