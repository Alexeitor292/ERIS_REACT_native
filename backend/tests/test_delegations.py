"""Out of the office: who may be named, for how long, and what acting allows."""
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import deps
from app.services import delegations
from app.services.delegations import Reach, blocked_while_acting, check_dates, may_name, supervises

D04, D07 = frozenset({"04"}), frozenset({"07"})


def test_someone_in_the_same_office_may_be_named():
    assert may_name(Reach(office_id=1), Reach(office_id=1))
    assert not may_name(Reach(office_id=1), Reach(office_id=2))


def test_someone_on_the_same_districts_lists_may_be_named():
    assert may_name(Reach(districts=D04), Reach(districts=D04 | D07))
    assert not may_name(Reach(districts=D04), Reach(districts=D07))


def test_nobody_placed_has_no_one_to_name():
    assert not Reach().placed
    assert not may_name(Reach(), Reach())


def test_a_person_in_both_worlds_matches_either():
    both = Reach(office_id=1, districts=D04)
    assert may_name(both, Reach(office_id=1))
    assert may_name(both, Reach(districts=D04))


@pytest.mark.parametrize(
    "starts, ends, detail",
    [
        (date(2026, 11, 10), date(2026, 11, 9), "before the first day"),
        (date(2026, 10, 1), date(2026, 11, 1), "already passed"),
        (date(2026, 11, 2), date(2027, 11, 5), "at most a year"),
    ],
)
def test_dates_that_make_no_sense_are_refused(starts, ends, detail):
    with pytest.raises(HTTPException) as refused:
        check_dates(starts, ends, date(2026, 11, 2))
    assert detail in refused.value.detail


def test_good_dates_pass_including_a_single_day_and_one_already_running():
    today = date(2026, 11, 2)
    check_dates(today, today, today)
    check_dates(date(2026, 10, 1), date(2026, 11, 14), today)


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/org/offices"),
        ("POST", "/org-tree/branches/3/chief"),
        ("POST", "/admin/users"),
        ("POST", "/delegations"),
        ("POST", "/delegations/4/cancel"),
        ("POST", "/auth/sessions/revoke-all"),
        ("POST", "/notifications/devices"),
    ],
)
def test_the_keys_stay_with_their_owner_while_acting(method, path):
    assert blocked_while_acting(method, path)


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/assessments/5/review"),
        ("POST", "/shares/3/reviews/4"),
        ("PATCH", "/submissions/501/gisa"),
        ("POST", "/notifications/read"),
        ("POST", "/auth/logout"),
        ("GET", "/org/offices"),
        ("GET", "/auth/me"),
    ],
)
def test_the_work_itself_passes_while_acting(method, path):
    assert not blocked_while_acting(method, path)


class FakeDb:
    """Answers the one query acting asks; remembers what was recorded."""

    def __init__(self, person=None):
        self.info = {}
        self.person = person

    def execute(self, statement, params=None):
        return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: self.person))


MARIA = {"id": 9, "email": "maria@dot.ca.gov", "full_name": "Maria", "metadata_json": None}


def request_as(monkeypatch, *, method="GET", path="/my-forms", delegation=11, person=MARIA, held=("BRANCH_CHIEF", "ADMIN")):
    real = {"id": 7, "email": "sam@dot.ca.gov", "full_name": "Sam", "metadata_json": None, "roles": ["STAFF"]}
    recorded = []
    monkeypatch.setattr(deps, "authenticate", lambda request, db, token: (real, SimpleNamespace(client="web")))
    monkeypatch.setattr(delegations, "running", lambda db, delegate_id, delegator_id: delegation)
    monkeypatch.setattr(delegations, "record_action", lambda db, **fields: recorded.append(fields))
    monkeypatch.setattr(deps, "user_with_roles", lambda db, u: {**u, "roles": list(held) if u["id"] == 9 else ["STAFF"]})
    db = FakeDb(person)
    request = SimpleNamespace(url=SimpleNamespace(path=path), method=method, headers={delegations.ACTING_HEADER: "9"})
    return deps.current_session(request, None, db)[0], recorded, db


def test_acting_judges_the_request_as_the_absent_person(monkeypatch):
    user, _, db = request_as(monkeypatch)
    assert user["id"] == 9
    assert "BRANCH_CHIEF" in user["roles"]
    assert user["acting"]["user_id"] == 7
    assert db.info["acting"]["full_name"] == "Sam"


def test_acting_does_not_pass_on_administrator(monkeypatch):
    user, _, _ = request_as(monkeypatch)
    assert "ADMIN" not in user["roles"]


def test_a_write_while_acting_is_recorded_and_a_read_is_not(monkeypatch):
    _, read, _ = request_as(monkeypatch, method="GET")
    assert read == []
    _, wrote, _ = request_as(monkeypatch, method="POST", path="/assessments/5/review")
    assert wrote == [{"delegation_id": 11, "actor_id": 7, "acting_for": 9, "method": "POST", "path": "/assessments/5/review"}]


def test_acting_stops_when_the_delegation_is_not_running(monkeypatch):
    with pytest.raises(HTTPException) as refused:
        request_as(monkeypatch, delegation=None)
    assert refused.value.status_code == 403
    assert refused.value.detail == delegations.ACTING_ENDED_DETAIL


def test_acting_cannot_change_the_organization(monkeypatch):
    with pytest.raises(HTTPException) as refused:
        request_as(monkeypatch, method="POST", path="/org-tree/branches/3/chief")
    assert refused.value.detail == delegations.ACTING_BLOCKED_DETAIL


def test_without_the_header_someone_is_only_themself(monkeypatch):
    real = {"id": 7, "email": "sam@dot.ca.gov", "full_name": "Sam", "metadata_json": None, "roles": ["STAFF"]}
    monkeypatch.setattr(deps, "authenticate", lambda request, db, token: (real, SimpleNamespace(client="web")))
    monkeypatch.setattr(deps, "user_with_roles", lambda db, u: u)
    request = SimpleNamespace(url=SimpleNamespace(path="/my-forms"), method="GET", headers={})
    user = deps.current_session(request, None, FakeDb())[0]
    assert user["id"] == 7 and "acting" not in user


def acting_db(user_id=7, name="Sam"):
    return SimpleNamespace(info={"acting": {"delegation_id": 1, "user_id": user_id, "full_name": name}})


def test_nobody_signs_off_their_own_work_while_acting():
    with pytest.raises(HTTPException) as refused:
        delegations.refuse_own_work(acting_db(user_id=7), 7)
    assert refused.value.status_code == 403
    delegations.refuse_own_work(acting_db(user_id=7), 8, None)
    delegations.refuse_own_work(SimpleNamespace(info={}), 7)


def test_the_record_names_both_people():
    assert delegations.stamp(acting_db(), {"a": 1}) == {"a": 1, "acted_by": {"user_id": 7, "full_name": "Sam"}}
    assert delegations.stamp(SimpleNamespace(info={}), {"a": 1}) == {"a": 1}
    assert delegations.signed_note(acting_db(), "Fine", "Maria") == "Fine (Sam, acting for Maria)"
    assert delegations.signed_note(acting_db(), None, "Maria") == "Sam, acting for Maria"
    assert delegations.signed_note(SimpleNamespace(info={}), "Fine", "Maria") == "Fine"


def test_a_timeline_row_names_both_people():
    from app.routes.assessments import _actor_label

    assert _actor_label("Maria", '{"acted_by": {"user_id": 7, "full_name": "Sam"}}') == "Sam, acting for Maria"
    assert _actor_label("Maria", {"acted_by": {"full_name": "Sam"}}) == "Sam, acting for Maria"
    assert _actor_label("Maria", None) == "Maria"
    assert _actor_label("Maria", "not json") == "Maria"


def place(position, *, office=1, branch=None):
    return {"position": position, "office_id": office, "branch_id": branch}


OFFICE_CHIEF, BRANCH_CHIEF = place("OFFICE_CHIEF"), place("BRANCH_CHIEF", branch=3)


def test_a_staff_members_supervisor_is_their_branch_chief():
    assert supervises(BRANCH_CHIEF, place("STAFF", branch=3), branch_has_chief=True)
    assert not supervises(BRANCH_CHIEF, place("STAFF", branch=4), branch_has_chief=True), "another branch"


def test_an_office_chief_is_not_bothered_with_staff_who_have_a_branch_chief():
    assert not supervises(OFFICE_CHIEF, place("STAFF", branch=3), branch_has_chief=True)
    assert supervises(OFFICE_CHIEF, place("STAFF", branch=3), branch_has_chief=False), "a branch with no chief"


def test_branch_chiefs_and_senior_specialists_answer_to_their_office_chief():
    assert supervises(OFFICE_CHIEF, place("BRANCH_CHIEF", branch=3), branch_has_chief=True)
    assert supervises(OFFICE_CHIEF, place("SENIOR_SPECIALIST"), branch_has_chief=False)
    assert not supervises(OFFICE_CHIEF, place("SENIOR_SPECIALIST", office=2), branch_has_chief=False), "another office"
    assert not supervises(BRANCH_CHIEF, place("SENIOR_SPECIALIST"), branch_has_chief=False)


def test_nobody_supervises_an_office_chief_or_someone_placed_nowhere():
    assert not supervises(OFFICE_CHIEF, place("OFFICE_CHIEF"), branch_has_chief=False)
    assert not supervises(BRANCH_CHIEF, place("OFFICE_CHIEF"), branch_has_chief=False)
    assert not supervises(OFFICE_CHIEF, place(None, office=None), branch_has_chief=False)
    assert not supervises(place("STAFF", branch=3), place("STAFF", branch=3), branch_has_chief=True)
