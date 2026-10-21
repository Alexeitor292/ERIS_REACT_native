"""Title-independent maintenance setup and work. All writes check district or step duty."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..roles import ALL_ROLE_NAMES, is_admin
from ..services import maintenance_workflows as mw

router = APIRouter(tags=["maintenance-workflows"])
authenticated = require_roles(ALL_ROLE_NAMES)


class Publish(BaseModel):
    revision: int = Field(ge=0)
    definition: mw.Definition


class Action(BaseModel):
    version: int = Field(ge=1)
    action: Literal["APPROVE", "REQUEST_INFORMATION", "MAINTENANCE", "GEOTECH", "RESUBMIT", "EDIT", "RESTART"]
    notes: str = Field(min_length=1, max_length=4000)
    description: str | None = Field(default=None, max_length=20000)
    event_group_id: int | None = Field(default=None, ge=1)
    new_group_title: str | None = Field(default=None, max_length=255)


def _manager(db, user, district):
    current = mw.config(db, district)
    if not is_admin(user) and (not current or not mw.can_manage(user, current["definition"])):
        raise HTTPException(403, "Only this district's named workflow managers or administrators can change its workflow")
    return current


@router.get("/maintenance-workflows")
def configurations(db: Session = Depends(get_db), user=Depends(authenticated)):
    rows = {r["district"]: dict(r) for r in db.execute(text("SELECT * FROM maintenance_workflows")).mappings()}
    result = []
    for n in range(1, 13):
        district = f"{n:02d}"
        row = rows.get(district)
        definition = mw.unpack(row["definition_json"]) if row else None
        people = []
        if definition:
            people = [dict(p) for p in db.execute(text("SELECT id, full_name, email, is_active FROM users WHERE id IN :ids")
                .bindparams(bindparam("ids", expanding=True)), {"ids": sorted(mw.participants(definition))}).mappings()]
        result.append({"district": district, "revision": row["revision"] if row else 0,
                       "definition": definition, "people": people, "can_manage": is_admin(user) or bool(definition and mw.can_manage(user, definition))})
    return {"districts": result}


@router.get("/maintenance-workflows/{district}/people")
def people(district: str, q: str = Query(default="", max_length=80), db: Session = Depends(get_db), user=Depends(authenticated)):
    from ..services.org_tree import search_people
    _manager(db, user, district)
    return {"items": search_people(db, q)}


@router.put("/maintenance-workflows/{district}")
def publish(district: str, payload: Publish, db: Session = Depends(get_db), user=Depends(authenticated)):
    district = mw.district_code(district)
    try:
        current = mw.config(db, district, lock=True)
        _manager(db, user, district)
        revision = current["revision"] if current else 0
        if revision != payload.revision:
            raise HTTPException(409, "Another manager changed this workflow. Reload before saving")
        definition = payload.definition.model_dump()
        users = mw.participants(definition)
        active = set(db.execute(text("SELECT id FROM users WHERE id IN :ids AND is_active = 1")
                               .bindparams(bindparam("ids", expanding=True)), {"ids": sorted(users)}).scalars())
        if users - active:
            raise HTTPException(422, "Every assigned person must be an active ERIS user")
        values = {"d": district, "r": revision + 1, "p": json.dumps(definition), "u": int(user["id"])}
        if current:
            db.execute(text("""UPDATE maintenance_workflows SET revision = :r, definition_json = :p,
                updated_by_user_id = :u, updated_at = CURRENT_TIMESTAMP WHERE district = :d"""), values)
        else:
            db.execute(text("""INSERT INTO maintenance_workflows
                (district, revision, definition_json, updated_by_user_id) VALUES (:d, :r, :p, :u)"""), values)
        mw.event(db, district=district, actor=int(user["id"]), action="WORKFLOW_PUBLISHED",
                 metadata={"revision": revision + 1, "definition": definition})
        db.commit()
        return {"district": district, "revision": revision + 1, "definition": definition, "can_manage": mw.can_manage(user, definition)}
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Another manager created this workflow. Reload before saving")
    except Exception:
        db.rollback()
        raise


def _payload(db, incident, workflow, user):
    uid = int(user["id"])
    definition, state = workflow["definition"], workflow["state"]
    step = definition["steps"][state["step_index"]]
    current = mw.config(db, workflow["district"])
    manager = bool(current and mw.can_manage(user, current["definition"]))
    events = db.execute(text("""SELECT e.id, e.action, e.step_index, e.notes, e.created_at, u.full_name AS actor_name
        FROM maintenance_workflow_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.incident_id = :i ORDER BY e.id"""), {"i": incident["id"]}).mappings().all()
    assigned_ids = mw.users_for(definition, step["duty_ids"])
    assigned = db.execute(text("SELECT id, full_name, is_active FROM users WHERE id IN :ids")
                          .bindparams(bindparam("ids", expanding=True)), {"ids": sorted(assigned_ids)}).mappings().all()
    groups = db.execute(text("SELECT id, title FROM event_groups WHERE district = :d AND status = 'OPEN' ORDER BY id DESC"),
                        {"d": workflow["district"]}).mappings().all() if step["allow_geotech"] else []
    return {"incident_id": incident["id"], "district": workflow["district"], "revision": workflow["revision"],
            "version": workflow["version"], "state": state, "outcome": workflow["outcome"], "step": step,
            "steps": [{"name": s["name"], "kind": s["kind"]} for s in definition["steps"]],
            "assigned": [dict(p) for p in assigned], "events": [dict(e) for e in events], "groups": [dict(g) for g in groups],
            "can_act": not workflow["outcome"] and not state["waiting_reporter"] and uid in assigned_ids and uid not in state["approved_user_ids"],
            "can_edit": not workflow["outcome"] and (uid == incident["reporter_user_id"] or mw.capability(definition, uid, "edit_report")),
            "can_resubmit": not workflow["outcome"] and state["waiting_reporter"] and uid == incident["reporter_user_id"],
            "can_restart": not workflow["outcome"] and manager}


@router.get("/maintenance-work/incidents")
def work(db: Session = Depends(get_db), user=Depends(authenticated)):
    # Scan only this narrow workflow table; no broad operational read role is granted.
    rows = db.execute(text("""SELECT i.id, i.title, i.reporter_user_id, i.district, i.status,
        i.created_at, r.revision, r.version, r.outcome, r.definition_json, r.state_json
        FROM maintenance_workflow_runs r JOIN incidents i ON i.id = r.incident_id
        ORDER BY i.id DESC""")).mappings()
    result = []
    for row in rows:
        workflow = {**row, "definition": mw.unpack(row["definition_json"]), "state": mw.unpack(row["state_json"])}
        if mw.can_read(user, row, workflow, db=db):
            step = workflow["definition"]["steps"][workflow["state"]["step_index"]]
            result.append({"id": row["id"], "title": row["title"], "district": row["district"], "outcome": row["outcome"],
                           "step_name": step["name"], "waiting_reporter": workflow["state"]["waiting_reporter"],
                           "my_turn": not row["outcome"] and ((workflow["state"]["waiting_reporter"] and row["reporter_user_id"] == int(user["id"])) or
                           (not workflow["state"]["waiting_reporter"] and int(user["id"]) in mw.users_for(workflow["definition"], step["duty_ids"]) and int(user["id"]) not in workflow["state"]["approved_user_ids"]))})
    return {"items": result}


@router.get("/maintenance-work/incidents/{incident_id}")
def detail(incident_id: int, db: Session = Depends(get_db), user=Depends(authenticated)):
    workflow = mw.run(db, incident_id)
    incident = db.execute(text("SELECT id, reporter_user_id FROM incidents WHERE id = :i"), {"i": incident_id}).mappings().first()
    if not incident or not mw.can_read(user, incident, workflow, db=db):
        raise HTTPException(404, "Maintenance report not found")
    return _payload(db, incident, workflow, user)


@router.post("/maintenance-work/incidents/{incident_id}/actions")
def act(incident_id: int, payload: Action, db: Session = Depends(get_db), user=Depends(authenticated)):
    from . import assessments as assessments_routes
    from . import incidents as incidents_routes
    from . import event_groups
    from ..schemas.common import IncidentTriageRequest
    try:
        workflow = mw.run(db, incident_id, lock=True)
        mw.check_open(workflow, payload.version)
        incident = incidents_routes._incident_with_assignment(db, incident_id)
        if not incident or not mw.can_read(user, incident, workflow, db=db):
            raise HTTPException(404, "Maintenance report not found")
        notes = payload.notes.strip()
        if not notes:
            raise HTTPException(422, "Describe the review or decision")
        uid = int(user["id"])
        state, definition = workflow["state"], workflow["definition"]
        old_step = state["step_index"]
        outcome = None
        if payload.action == "RESTART":
            current = _manager(db, user, workflow["district"])
            if not current:
                raise HTTPException(409, "Configure the district workflow first")
            definition = current["definition"]
            state = {"step_index": 0, "approved_user_ids": [], "waiting_reporter": False}
            db.execute(text("UPDATE maintenance_workflow_runs SET definition_json = :p, revision = :r WHERE incident_id = :i"),
                       {"p": json.dumps(definition), "r": current["revision"], "i": incident_id})
            workflow["definition"] = definition
        elif payload.action in {"RESUBMIT", "EDIT"}:
            reporter = uid == int(incident["reporter_user_id"])
            if payload.action == "RESUBMIT" and not (reporter and state["waiting_reporter"]):
                raise HTTPException(403, "Only the reporter may resubmit requested information")
            if payload.action == "EDIT" and not (reporter or mw.capability(definition, uid, "edit_report")):
                raise HTTPException(403, "You do not have report editing duty")
            if payload.description is not None:
                db.execute(text("UPDATE incidents SET description = :d, updated_at = CURRENT_TIMESTAMP WHERE id = :i"),
                           {"d": payload.description, "i": incident_id})
            # A review must never stand for report content somebody later changed.
            if payload.action == "RESUBMIT" or payload.description is not None:
                state = {"step_index": 0, "waiting_reporter": False, "approved_user_ids": []}
        else:
            state = mw.transition(definition, state, uid, payload.action)
            if payload.action in {"MAINTENANCE", "GEOTECH"}:
                decision = {"event_group_id": payload.event_group_id, "new_group_title": payload.new_group_title}
                if workflow["state"].get("decision") and workflow["state"]["decision"] != decision:
                    raise HTTPException(409, "Use the same Incident Group as the first decision maker")
                state["decision"] = decision
                step = definition["steps"][old_step]
                complete = step["rule"] == "ANY" or mw.users_for(definition, step["duty_ids"]) <= set(state["approved_user_ids"])
                if complete:
                    outcome = payload.action
                    if outcome == "GEOTECH":
                        # Existing groups must belong to this district; a maintenance
                        # duty never confers statewide group management.
                        if payload.event_group_id:
                            group = event_groups._event_group_row(db, payload.event_group_id)
                            if not group or mw.district_code(group["district"]) != workflow["district"]:
                                raise HTTPException(403, "Choose an Incident Group in this district")
                        event_groups.apply_incident_event_group(db,
                            incident=event_groups._incident_row(db, incident_id), actor_user_id=uid,
                            mode="EXISTING" if payload.event_group_id else "CREATE_NEW",
                            event_group_id=payload.event_group_id, title=payload.new_group_title or incident["title"],
                            description=None, notes=notes)
                        assessments_routes._triage_assessment_required(db, incident, user,
                            IncidentTriageRequest(disposition="ASSESSMENT_REQUIRED", notes=notes), notes)
                    else:
                        assessments_routes._triage_no_assessment(db, incident, uid, notes)
        mw.save_state(db, workflow, state, outcome)
        mw.event(db, district=workflow["district"], actor=uid, action=payload.action, incident_id=incident_id,
                 step_index=old_step, notes=notes, metadata={"version": payload.version, "outcome": outcome})
        updated = {**workflow, "state": state, "outcome": outcome}
        mw.notify(db, updated, f"Maintenance report: {payload.action.replace('_', ' ').lower()}",
                  entered=state["step_index"] != old_step or payload.action in {"RESUBMIT", "RESTART"})
        if payload.action == "REQUEST_INFORMATION":
            from ..services.notification_feed import add
            add(db, [incident["reporter_user_id"]], kind="MAINTENANCE_WORKFLOW", title="More report information needed",
                body=notes, link=f"/maintenance-work?incident={incident_id}", incident_id=incident_id)
        db.commit()
        return detail(incident_id, db, user)
    except Exception:
        db.rollback()
        raise
