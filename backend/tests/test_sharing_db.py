"""Sharing a technical form through the branch and office chiefs, end to end.

Two offices, three branches of our own, and people placed in them; the owner is
staff in the first branch. Requires a live MariaDB at Alembic head.
Run with: pytest -m db
"""
from __future__ import annotations

import uuid

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db

@pytest.fixture(scope="module")
def org(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Share")
    people = {}
    for key, office in (("ochief_w", "WEST"), ("ochief_n", "NORTH")):
        people[key] = placed.make("OFFICE_CHIEF", key, office=office)
    branches = {}
    for key, office in (("chief_wa", "WEST"), ("chief_wb", "WEST"), ("chief_na", "NORTH")):
        people[key] = placed.make("BRANCH_CHIEF", key, office=office)
        branches[key[-2:]] = placed.branches[-1]
    for key, branch in (("owner", "wa"), ("mate", "wa"), ("staff_wb", "wb"), ("staff_na", "na")):
        people[key] = placed.make("STAFF", key, branch_id=branches[branch])
    for key, office in (("spec_w", "WEST"), ("spec_n", "NORTH")):
        people[key] = placed.make("SENIOR_SPECIALIST", key, office=office)
    for person in people.values():
        person["headers"] = placed.login(person)
    yield people
    placed.cleanup()


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
