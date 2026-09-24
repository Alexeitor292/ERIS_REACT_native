"""Sharing a technical form through the branch and office chiefs, end to end.

Two offices, three branches of our own, and people placed in them; the owner is
staff in the first branch. Requires a live MariaDB at Alembic head.
Run with: pytest -m db
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6]
_PASSWORD = "sharing-rules-password"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def org(client_db, admin_token):
    admin = _auth(admin_token)
    tree = client_db.get("/org/tree", headers=admin).json()
    offices = {o["office"]["code"]: o["office"]["id"] for o in tree["offices"]}
    west, north = offices["WEST"], offices["NORTH"]

    branches = {}
    for key, office in (("wa", west), ("wb", west), ("na", north)):
        name = f"Share test {key} {_RUN}"
        payload = client_db.post(f"/org/offices/{office}/branches", json={"name": name}, headers=admin)
        assert payload.status_code == 201, payload.text
        branches[key] = next(b["id"] for o in payload.json()["offices"] for b in o["branches"] if b["name"] == name)

    people = {}
    for key in ("owner", "mate", "chief_wa", "chief_wb", "staff_wb", "chief_na", "staff_na", "spec_w", "spec_n", "ochief_w", "ochief_n"):
        email = f"share-{key}-{_RUN}@example.test"
        made = client_db.post("/admin/users", json={"email": email, "full_name": f"Zzz Share {key}", "password": _PASSWORD}, headers=admin)
        assert made.status_code == 201, made.text
        people[key] = {"id": made.json()["id"], "email": email}

    def place(path, key):
        resp = client_db.post(path, json={"user_id": people[key]["id"]}, headers=admin)
        assert resp.status_code == 200, resp.text

    place(f"/org/branches/{branches['wa']}/chief", "chief_wa")
    place(f"/org/branches/{branches['wa']}/staff", "owner")
    place(f"/org/branches/{branches['wa']}/staff", "mate")
    place(f"/org/branches/{branches['wb']}/chief", "chief_wb")
    place(f"/org/branches/{branches['wb']}/staff", "staff_wb")
    place(f"/org/branches/{branches['na']}/chief", "chief_na")
    place(f"/org/branches/{branches['na']}/staff", "staff_na")
    place(f"/org/offices/{west}/specialists", "spec_w")
    place(f"/org/offices/{north}/specialists", "spec_n")
    place(f"/org/offices/{west}/chiefs", "ochief_w")
    place(f"/org/offices/{north}/chiefs", "ochief_n")
    for key in people:
        login = client_db.post("/auth/login", json={"email": people[key]["email"], "password": _PASSWORD})
        assert login.status_code == 200, login.text
        people[key]["headers"] = _auth(login.json()["access_token"])

    yield people
    for person in people.values():
        client_db.delete(f"/org/tree/people/{person['id']}", headers=admin)
        client_db.patch(f"/admin/users/{person['id']}", json={"is_active": False}, headers=admin)
    # Gone, not retired: the seed-shape tests count every branch row.
    from sqlalchemy import bindparam, text

    from app.db import engine

    with engine.begin() as conn:
        ids = {"ids": list(branches.values())}
        conn.execute(text("DELETE FROM org_branch_districts WHERE branch_id IN :ids").bindparams(bindparam("ids", expanding=True)), ids)
        conn.execute(text("UPDATE org_user_profiles SET branch_id = NULL WHERE branch_id IN :ids").bindparams(bindparam("ids", expanding=True)), ids)
        conn.execute(text("DELETE FROM org_branches WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)), ids)


def _form(client_db, owner) -> int:
    made = client_db.post("/submissions", json={"title": f"Share test form {uuid.uuid4().hex[:6]}"}, headers=owner["headers"])
    assert made.status_code == 200, made.text
    return int(made.json()["submission_id"])


def _share(client_db, form, owner, person) -> dict:
    resp = client_db.post(f"/submissions/{form}/share", json={"user_id": person["id"]}, headers=owner["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()["share"]


def _can_edit(client_db, form, person) -> bool:
    resp = client_db.patch(f"/submissions/{form}/gisa", json={"latitude": 38.5, "longitude": -122.5}, headers=person["headers"])
    assert resp.status_code in (200, 403), resp.text
    return resp.status_code == 200


def _waiting(client_db, person, share_id) -> dict | None:
    items = client_db.get("/shares/reviews", headers=person["headers"]).json()["items"]
    return next((item for item in items if item["share_id"] == share_id), None)


def _decide(client_db, person, item, decision):
    return client_db.post(
        f"/shares/{item['share_id']}/reviews/{item['review_id']}", json={"decision": decision}, headers=person["headers"]
    )


def test_inside_the_branch_it_is_shared_at_once_and_the_branch_chief_may_stop_it(client_db, org):
    form = _form(client_db, org["owner"])
    share = _share(client_db, form, org["owner"], org["mate"])
    assert share["status"] == "ACTIVE"
    assert [(r["kind"], r["decision"]) for r in share["reviews"]] == [("NOTICE", "PENDING")]
    assert _can_edit(client_db, form, org["mate"])
    assert _waiting(client_db, org["ochief_w"], share["id"]) is None  # the office is not involved

    notice = _waiting(client_db, org["chief_wa"], share["id"])
    assert notice and notice["kind"] == "NOTICE"
    assert _decide(client_db, org["chief_wa"], notice, "REJECT").status_code == 200
    assert not _can_edit(client_db, form, org["mate"])


def test_across_branches_both_branch_chiefs_must_approve(client_db, org):
    form = _form(client_db, org["owner"])
    share = _share(client_db, form, org["owner"], org["staff_wb"])
    assert share["status"] == "PENDING"
    assert not _can_edit(client_db, form, org["staff_wb"])

    theirs = _waiting(client_db, org["chief_wb"], share["id"])
    assert _decide(client_db, org["chief_wa"], theirs, "APPROVE").status_code == 403  # not chief_wa's branch
    assert _decide(client_db, org["chief_wa"], _waiting(client_db, org["chief_wa"], share["id"]), "APPROVE").status_code == 200
    assert not _can_edit(client_db, form, org["staff_wb"])
    assert _decide(client_db, org["chief_wb"], theirs, "APPROVE").json()["status"] == "ACTIVE"
    assert _can_edit(client_db, form, org["staff_wb"])
    assert _waiting(client_db, org["ochief_w"], share["id"]) is None


def test_across_offices_the_office_chiefs_are_told_and_either_may_stop_it(client_db, org):
    form = _form(client_db, org["owner"])
    share = _share(client_db, form, org["owner"], org["staff_na"])
    assert share["status"] == "PENDING"
    assert sorted((r["unit_type"], r["kind"]) for r in share["reviews"]) == [
        ("BRANCH", "APPROVAL"), ("BRANCH", "APPROVAL"), ("OFFICE", "NOTICE"), ("OFFICE", "NOTICE"),
    ]
    notice = _waiting(client_db, org["ochief_n"], share["id"])
    assert notice and notice["kind"] == "NOTICE"
    assert _decide(client_db, org["ochief_n"], notice, "APPROVE").status_code == 400  # told, not asked
    assert _decide(client_db, org["ochief_n"], notice, "REJECT").json()["status"] == "REJECTED"
    assert _waiting(client_db, org["chief_na"], share["id"]) is None


def test_staff_to_a_specialist_needs_the_branch_chief_and_tells_the_office_chief(client_db, org):
    form = _form(client_db, org["owner"])
    share = _share(client_db, form, org["owner"], org["spec_w"])
    assert share["status"] == "PENDING"
    assert _decide(client_db, org["chief_wa"], _waiting(client_db, org["chief_wa"], share["id"]), "APPROVE").json()["status"] == "ACTIVE"
    assert _can_edit(client_db, form, org["spec_w"])
    notice = _waiting(client_db, org["ochief_w"], share["id"])
    assert _decide(client_db, org["ochief_w"], notice, "ACKNOWLEDGE").status_code == 200
    assert _waiting(client_db, org["ochief_w"], share["id"]) is None
    assert _can_edit(client_db, form, org["spec_w"])


def test_specialist_to_specialist_goes_through_and_both_office_chiefs_are_told(client_db, org):
    form = _form(client_db, org["spec_w"])
    share = _share(client_db, form, org["spec_w"], org["spec_n"])
    assert share["status"] == "ACTIVE"
    assert _can_edit(client_db, form, org["spec_n"])
    assert _waiting(client_db, org["ochief_w"], share["id"]) and _waiting(client_db, org["ochief_n"], share["id"])


def test_the_owner_can_withdraw_a_request_and_the_form_lists_where_each_stands(client_db, org):
    form = _form(client_db, org["owner"])
    share = _share(client_db, form, org["owner"], org["staff_wb"])
    listed = client_db.get(f"/submissions/{form}/shares", headers=org["owner"]["headers"]).json()
    assert [s["status"] for s in listed["shares"]] == ["PENDING"]
    candidate = next(c for c in listed["candidates"] if c["id"] == org["spec_n"]["id"])
    assert candidate["route"]["immediate"] is False and len(candidate["route"]["notices"]) == 2
    assert client_db.delete(f"/submissions/{form}/share/{org['staff_wb']['id']}", headers=org["owner"]["headers"]).status_code == 200
    assert client_db.get(f"/submissions/{form}/shares", headers=org["owner"]["headers"]).json()["shares"][0]["status"] == "CANCELLED"
    assert _waiting(client_db, org["chief_wb"], share["id"]) is None
