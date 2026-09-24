"""Test accounts, placed where their roles come from.

A role is never granted directly (only Administrator is): it follows from a
place in an office tree or a district list. ``People`` creates an account and
puts it in the place that gives the role asked for, and ``cleanup`` takes
everything back out, deleting the branches it made (the seed-shape tests count
every branch row) and deactivating the accounts.

    people = People(client_db, admin_token)
    staff = people.make("STAFF")                 # staff in the office's fixture branch
    chief = people.make("BRANCH_CHIEF")          # chief of a branch of their own
    ...
    people.cleanup()
"""
from __future__ import annotations

import uuid

from sqlalchemy import bindparam, text

PASSWORD = "placed-people-test-password"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class People:
    def __init__(self, client, admin_token: str, *, prefix: str = "Zzz Placed"):
        self.client = client
        self.admin = _auth(admin_token)
        self.prefix = prefix
        self.run = uuid.uuid4().hex[:6]
        self.users: list[int] = []
        self.branches: list[int] = []
        self._fixture_branch: dict[str, int] = {}

    # --- lookups ------------------------------------------------------------
    def office_id(self, code: str = "WEST") -> int:
        tree = self.client.get("/org/tree", headers=self.admin).json()
        return next(o["office"]["id"] for o in tree["offices"] if o["office"]["code"] == code)

    def _office(self, code: str) -> dict:
        tree = self.client.get("/org/tree", headers=self.admin).json()
        return next(o for o in tree["offices"] if o["office"]["code"] == code)

    # --- making people ------------------------------------------------------
    def account(self, key: str = "", *, full_name: str | None = None, email: str | None = None, admin: bool = False, metadata: dict | None = None) -> dict:
        """An account placed nowhere: a guest (or an administrator)."""
        key = key or uuid.uuid4().hex[:6]
        email = email or f"placed-{key}-{self.run}@example.test"
        made = self.client.post(
            "/admin/users",
            json={
                "email": email, "full_name": full_name or f"{self.prefix} {key} {self.run}", "password": PASSWORD,
                "roles": ["ADMIN"] if admin else [], **({"metadata": metadata} if metadata else {}),
            },
            headers=self.admin,
        )
        assert made.status_code == 201, made.text
        user = {"id": int(made.json()["id"]), "email": email}
        self.users.append(user["id"])
        return user

    def _ensure_office_chief(self, code: str) -> None:
        office = self._office(code)
        if not office["chiefs"]:
            chief = self.account(f"ochief-{code.lower()}")
            self._post(f"/org/offices/{office['office']['id']}/chiefs", chief)

    def fixture_branch(self, code: str = "WEST") -> int:
        """A live branch (with a chief) to put staff in: the office's first one, or one of ours."""
        if code in self._fixture_branch:
            return self._fixture_branch[code]
        office = self._office(code)
        live = [b for b in office["branches"] if b["chief"]]
        if live:
            branch_id = int(live[0]["id"])
        else:
            branch_id = self.branch(code, chief=self.account(f"bchief-{code.lower()}"))
        self._fixture_branch[code] = branch_id
        return branch_id

    def branch(self, code: str = "WEST", *, chief: dict, name: str | None = None, **extra) -> int:
        """A new branch led by ``chief`` (deleted again by cleanup)."""
        self._ensure_office_chief(code)
        office_id = self.office_id(code)
        name = name or f"{self.prefix} branch {uuid.uuid4().hex[:4]} {self.run}"
        if extra:
            resp = self.client.post(
                "/admin/org/branches",
                json={"office_id": office_id, "name": name, "chief_user_id": chief["id"], **extra},
                headers=self.admin,
            )
            assert resp.status_code == 201, resp.text
            branch_id = int(resp.json()["branch"]["id"])
        else:
            resp = self.client.post(f"/org/offices/{office_id}/branches", json={"name": name, "chief_user_id": chief["id"]}, headers=self.admin)
            assert resp.status_code == 201, resp.text
            branch_id = next(b["id"] for o in resp.json()["offices"] for b in o["branches"] if b["name"] == name)
        self.branches.append(int(branch_id))
        return int(branch_id)

    def _post(self, path: str, user: dict) -> None:
        resp = self.client.post(path, json={"user_id": user["id"]}, headers=self.admin)
        assert resp.status_code == 200, resp.text

    def place(self, user: dict, role: str, *, office: str = "WEST", district: str = "01", branch_id: int | None = None) -> dict:
        role = role.upper()
        if role == "STAFF":
            self._post(f"/org/branches/{branch_id or self.fixture_branch(office)}/staff", user)
        elif role == "BRANCH_CHIEF":
            if branch_id:
                self._post(f"/org/branches/{branch_id}/chief", user)
            else:
                self.branch(office, chief=user)
        elif role == "SENIOR_SPECIALIST":
            self._ensure_office_chief(office)
            self._post(f"/org/offices/{self.office_id(office)}/specialists", user)
        elif role == "OFFICE_CHIEF":
            self._post(f"/org/offices/{self.office_id(office)}/chiefs", user)
        elif role == "MAINTENANCE_COORDINATOR":
            self._post(f"/org/maintenance/{district}/coordinators", user)
        elif role == "MAINTENANCE_CREW":
            self._post(f"/org/maintenance/{district}/crew", user)
        elif role == "ADMIN":
            resp = self.client.put(f"/admin/users/{user['id']}/admin", json={"is_admin": True}, headers=self.admin)
            assert resp.status_code == 200, resp.text
        elif role != "GUEST":
            raise AssertionError(f"No place gives the role {role}")
        return user

    def make(self, role: str | None = None, key: str = "", *, full_name: str | None = None, email: str | None = None, metadata: dict | None = None, **where) -> dict:
        user = self.account(key or (role or "guest").lower(), full_name=full_name, email=email, metadata=metadata)
        if role:
            self.place(user, role, **where)
        return user

    def login(self, user: dict) -> dict:
        resp = self.client.post("/auth/login", json={"email": user["email"], "password": PASSWORD})
        assert resp.status_code == 200, resp.text
        return _auth(resp.json()["access_token"])

    # --- cleaning up ----------------------------------------------------------
    def cleanup(self) -> None:
        from app.db import engine

        users, branches = self.users, self.branches
        with engine.begin() as conn:
            if users:
                ids = {"ids": users}
                for sql in (
                    "UPDATE org_branches SET chief_user_id = NULL WHERE chief_user_id IN :ids",
                    "UPDATE org_user_profiles SET office_id = NULL, branch_id = NULL, tree_position = NULL WHERE user_id IN :ids",
                    "DELETE FROM org_coordinator_coverage WHERE user_id IN :ids",
                    "DELETE FROM org_district_crew WHERE user_id IN :ids",
                    "DELETE ur FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id IN :ids",
                    "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'GUEST' WHERE u.id IN :ids",
                    "UPDATE users SET is_active = 0 WHERE id IN :ids",
                ):
                    conn.execute(text(sql).bindparams(bindparam("ids", expanding=True)), ids)
            if branches:
                ids = {"ids": branches}
                for sql in (
                    "UPDATE org_user_profiles SET branch_id = NULL, tree_position = NULL WHERE branch_id IN :ids",
                    "DELETE FROM org_branch_districts WHERE branch_id IN :ids",
                    "DELETE FROM org_branches WHERE id IN :ids",
                ):
                    conn.execute(text(sql).bindparams(bindparam("ids", expanding=True)), ids)
        self.users, self.branches = [], []
