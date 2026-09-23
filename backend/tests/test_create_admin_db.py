"""The first-administrator bootstrap, ``python -m app.tools.create_admin``.

A production database starts with no accounts (database/init creates none), so
this command is the only way in. Requires a live MariaDB at Alembic head.
Run with: pytest -m db
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

from app.auth import hash_password
from app.config import settings
from app.tools import create_admin

pytestmark = pytest.mark.db


def _roles_of(email: str) -> list[str]:
    from app.db import engine

    with engine.connect() as conn:
        return sorted(
            conn.execute(
                text(
                    "SELECT r.name FROM users u JOIN user_roles ur ON ur.user_id = u.id "
                    "JOIN roles r ON r.id = ur.role_id WHERE u.email = :e"
                ),
                {"e": email},
            ).scalars()
        )


def _delete(email: str) -> None:
    from app.db import engine

    with engine.begin() as conn:
        conn.execute(text("DELETE FROM users WHERE email = :e"), {"e": email})


@pytest.fixture()
def new_email():
    email = f"eris.admin.test.{uuid4().hex[:8]}@dot.ca.gov"
    yield email
    _delete(email)


class TestCreatingTheFirstAdministrator:
    def test_a_new_account_holds_only_admin_and_can_sign_in(self, client_db, new_email, monkeypatch):
        monkeypatch.setenv(create_admin.PASSWORD_ENV, "correct horse battery")
        assert create_admin.main(["--email", new_email.upper(), "--name", "Test Administrator"]) == 0
        assert _roles_of(new_email) == ["ADMIN"]
        resp = client_db.post("/auth/login", json={"email": new_email, "password": "correct horse battery"})
        assert resp.status_code == 200, resp.text

    def test_an_sso_only_account_has_no_password_to_sign_in_with(self, client_db, new_email, monkeypatch):
        monkeypatch.delenv(create_admin.PASSWORD_ENV, raising=False)
        assert create_admin.main(["--email", new_email, "--name", "Test Administrator", "--sso-only"]) == 0
        assert _roles_of(new_email) == ["ADMIN"]
        for password in ("", "password", "correct horse battery"):
            resp = client_db.post("/auth/login", json={"email": new_email, "password": password})
            assert resp.status_code in (401, 422), resp.text

    def test_running_it_again_changes_nothing_but_what_was_asked(self, client_db, new_email, monkeypatch):
        monkeypatch.setenv(create_admin.PASSWORD_ENV, "correct horse battery")
        assert create_admin.main(["--email", new_email, "--name", "Test Administrator"]) == 0
        # Again, with no password: the account keeps the one it has.
        assert create_admin.main(["--email", new_email, "--sso-only"]) == 0
        assert _roles_of(new_email) == ["ADMIN"]
        resp = client_db.post("/auth/login", json={"email": new_email, "password": "correct horse battery"})
        assert resp.status_code == 200, resp.text


class TestPromotingAnExistingAccount:
    def test_it_adds_admin_and_touches_no_other_role(self, client_db):
        from app.db import SessionLocal, engine

        email = "mock.staff.2@dot.ca.gov"
        db = SessionLocal()
        try:
            _, created = create_admin.ensure_admin(db, email=email, full_name=None, password_hash=None)
            assert created is False
            assert _roles_of(email) == ["ADMIN", "STAFF"]
            # The password was not given, so it was not changed.
            resp = client_db.post("/auth/login", json={"email": email, "password": "password"})
            assert resp.status_code == 200, resp.text
        finally:
            db.close()
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "DELETE ur FROM user_roles ur JOIN users u ON u.id = ur.user_id "
                        "JOIN roles r ON r.id = ur.role_id WHERE u.email = :e AND r.name = 'ADMIN'"
                    ),
                    {"e": email},
                )
        assert _roles_of(email) == ["STAFF"]


class TestRefusals:
    def test_a_mock_account_is_refused_outside_dev(self, client_db, monkeypatch):
        monkeypatch.setattr(settings, "ENV", "prod")
        monkeypatch.setenv(create_admin.PASSWORD_ENV, "correct horse battery")
        assert create_admin.main(["--email", "mock.new.admin@dot.ca.gov", "--name", "Mock"]) == 2
        assert _roles_of("mock.new.admin@dot.ca.gov") == []

    def test_a_short_password_is_refused(self, client_db, new_email, monkeypatch):
        monkeypatch.setenv(create_admin.PASSWORD_ENV, "short")
        assert create_admin.main(["--email", new_email, "--name", "Test Administrator"]) == 2
        assert _roles_of(new_email) == []

    def test_a_new_account_needs_a_name(self, client_db, new_email):
        from app.db import SessionLocal

        db = SessionLocal()
        try:
            with pytest.raises(create_admin.AdminSetupError, match="--name"):
                create_admin.ensure_admin(db, email=new_email, full_name=None, password_hash=hash_password("x" * 12))
        finally:
            db.close()

    @pytest.mark.parametrize("email", ["", "no-at-sign", "a@nodot", "two words@dot.ca.gov"])
    def test_not_an_email_address(self, email):
        with pytest.raises(create_admin.AdminSetupError):
            create_admin.normalize_email(email)
