"""
DB-backed integration tests — require a live MariaDB stamped at Alembic head.
Run in isolation with: pytest -m db
These tests are excluded from the no-DB CI job and run in a separate job
that starts a MariaDB service container.
"""
import pytest

pytestmark = pytest.mark.db


class TestAlembicCurrent:
    def test_db_at_head(self, client_db):
        from alembic.config import Config
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory
        from app.db import engine
        import os

        backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        cfg = Config(os.path.join(backend_dir, "alembic.ini"))
        cfg.set_main_option("script_location", os.path.join(backend_dir, "migrations"))
        expected = set(ScriptDirectory.from_config(cfg).get_heads())

        with engine.connect() as conn:
            current = set(MigrationContext.configure(conn).get_current_heads())

        assert current == expected, (
            f"DB revision {current} does not match script head {expected}. "
            f"Run: alembic upgrade head"
        )


class TestHealthWithRealStartup:
    def test_health_ok(self, client_db):
        resp = client_db.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


class TestAuth:
    def test_login_returns_token(self, client_db):
        resp = client_db.post(
            "/auth/login",
            json={"email": "admin@local", "password": "password"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert len(data["access_token"]) > 20

    def test_login_wrong_password_rejected(self, client_db):
        resp = client_db.post(
            "/auth/login",
            json={"email": "admin@local", "password": "wrongpassword"},
        )
        assert resp.status_code == 401

    def test_me_returns_admin_user(self, admin_token, client_db):
        resp = client_db.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        me = resp.json()
        assert me["email"] == "admin@local"
        assert "ADMIN" in me["roles"]
        assert me["id"] > 0

    def test_me_all_admin_roles_present(self, admin_token, client_db):
        resp = client_db.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        roles = set(resp.json()["roles"])
        expected = {"ADMIN", "REVIEWER", "FIELD_WORKER", "MAINTENANCE",
                    "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF"}
        missing = expected - roles
        assert not missing, f"Admin user missing roles: {missing}"

    def test_me_without_token_rejected(self, client_db):
        resp = client_db.get("/auth/me")
        assert resp.status_code == 401


class TestGISALookups:
    def test_lookups_returns_all_categories(self, admin_token, client_db):
        resp = client_db.get(
            "/gisa/lookups",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "distribution" in data
        assert "highway_status" in data
        assert "incident_types" in data
        assert "actions" in data

    def test_lookups_non_empty(self, admin_token, client_db):
        resp = client_db.get(
            "/gisa/lookups",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        data = resp.json()
        assert len(data["distribution"]) > 0
        assert len(data["highway_status"]) > 0
        assert len(data["incident_types"]) > 0
        assert len(data["actions"]["immediate"]) > 0

    def test_lookups_without_auth_rejected(self, client_db):
        resp = client_db.get("/gisa/lookups")
        assert resp.status_code == 401


class TestSubmissions:
    def test_list_returns_200(self, admin_token, client_db):
        resp = client_db.get(
            "/submissions",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert "items" in resp.json()

    def test_list_without_auth_rejected(self, client_db):
        resp = client_db.get("/submissions")
        assert resp.status_code == 401


class TestIncidents:
    def test_list_returns_200(self, admin_token, client_db):
        resp = client_db.get(
            "/incidents",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert "items" in resp.json()

    def test_list_without_auth_rejected(self, client_db):
        resp = client_db.get("/incidents")
        assert resp.status_code == 401
