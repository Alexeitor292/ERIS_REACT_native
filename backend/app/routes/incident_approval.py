from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from . import event_groups as event_group_routes
from . import incidents as incidents_routes

router = APIRouter(tags=["incidents", "event-groups"])


class IncidentCoordinatorApprovalRequest(BaseModel):
    """Approve a provisional Incident and make its identity historical.

    event_group_id is optional on purpose:
    - supplied: approve into that existing open Event Group
    - omitted with an existing Incident event_group_id: keep that prior decision
    - omitted with no Event Group: ERIS creates a new Event Group automatically
    """

    event_group_id: int | None = Field(default=None, ge=1)
    new_event_group_title: str | None = Field(default=None, max_length=255)
    new_event_group_description: str | None = None
    comment: str | None = Field(default=None, max_length=2000)


def _record_group_move_if_needed(
    *,
    db: Session,
    incident_id: int,
    old_event_group_id: int | None,
    new_event_group_id: int,
    actor_user_id: int,
    notes: str | None,
) -> None:
    if old_event_group_id == new_event_group_id:
        return

    if old_event_group_id is not None:
        event_group_routes._record_event_group_event(
            db,
            event_group_id=old_event_group_id,
            incident_id=incident_id,
            actor_user_id=actor_user_id,
            event_type="INCIDENT_MOVED_OUT",
            notes=notes,
            metadata={"to_event_group_id": new_event_group_id, "reason": "COORDINATOR_APPROVAL"},
        )

    event_group_routes._record_event_group_event(
        db,
        event_group_id=new_event_group_id,
        incident_id=incident_id,
        actor_user_id=actor_user_id,
        event_type="INCIDENT_LINKED" if old_event_group_id is None else "INCIDENT_MOVED_IN",
        notes=notes,
        metadata={"from_event_group_id": old_event_group_id, "reason": "COORDINATOR_APPROVAL"},
    )


@router.post("/incidents/{incident_id}/coordinator/approve")
def coordinator_approve_incident(
    payload: IncidentCoordinatorApprovalRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    group_incident = event_group_routes._incident_row(db, incident_id)
    if not group_incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    incident = incidents_routes._incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident = dict(incident)

    incidents_routes._ensure_incident_district_access(user, incident.get("district"))

    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved Incidents cannot be approved")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(status_code=409, detail="Incident approval is only allowed during coordinator review")
    if group_incident.get("incident_key") is not None:
        raise HTTPException(status_code=409, detail="Incident already has a permanent historical key")
    if incident.get("location_id") is None:
        raise HTTPException(
            status_code=409,
            detail="Select or create a location record before approving this Incident.",
        )

    actor_id = int(user["id"])
    notes = (payload.comment or "").strip() or None
    old_event_group_id = (
        int(group_incident["event_group_id"])
        if group_incident.get("event_group_id") is not None
        else None
    )

    office_code = incident.get("office_code") or incidents_routes._office_for_district(incident.get("district"))
    office_chief_ids = incidents_routes._routing_users_for(
        db=db,
        assignment_type="OFFICE_CHIEF",
        office_code=office_code,
    )
    if not office_chief_ids:
        raise HTTPException(status_code=400, detail="No office chief routing configured for this office")

    try:
        requested_event_group_id = payload.event_group_id
        target_event_group_id: int
        created_event_group = False

        if requested_event_group_id is not None:
            target = event_group_routes._event_group_row(db, int(requested_event_group_id))
            if not target:
                raise HTTPException(status_code=404, detail="Event Group not found")
            target_dict = dict(target)
            event_group_routes._ensure_manage_scope(user, target_dict)
            if str(target_dict["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="Only an open Event Group can accept an Incident")
            target_event_group_id = int(requested_event_group_id)
        elif old_event_group_id is not None:
            target = event_group_routes._event_group_row(db, old_event_group_id)
            if not target or str(target["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="The Incident's selected Event Group is not open")
            target_event_group_id = old_event_group_id
        else:
            target_event_group_id = event_group_routes._create_event_group_for_incident(
                db,
                incident=group_incident,
                actor_user_id=actor_id,
                title=payload.new_event_group_title,
                description=payload.new_event_group_description,
                notes=notes,
            )
            created_event_group = True

        _record_group_move_if_needed(
            db=db,
            incident_id=incident_id,
            old_event_group_id=old_event_group_id,
            new_event_group_id=target_event_group_id,
            actor_user_id=actor_id,
            notes=notes,
        )

        incident_key = str(uuid.uuid4())

        # The linked technical submission is created while the Incident still
        # carries its internal database id. Its lifetime remains attached to the
        # Incident; the permanent incident_key is the historical external identity.
        linked_submission_id = incidents_routes._ensure_linked_submission(
            db=db,
            incident_row=incident,
            assignee_user_id=actor_id,
            actor_user_id=actor_id,
        )

        db.execute(
            text(
                """
                UPDATE incidents
                SET event_group_id = :event_group_id,
                    project_id = :event_group_id,
                    incident_key = :incident_key,
                    approved_at = NOW(),
                    approved_by_user_id = :approved_by,
                    current_stage = 'OFFICE_CHIEF_REVIEW',
                    office_code = :office_code,
                    updated_at = NOW()
                WHERE id = :iid
                  AND current_stage = 'COORDINATOR_REVIEW'
                  AND incident_key IS NULL
                """
            ),
            {
                "iid": incident_id,
                "event_group_id": target_event_group_id,
                "incident_key": incident_key,
                "approved_by": actor_id,
                "office_code": office_code,
            },
        )

        incidents_routes._set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=office_chief_ids[0],
            assigned_by_user_id=actor_id,
            assignment_mode="ASSIGN",
            assignment_stage="OFFICE_CHIEF",
        )
        incidents_routes._queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=office_chief_ids,
            template_code="INCIDENT_OFFICE_CHIEF_REVIEW",
            payload={
                "incident_id": incident_id,
                "incident_key": incident_key,
                "event_group_id": target_event_group_id,
                "office_code": office_code,
                "comment": notes,
            },
        )

        db.commit()

        approved = event_group_routes._incident_row(db, incident_id)
        event_group = event_group_routes._event_group_row(db, target_event_group_id)
        return {
            "incident": event_group_routes._incident_summary(dict(approved)),
            "event_group": event_group_routes._serialize_event_group(dict(event_group)),
            "created_event_group": created_event_group,
            "current_stage": "OFFICE_CHIEF_REVIEW",
            "office_code": office_code,
            "linked_submission_id": linked_submission_id,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
