"""Roles follow from where people sit: the office trees and the maintenance lists.

Walks one throwaway office through the whole lifecycle: an administrator names
its chief; the chief adds a senior specialist and a branch with its chief; the
branch chief adds staff; people move, are removed and become guests; and the
maintenance lists give and take the coordinator and crew roles.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6].upper()
_PASSWORD = "org-tree-test-password"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _roles(user_id: int) -> set[str]:
    from app.db import engine

    with engine.connect() as conn:
        return set(conn.execute(
            text("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :uid"),
            {"uid": int(user_id)},
        ).scalars().all())


@pytest.fixture(scope="module")
def people(client_db, admin_token):
    """Throwaway accounts with no roles, deactivated afterwards."""
    made: dict[str, dict] = {}

    def make(key: str) -> dict:
        email = f"orgtree-{key}-{_RUN.lower()}@example.test"
        resp = client_db.post(
            "/admin/users",
            json={"email": email, "full_name": f"Zzz Tree {key} {_RUN}", "password": _PASSWORD},
            headers=_auth(admin_token),
        )
        assert resp.status_code == 201, resp.text
        made[key] = {"id": int(resp.json()["id"]), "email": email}
        return made[key]

    for key in ("chief", "chief2", "specialist", "bchief", "bchief2", "staff", "staff2", "outsider", "coord", "crew"):
        make(key)
    yield made
    for person in made.values():
        client_db.patch(f"/admin/users/{person['id']}", json={"is_active": False}, headers=_auth(admin_token))


@pytest.fixture(scope="module")
def office(client_db, admin_token):
    code = f"T{_RUN}"
    resp = client_db.post(
        "/admin/org/offices",
        json={"code": code, "name": f"Zzz Tree Test Office {_RUN}", "short_name": f"Tree {_RUN}", "is_routing_target": False},
        headers=_auth(admin_token),
    )
    assert resp.status_code == 201, resp.text
    office = resp.json()["office"]
    yield office
    _drop_office(office["id"])


def _drop_office(office_id: int) -> None:
    """Offices are never deleted through the API; a test's throwaway one is, here,
    so the seeded office set stays exactly the seeded one (test_seed_shape_db)."""
    from app.db import engine

    with engine.begin() as conn:
        conn.execute(text("UPDATE org_user_profiles SET office_id = NULL, branch_id = NULL, tree_position = NULL WHERE office_id = :oid"), {"oid": office_id})
        conn.execute(text("DELETE FROM org_branch_districts WHERE branch_id IN (SELECT id FROM org_branches WHERE office_id = :oid)"), {"oid": office_id})
        conn.execute(text("DELETE FROM org_branches WHERE office_id = :oid"), {"oid": office_id})
        conn.execute(text("DELETE FROM org_office_districts WHERE office_id = :oid"), {"oid": office_id})
        conn.execute(text("DELETE FROM org_offices WHERE id = :oid"), {"oid": office_id})


def _login(client_db, person: dict) -> str:
    resp = client_db.post("/auth/login", json={"email": person["email"], "password": _PASSWORD})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _tree(payload: dict, office_id: int) -> dict:
    return next(o for o in payload["offices"] if o["office"]["id"] == office_id)


def test_a_new_account_is_a_guest(people):
    assert _roles(people["staff"]["id"]) == {"GUEST"}


def test_the_whole_tree(client_db, admin_token, people, office):
    oid = office["id"]
    admin = _auth(admin_token)

    # Only an administrator names an office chief.
    resp = client_db.post(f"/org/offices/{oid}/chiefs", json={"user_id": people["chief"]["id"]}, headers=admin)
    assert resp.status_code == 200, resp.text
    assert _roles(people["chief"]["id"]) == {"OFFICE_CHIEF"}
    chief = _auth(_login(client_db, people["chief"]))
    tree = _tree(client_db.get("/org/tree", headers=chief).json(), oid)
    assert [p["id"] for p in tree["chiefs"]] == [people["chief"]["id"]]
    assert tree["can_manage"] is True and tree["can_name_chiefs"] is False
    assert client_db.post(f"/org/offices/{oid}/chiefs", json={"user_id": people["chief2"]["id"]}, headers=chief).status_code == 403

    # The chief adds a senior specialist and a branch with its chief.
    assert client_db.post(f"/org/offices/{oid}/specialists", json={"user_id": people["specialist"]["id"]}, headers=chief).status_code == 200
    assert _roles(people["specialist"]["id"]) == {"SENIOR_SPECIALIST"}
    resp = client_db.post(
        f"/org/offices/{oid}/branches",
        json={"letter": "a", "home_city": "Oakland", "home_district": "4", "chief_user_id": people["bchief"]["id"]},
        headers=chief,
    )
    assert resp.status_code == 201, resp.text
    branch = _tree(resp.json(), oid)["branches"][0]
    assert branch["letter"] == "A" and branch["name"] == "Branch A" and branch["home_district"] == "04"
    assert branch["chief"]["id"] == people["bchief"]["id"]
    assert _roles(people["bchief"]["id"]) == {"BRANCH_CHIEF"}
    dup = client_db.post(f"/org/offices/{oid}/branches", json={"letter": "A"}, headers=chief)
    assert dup.status_code == 409

    # The branch chief adds staff to their own branch, and nothing else.
    bchief = _auth(_login(client_db, people["bchief"]))
    assert client_db.post(f"/org/branches/{branch['id']}/staff", json={"user_id": people["staff"]["id"]}, headers=bchief).status_code == 200
    assert _roles(people["staff"]["id"]) == {"STAFF"}
    assert client_db.post(f"/org/offices/{oid}/specialists", json={"user_id": people["staff2"]["id"]}, headers=bchief).status_code == 403
    # ...and cannot pull in somebody already placed in the office.
    moved = client_db.post(f"/org/branches/{branch['id']}/staff", json={"user_id": people["specialist"]["id"]}, headers=bchief)
    assert moved.status_code == 409 and "office chief" in moved.json()["detail"]
    tree = _tree(client_db.get("/org/tree", headers=bchief).json(), oid)
    assert tree["can_manage"] is False and tree["branches"][0]["can_manage"] is True

    # A second branch; the office chief moves staff between branches.
    resp = client_db.post(f"/org/offices/{oid}/branches", json={"name": "Coastal"}, headers=chief)
    coastal = next(b for b in _tree(resp.json(), oid)["branches"] if b["name"] == "Coastal")
    assert client_db.post(f"/org/branches/{coastal['id']}/staff", json={"user_id": people["staff"]["id"]}, headers=chief).status_code == 200
    tree = _tree(client_db.get("/org/tree", headers=chief).json(), oid)
    by_name = {b["name"]: b for b in tree["branches"]}
    assert [p["id"] for p in by_name["Coastal"]["staff"]] == [people["staff"]["id"]]
    assert by_name["Branch A"]["staff"] == []

    # Replacing a branch chief keeps the previous one in the branch, as staff.
    assert client_db.post(f"/org/branches/{branch['id']}/chief", json={"user_id": people["bchief2"]["id"]}, headers=chief).status_code == 200
    assert _roles(people["bchief2"]["id"]) == {"BRANCH_CHIEF"}
    assert _roles(people["bchief"]["id"]) == {"STAFF"}
    tree = _tree(client_db.get("/org/tree", headers=chief).json(), oid)
    branch_a = next(b for b in tree["branches"] if b["id"] == branch["id"])
    assert branch_a["chief"]["id"] == people["bchief2"]["id"]
    assert [p["id"] for p in branch_a["staff"]] == [people["bchief"]["id"]]

    # Only an administrator moves somebody out of another office.
    other = client_db.get("/org/tree", headers=admin).json()["offices"]
    elsewhere = next((o for o in other if o["office"]["id"] != oid and o["chiefs"]), None)
    if elsewhere:
        stranger = elsewhere["chiefs"][0]["id"]
        refused = client_db.post(f"/org/offices/{oid}/specialists", json={"user_id": stranger}, headers=chief)
        assert refused.status_code == 409 and "administrator" in refused.json()["detail"]

    # A branch with people in it cannot be retired; empty, it can.
    assert client_db.post(f"/org/branches/{coastal['id']}/retire", headers=chief).status_code == 409
    assert client_db.delete(f"/org/tree/people/{people['staff']['id']}", headers=chief).status_code == 200
    assert _roles(people["staff"]["id"]) == {"GUEST"}
    assert client_db.post(f"/org/branches/{coastal['id']}/retire", headers=chief).status_code == 200

    # The office chief cannot remove themselves; the administrator can.
    assert client_db.delete(f"/org/tree/people/{people['chief']['id']}", headers=chief).status_code == 403
    assert client_db.delete(f"/org/tree/people/{people['chief']['id']}", headers=admin).status_code == 200
    assert _roles(people["chief"]["id"]) == {"GUEST"}


def test_people_search_says_where_each_one_sits(client_db, admin_token, people):
    resp = client_db.get("/org/people", params={"q": f"Tree specialist {_RUN}"}, headers=_auth(admin_token))
    assert resp.status_code == 200
    hit = next(p for p in resp.json()["items"] if p["id"] == people["specialist"]["id"])
    assert hit["placement"]["position"] == "SENIOR_SPECIALIST"
    assert hit["placement"]["label"].startswith("Senior Specialist · ")


def test_maintenance_lists_give_and_take_roles(client_db, admin_token, people):
    admin = _auth(admin_token)
    coord, crew = people["coord"]["id"], people["crew"]["id"]
    assert client_db.post("/org/maintenance/11/coordinators", json={"user_id": coord}, headers=admin).status_code == 200
    assert client_db.post("/org/maintenance/11/crew", json={"user_id": crew}, headers=admin).status_code == 200
    assert _roles(coord) == {"MAINTENANCE_COORDINATOR"}
    assert _roles(crew) == {"MAINTENANCE_CREW"}
    body = client_db.get("/org/maintenance", headers=admin).json()
    d11 = next(d for d in body["districts"] if d["district"] == "11")
    assert coord in [p["id"] for p in d11["coordinators"]] and crew in [p["id"] for p in d11["crew"]]
    assert len(body["districts"]) >= 12
    # Crew in two districts stays crew until the last one goes.
    assert client_db.post("/org/maintenance/12/crew", json={"user_id": crew}, headers=admin).status_code == 200
    assert client_db.delete(f"/org/maintenance/11/crew/{crew}", headers=admin).status_code == 200
    assert _roles(crew) == {"MAINTENANCE_CREW"}
    assert client_db.delete(f"/org/maintenance/12/crew/{crew}", headers=admin).status_code == 200
    assert _roles(crew) == {"GUEST"}
    assert client_db.delete(f"/org/maintenance/11/coordinators/{coord}", headers=admin).status_code == 200
    assert _roles(coord) == {"GUEST"}
    assert client_db.post("/org/maintenance/13/crew", json={"user_id": crew}, headers=admin).status_code == 422


def test_the_admin_switch(client_db, admin_token, people):
    admin = _auth(admin_token)
    uid = people["outsider"]["id"]
    resp = client_db.put(f"/admin/users/{uid}/admin", json={"is_admin": True}, headers=admin)
    assert resp.status_code == 200 and resp.json()["roles"] == ["ADMIN"]
    resp = client_db.put(f"/admin/users/{uid}/admin", json={"is_admin": False}, headers=admin)
    assert resp.status_code == 200 and resp.json()["roles"] == ["GUEST"]
    me = client_db.get("/auth/me", headers=admin)
    my_id = me.json()["id"] if me.status_code == 200 else None
    if my_id:
        refused = client_db.put(f"/admin/users/{my_id}/admin", json={"is_admin": False}, headers=admin)
        assert refused.status_code == 409


def test_only_chiefs_and_administrators_see_the_trees(client_db, people):
    guest = _auth(_login(client_db, people["staff2"]))
    assert client_db.get("/org/tree", headers=guest).status_code == 403
    assert client_db.get("/org/maintenance", headers=guest).status_code == 403


def test_details_are_edited_on_the_tree(client_db, admin_token, people, office):
    admin = _auth(admin_token)
    uid = people["specialist"]["id"]
    resp = client_db.put(
        f"/org/tree/people/{uid}/details",
        json={"availability": "rotation_out", "available_until": "2027-02-05", "home_district": "4", "position_number": "559-000-3161-001"},
        headers=admin,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["availability"] == "ROTATION_OUT" and body["home_district"] == "04"
    assert body["available_until"].startswith("2027-02-05")
    # Details never touch a role.
    assert _roles(uid) == {"SENIOR_SPECIALIST"}
    assert client_db.put(f"/org/tree/people/{uid}/details", json={"availability": "ON_MARS"}, headers=admin).status_code == 422
