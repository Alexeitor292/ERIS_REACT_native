from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import require_roles
from ..storage import object_access_url
from . import photo_map as photo_map_routes
from . import projects as project_routes

router = APIRouter(tags=["mission-center-gis"])

MISSION_CENTER_ROLES = project_routes.PROJECT_READ_ROLES


def _iso(value):
    return value.isoformat() if value is not None and hasattr(value, "isoformat") else value


def _json_value(value):
    if value is None or isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return None


def _project_map_rows(db: Session, *, after_id: int | None, limit: int) -> list[dict]:
    where = "WHERE p.id > :after_id" if after_id is not None else ""
    params: dict[str, object] = {"limit_plus_one": limit + 1}
    if after_id is not None:
        params["after_id"] = after_id

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
            {where}
            GROUP BY p.id
            ORDER BY p.id ASC
            LIMIT :limit_plus_one
            """
        ),
        params,
    ).mappings().all()
    return [project_routes._serialize_project(dict(row)) for row in rows]


def _incident_row(db: Session, incident_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.project_id, i.title, i.description, i.status, i.current_stage,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.first_observed_at, i.first_occurred_at, i.created_at, i.updated_at,
              MAX(isl.submission_id) AS linked_submission_id
            FROM incidents i
            LEFT JOIN incident_submission_links isl ON isl.incident_id = i.id
            WHERE i.id = :iid
            GROUP BY i.id
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    return dict(row) if row else None


def _incident_photo_rows(db: Session, incident_id: int):
    return db.execute(
        text(
            """
            SELECT
              a.id attachment_id, a.file_name, a.mime_type, a.storage_bucket, a.storage_key,
              NULL section_key, 'INCIDENT' source_scope,
              COALESCE(cm.captured_at, a.captured_at) captured_at,
              cm.latitude, cm.longitude, cm.horizontal_accuracy_m, cm.altitude_m,
              cm.camera_heading_deg, cm.camera_heading_accuracy_code, cm.heading_reference,
              cm.location_source, cm.heading_source,
              cc.id correction_id,
              cc.location_is_override correction_location_is_override,
              cc.latitude correction_latitude, cc.longitude correction_longitude,
              cc.heading_is_override correction_heading_is_override,
              cc.camera_heading_deg correction_camera_heading_deg,
              cc.corrected_by_user_id correction_corrected_by_user_id,
              cc.created_at correction_created_at
            FROM incident_attachments ia
            JOIN attachments a ON a.id = ia.attachment_id
            LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id = a.id
            LEFT JOIN attachment_capture_corrections cc ON cc.id = (
              SELECT c2.id
              FROM attachment_capture_corrections c2
              WHERE c2.attachment_id = a.id
              ORDER BY c2.id DESC
              LIMIT 1
            )
            WHERE ia.incident_id = :iid
              AND ia.kind = 'PHOTO'
            ORDER BY COALESCE(cm.captured_at, a.captured_at) ASC, a.id ASC
            """
        ),
        {"iid": incident_id},
    ).mappings().all()


def _incident_only_photo_map(db: Session, incident: dict) -> dict:
    photos: list[dict] = []
    for row in _incident_photo_rows(db, int(incident["id"])):
        capture = photo_map_routes._effective_capture(row)
        photos.append(
            {
                "attachment_id": int(row["attachment_id"]),
                "file_name": row["file_name"],
                "mime_type": row["mime_type"],
                "section_key": None,
                "source_scope": "INCIDENT",
                "captured_at": _iso(row["captured_at"]),
                **capture,
                "download_url": object_access_url(
                    str(row["storage_bucket"] or settings.MINIO_BUCKET),
                    str(row["storage_key"]),
                    expires_seconds=900,
                ),
            }
        )

    mapped = [photo for photo in photos if photo["latitude"] is not None and photo["longitude"] is not None]
    headed = [photo for photo in mapped if photo["camera_heading_deg"] is not None]
    return {
        "affected_geometry": None,
        "photos": photos,
        "summary": {
            "photos_total": len(photos),
            "photos_geotagged": len(mapped),
            "photos_with_heading": len(headed),
            "photos_unmapped": len(photos) - len(mapped),
        },
    }


@router.get("/mission-center/projects")
def mission_center_projects(
    after_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=1000, ge=1, le=2000),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(MISSION_CENTER_ROLES)),
):
    """Return lightweight statewide Project points using cursor pagination.

    The Mission Center follows this cursor until ``next_cursor`` is null, so the
    initial California view is not silently capped at the Project worklist's
    normal operational page size.
    """
    rows = _project_map_rows(db, after_id=after_id, limit=limit)
    has_more = len(rows) > limit
    items = rows[:limit]
    return {
        "items": items,
        "next_cursor": int(items[-1]["id"]) if has_more and items else None,
        "has_more": has_more,
    }


@router.get("/mission-center/incidents/{incident_id}/gis")
def mission_center_incident_gis(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(MISSION_CENTER_ROLES)),
):
    """Return GIS evidence needed for the Mission Center Incident drill-down.

    If a technical submission exists, reuse the same quality-gated/corrected
    photo-map contract used by Submission Photo Evidence. If assessment routing
    has not created a submission yet, return the Incident's Maintenance photos
    directly so the GIS view still works during coordinator review.
    """
    incident = _incident_row(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    project = None
    if incident.get("project_id") is not None:
        project_row = project_routes._project_row(db, int(incident["project_id"]))
        if project_row:
            project = project_routes._serialize_project(dict(project_row))

    linked_submission_id = (
        int(incident["linked_submission_id"])
        if incident.get("linked_submission_id") is not None
        else None
    )

    if linked_submission_id is not None:
        photo_map = photo_map_routes.submission_photo_map(
            submission_id=linked_submission_id,
            db=db,
            user=user,
        )
        geometry = photo_map.get("affected_geometry")
        photos = photo_map.get("photos") or []
        summary = photo_map.get("summary") or {}
    else:
        photo_map = _incident_only_photo_map(db, incident)
        geometry = photo_map["affected_geometry"]
        photos = photo_map["photos"]
        summary = photo_map["summary"]

    return {
        "incident": {
            "id": int(incident["id"]),
            "project_id": int(incident["project_id"]) if incident.get("project_id") is not None else None,
            "title": incident.get("title"),
            "description": incident.get("description"),
            "status": incident.get("status"),
            "current_stage": incident.get("current_stage"),
            "latitude": float(incident["latitude"]),
            "longitude": float(incident["longitude"]),
            "district": incident.get("district"),
            "county": incident.get("county"),
            "route": incident.get("route"),
            "post_mile": incident.get("post_mile"),
            "first_observed_at": _iso(incident.get("first_observed_at")),
            "first_occurred_at": _iso(incident.get("first_occurred_at")),
            "created_at": _iso(incident.get("created_at")),
            "updated_at": _iso(incident.get("updated_at")),
            "linked_submission_id": linked_submission_id,
        },
        "project": project,
        "geometry": _json_value(geometry),
        "geometry_srid": 4326,
        "geometry_source": "SUBMISSION_GISA" if linked_submission_id is not None and geometry is not None else None,
        "photo_summary": summary,
        "photos": photos,
    }
