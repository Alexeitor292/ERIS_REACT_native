"""Duty authorization and workflow persistence, without a running MariaDB.

SQLite exercises the real SQL and transaction boundaries. Its test connection
strips FOR UPDATE (MariaDB supplies the production row lock); stale versions
are independently tested. Existing assessment routing is mocked only at the
handoff boundary, with rollback tested when that boundary fails.
"""
import copy
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from app.routes import maintenance_workflows as routes
from app.services import maintenance_workflows as mw


def user(uid, roles=None):
    return {"id": uid, "roles": roles or ["GUEST"]}


@pytest.fixture
def plan():
    return mw.Definition.model_validate({
        "manager_user_ids": [1],
        "duties": [
            {"id": "report", "name": "Reporting supervisors", "user_ids": [2, 3], "report": True},
            {"id": "review", "name": "First review", "user_ids": [4, 5]},
            {"id": "decision", "name": "Decision duty", "user_ids": [6, 7]},
            {"id": "notify", "name": "Keep informed", "user_ids": [8]},
        ],
        "notify_duty_ids": ["notify"],
        "steps": [
            {"name": "Supervisor review", "kind": "REVIEW", "duty_ids": ["review"], "rule": "ALL"},
            {"name": "Repair decision", "kind": "DECISION", "duty_ids": ["decision"], "rule": "ALL", "allow_geotech": True, "allow_maintenance": True},
        ],
    }).model_dump()


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "before_cursor_execute", retval=True)
    def sqlite_lock(_conn, _cursor, statement, params, _context, _many):
        return statement.replace(" FOR UPDATE", ""), params

    schema = [
        "CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, is_active INT)",
        "CREATE TABLE maintenance_workflows (district TEXT PRIMARY KEY, revision INT, definition_json TEXT, updated_by_user_id INT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE maintenance_workflow_runs (incident_id INT PRIMARY KEY, district TEXT, revision INT, definition_json TEXT, state_json TEXT, version INT, outcome TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE maintenance_workflow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, district TEXT, incident_id INT, actor_user_id INT, action TEXT, step_index INT, notes TEXT, metadata_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE incidents (id INTEGER PRIMARY KEY, reporter_user_id INT, title TEXT, district TEXT, description TEXT, status TEXT, updated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE event_groups (id INTEGER PRIMARY KEY, title TEXT, district TEXT, status TEXT)",
    ]
    with Session(engine) as session:
        for statement in schema:
            session.execute(text(statement))
        for uid in range(1, 12):
            session.execute(text("INSERT INTO users VALUES (:id, :name, :email, 1)"),
                            {"id": uid, "name": f"Person {uid}", "email": f"{uid}@example.test"})
        session.execute(text("INSERT INTO incidents (id, reporter_user_id, title, district, description, status) VALUES (10, 2, 'Report', '03', 'Original', 'NEW')"))
        session.commit()
        notices = []
        monkeypatch.setattr("app.services.notification_feed.add", lambda _db, user_ids, **kw: notices.append((set(user_ids), kw)))
        session.info["notices"] = notices
        monkeypatch.setattr("app.routes.incidents._incident_with_assignment", lambda db, iid: db.execute(text("SELECT * FROM incidents WHERE id = :i"), {"i": iid}).mappings().first())
        yield session
    engine.dispose()


def publish(db, plan, district="03", revision=0, actor=None):
    return routes.publish(district, routes.Publish(revision=revision, definition=plan), db, actor or user(1, ["ADMIN"]))


def start(db, plan):
    publish(db, plan)
    mw.start(db, 10, "03", 2, mw.config(db, "03"))
    db.commit()
    return mw.run(db, 10)


def act(db, uid, action, **kwargs):
    current = mw.run(db, 10)
    return routes.act(10, routes.Action(version=current["version"], action=action, notes="Checked the report", **kwargs), db, user(uid))


def test_managers_are_district_scoped_not_titles(db, plan):
    with pytest.raises(HTTPException) as exc:
        publish(db, plan, actor=user(1, ["MAINTENANCE_COORDINATOR"]))
    assert exc.value.status_code == 403
    publish(db, plan)
    assert publish(db, plan, revision=1, actor=user(1))["revision"] == 2
    with pytest.raises(HTTPException):
        publish(db, plan, district="04", actor=user(1))
    with pytest.raises(HTTPException):
        publish(db, plan, revision=2, actor=user(4, ["OFFICE_CHIEF"]))


def test_publication_conflicts_and_inactive_people(db, plan):
    publish(db, plan)
    with pytest.raises(HTTPException) as exc:
        publish(db, plan)
    assert exc.value.status_code == 409
    db.execute(text("UPDATE users SET is_active = 0 WHERE id = 6")); db.commit()
    with pytest.raises(HTTPException) as exc:
        publish(db, plan, revision=1)
    assert exc.value.status_code == 422
    assert mw.config(db, "03")["revision"] == 1


@pytest.mark.parametrize("change", [
    lambda p: p.update(manager_user_ids=[]),
    lambda p: p["duties"][0].update(report=False),
    lambda p: p["steps"][-1].update(duty_ids=[]),
    lambda p: p["steps"][0].update(allow_geotech=True),
    lambda p: p["steps"][0].update(duty_ids=["missing"]),
    lambda p: p["steps"][-1].update(allow_geotech=False, allow_maintenance=False),
    lambda p: p["duties"][1].update(user_ids=[4, 4]),
    lambda p: p["steps"][0].update(kind="DECISION"),
])
def test_invalid_paths_fail_before_publication(plan, change):
    change(plan)
    with pytest.raises(ValidationError):
        mw.Definition.model_validate(plan)


def test_report_permission_is_title_independent(db, plan):
    publish(db, plan)
    assert mw.authorize_report(db, user(2), "3")
    for actor in [user(6), user(9, ["STAFF"]), user(9, ["MAINTENANCE_CREW"])]:
        with pytest.raises(HTTPException):
            mw.authorize_report(db, actor, "03")
    assert mw.authorize_report(db, user(9, ["STAFF"]), "04") is None


def test_reporters_cannot_read_other_reports_and_notifications_do_not_grant_actions(db, plan):
    workflow = start(db, plan)
    incident = {"reporter_user_id": 2}
    assert mw.can_read(user(2), incident, workflow)
    assert not mw.can_read(user(3), incident, workflow)
    assert mw.can_read(user(8), incident, workflow)
    assert not mw.can_read(user(9, ["MAINTENANCE_COORDINATOR"]), incident, workflow)
    with pytest.raises(HTTPException):
        mw.transition(plan, workflow["state"], 8, "APPROVE")
    assert db.info["notices"][0][0] == {4, 5, 8}


def test_all_reviews_are_unique_and_final_people_cannot_skip_steps(db, plan):
    workflow = start(db, plan)
    state = workflow["state"]
    with pytest.raises(HTTPException):
        mw.transition(plan, state, 6, "GEOTECH")
    assert act(db, 4, "APPROVE")["state"]["step_index"] == 0
    with pytest.raises(HTTPException):
        act(db, 4, "APPROVE")
    result = act(db, 5, "APPROVE")
    assert result["state"]["step_index"] == 1
    assert result["state"]["approved_user_ids"] == []
    assert state["approved_user_ids"] == []  # Pure transition did not mutate its input.


def test_any_review_advances_and_overlapping_duties_count_each_person_once(plan):
    plan["steps"][0]["rule"] = "ANY"
    state = {"step_index": 0, "approved_user_ids": [], "waiting_reporter": False}
    assert mw.transition(plan, state, 4, "APPROVE")["step_index"] == 1
    plan["steps"][0]["rule"] = "ALL"
    plan["duties"].append({**plan["duties"][1], "id": "also", "user_ids": [4]})
    plan["steps"][0]["duty_ids"].append("also")
    state = mw.transition(plan, state, 4, "APPROVE")
    assert mw.transition(plan, state, 5, "APPROVE")["step_index"] == 1


def test_configurable_early_maintenance_outcome_and_no_early_geotech(plan):
    plan["steps"][0]["allow_maintenance"] = True
    state = {"step_index": 0, "approved_user_ids": [], "waiting_reporter": False}
    assert mw.transition(plan, state, 4, "MAINTENANCE")["pending_outcome"] == "MAINTENANCE"
    with pytest.raises(HTTPException):
        mw.transition(plan, state, 4, "GEOTECH")


def test_request_information_and_resubmission_restart_reviews(db, plan):
    start(db, plan)
    act(db, 4, "APPROVE")
    result = act(db, 5, "REQUEST_INFORMATION")
    assert result["state"]["waiting_reporter"]
    assert result["state"]["approved_user_ids"] == []
    with pytest.raises(HTTPException):
        act(db, 4, "APPROVE")
    with pytest.raises(HTTPException):
        act(db, 3, "RESUBMIT", description="Not my report")
    result = act(db, 2, "RESUBMIT", description="Added road condition")
    assert not result["state"]["waiting_reporter"]
    assert db.execute(text("SELECT description FROM incidents WHERE id = 10")).scalar() == "Added road condition"
    assert any(2 in recipients for recipients, _ in db.info["notices"])
    # Every notice opens the report in My Work, where maintenance reports wait.
    assert {notice["link"] for _, notice in db.info["notices"]} == {"/my-work?maintenance=10"}


def test_stale_action_and_completed_run_refuse_writes(db, plan, monkeypatch):
    workflow = start(db, plan)
    act(db, 4, "APPROVE")
    with pytest.raises(HTTPException) as exc:
        routes.act(10, routes.Action(version=workflow["version"], action="APPROVE", notes="Stale"), db, user(5))
    assert exc.value.status_code == 409
    act(db, 5, "APPROVE")
    monkeypatch.setattr("app.routes.assessments._triage_no_assessment", lambda *_args: None)
    act(db, 6, "MAINTENANCE")
    assert mw.run(db, 10)["outcome"] is None
    act(db, 7, "MAINTENANCE")
    assert mw.run(db, 10)["outcome"] == "MAINTENANCE"
    with pytest.raises(HTTPException):
        act(db, 2, "EDIT", description="After decision")


def test_handoff_waits_for_unanimity_and_is_transactional(db, plan, monkeypatch):
    start(db, plan); act(db, 4, "APPROVE"); act(db, 5, "APPROVE")
    calls = []
    monkeypatch.setattr("app.routes.event_groups._incident_row", lambda db, iid: {"id": iid})
    def group(db, **kwargs):
        db.execute(text("INSERT INTO event_groups VALUES (20, 'Group', '03', 'OPEN')"))
        calls.append("group")
    monkeypatch.setattr("app.routes.event_groups.apply_incident_event_group", group)
    def fail(*_args):
        raise HTTPException(409, "Destination not configured")
    monkeypatch.setattr("app.routes.assessments._triage_assessment_required", fail)
    act(db, 6, "GEOTECH", new_group_title="Group")
    assert not calls
    before = mw.run(db, 10)
    with pytest.raises(HTTPException):
        act(db, 7, "GEOTECH", new_group_title="Different group")
    with pytest.raises(HTTPException):
        act(db, 7, "GEOTECH", new_group_title="Group")
    assert db.execute(text("SELECT COUNT(*) FROM event_groups")).scalar() == 0
    assert mw.run(db, 10)["version"] == before["version"]
    monkeypatch.setattr("app.routes.assessments._triage_assessment_required", lambda *_args: calls.append("assessment"))
    act(db, 7, "GEOTECH", new_group_title="Group")
    assert mw.run(db, 10)["outcome"] == "GEOTECH"
    assert calls[-2:] == ["group", "assessment"]


def test_snapshot_survives_publication_and_manager_can_explicitly_restart(db, plan):
    start(db, plan); act(db, 4, "APPROVE")
    changed = copy.deepcopy(plan)
    changed["manager_user_ids"] = [9]
    changed["duties"][1]["user_ids"] = [10]
    publish(db, changed, revision=1)
    assert mw.run(db, 10)["definition"] == plan
    assert mw.can_read(user(9), {"reporter_user_id": 2}, mw.run(db, 10), db=db)
    result = act(db, 9, "RESTART")
    assert result["revision"] == 2
    assert result["state"]["approved_user_ids"] == []
    assert mw.run(db, 10)["definition"]["duties"][1]["user_ids"] == [10]
    with pytest.raises(HTTPException):
        act(db, 4, "APPROVE")
    assert act(db, 10, "APPROVE")["state"]["step_index"] == 1


def test_legacy_coordinator_action_cannot_bypass_workflow(db, plan):
    start(db, plan)
    from app.routes.assessments import triage_incident
    from app.schemas.common import IncidentTriageRequest
    with pytest.raises(HTTPException) as exc:
        triage_incident(IncidentTriageRequest(disposition="NO_ASSESSMENT_REQUIRED"), 10, db, user(9, ["MAINTENANCE_COORDINATOR"]))
    assert exc.value.status_code == 409
    assert mw.run(db, 10)["outcome"] is None


def test_only_assigned_records_appear_in_queue(db, plan):
    start(db, plan)
    assert len(routes.work(db, user(2))["items"]) == 1
    assert routes.work(db, user(3))["items"] == []
    assert routes.work(db, user(9, ["MAINTENANCE_COORDINATOR"]))["items"] == []
    assert routes.work(db, user(4))["items"][0]["my_turn"]
    assert not routes.work(db, user(8))["items"][0]["my_turn"]


def test_notification_only_workflow_members_have_their_own_feed(db, plan):
    publish(db, plan)
    from app.routes.notifications import notification_user
    assert notification_user(db, user(8))["id"] == 8
    with pytest.raises(HTTPException):
        notification_user(db, user(11))


def test_old_tree_endpoint_cannot_restore_title_based_access(db, plan):
    start(db, plan)
    from app.routes.workflow_tree import _ensure_workflow_tree_access
    incident = {"id": 10, "reporter_user_id": 2}
    _ensure_workflow_tree_access(user(4), incident, db=db)
    with pytest.raises(HTTPException) as exc:
        _ensure_workflow_tree_access(user(9, ["OFFICE_CHIEF"]), incident, db=db)
    assert exc.value.status_code == 404
