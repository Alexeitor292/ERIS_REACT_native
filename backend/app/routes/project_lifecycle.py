from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from . import projects as project_routes

router = APIRouter(tags=["projects"])


class ProjectLifecycleRequest(BaseModel):
    notes: str | None = Field(default=None, max_length=2000)


@router.post("/projects/{project_id}/close")
def close_project(
    payload: ProjectLifecycleRequest,
    project_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(project_routes.PROJECT_MANAGE_ROLES)),
):
    row = project_routes._project_row(db, project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    project = dict(row)
    project_routes._ensure_manage_scope(user, project)

    status = str(project["status"]).upper()
    if status == "ARCHIVED":
        raise HTTPException(status_code=409, detail="Archived Projects cannot be closed or reopened")
    if status == "CLOSED":
        return {"project": project_routes._serialize_project(project), "changed": False}

    active_count = int(project.get("open_incident_count") or 0)
    if active_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Project cannot be closed while {active_count} active Incident{'s' if active_count != 1 else ''} remain",
        )

    notes = (payload.notes or "").strip() or None
    try:
        db.execute(
            text(
                """
                UPDATE projects
                SET status = 'CLOSED',
                    closed_at = NOW(),
                    closed_by_user_id = :uid,
                    updated_at = NOW()
                WHERE id = :pid AND status = 'OPEN'
                """
            ),
            {"pid": project_id, "uid": int(user["id"])},
        )
        project_routes._record_project_event(
            db,
            project_id=project_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="PROJECT_CLOSED",
            notes=notes,
            metadata={"active_incident_count": 0},
        )
        db.commit()
        updated = project_routes._project_row(db, project_id)
        return {"project": project_routes._serialize_project(dict(updated)), "changed": True}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/projects/{project_id}/reopen")
def reopen_project(
    payload: ProjectLifecycleRequest,
    project_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(project_routes.PROJECT_MANAGE_ROLES)),
):
    row = project_routes._project_row(db, project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    project = dict(row)
    project_routes._ensure_manage_scope(user, project)

    status = str(project["status"]).upper()
    if status == "ARCHIVED":
        raise HTTPException(status_code=409, detail="Archived Projects cannot be closed or reopened")
    if status == "OPEN":
        return {"project": project_routes._serialize_project(project), "changed": False}

    notes = (payload.notes or "").strip() or None
    try:
        db.execute(
            text(
                """
                UPDATE projects
                SET status = 'OPEN',
                    closed_at = NULL,
                    closed_by_user_id = NULL,
                    updated_at = NOW()
                WHERE id = :pid AND status = 'CLOSED'
                """
            ),
            {"pid": project_id},
        )
        project_routes._record_project_event(
            db,
            project_id=project_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="PROJECT_REOPENED",
            notes=notes,
        )
        db.commit()
        updated = project_routes._project_row(db, project_id)
        return {"project": project_routes._serialize_project(dict(updated)), "changed": True}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
