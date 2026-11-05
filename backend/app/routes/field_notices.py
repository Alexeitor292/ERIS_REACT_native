"""District contacts, and Immediate Actions delivered from a form still in draft.

* ``GET /district-contacts/{district}`` — who can be named, and the default.
* ``PUT /district-contacts/{district}`` — set the district's default.
* ``POST /submissions/{id}/immediate-actions/deliver`` — tell the supervisor of the
  person filling out the form, and the District Contact, which immediate actions
  were taken and why. It is the one thing a draft may send. The notice carries what
  they need, and gives no access to the form.
"""
from __future__ import annotations

from datetime import datetime
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..constants.gisa_lookups import GISA_ACTION_LUT
from ..db import get_db
from ..deps import deny_public_only_unless_maintenance_duty, require_roles
from ..roles import GISA_AUTHOR_ROLES
from ..services import district_contact, notification_feed
from ..services.gisa_validation import validate_action_code_group
from . import incidents as incidents_routes

router = APIRouter(tags=["field notices"])

ACTION_LABELS = {item["code"]: item["label"] for item in GISA_ACTION_LUT}
# A late notice says so: the person reading it has to know what they are looking at.
LATE_AFTER_SECONDS = 300


class DistrictContactRequest(BaseModel):
    user_id: int | None = Field(default=None, ge=1)


class ImmediateDelivery(BaseModel):
    actions: list[str] = Field(..., min_length=1, max_length=20)
    description: str = Field(..., max_length=800)
    # Written by the phone once: sending it again, after a lost answer, changes nothing.
    client_uuid: str = Field(..., min_length=36, max_length=36)
    written_at: datetime | None = None


@router.get("/district-contacts/{district}")
def district_contacts(district: str, db: Session = Depends(get_db), user=Depends(deny_public_only_unless_maintenance_duty)) -> dict[str, Any]:
    return district_contact.overview(db, user, district)


@router.put("/district-contacts/{district}")
def set_district_contact(
    district: str,
    payload: DistrictContactRequest,
    db: Session = Depends(get_db),
    user=Depends(deny_public_only_unless_maintenance_duty),
) -> dict[str, Any]:
    district_contact.set_default(db, user, district, payload.user_id)
    db.commit()
    return district_contact.overview(db, user, district)


def supervisors_of(db: Session, assessment: dict | None) -> list[int]:
    """Who the person filling out the form answers to, on this assessment's route."""
    if not assessment:
        return []
    if assessment.get("routing_path") == "BRANCH":
        return [int(assessment["branch_chief_user_id"])] if assessment.get("branch_chief_user_id") else []
    if assessment.get("routing_path") == "SENIOR_ENGINEER":
        return incidents_routes._routing_users_for(db=db, assignment_type="OFFICE_CHIEF", office_code=assessment.get("office_code"))
    return []


def notice_text(labels: list[str], description: str, written_at: datetime | None, sent_at: datetime) -> str:
    late = written_at is not None and (sent_at - written_at).total_seconds() > LATE_AFTER_SECONDS
    written = f" Written {written_at:%b} {written_at.day}, {written_at:%-I:%M %p}, with no connection." if late else ""
    return f"{', '.join(labels)}. {description}{written}"[:1000]


@router.post("/submissions/{submission_id}/immediate-actions/deliver")
def deliver_immediate_actions(
    payload: ImmediateDelivery,
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict[str, Any]:
    from ..main import get_gisa, get_submission_status, linked_assessment_for_submission, require_can_edit_submission  # the app module imports this router

    require_can_edit_submission(submission_id, db, user)
    status = get_submission_status(db, submission_id)
    if status not in {"DRAFT", "REJECTED", "SUBMITTED"}:
        raise HTTPException(status_code=409, detail="This form is finished. Immediate Actions are delivered while it is in progress.")
    description = payload.description.strip()
    if not description:
        raise HTTPException(status_code=422, detail="Say what happened before delivering.")
    codes = list(dict.fromkeys(code.strip() for code in payload.actions))
    for code in codes:
        validate_action_code_group(code, "IMMEDIATE")

    existing = db.execute(
        text("SELECT id FROM immediate_action_deliveries WHERE client_uuid = :u"), {"u": payload.client_uuid}
    ).scalar()
    if existing is not None:
        return {"delivered": True, "already": True, "told": []}

    labels = [ACTION_LABELS.get(code, code) for code in codes]
    assessment = linked_assessment_for_submission(db, submission_id)
    incident_id = int(assessment["incident_id"]) if assessment else None
    contact = district_contact.contact_of(db, incident_id) if incident_id is not None else None
    supervisors = [uid for uid in supervisors_of(db, assessment) if uid != contact]
    gisa = get_gisa(db, submission_id) or {}
    place = "-".join(str(gisa[key]).strip() for key in ("district", "county", "route", "post_mile") if gisa.get(key))
    title = f"Immediate actions: {place or f'form #{submission_id}'}"
    written_at = payload.written_at.replace(tzinfo=None) if payload.written_at else None
    body = notice_text(labels, description, written_at, datetime.now())
    db.execute(
        text("""
            INSERT INTO immediate_action_deliveries (submission_id, actor_user_id, client_uuid, actions_json, description, written_at)
            VALUES (:sid, :actor, :uuid, :actions, :description, :written)
        """),
        {"sid": submission_id, "actor": int(user["id"]), "uuid": payload.client_uuid,
         "actions": json.dumps(codes), "description": description, "written": written_at},
    )
    # The form keeps its own record, as its Actions step shows it.
    db.execute(
        text("""
            INSERT INTO workflow_events (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES (:sid, :actor, 'COORDINATOR_NOTIFIED', :status, :status, :comment)
        """),
        {"sid": submission_id, "actor": int(user["id"]), "status": status,
         "comment": f"Immediate actions: {', '.join(codes)} | Message: {description}"},
    )
    # A supervisor can open the assessment; the contact reads it all in the notice.
    if supervisors:
        notification_feed.add(
            db, supervisors, kind="IMMEDIATE_ACTIONS", title=title, body=body, actor_id=int(user["id"]), incident_id=incident_id,
            link=f"/my-work?assessment={int(assessment['id'])}",
        )
    if contact is not None:
        notification_feed.add(db, [contact], kind="IMMEDIATE_ACTIONS", title=title, body=body, actor_id=int(user["id"]), incident_id=incident_id)
    db.commit()
    told = [uid for uid in [*supervisors, *([contact] if contact is not None else [])] if uid != int(user["id"])]
    return {"delivered": True, "already": False, "told": told, "supervisor_told": bool(supervisors), "contact_told": contact is not None}
