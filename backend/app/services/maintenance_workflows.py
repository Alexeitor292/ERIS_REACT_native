"""District-scoped duties, independent of job titles and global ERIS roles.

Publishing affects new reports. A run freezes its review path and participants;
managers can explicitly restart an open run on the current revision. No helper
commits: the report, workflow, decision and notices share one transaction.
"""
from __future__ import annotations

import json
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import text

from ..roles import FIELD_REPORTING_ROLES, is_admin
from ..user_metadata import normalize_district_code


class Duty(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    user_ids: list[int]
    report: bool = False
    view_district: bool = False
    edit_report: bool = False


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["REVIEW", "DECISION"] = "REVIEW"
    duty_ids: list[str]
    notify_duty_ids: list[str] = Field(default_factory=list)
    rule: Literal["ANY", "ALL"] = "ANY"
    request_information: bool = True
    # A district can end review early with a maintenance-only outcome.
    allow_maintenance: bool = False
    allow_geotech: bool = False


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manager_user_ids: list[int]
    duties: list[Duty]
    steps: list[Step]
    notify_duty_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_path(self):
        ids = [d.id for d in self.duties]
        if len(ids) != len(set(ids)):
            raise ValueError("Duty identifiers must be unique")
        if not self.manager_user_ids:
            raise ValueError("Choose at least one district workflow manager")
        for users in [self.manager_user_ids, *(d.user_ids for d in self.duties)]:
            if any(uid <= 0 for uid in users) or len(users) != len(set(users)):
                raise ValueError("Choose unique, valid users")
        if not any(d.report and d.user_ids for d in self.duties):
            raise ValueError("Choose at least one person who can report incidents")
        if not self.steps or self.steps[-1].kind != "DECISION":
            raise ValueError("End the workflow with a final decision step")
        if any(s.kind == "DECISION" for s in self.steps[:-1]):
            raise ValueError("The final decision must be the last step")
        known = set(ids)
        for refs in [self.notify_duty_ids, *(s.notify_duty_ids for s in self.steps), *(s.duty_ids for s in self.steps)]:
            if not set(refs) <= known or len(refs) != len(set(refs)):
                raise ValueError("Steps and notifications must use distinct, existing duties")
        for step in self.steps:
            if not users_for(self.model_dump(), step.duty_ids):
                raise ValueError(f"Choose at least one person for {step.name}")
            if step.kind == "REVIEW" and step.allow_geotech:
                raise ValueError("Only the final decision step can send a report to GeoTech")
            if step.kind == "DECISION" and not (step.allow_maintenance or step.allow_geotech):
                raise ValueError("The final decision needs at least one allowed outcome")
        return self


def unpack(value):
    return json.loads(value) if isinstance(value, str) else value


def district_code(value):
    code = normalize_district_code(value)
    if code not in {f"{n:02d}" for n in range(1, 13)}:
        raise HTTPException(422, "Choose a district from 01 to 12")
    return code


def users_for(definition, duty_ids):
    return {uid for duty in definition["duties"] if duty["id"] in duty_ids for uid in duty["user_ids"]}


def capability(definition, uid, permission):
    return any(uid in duty["user_ids"] and duty.get(permission, False) for duty in definition["duties"])


def participants(definition):
    return set(definition["manager_user_ids"]) | {uid for d in definition["duties"] for uid in d["user_ids"]}


def config(db, district, *, lock=False):
    row = db.execute(text("SELECT * FROM maintenance_workflows WHERE district = :d" + (" FOR UPDATE" if lock else "")),
                     {"d": district_code(district)}).mappings().first()
    return {**row, "definition": unpack(row["definition_json"])} if row else None


def run(db, incident_id, *, lock=False):
    row = db.execute(text("SELECT * FROM maintenance_workflow_runs WHERE incident_id = :id" + (" FOR UPDATE" if lock else "")),
                     {"id": incident_id}).mappings().first()
    return {**row, "definition": unpack(row["definition_json"]), "state": unpack(row["state_json"])} if row else None


def can_manage(user, definition):
    return is_admin(user) or int(user["id"]) in definition["manager_user_ids"]


def can_read(user, incident, workflow, *, db=None):
    if not workflow:
        return False
    uid = int(user["id"])
    definition = workflow["definition"]
    if db is not None:
        current = config(db, workflow["district"])
        if current and can_manage(user, current["definition"]):
            return True
    if is_admin(user) or uid == int(incident["reporter_user_id"]) or uid in definition["manager_user_ids"]:
        return True
    # Reporting alone is intentionally not district-wide read access.
    readers = users_for(definition, definition["notify_duty_ids"])
    for step in definition["steps"]:
        readers |= users_for(definition, step["duty_ids"] + step["notify_duty_ids"])
    return uid in readers or capability(definition, uid, "view_district") or capability(definition, uid, "edit_report")


def authorize_report(db, user, district):
    workflow = config(db, district)
    if workflow:
        allowed = is_admin(user) or capability(workflow["definition"], int(user["id"]), "report")
    else:
        allowed = bool(set(user["roles"]) & set(FIELD_REPORTING_ROLES))
    if not allowed:
        raise HTTPException(403, "You do not have reporting duty for this district")
    return workflow


def legacy_action(db, incident_id):
    current = run(db, incident_id)
    if current and not current["outcome"]:
        raise HTTPException(409, "Use this incident's district maintenance workflow")


def event(db, *, district, actor, action, incident_id=None, step_index=None, notes=None, metadata=None):
    db.execute(text("""INSERT INTO maintenance_workflow_events
        (district, incident_id, actor_user_id, action, step_index, notes, metadata_json)
        VALUES (:d, :i, :u, :a, :s, :n, :m)"""),
        {"d": district, "i": incident_id, "u": actor, "a": action, "s": step_index,
         "n": notes, "m": json.dumps(metadata) if metadata is not None else None})


def notify(db, workflow, message, *, entered=False):
    from .notification_feed import add
    definition, state = workflow["definition"], workflow["state"]
    recipients = users_for(definition, definition["notify_duty_ids"])
    if workflow.get("outcome") is None:
        step = definition["steps"][state["step_index"]]
        recipients |= users_for(definition, step["notify_duty_ids"])
        if entered:
            recipients |= users_for(definition, step["duty_ids"])
    add(db, user_ids=recipients, kind="MAINTENANCE_WORKFLOW", title=message,
         body=f"District {int(workflow['district'])} · Incident #{workflow['incident_id']}",
         link=f"/maintenance-work?incident={workflow['incident_id']}", incident_id=workflow["incident_id"])


def start(db, incident_id, district, actor, workflow):
    definition = workflow["definition"]
    state = {"step_index": 0, "approved_user_ids": [], "waiting_reporter": False}
    db.execute(text("""INSERT INTO maintenance_workflow_runs
        (incident_id, district, revision, definition_json, state_json, version)
        VALUES (:i, :d, :r, :p, :s, 1)"""),
        {"i": incident_id, "d": district_code(district), "r": workflow["revision"],
         "p": json.dumps(definition), "s": json.dumps(state)})
    current = {"incident_id": incident_id, "district": district_code(district), "definition": definition,
               "state": state, "outcome": None}
    event(db, district=current["district"], actor=actor, action="REPORTED", incident_id=incident_id,
          metadata={"revision": workflow["revision"]})
    notify(db, current, f"Review needed: {definition['steps'][0]['name']}", entered=True)


def transition(definition, state, uid, action):
    """Pure state transition; ANY/ALL count distinct people, even across duties."""
    state = {**state, "approved_user_ids": list(state["approved_user_ids"])}
    step = definition["steps"][state["step_index"]]
    assignees = users_for(definition, step["duty_ids"])
    if state["waiting_reporter"]:
        raise HTTPException(409, "Waiting for the reporter to supply information")
    if uid not in assignees:
        raise HTTPException(403, "You are not assigned to the current step")
    if action == "REQUEST_INFORMATION":
        if not step["request_information"]:
            raise HTTPException(403, "This step cannot request reporter information")
        state["waiting_reporter"] = True
        state["approved_user_ids"] = []
        state["pending_outcome"] = None
        state.pop("decision", None)
    elif action == "APPROVE":
        if step["kind"] != "REVIEW":
            raise HTTPException(409, "Choose a final outcome for this step")
        if uid in state["approved_user_ids"]:
            raise HTTPException(409, "You already reviewed this step")
        if state.get("pending_outcome"):
            raise HTTPException(409, "A maintenance outcome is awaiting the other reviewers")
        state["approved_user_ids"].append(uid)
        if step["rule"] == "ANY" or assignees <= set(state["approved_user_ids"]):
            state["step_index"] += 1
            state["approved_user_ids"] = []
    elif action in {"MAINTENANCE", "GEOTECH"}:
        if not step[f"allow_{action.lower()}"]:
            raise HTTPException(403, "This outcome is not allowed at the current step")
        if uid in state["approved_user_ids"]:
            raise HTTPException(409, "You already voted at this step")
        if state["approved_user_ids"] and state.get("pending_outcome") != action:
            raise HTTPException(409, "Reviewers must agree on the same outcome")
        state["approved_user_ids"].append(uid)
        state["pending_outcome"] = action
    else:
        raise HTTPException(422, "Unknown workflow action")
    return state


def save_state(db, workflow, state, outcome=None):
    db.execute(text("""UPDATE maintenance_workflow_runs SET state_json = :s,
        outcome = :o, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE incident_id = :i"""),
        {"s": json.dumps(state), "o": outcome, "i": workflow["incident_id"]})


def check_open(workflow, version):
    if not workflow:
        raise HTTPException(404, "This incident does not use a district workflow")
    if workflow["outcome"]:
        raise HTTPException(409, "This maintenance workflow has ended")
    if workflow["version"] != version:
        raise HTTPException(409, "The incident changed. Reload before acting")


def summary(db, uid):
    items = []
    for row in db.execute(text("SELECT district, definition_json FROM maintenance_workflows")).mappings():
        definition = unpack(row["definition_json"])
        if uid in participants(definition):
            items.append({"district": row["district"], "report": capability(definition, uid, "report"),
                          "manage": uid in definition["manager_user_ids"]})
    # People remain able to finish runs from earlier published versions.
    if not items:
        for row in db.execute(text("SELECT DISTINCT district, definition_json FROM maintenance_workflow_runs")).mappings():
            if uid in participants(unpack(row["definition_json"])):
                items.append({"district": row["district"], "report": False, "manage": False})
                break
    return items
