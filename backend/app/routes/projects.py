from __future__ import annotations

import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..roles import ADMIN, MAINTENANCE_COORDINATOR, OPERATIONAL_ROLES, expand_roles, is_admin
from . import incidents as incidents_routes

router = APIRouter(tags=["projects"])

PROJECT_READ_ROLES = sorted(OPERATIONAL_ROLES)
PROJECT_MANAGE_ROLES = sorted(set(expand_roles(MAINTENANCE_COORDINATOR, ADMIN)))


class IncidentProjectAssociationRequest(BaseModel):
    mode: Literal["EXISTING", "CREATE_NEW"]
    project_id: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    notes: str | None = Field(default=None, max_length=2000)


class ProjectPatchRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


def _incident_row(db: Session, incident_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.project_id, i.title, i.description, i.incident_type,
              i.location_id, i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.office_code, i.current_stage, i.status, i.reporter_user_id,
              i.created_at, i.updated_at, i.resolved_at, i.resolved_by_user_id
            FROM incidents i
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    return dict(row) if row else None


def _incident_summary(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "project_id": int(row["project_id"]) if row.get("project_id") is not None else None,
        "title": row["title"],
        "incident_type": row.get("incident_type"),
        "status": row["status"],
        "current_stage": row["current_stage"],
        "latitude": float(row["latitude"]),
        "longitude": float(row["longitude"]),
        "district": row.get("district"),
        "county": row.get("county"),
        "route": row.get("route"),
        "post_mile": row.get("post_mile"),
        "first_observed_at": row.get("first_observed_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _project_row(db: Session, project_id: int):
    return db.execute(
        text(
            """
            SELECT
              p.id, p.project_uuid, p.title, p.description, p.status,
              p.anchor_location_id, p.anchor_latitude, p.anchor_longitude,
              p.district, p.county, p.route, p.post_mile,
              p.created_from_incident_id, p.created_by_user_id, p.source,
              p.closed_at, p.closed_by_user_id, p.created_at, p.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude
            FROM projects p
            LEFT JOIN incidents i ON i.project_id = p.id
            WHERE p.id = :pid
            GROUP BY p.id
            LIMIT 1
            """
        ),
        {"pid": project_id},
    ).mappings().first()


def _serialize_project(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "project_uuid": row["project_uuid"],
        "title": row["title"],
        "description": row.get("description"),
        "status": row["status"],
        "anchor_location_id": int(row["anchor_location_id"]) if row.get("anchor_location_id") is not None else None,
        "anchor_latitude": float(row["anchor_latitude"]),
        "anchor_longitude": float(row["anchor_longitude"]),
        "centroid_latitude": float(row["centroid_latitude"]) if row.get("centroid_latitude") is not None else float(row["anchor_latitude"]),
        "centroid_longitude": float(row["centroid_longitude"]) if row.get("centroid_longitude") is not None else float(row["anchor_longitude"]),
        "district": row.get("district"),
        "county": row.get("county"),
        "route": row.get("route"),
        "post_mile": row.get("post_mile"),
        "created_from_incident_id": int(row["created_from_incident_id"]) if row.get("created_from_incident_id") is not None else None,
        "created_by_user_id": int(row["created_by_user_id"]),
        "source": row["source"],
        "incident_count": int(row.get("incident_count") or 0),
        "open_incident_count": int(row.get("open_incident_count") or 0),
        "latest_incident_activity_at": row.get("latest_incident_activity_at"),
        "closed_at": row.get("closed_at"),
        "closed_by_user_id": int(row["closed_by_user_id"]) if row.get("closed_by_user_id") is not None else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _project_incidents(db: Session, project_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT
              i.id, i.project_id, i.title, i.incident_type, i.status, i.current_stage,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.first_observed_at, i.created_at, i.updated_at
            FROM incidents i
            WHERE i.project_id = :pid
            ORDER BY i.first_observed_at DESC, i.id DESC
            """
        ),
        {"pid": project_id},
    ).mappings().all()
    return [_incident_summary(dict(row)) for row in rows]


def _project_events(db: Session, project_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT
              pe.id, pe.project_id, pe.incident_id, pe.actor_user_id,
              pe.event_type, pe.notes, pe.metadata_json, pe.created_at,
              u.full_name AS actor_name, u.email AS actor_email
            FROM project_events pe
            LEFT JOIN users u ON u.id = pe.actor_user_id
            WHERE pe.project_id = :pid
            ORDER BY pe.created_at ASC, pe.id ASC
            """
        ),
        {"pid": project_id},
    ).mappings().all()
    items: list[dict] = []
    for row in rows:
        metadata = row["metadata_json"]
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except Exception:
                metadata = None
        items.append(
            {
                "id": int(row["id"]),
                "project_id": int(row["project_id"]),
                "incident_id": int(row["incident_id"]) if row["incident_id"] is not None else None,
                "actor_user_id": int(row["actor_user_id"]) if row["actor_user_id"] is not None else None,
                "actor_name": row["actor_name"],
                "actor_email": row["actor_email"],
                "event_type": row["event_type"],
                "notes": row["notes"],
                "metadata": metadata,
                "created_at": row["created_at"],
            }
        )
    return items


def _record_project_event(
    db: Session,
    *,
    project_id: int,
    incident_id: int | None,
    actor_user_id: int | None,
    event_type: str,
    notes: str | None = None,
    metadata: dict | None = None,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO project_events
              (project_id, incident_id, actor_user_id, event_type, notes, metadata_json)
            VALUES
              (:pid, :iid, :actor, :event_type, :notes, :metadata_json)
            """
        ),
        {
            "pid": project_id,
            "iid": incident_id,
            "actor": actor_user_id,
            "event_type": event_type,
            "notes": notes,
            "metadata_json": json.dumps(metadata) if metadata is not None else None,
        },
    )


def _generated_project_title(incident: dict) -> str:
    district = str(incident.get("district") or "").strip()
    county = str(incident.get("county") or "").strip()
    route = str(incident.get("route") or "").strip()
    post_mile = str(incident.get("post_mile") or "").strip()
    pieces = [
        f"D{district}" if district else None,
        county or None,
        f"R{route}" if route else None,
        f"PM {post_mile}" if post_mile else None,
    ]
    location = " · ".join(piece for piece in pieces if piece)
    return f"Incident #{int(incident['id'])} Project" + (f" · {location}" if location else "")


def _ensure_manage_scope(user: dict, incident_or_project: dict) -> None:
    if is_admin(user):
        return
    incidents_routes._ensure_incident_district_access(user, incident_or_project.get("district"))


@router.get("/projects")
def list_projects(
    status: str | None = Query(default="OPEN"),
    q: str | None = Query(default=None, max_length=255),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(PROJECT_READ_ROLES)),
):
    where: list[str] = []
    params: dict[str, object] = {"limit": limit}
    if status:
        normalized = status.strip().upper()
        if normalized not in {"OPEN", "CLOSED", "ARCHIVED", "ALL"}:
            raise HTTPException(status_code=400, detail="Invalid project status")
        if normalized != "ALL":
            where.append("p.status = :status")
            params["status"] = normalized
    if q and q.strip():
        where.append("(p.title LIKE :q OR p.description LIKE :q OR p.route LIKE :q OR p.county LIKE :q)")
        params["q"] = f"%{q.strip()}%"
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              p.id, p.project_uuid, p.title, p.description, p.status,
              p.anchor_location_id, p.anchor_latitude, p.anchor_longitude,
              p.district, p.county, p.route, p.post_mile,
              p.created_from_incident_id, p.created_by_user_id, p.source,
              p.closed_at, p.closed_by_user_id, p.created_at, p.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude
            FROM projects p
            LEFT JOIN incidents i ON i.project_id = p.id
            {where_sql}
            GROUP BY p.id
            ORDER BY p.updated_at DESC, p.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_project(dict(row)) for row in rows]}


@router.get("/projects/{project_id}")
def get_project(
    project_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(PROJECT_READ_ROLES)),
):
    row = _project_row(db, project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "project": _serialize_project(dict(row)),
        "incidents": _project_incidents(db, project_id),
        "events": _project_events(db, project_id),
    }


@router.patch("/projects/{project_id}")
def update_project(
    payload: ProjectPatchRequest,
    project_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(PROJECT_MANAGE_ROLES)),
):
    row = _project_row(db, project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    _ensure_manage_scope(user, dict(row))

    sets: list[str] = []
    params: dict[str, object] = {"pid": project_id}
    if payload.title is not None:
        sets.append("title = :title")
        params["title"] = payload.title.strip()
    if payload.description is not None:
        sets.append("description = :description")
        params["description"] = payload.description.strip() or None
    if not sets:
        return {"project": _serialize_project(dict(row))}

    try:
        db.execute(text(f"UPDATE projects SET {', '.join(sets)}, updated_at = NOW() WHERE id = :pid"), params)
        _record_project_event(
            db,
            project_id=project_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="PROJECT_UPDATED",
        )
        db.commit()
        return {"project": _serialize_project(dict(_project_row(db, project_id)))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/{incident_id}/project-context")
def incident_project_context(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(PROJECT_MANAGE_ROLES)),
):
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_manage_scope(user, incident)
    project = None
    if incident.get("project_id") is not None:
        project_row = _project_row(db, int(incident["project_id"]))
        if project_row:
            project = _serialize_project(dict(project_row))
    return {
        "incident": _incident_summary(incident),
        "project": project,
        "requires_project_association": project is None,
        "can_change_association": str(incident["current_stage"]).upper() == "COORDINATOR_REVIEW" or is_admin(user),
    }


@router.get("/incidents/{incident_id}/nearby-projects")
def nearby_projects_for_incident(
    incident_id: int = Path(..., ge=1),
    radius_m: float = Query(default=8046.72, gt=0, le=80467.2),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user=Depends(require_roles(PROJECT_MANAGE_ROLES)),
):
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_manage_scope(user, incident)

    lat = float(incident["latitude"])
    lon = float(incident["longitude"])
    rows = db.execute(
        text(
            """
            SELECT
              p.id, p.project_uuid, p.title, p.description, p.status,
              p.anchor_location_id, p.anchor_latitude, p.anchor_longitude,
              p.district, p.county, p.route, p.post_mile,
              p.created_from_incident_id, p.created_by_user_id, p.source,
              p.closed_at, p.closed_by_user_id, p.created_at, p.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude,
              MIN(ST_DISTANCE_SPHERE(POINT(i.longitude, i.latitude), POINT(:lon, :lat))) AS nearest_distance_m
            FROM projects p
            JOIN incidents i ON i.project_id = p.id
            WHERE p.status = 'OPEN'
            GROUP BY p.id
            HAVING nearest_distance_m <= :radius_m
            ORDER BY nearest_distance_m ASC, p.updated_at DESC
            LIMIT :limit
            """
        ),
        {"lat": lat, "lon": lon, "radius_m": radius_m, "limit": limit},
    ).mappings().all()

    items: list[dict] = []
    for row in rows:
        project = _serialize_project(dict(row))
        project["nearest_distance_m"] = float(row["nearest_distance_m"])
        project["incidents"] = _project_incidents(db, int(row["id"]))
        items.append(project)

    return {
        "incident": _incident_summary(incident),
        "radius_m": radius_m,
        "items": items,
    }


@router.post("/incidents/{incident_id}/project-association")
def associate_incident_project(
    payload: IncidentProjectAssociationRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(PROJECT_MANAGE_ROLES)),
):
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_manage_scope(user, incident)
    if str(incident["status"]).upper() == "RESOLVED" and not is_admin(user):
        raise HTTPException(status_code=409, detail="Only an administrator may regroup a resolved incident")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW" and not is_admin(user):
        raise HTTPException(status_code=409, detail="Project association is managed during coordinator review")

    old_project_id = int(incident["project_id"]) if incident.get("project_id") is not None else None
    mode = payload.mode.upper()
    actor_id = int(user["id"])
    notes = (payload.notes or "").strip() or None

    try:
        if mode == "EXISTING":
            if payload.project_id is None:
                raise HTTPException(status_code=400, detail="project_id is required for EXISTING mode")
            target_row = _project_row(db, int(payload.project_id))
            if not target_row:
                raise HTTPException(status_code=404, detail="Project not found")
            if str(target_row["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="Only an open Project can accept an incident")
            target_project_id = int(payload.project_id)
            created = False
        else:
            title = (payload.title or "").strip() or _generated_project_title(incident)
            description = (payload.description or "").strip() or None
            db.execute(
                text(
                    """
                    INSERT INTO projects (
                      project_uuid, title, description, status,
                      anchor_location_id, anchor_latitude, anchor_longitude,
                      district, county, route, post_mile,
                      created_from_incident_id, created_by_user_id, source
                    ) VALUES (
                      :uuid, :title, :description, 'OPEN',
                      :location_id, :lat, :lon,
                      :district, :county, :route, :post_mile,
                      :iid, :uid, 'COORDINATOR_CREATED'
                    )
                    """
                ),
                {
                    "uuid": str(uuid.uuid4()),
                    "title": title,
                    "description": description,
                    "location_id": incident.get("location_id"),
                    "lat": incident["latitude"],
                    "lon": incident["longitude"],
                    "district": incident.get("district"),
                    "county": incident.get("county"),
                    "route": incident.get("route"),
                    "post_mile": incident.get("post_mile"),
                    "iid": incident_id,
                    "uid": actor_id,
                },
            )
            target_project_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
            created = True
            _record_project_event(
                db,
                project_id=target_project_id,
                incident_id=incident_id,
                actor_user_id=actor_id,
                event_type="PROJECT_CREATED",
                notes=notes,
                metadata={"mode": mode},
            )

        if old_project_id == target_project_id:
            db.commit()
            return {
                "incident_id": incident_id,
                "project": _serialize_project(dict(_project_row(db, target_project_id))),
                "created": created,
                "changed": False,
            }

        if old_project_id is not None:
            _record_project_event(
                db,
                project_id=old_project_id,
                incident_id=incident_id,
                actor_user_id=actor_id,
                event_type="INCIDENT_MOVED_OUT",
                notes=notes,
                metadata={"to_project_id": target_project_id},
            )

        db.execute(
            text("UPDATE incidents SET project_id = :pid, updated_at = NOW() WHERE id = :iid"),
            {"pid": target_project_id, "iid": incident_id},
        )

        _record_project_event(
            db,
            project_id=target_project_id,
            incident_id=incident_id,
            actor_user_id=actor_id,
            event_type="INCIDENT_LINKED" if old_project_id is None else "INCIDENT_MOVED_IN",
            notes=notes,
            metadata={"from_project_id": old_project_id, "mode": mode},
        )

        # Historical one-incident migration placeholders disappear from active
        # Project discovery after the incident is regrouped into its real Project.
        if old_project_id is not None:
            db.execute(
                text(
                    """
                    UPDATE projects p
                    SET p.status = 'ARCHIVED', p.updated_at = NOW()
                    WHERE p.id = :old_pid
                      AND p.source = 'LEGACY_BACKFILL'
                      AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.project_id = p.id)
                    """
                ),
                {"old_pid": old_project_id},
            )

        db.commit()
        target = _project_row(db, target_project_id)
        return {
            "incident_id": incident_id,
            "project": _serialize_project(dict(target)),
            "created": created,
            "changed": True,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
