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

router = APIRouter(tags=["event-groups"])

EVENT_GROUP_READ_ROLES = sorted(OPERATIONAL_ROLES)
EVENT_GROUP_MANAGE_ROLES = sorted(set(expand_roles(MAINTENANCE_COORDINATOR, ADMIN)))


class IncidentEventGroupAssociationRequest(BaseModel):
    mode: Literal["EXISTING", "CREATE_NEW"]
    event_group_id: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    notes: str | None = Field(default=None, max_length=2000)


class EventGroupPatchRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


def _incident_row(db: Session, incident_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.event_group_id, i.incident_key, i.approved_at, i.approved_by_user_id,
              i.title, i.description, i.incident_type,
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
        "event_group_id": int(row["event_group_id"]) if row.get("event_group_id") is not None else None,
        "incident_key": row.get("incident_key"),
        "is_permanent": row.get("incident_key") is not None,
        "approved_at": row.get("approved_at"),
        "approved_by_user_id": int(row["approved_by_user_id"]) if row.get("approved_by_user_id") is not None else None,
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


def _event_group_row(db: Session, event_group_id: int):
    return db.execute(
        text(
            """
            SELECT
              eg.id, eg.event_group_key, eg.title, eg.description, eg.status,
              eg.anchor_location_id, eg.anchor_latitude, eg.anchor_longitude,
              eg.district, eg.county, eg.route, eg.post_mile,
              eg.created_from_incident_id, eg.created_by_user_id, eg.source,
              eg.closed_at, eg.closed_by_user_id, eg.created_at, eg.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude
            FROM event_groups eg
            LEFT JOIN incidents i ON i.event_group_id = eg.id
            WHERE eg.id = :egid
            GROUP BY eg.id
            LIMIT 1
            """
        ),
        {"egid": event_group_id},
    ).mappings().first()


def _serialize_event_group(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "event_group_key": row["event_group_key"],
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


def _event_group_incidents(db: Session, event_group_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT
              i.id, i.event_group_id, i.incident_key, i.approved_at, i.approved_by_user_id,
              i.title, i.incident_type, i.status, i.current_stage,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.first_observed_at, i.created_at, i.updated_at
            FROM incidents i
            WHERE i.event_group_id = :egid
            ORDER BY i.first_observed_at DESC, i.id DESC
            """
        ),
        {"egid": event_group_id},
    ).mappings().all()
    return [_incident_summary(dict(row)) for row in rows]


def _event_group_events(db: Session, event_group_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT
              ege.id, ege.event_group_id, ege.incident_id, ege.actor_user_id,
              ege.event_type, ege.notes, ege.metadata_json, ege.created_at,
              u.full_name AS actor_name, u.email AS actor_email
            FROM event_group_events ege
            LEFT JOIN users u ON u.id = ege.actor_user_id
            WHERE ege.event_group_id = :egid
            ORDER BY ege.created_at ASC, ege.id ASC
            """
        ),
        {"egid": event_group_id},
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
                "event_group_id": int(row["event_group_id"]),
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


def _record_event_group_event(
    db: Session,
    *,
    event_group_id: int,
    incident_id: int | None,
    actor_user_id: int | None,
    event_type: str,
    notes: str | None = None,
    metadata: dict | None = None,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO event_group_events
              (event_group_id, incident_id, actor_user_id, event_type, notes, metadata_json)
            VALUES
              (:egid, :iid, :actor, :event_type, :notes, :metadata_json)
            """
        ),
        {
            "egid": event_group_id,
            "iid": incident_id,
            "actor": actor_user_id,
            "event_type": event_type,
            "notes": notes,
            "metadata_json": json.dumps(metadata) if metadata is not None else None,
        },
    )


def _generated_event_group_title(incident: dict) -> str:
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
    return f"Incident #{int(incident['id'])} Event Group" + (f" · {location}" if location else "")


def _ensure_manage_scope(user: dict, incident_or_group: dict) -> None:
    if is_admin(user):
        return
    incidents_routes._ensure_incident_district_access(user, incident_or_group.get("district"))


def _create_event_group_for_incident(
    db: Session,
    *,
    incident: dict,
    actor_user_id: int,
    title: str | None = None,
    description: str | None = None,
    notes: str | None = None,
) -> int:
    resolved_title = (title or "").strip() or _generated_event_group_title(incident)
    resolved_description = (description or "").strip() or None
    db.execute(
        text(
            """
            INSERT INTO event_groups (
              event_group_key, title, description, status,
              anchor_location_id, anchor_latitude, anchor_longitude,
              district, county, route, post_mile,
              created_from_incident_id, created_by_user_id, source
            ) VALUES (
              :group_key, :title, :description, 'OPEN',
              :location_id, :lat, :lon,
              :district, :county, :route, :post_mile,
              :iid, :uid, 'COORDINATOR_CREATED'
            )
            """
        ),
        {
            "group_key": str(uuid.uuid4()),
            "title": resolved_title,
            "description": resolved_description,
            "location_id": incident.get("location_id"),
            "lat": incident["latitude"],
            "lon": incident["longitude"],
            "district": incident.get("district"),
            "county": incident.get("county"),
            "route": incident.get("route"),
            "post_mile": incident.get("post_mile"),
            "iid": int(incident["id"]),
            "uid": actor_user_id,
        },
    )
    event_group_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
    _record_event_group_event(
        db,
        event_group_id=event_group_id,
        incident_id=int(incident["id"]),
        actor_user_id=actor_user_id,
        event_type="EVENT_GROUP_CREATED",
        notes=notes,
        metadata={"mode": "CREATE_NEW"},
    )
    return event_group_id


@router.get("/event-groups")
def list_event_groups(
    status: str | None = Query(default="OPEN"),
    q: str | None = Query(default=None, max_length=255),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(EVENT_GROUP_READ_ROLES)),
):
    where: list[str] = []
    params: dict[str, object] = {"limit": limit}
    if status:
        normalized = status.strip().upper()
        if normalized not in {"OPEN", "CLOSED", "ARCHIVED", "ALL"}:
            raise HTTPException(status_code=400, detail="Invalid Event Group status")
        if normalized != "ALL":
            where.append("eg.status = :status")
            params["status"] = normalized
    if q and q.strip():
        where.append("(eg.title LIKE :q OR eg.description LIKE :q OR eg.route LIKE :q OR eg.county LIKE :q)")
        params["q"] = f"%{q.strip()}%"
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              eg.id, eg.event_group_key, eg.title, eg.description, eg.status,
              eg.anchor_location_id, eg.anchor_latitude, eg.anchor_longitude,
              eg.district, eg.county, eg.route, eg.post_mile,
              eg.created_from_incident_id, eg.created_by_user_id, eg.source,
              eg.closed_at, eg.closed_by_user_id, eg.created_at, eg.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude
            FROM event_groups eg
            LEFT JOIN incidents i ON i.event_group_id = eg.id
            {where_sql}
            GROUP BY eg.id
            ORDER BY eg.updated_at DESC, eg.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_event_group(dict(row)) for row in rows]}


@router.get("/event-groups/{event_group_id}")
def get_event_group(
    event_group_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(EVENT_GROUP_READ_ROLES)),
):
    row = _event_group_row(db, event_group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Event Group not found")
    return {
        "event_group": _serialize_event_group(dict(row)),
        "incidents": _event_group_incidents(db, event_group_id),
        "events": _event_group_events(db, event_group_id),
    }


@router.patch("/event-groups/{event_group_id}")
def update_event_group(
    payload: EventGroupPatchRequest,
    event_group_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(EVENT_GROUP_MANAGE_ROLES)),
):
    row = _event_group_row(db, event_group_id)
    if not row:
        raise HTTPException(status_code=404, detail="Event Group not found")
    _ensure_manage_scope(user, dict(row))

    sets: list[str] = []
    params: dict[str, object] = {"egid": event_group_id}
    if payload.title is not None:
        sets.append("title = :title")
        params["title"] = payload.title.strip()
    if payload.description is not None:
        sets.append("description = :description")
        params["description"] = payload.description.strip() or None
    if not sets:
        return {"event_group": _serialize_event_group(dict(row))}

    try:
        db.execute(text(f"UPDATE event_groups SET {', '.join(sets)}, updated_at = NOW() WHERE id = :egid"), params)
        _record_event_group_event(
            db,
            event_group_id=event_group_id,
            incident_id=None,
            actor_user_id=int(user["id"]),
            event_type="EVENT_GROUP_UPDATED",
        )
        db.commit()
        return {"event_group": _serialize_event_group(dict(_event_group_row(db, event_group_id)))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/{incident_id}/event-group-context")
def incident_event_group_context(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(EVENT_GROUP_MANAGE_ROLES)),
):
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_manage_scope(user, incident)
    event_group = None
    if incident.get("event_group_id") is not None:
        group_row = _event_group_row(db, int(incident["event_group_id"]))
        if group_row:
            event_group = _serialize_event_group(dict(group_row))
    return {
        "incident": _incident_summary(incident),
        "event_group": event_group,
        "requires_event_group_decision": event_group is None,
        "is_permanent": incident.get("incident_key") is not None,
        "can_change_association": str(incident["current_stage"]).upper() == "COORDINATOR_REVIEW" or is_admin(user),
    }


@router.get("/incidents/{incident_id}/nearby-event-groups")
def nearby_event_groups_for_incident(
    incident_id: int = Path(..., ge=1),
    radius_m: float = Query(default=8046.72, gt=0, le=80467.2),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user=Depends(require_roles(EVENT_GROUP_MANAGE_ROLES)),
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
              eg.id, eg.event_group_key, eg.title, eg.description, eg.status,
              eg.anchor_location_id, eg.anchor_latitude, eg.anchor_longitude,
              eg.district, eg.county, eg.route, eg.post_mile,
              eg.created_from_incident_id, eg.created_by_user_id, eg.source,
              eg.closed_at, eg.closed_by_user_id, eg.created_at, eg.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude,
              MIN(ST_DISTANCE_SPHERE(POINT(i.longitude, i.latitude), POINT(:lon, :lat))) AS nearest_distance_m
            FROM event_groups eg
            JOIN incidents i ON i.event_group_id = eg.id
            WHERE eg.status = 'OPEN'
            GROUP BY eg.id
            HAVING nearest_distance_m <= :radius_m
            ORDER BY nearest_distance_m ASC, eg.updated_at DESC
            LIMIT :limit
            """
        ),
        {"lat": lat, "lon": lon, "radius_m": radius_m, "limit": limit},
    ).mappings().all()

    items: list[dict] = []
    for row in rows:
        event_group = _serialize_event_group(dict(row))
        event_group["nearest_distance_m"] = float(row["nearest_distance_m"])
        event_group["incidents"] = _event_group_incidents(db, int(row["id"]))
        items.append(event_group)

    return {"incident": _incident_summary(incident), "radius_m": radius_m, "items": items}


@router.post("/incidents/{incident_id}/event-group-association")
def associate_incident_event_group(
    payload: IncidentEventGroupAssociationRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(EVENT_GROUP_MANAGE_ROLES)),
):
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_manage_scope(user, incident)
    if str(incident["status"]).upper() == "RESOLVED" and not is_admin(user):
        raise HTTPException(status_code=409, detail="Only an administrator may regroup a resolved Incident")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW" and not is_admin(user):
        raise HTTPException(status_code=409, detail="Event Group association is managed during coordinator review")

    old_event_group_id = int(incident["event_group_id"]) if incident.get("event_group_id") is not None else None
    mode = payload.mode.upper()
    actor_id = int(user["id"])
    notes = (payload.notes or "").strip() or None

    try:
        if mode == "EXISTING":
            if payload.event_group_id is None:
                raise HTTPException(status_code=400, detail="event_group_id is required for EXISTING mode")
            target_row = _event_group_row(db, int(payload.event_group_id))
            if not target_row:
                raise HTTPException(status_code=404, detail="Event Group not found")
            if str(target_row["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="Only an open Event Group can accept an Incident")
            target_event_group_id = int(payload.event_group_id)
            created = False
        else:
            target_event_group_id = _create_event_group_for_incident(
                db,
                incident=incident,
                actor_user_id=actor_id,
                title=payload.title,
                description=payload.description,
                notes=notes,
            )
            created = True

        if old_event_group_id == target_event_group_id:
            db.commit()
            return {
                "incident_id": incident_id,
                "event_group": _serialize_event_group(dict(_event_group_row(db, target_event_group_id))),
                "created": created,
                "changed": False,
            }

        if old_event_group_id is not None:
            _record_event_group_event(
                db,
                event_group_id=old_event_group_id,
                incident_id=incident_id,
                actor_user_id=actor_id,
                event_type="INCIDENT_MOVED_OUT",
                notes=notes,
                metadata={"to_event_group_id": target_event_group_id},
            )

        db.execute(
            text("UPDATE incidents SET event_group_id = :egid, updated_at = NOW() WHERE id = :iid"),
            {"egid": target_event_group_id, "iid": incident_id},
        )

        _record_event_group_event(
            db,
            event_group_id=target_event_group_id,
            incident_id=incident_id,
            actor_user_id=actor_id,
            event_type="INCIDENT_LINKED" if old_event_group_id is None else "INCIDENT_MOVED_IN",
            notes=notes,
            metadata={"from_event_group_id": old_event_group_id, "mode": mode},
        )

        if old_event_group_id is not None:
            db.execute(
                text(
                    """
                    UPDATE event_groups eg
                    SET eg.status = 'ARCHIVED', eg.updated_at = NOW()
                    WHERE eg.id = :old_egid
                      AND eg.source = 'LEGACY_BACKFILL'
                      AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.event_group_id = eg.id)
                    """
                ),
                {"old_egid": old_event_group_id},
            )

        db.commit()
        target = _event_group_row(db, target_event_group_id)
        return {
            "incident_id": incident_id,
            "event_group": _serialize_event_group(dict(target)),
            "created": created,
            "changed": True,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
