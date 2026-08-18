from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from . import event_groups as event_group_routes

router = APIRouter(tags=["event-groups"])


class EventGroupLifecycleRequest(BaseModel):
    notes: str | None = Field(default=None, max_length=2000)


@router.post("/event-groups/{event_group_id}/close")
def close_event_group(
    payload: EventGroupLifecycleRequest,
    event_group_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(event_group_routes.EVENT_GROUP_MANAGE_ROLES)),
):
    row = event_group_routes._event_group_row(db, event_group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Event Group not found")
    event_group = dict(row)
    event_group_routes._ensure_manage_scope(user, event_group)

    status = str(event_group["status"]).upper()
    if status == "ARCHIVED":
        raise HTTPException(status_code=409, detail="Archived Event Groups cannot be closed or reopened")
    if status == "CLOSED":
        return {"event_group": event_group_routes._serialize_event_group(event_group), "changed": False}

    active_count = int(event_group.get("open_incident_count") or 0)
    if active_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Event Group cannot be closed while {active_count} active Incident{'s' if active_count != 1 else ''} remain",
        )

    notes = (payload.notes or "").strip() or None
    try:
        db.execute(
            text(
                """
                UPDATE event_groups
                SET status = 'CLOSED',
                    closed_at = NOW(),
                    closed_by_user_id = :uid,
                    updated_at = NOW()
                WHERE id = :egid AND status = 'OPEN'
                """
            ),
            {"egid": event_group_id, "uid": int(user["id"])},
        )
        event_group_routes._record_event_group_event(
            db,
            event_group_id=event_group_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="EVENT_GROUP_CLOSED",
            notes=notes,
            metadata={"active_incident_count": 0},
        )
        db.commit()
        updated = event_group_routes._event_group_row(db, event_group_id)
        return {"event_group": event_group_routes._serialize_event_group(dict(updated)), "changed": True}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/event-groups/{event_group_id}/reopen")
def reopen_event_group(
    payload: EventGroupLifecycleRequest,
    event_group_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(event_group_routes.EVENT_GROUP_MANAGE_ROLES)),
):
    row = event_group_routes._event_group_row(db, event_group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Event Group not found")
    event_group = dict(row)
    event_group_routes._ensure_manage_scope(user, event_group)

    status = str(event_group["status"]).upper()
    if status == "ARCHIVED":
        raise HTTPException(status_code=409, detail="Archived Event Groups cannot be closed or reopened")
    if status == "OPEN":
        return {"event_group": event_group_routes._serialize_event_group(event_group), "changed": False}

    notes = (payload.notes or "").strip() or None
    try:
        db.execute(
            text(
                """
                UPDATE event_groups
                SET status = 'OPEN',
                    closed_at = NULL,
                    closed_by_user_id = NULL,
                    updated_at = NOW()
                WHERE id = :egid AND status = 'CLOSED'
                """
            ),
            {"egid": event_group_id},
        )
        event_group_routes._record_event_group_event(
            db,
            event_group_id=event_group_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="EVENT_GROUP_REOPENED",
            notes=notes,
        )
        db.commit()
        updated = event_group_routes._event_group_row(db, event_group_id)
        return {"event_group": event_group_routes._serialize_event_group(dict(updated)), "changed": True}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
