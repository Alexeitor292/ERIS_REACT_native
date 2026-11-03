"""Out of the office, the app's access rule and moving work, against the real schema.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from datetime import date, timedelta

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db

TODAY = date.today()
NEXT_WEEK = TODAY + timedelta(days=7)


@pytest.fixture(scope="module")
def people(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Delegation")
    away = placed.make("STAFF", "delegation-away")
    stand_in = placed.make("STAFF", "delegation-stand-in")
    guest = placed.account("delegation-guest")
    for person in (away, stand_in, guest):
        person["headers"] = placed.login(person)
    yield {"away": away, "stand_in": stand_in, "guest": guest, "admin": placed.admin}
    placed.cleanup()


def _set(client, people, **over):
    body = {"delegate_user_id": people["stand_in"]["id"], "starts_on": TODAY.isoformat(), "ends_on": NEXT_WEEK.isoformat(), **over}
    return client.post("/delegations", json=body, headers=people["away"]["headers"])


def _acting(people):
    return {**people["stand_in"]["headers"], "X-ERIS-Acting-For": str(people["away"]["id"])}


def test_a_delegation_lets_someone_act_and_ends_when_cancelled(client_db, people):
    made = _set(client_db, people)
    assert made.status_code == 200, made.text
    delegation_id = made.json()["id"]
    try:
        me = client_db.get("/auth/me", headers=people["stand_in"]["headers"]).json()
        assert [o["user_id"] for o in me["acting_options"]] == [people["away"]["id"]]

        acting = client_db.get("/auth/me", headers=_acting(people))
        assert acting.status_code == 200, acting.text
        assert acting.json()["id"] == people["away"]["id"]
        assert acting.json()["acting"]["user_id"] == people["stand_in"]["id"]

        assert _set(client_db, people, starts_on=NEXT_WEEK.isoformat()).status_code == 409, "overlapping dates"

        blocked = client_db.post(f"/delegations/{delegation_id}/cancel", headers=_acting(people))
        assert blocked.status_code == 403, "not while acting"
    finally:
        assert client_db.post(f"/delegations/{delegation_id}/cancel", headers=people["away"]["headers"]).status_code == 200
    ended = client_db.get("/auth/me", headers=_acting(people))
    assert ended.status_code == 403
    assert "no longer acting" in ended.json()["detail"]


def test_a_stranger_cannot_act_for_someone(client_db, people):
    response = client_db.get("/auth/me", headers=_acting(people))
    assert response.status_code == 403


def test_dates_and_people_are_checked(client_db, people):
    backwards = _set(client_db, people, starts_on=NEXT_WEEK.isoformat(), ends_on=TODAY.isoformat())
    assert backwards.status_code == 400
    assert _set(client_db, people, delegate_user_id=people["away"]["id"]).status_code == 400
    assert _set(client_db, people, delegate_user_id=people["guest"]["id"]).status_code == 400, "not placed anywhere"


def test_candidates_are_from_the_same_office(client_db, people):
    found = client_db.get("/delegations/candidates", headers=people["away"]["headers"])
    assert found.status_code == 200, found.text
    ids = {item["id"] for item in found.json()["items"]}
    assert people["stand_in"]["id"] in ids
    assert people["away"]["id"] not in ids
    assert people["guest"]["id"] not in ids


def test_someone_placed_nowhere_is_refused_by_the_app_only(client_db, people, monkeypatch):
    from app import deps
    from app.services import app_access

    monkeypatch.setattr(deps, "may_use_app", app_access.may_use_app)  # conftest turns it off for the others
    refused = client_db.get("/auth/me", headers=people["guest"]["headers"])
    assert refused.status_code == 403
    assert "ERIS Mobile" in refused.json()["detail"]
    assert client_db.post("/auth/logout", headers=people["guest"]["headers"]).status_code in (200, 204)


def test_my_forms_lists_a_form_of_ones_own_on_no_assessment(client_db, people):
    made = client_db.post("/submissions", json={"title": "Zzz delegation form"}, headers=people["away"]["headers"])
    assert made.status_code in (200, 201), made.text
    form_id = made.json()["submission_id"]
    answer = client_db.get("/my-forms", headers=people["away"]["headers"])
    assert answer.status_code == 200, answer.text
    assert form_id in {form["id"] for form in answer.json()["own"]}
    assert form_id not in {form["id"] for form in client_db.get("/my-forms", headers=people["stand_in"]["headers"]).json()["own"]}


def test_the_workload_answers_and_is_for_chiefs(client_db, people):
    answer = client_db.get("/assessments/workload", headers=people["admin"])
    assert answer.status_code == 200, answer.text
    assert set(answer.json()) == {"groups", "left"}
    assert client_db.get("/assessments/workload", headers=people["away"]["headers"]).status_code == 403


def test_moving_says_which_were_refused(client_db, people):
    answer = client_db.post(
        "/assessments/move",
        json={"assessment_ids": [999999999], "to_user_id": people["stand_in"]["id"], "kind": "STAFF"},
        headers=people["admin"],
    )
    assert answer.status_code == 200, answer.text
    assert answer.json()["moved"] == []
    assert answer.json()["failed"][0]["id"] == 999999999
