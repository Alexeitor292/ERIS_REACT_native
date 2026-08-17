"""
DB-backed integration tests — require a live MariaDB stamped at Alembic head.
Run in isolation with: pytest -m db
These tests are excluded from the no-DB CI job and run in a separate job
that starts a MariaDB service container.
"""
from uuid import uuid4

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

    def test_cursor_page_returns_contract_and_next_page(self, admin_token, client_db):
        headers = {"Authorization": f"Bearer {admin_token}"}
        created_ids = []
        try:
            for suffix in ("a", "b"):
                created = client_db.post(
                    "/submissions",
                    headers=headers,
                    json={"title": f"pagination-{suffix}-{uuid4().hex}"},
                )
                assert created.status_code == 200
                created_ids.append(int(created.json()["submission_id"]))

            first = client_db.get("/submissions/page?limit=1", headers=headers)
            assert first.status_code == 200
            first_data = first.json()
            assert len(first_data["items"]) == 1
            assert first_data["has_more"] is True
            assert isinstance(first_data["next_cursor"], int)

            cursor = int(first_data["next_cursor"])
            second = client_db.get(f"/submissions/page?limit=1&before_id={cursor}", headers=headers)
            assert second.status_code == 200
            second_data = second.json()
            assert second_data["items"]
            assert all(int(item["id"]) < cursor for item in second_data["items"])
        finally:
            for submission_id in created_ids:
                client_db.delete(f"/submissions/{submission_id}", headers=headers)

    def test_cursor_page_invalid_status_rejected(self, admin_token, client_db):
        resp = client_db.get(
            "/submissions/page?status=NOT_A_STATUS",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 400

    def test_cursor_page_without_auth_rejected(self, client_db):
        resp = client_db.get("/submissions/page")
        assert resp.status_code == 401

    def test_cursor_page_preserves_field_worker_visibility(self, admin_token, client_db):
        admin_headers = {"Authorization": f"Bearer {admin_token}"}
        unique = uuid4().hex
        field_email = f"pagination-field-{unique}@example.test"
        password = "pagination-test-password"
        field_user_id = None
        admin_submission_id = None
        field_submission_id = None
        field_headers = None

        try:
            created_user = client_db.post(
                "/admin/users",
                headers=admin_headers,
                json={
                    "email": field_email,
                    "full_name": "Pagination Field Worker",
                    "password": password,
                    "roles": ["FIELD_WORKER"],
                },
            )
            assert created_user.status_code == 201
            field_user_id = int(created_user.json()["id"])

            login = client_db.post("/auth/login", json={"email": field_email, "password": password})
            assert login.status_code == 200
            field_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

            admin_created = client_db.post(
                "/submissions",
                headers=admin_headers,
                json={"title": f"admin-only-{unique}"},
            )
            assert admin_created.status_code == 200
            admin_submission_id = int(admin_created.json()["submission_id"])

            field_created = client_db.post(
                "/submissions",
                headers=field_headers,
                json={"title": f"field-owned-{unique}"},
            )
            assert field_created.status_code == 200
            field_submission_id = int(field_created.json()["submission_id"])

            page = client_db.get("/submissions/page?limit=200", headers=field_headers)
            assert page.status_code == 200
            visible_ids = {int(item["id"]) for item in page.json()["items"]}
            assert field_submission_id in visible_ids
            assert admin_submission_id not in visible_ids
        finally:
            if field_submission_id is not None and field_headers is not None:
                client_db.delete(f"/submissions/{field_submission_id}", headers=field_headers)
            if admin_submission_id is not None:
                client_db.delete(f"/submissions/{admin_submission_id}", headers=admin_headers)
            if field_user_id is not None:
                client_db.patch(
                    f"/admin/users/{field_user_id}",
                    headers=admin_headers,
                    json={"is_active": False},
                )


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
