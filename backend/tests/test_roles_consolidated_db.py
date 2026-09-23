"""The consolidated roles and the Entra-ready account schema, in the database.

20260923_roles_consolidated left ERIS with seven work roles and the
Administrator, one code each; 20260923_entra_identity prepared the account
tables for Entra ID sign-in — authentication only. These tests pin what a
database at head must look like, and what the API does with it.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import re
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError

from app.roles import ALL_ROLES

pytestmark = pytest.mark.db

RETIRED = {
    "MAINTENANCE", "MAINTENANCE_FIELD_WORKER", "MAINT_COORDINATOR", "GEOTECH_OFFICE_CHIEF",
    "GEOTECH_BRANCH_CHIEF", "GEOTECH_ENGINEER", "GEOTECH_SENIOR_ENGINEER", "FIELD_WORKER",
    "CALTRANS_VIEWER", "REVIEWER",
}

SEEDED = {
    "mock.admin@dot.ca.gov": "ADMIN",
    "mock.maintenance.crew@dot.ca.gov": "MAINTENANCE_CREW",
    "mock.coordinator.d01@dot.ca.gov": "MAINTENANCE_COORDINATOR",
    "mock.coordinator.d04@dot.ca.gov": "MAINTENANCE_COORDINATOR",
    "mock.office.chief@dot.ca.gov": "OFFICE_CHIEF",
    "mock.branch.chief@dot.ca.gov": "BRANCH_CHIEF",
    "mock.senior.specialist@dot.ca.gov": "SENIOR_SPECIALIST",
    "mock.staff@dot.ca.gov": "STAFF",
    "mock.staff.2@dot.ca.gov": "STAFF",
    "mock.guest@dot.ca.gov": "GUEST",
}


def _rows(sql: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(sql), params or {}).mappings().all()]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestTheRoleTable:
    def test_it_holds_exactly_the_eight_roles(self, client_db):
        assert {row["name"] for row in _rows("SELECT name FROM roles")} == set(ALL_ROLES)

    def test_no_retired_code_is_left_on_a_classification_rule(self, client_db):
        suggested = {row["eris_role"] for row in _rows("SELECT DISTINCT eris_role FROM org_classifications")}
        assert not suggested & RETIRED
        assert suggested - {None} <= set(ALL_ROLES)

    def test_the_eligibility_triggers_name_only_current_roles(self, client_db):
        bodies = _rows(
            "SELECT TRIGGER_NAME, ACTION_STATEMENT FROM information_schema.TRIGGERS "
            "WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE '%elig%'"
        )
        assert len(bodies) == 6
        for row in bodies:
            named = set(re.findall(r"'([A-Z_]{4,})'", row["ACTION_STATEMENT"]))
            assert not named & RETIRED, (row["TRIGGER_NAME"], named & RETIRED)
            assert {"STAFF", "SENIOR_SPECIALIST"} & named, row["TRIGGER_NAME"]

    def test_the_seeded_mock_accounts_hold_one_role_each(self, client_db):
        rows = _rows(
            """
            SELECT u.email, GROUP_CONCAT(r.name ORDER BY r.name) AS roles
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN roles r ON r.id = ur.role_id
             WHERE u.email IN :emails
             GROUP BY u.email
            """.replace(":emails", "(" + ", ".join(f"'{e}'" for e in SEEDED) + ")")
        )
        assert {row["email"]: row["roles"] for row in rows} == SEEDED

    def test_every_seeded_account_is_a_mock_dot_ca_gov_address(self, client_db):
        assert _rows("SELECT email FROM users WHERE email LIKE '%@local'") == []
        for email in SEEDED:
            assert email.startswith("mock.") and email.endswith("@dot.ca.gov")


class TestAssigningRoles:
    def test_a_retired_code_cannot_be_granted(self, client_db, admin_token):
        user_id = int(_rows("SELECT id FROM users WHERE email = 'mock.staff.2@dot.ca.gov'")[0]["id"])
        for code in ("FIELD_WORKER", "GEOTECH_ENGINEER", "REVIEWER"):
            resp = client_db.put(f"/admin/users/{user_id}/roles", json={"roles": [code]}, headers=_auth(admin_token))
            assert resp.status_code in (400, 422), (code, resp.status_code, resp.text)
        still = _rows("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :u", {"u": user_id})
        assert [row["name"] for row in still] == ["STAFF"]

    def test_the_role_list_offered_to_admins_is_the_eight(self, client_db, admin_token):
        resp = client_db.get("/admin/roles", headers=_auth(admin_token))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        names = body if isinstance(body, list) else body.get("items", body.get("roles", []))
        names = [item["name"] if isinstance(item, dict) else item for item in names]
        # In the order the role model presents them, not alphabetical.
        assert names == list(ALL_ROLES)


class TestEntraReadyAccounts:
    def test_an_account_may_have_no_password(self, client_db):
        column = _rows("SHOW COLUMNS FROM users LIKE 'password_hash'")[0]
        assert column["Null"] == "YES"

    def test_an_sso_only_account_is_refused_by_password_login_like_a_wrong_password(self, client_db):
        from app.db import engine

        email = f"mock.sso.only.{uuid4().hex[:8]}@dot.ca.gov"
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO users (email, full_name, password_hash, is_active) VALUES (:e, 'Mock SSO Only', NULL, 1)"), {"e": email})
        try:
            for password in ("", "password", "anything"):
                resp = client_db.post("/auth/login", json={"email": email, "password": password})
                assert resp.status_code in (401, 422), resp.text
                if resp.status_code == 401:
                    assert resp.json()["detail"] == "Invalid credentials"
            wrong = client_db.post("/auth/login", json={"email": "mock.staff@dot.ca.gov", "password": "not-it"})
            assert wrong.status_code == 401 and wrong.json()["detail"] == "Invalid credentials"
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM users WHERE email = :e"), {"e": email})

    def test_a_successful_login_records_when(self, client_db):
        from app.db import engine

        with engine.begin() as conn:
            conn.execute(text("UPDATE users SET last_login_at = NULL WHERE email = 'mock.guest@dot.ca.gov'"))
        resp = client_db.post("/auth/login", json={"email": "mock.guest@dot.ca.gov", "password": "password"})
        assert resp.status_code == 200, resp.text
        assert _rows("SELECT last_login_at FROM users WHERE email = 'mock.guest@dot.ca.gov'")[0]["last_login_at"] is not None

    def test_one_entra_identity_per_account_and_one_account_per_identity(self, client_db):
        from app.db import engine

        users = _rows("SELECT id FROM users WHERE email IN ('mock.staff@dot.ca.gov', 'mock.staff.2@dot.ca.gov') ORDER BY email")
        first, second = int(users[0]["id"]), int(users[1]["id"])
        tenant = "72f988bf-0000-4000-8000-000000000000"
        oid = str(uuid4())
        insert = text(
            "INSERT INTO user_external_identities (user_id, provider, tenant_id, object_id) VALUES (:u, :p, :t, :o)"
        )
        with engine.connect() as conn:
            outer = conn.begin()
            try:
                conn.execute(insert, {"u": first, "p": "ENTRA_ID", "t": tenant, "o": oid})
                # The same Entra person cannot be linked to a second account...
                with pytest.raises(IntegrityError):
                    with conn.begin_nested():
                        conn.execute(insert, {"u": second, "p": "ENTRA_ID", "t": tenant, "o": oid})
                # ...and an account cannot hold two Entra identities.
                with pytest.raises(IntegrityError):
                    with conn.begin_nested():
                        conn.execute(insert, {"u": first, "p": "ENTRA_ID", "t": tenant, "o": str(uuid4())})
                # Only Entra ID is a known provider.
                with pytest.raises((IntegrityError, OperationalError)):
                    with conn.begin_nested():
                        conn.execute(insert, {"u": second, "p": "GOOGLE", "t": tenant, "o": str(uuid4())})
            finally:
                outer.rollback()

    def test_the_identity_table_carries_no_role_or_org_field(self, client_db):
        """Entra authenticates; ERIS assigns roles and org placement. A column
        that could hold either would invite the wrong design."""
        columns = {row["Field"] for row in _rows("SHOW COLUMNS FROM user_external_identities")}
        assert not {c for c in columns if "role" in c or "office" in c or "branch" in c or "group" in c}
