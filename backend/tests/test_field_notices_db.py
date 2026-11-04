"""District contacts and Immediate Actions delivered, against the real schema.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

import json
import uuid

import pytest
from sqlalchemy import text

from tests.test_workflow_tree import _auth, _create_incident, _login, _me_id

pytestmark = pytest.mark.db


def _rows(sql, **params):
    from app.db import engine

    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(text(sql), params).mappings()]


@pytest.fixture(scope="module")
def who(client_db):
    tokens = {
        "admin": _login(client_db, "mock.admin@dot.ca.gov"),
        "coordinator": _login(client_db, "mock.coordinator.d04@dot.ca.gov"),
        "crew": _login(client_db, "mock.maintenance.crew@dot.ca.gov"),
        "officechief": _login(client_db, "mock.office.chief@dot.ca.gov"),
        "branchchief": _login(client_db, "mock.branch.chief@dot.ca.gov"),
        "staff": _login(client_db, "mock.staff@dot.ca.gov"),
    }
    return {"tokens": tokens, "ids": {key: _me_id(client_db, value) for key, value in tokens.items()}}


def _hand_off(client_db, who, **extra):
    incident = _create_incident(client_db, who["tokens"]["admin"], district="04", county="Marin", route="1")
    answer = client_db.post(
        f"/incidents/{incident}/triage",
        json={"disposition": "ASSESSMENT_REQUIRED", **extra},
        headers=_auth(who["tokens"]["admin"]),
    )
    return incident, answer


def _feed(client_db, token):
    return client_db.get("/notifications?limit=50", headers=_auth(token)).json()["items"]


def test_the_default_is_set_by_an_administrator_and_read_by_the_hand_off(client_db, who):
    coordinator = who["ids"]["coordinator"]
    answer = client_db.put("/district-contacts/04", json={"user_id": coordinator}, headers=_auth(who["tokens"]["admin"]))
    assert answer.status_code == 200, answer.text
    assert answer.json()["default_user_id"] == coordinator
    assert client_db.put("/district-contacts/04", json={"user_id": coordinator}, headers=_auth(who["tokens"]["staff"])).status_code == 403
    assert client_db.put("/district-contacts/04", json={"user_id": who["ids"]["staff"]}, headers=_auth(who["tokens"]["admin"])).status_code == 400

    incident, handed = _hand_off(client_db, who)
    assert handed.status_code == 200, handed.text
    assert _rows("SELECT district_contact_user_id AS c FROM incidents WHERE id = :i", i=incident)[0]["c"] == coordinator


def test_a_hand_off_needs_a_contact_when_the_district_has_people(client_db, who, monkeypatch):
    import importlib

    from app.services import district_contact

    client_db.put("/district-contacts/04", json={"user_id": None}, headers=_auth(who["tokens"]["admin"]))
    source = importlib.util.find_spec("app.services.district_contact")
    fresh = importlib.util.module_from_spec(source)
    source.loader.exec_module(fresh)
    monkeypatch.setattr(district_contact, "choose", fresh.choose)  # conftest turns it off for the others
    _, refused = _hand_off(client_db, who)
    assert refused.status_code == 400
    assert "District Contact" in refused.text
    _, outsider = _hand_off(client_db, who, district_contact_user_id=who["ids"]["staff"])
    assert outsider.status_code == 400


def test_the_contact_fills_the_form_hears_the_milestones_and_cannot_open_the_draft(client_db, who):
    tokens, ids = who["tokens"], who["ids"]
    incident, handed = _hand_off(client_db, who, district_contact_user_id=ids["coordinator"])
    assert handed.status_code == 200, handed.text
    aid = handed.json()["assessment"]["id"]
    assert client_db.post(f"/assessments/{aid}/delegate-branch", json={"branch_chief_user_id": ids["branchchief"]}, headers=_auth(tokens["officechief"])).status_code == 200
    assigned = client_db.post(f"/assessments/{aid}/assign-engineer", json={"engineer_user_id": ids["staff"]}, headers=_auth(tokens["branchchief"]))
    assert assigned.status_code == 200, assigned.text
    form = assigned.json()["assessment"]["submission_id"]

    stored = _rows("SELECT district_contact AS c FROM submission_gisa WHERE submission_id = :s", s=form)[0]["c"]
    assert json.loads(stored)[0]["first_name"]
    titles = [item["title"] for item in _feed(client_db, tokens["coordinator"])]
    assert f"Assessment #{aid} assigned to Staff" in titles
    assert client_db.get(f"/submissions/{form}", headers=_auth(tokens["coordinator"])).status_code == 403

    body = {"actions": ["CLOSE_HIGHWAY_SHOULDER"], "description": "Rocks on the shoulder.", "client_uuid": str(uuid.uuid4())}
    delivered = client_db.post(f"/submissions/{form}/immediate-actions/deliver", json=body, headers=_auth(tokens["staff"]))
    assert delivered.status_code == 200, delivered.text
    assert delivered.json()["supervisor_told"] and delivered.json()["contact_told"]
    for reader in ("coordinator", "branchchief"):
        notice = next(item for item in _feed(client_db, tokens[reader]) if item["kind"] == "IMMEDIATE_ACTIONS")
        assert "Rocks on the shoulder." in notice["body"] and "Close highway shoulder" in notice["body"]
    contact_notice = next(item for item in _feed(client_db, tokens["coordinator"]) if item["kind"] == "IMMEDIATE_ACTIONS")
    assert contact_notice["link"] is None, "nothing to open in the draft"
    assert client_db.get(f"/submissions/{form}", headers=_auth(tokens["coordinator"])).status_code == 403

    # The phone sends it again after a lost answer: nobody is told twice.
    before = len([item for item in _feed(client_db, tokens["branchchief"]) if item["kind"] == "IMMEDIATE_ACTIONS"])
    again = client_db.post(f"/submissions/{form}/immediate-actions/deliver", json=body, headers=_auth(tokens["staff"]))
    assert again.json()["already"] is True
    assert len([item for item in _feed(client_db, tokens["branchchief"]) if item["kind"] == "IMMEDIATE_ACTIONS"]) == before

    # Only someone working on the form, and only immediate actions.
    assert client_db.post(f"/submissions/{form}/immediate-actions/deliver", json={**body, "client_uuid": str(uuid.uuid4())}, headers=_auth(tokens["crew"])).status_code == 403
    wrong = client_db.post(f"/submissions/{form}/immediate-actions/deliver", json={**body, "actions": ["NOPE"], "client_uuid": str(uuid.uuid4())}, headers=_auth(tokens["staff"]))
    assert wrong.status_code == 400
    assert incident
