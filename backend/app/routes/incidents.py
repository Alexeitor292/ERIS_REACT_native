from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_roles
from ..schemas.common import IncidentAssignRequest, IncidentCreate, IncidentResolveRequest
from ..storage import make_object_key, put_object_bytes

router = APIRouter(tags=["incidents"])


def _incident_with_assignment(db: Session, incident_id: int):
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    return row


def _serialize_incident(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "incident_type": row["incident_type"],
        "description": row["description"],
        "latitude": float(row["latitude"]),
        "longitude": float(row["longitude"]),
        "district": row["district"],
        "county": row["county"],
        "route": row["route"],
        "post_mile": row["post_mile"],
        "status": row["status"],
        "reporter_user_id": int(row["reporter_user_id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "resolved_at": row["resolved_at"],
        "resolved_by_user_id": row["resolved_by_user_id"],
        "resolution_comment": row["resolution_comment"],
        "linked_submission_id": int(row["submission_id"]) if row["submission_id"] is not None else None,
        "assignment": (
            {
                "assignment_id": int(row["assignment_id"]),
                "assignee_user_id": int(row["assignee_user_id"]),
                "assigned_by_user_id": int(row["assigned_by_user_id"]),
                "assignment_mode": row["assignment_mode"],
                "assigned_at": row["assigned_at"],
                "assignee_email": row["assignee_email"],
                "assignee_name": row["assignee_name"],
            }
            if row["assignment_id"] is not None
            else None
        ),
    }


def _ensure_linked_submission(
    *,
    db: Session,
    incident_row: dict,
    assignee_user_id: int,
    actor_user_id: int,
) -> int:
    existing = db.execute(
        text(
            """
            SELECT submission_id
            FROM incident_submission_links
            WHERE incident_id = :iid
            LIMIT 1
            """
        ),
        {"iid": int(incident_row["id"])},
    ).scalar()
    if existing is not None:
        db.execute(
            text(
                """
                INSERT INTO submission_editors (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": int(existing), "uid": assignee_user_id, "granted_by": actor_user_id},
        )
        return int(existing)

    title = f"Incident #{int(incident_row['id'])}: {incident_row['title']}"
    db.execute(
        text(
            """
            INSERT INTO submissions (created_by_user_id, status, client_submission_uuid, title)
            VALUES (:uid, 'DRAFT', UUID(), :title)
            """
        ),
        {"uid": assignee_user_id, "title": title},
    )
    submission_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())

    db.execute(
        text(
            """
            INSERT INTO workflow_events
              (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES
              (:sid, :actor, 'CREATE', NULL, 'DRAFT', :comment)
            """
        ),
        {
            "sid": submission_id,
            "actor": actor_user_id,
            "comment": f"Draft created from incident #{int(incident_row['id'])}",
        },
    )

    db.execute(
        text(
            """
            INSERT INTO submission_gisa (
              submission_id,
              report_date,
              date_incident_reported,
              district,
              county,
              route,
              post_mile,
              latitude,
              longitude,
              updated_by_user_id
            ) VALUES (
              :sid,
              CURDATE(),
              CURDATE(),
              :district,
              :county,
              :route,
              :post_mile,
              :lat,
              :lon,
              :updated_by
            )
            """
        ),
        {
            "sid": submission_id,
            "district": incident_row["district"],
            "county": incident_row["county"],
            "route": incident_row["route"],
            "post_mile": incident_row["post_mile"],
            "lat": incident_row["latitude"],
            "lon": incident_row["longitude"],
            "updated_by": actor_user_id,
        },
    )

    db.execute(
        text(
            """
            INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id)
            VALUES (:iid, :sid, :uid)
            """
        ),
        {"iid": int(incident_row["id"]), "sid": submission_id, "uid": actor_user_id},
    )
    reporter_uid = int(incident_row["reporter_user_id"])
    if reporter_uid != assignee_user_id:
        db.execute(
            text(
                """
                INSERT INTO submission_visibility (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": submission_id, "uid": reporter_uid, "granted_by": actor_user_id},
        )
    return submission_id


def _assign_incident(
    *,
    db: Session,
    incident_id: int,
    assignee_user_id: int,
    assigned_by_user_id: int,
    mode: str,
    require_unclaimed: bool = False,
) -> dict:
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")
    if require_unclaimed and incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) != assignee_user_id:
        raise HTTPException(status_code=409, detail="Incident is already assigned")

    assignee = db.execute(
        text("SELECT id, is_active FROM users WHERE id = :uid LIMIT 1"),
        {"uid": assignee_user_id},
    ).mappings().first()
    if not assignee or int(assignee["is_active"]) != 1:
        raise HTTPException(status_code=404, detail="Assignee not found or inactive")

    db.execute(
        text(
            """
            UPDATE incident_assignments
            SET is_active = 0, updated_at = NOW()
            WHERE incident_id = :iid AND is_active = 1
            """
        ),
        {"iid": incident_id},
    )

    db.execute(
        text(
            """
            INSERT INTO incident_assignments (
              incident_id, assignee_user_id, assigned_by_user_id, assignment_mode, is_active
            ) VALUES (
              :iid, :assignee, :assigned_by, :mode, 1
            )
            """
        ),
        {
            "iid": incident_id,
            "assignee": assignee_user_id,
            "assigned_by": assigned_by_user_id,
            "mode": mode,
        },
    )

    db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'IN_PROGRESS', updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id},
    )

    linked_submission_id = _ensure_linked_submission(
        db=db,
        incident_row=incident,
        assignee_user_id=assignee_user_id,
        actor_user_id=assigned_by_user_id,
    )
    return {
        "incident_id": incident_id,
        "assignee_user_id": assignee_user_id,
        "assignment_mode": mode,
        "linked_submission_id": linked_submission_id,
    }


@router.post("/incidents")
def create_incident(
    payload: IncidentCreate,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    try:
        db.execute(
            text(
                """
                INSERT INTO incidents (
                  title, incident_type, description, latitude, longitude,
                  district, county, route, post_mile,
                  status, reporter_user_id
                ) VALUES (
                  :title, :incident_type, :description, :lat, :lon,
                  :district, :county, :route, :post_mile,
                  'NEW', :uid
                )
                """
            ),
            {
                "title": title,
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": payload.latitude,
                "lon": payload.longitude,
                "district": (payload.district or "").strip() or None,
                "county": (payload.county or "").strip() or None,
                "route": (payload.route or "").strip() or None,
                "post_mile": (payload.post_mile or "").strip() or None,
                "uid": user["id"],
            },
        )
        new_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        db.commit()
        row = _incident_with_assignment(db, new_id)
        return {"incident": _serialize_incident(dict(row))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents")
def list_incidents(
    status: str | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    params: dict[str, object] = {"limit": limit}
    where_parts: list[str] = []
    if status:
        status_u = status.strip().upper()
        if status_u not in {"NEW", "IN_PROGRESS", "RESOLVED"}:
            raise HTTPException(status_code=400, detail="Invalid incident status filter")
        where_parts.append("i.status = :status")
        params["status"] = status_u
    if unclaimed_only:
        where_parts.append("a.id IS NULL")
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            {where_sql}
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_incident(dict(r)) for r in rows], "requested_by_user_id": user["id"]}


@router.get("/incidents/{incident_id}")
def get_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    row = _incident_with_assignment(db, incident_id)
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"incident": _serialize_incident(dict(row)), "requested_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/claim")
def claim_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(user["id"]),
            assigned_by_user_id=int(user["id"]),
            mode="CLAIM",
            require_unclaimed=True,
        )
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.assignee_user_id),
            assigned_by_user_id=int(user["id"]),
            mode="ASSIGN",
        )
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/unassign")
def unassign_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be unassigned")
    try:
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.execute(
            text("UPDATE incidents SET status = 'NEW', updated_at = NOW() WHERE id = :iid"),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "NEW"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(
    payload: IncidentResolveRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    assignee_user_id = incident["assignee_user_id"]
    if not ("ADMIN" in set(user["roles"]) or (assignee_user_id is not None and int(assignee_user_id) == int(user["id"]))):
        raise HTTPException(status_code=403, detail="Only assigned engineer or admin can resolve")
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET status = 'RESOLVED',
                    resolved_at = NOW(),
                    resolved_by_user_id = :uid,
                    resolution_comment = :comment,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "uid": user["id"],
                "comment": (payload.comment or "").strip() or None,
            },
        )
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "RESOLVED"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/mission-center/incidents")
def mission_center_incident_feed(
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    rows = db.execute(
        text(
            """
            SELECT
              i.id,
              i.title,
              i.incident_type,
              i.status,
              i.latitude,
              i.longitude,
              i.created_at,
              i.updated_at,
              a.assignee_user_id,
              u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            ORDER BY i.created_at DESC, i.id DESC
            """
        )
    ).mappings().all()
    return {
        "items": [
            {
                "id": int(r["id"]),
                "title": r["title"],
                "incident_type": r["incident_type"],
                "status": r["status"],
                "latitude": float(r["latitude"]),
                "longitude": float(r["longitude"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "assignee_user_id": int(r["assignee_user_id"]) if r["assignee_user_id"] is not None else None,
                "assignee_name": r["assignee_name"],
                "linked_submission_id": int(r["submission_id"]) if r["submission_id"] is not None else None,
            }
            for r in rows
        ],
        "requested_by_user_id": user["id"],
    }


@router.post("/incidents/{incident_id}/attachments")
async def upload_incident_attachment(
    incident_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    kind: str = Query(default="PHOTO", max_length=16),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    incident = db.execute(
        text(
            """
            SELECT
              i.id,
              i.reporter_user_id,
              a.assignee_user_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    user_roles = set(user["roles"])
    if "ADMIN" not in user_roles:
        is_reporter = int(incident["reporter_user_id"]) == int(user["id"])
        is_assignee = incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) == int(user["id"])
        if not (is_reporter or is_assignee):
            raise HTTPException(status_code=403, detail="Not allowed to attach files to this incident")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    mime_type = file.content_type or "application/octet-stream"
    normalized_kind = (kind or "").strip().upper()
    if normalized_kind not in {"PHOTO", "VIDEO", "DOC", "SKETCH"}:
        if mime_type.lower().startswith("image/"):
            normalized_kind = "PHOTO"
        elif mime_type.lower().startswith("video/"):
            normalized_kind = "VIDEO"
        else:
            normalized_kind = "DOC"

    object_key = make_object_key(file.filename or "incident_attachment.bin")
    put_object_bytes(
        object_key=object_key,
        data=content,
        content_type=mime_type,
        bucket=settings.MINIO_BUCKET,
    )
    sha = hashlib.sha256(content).hexdigest()

    try:
        db.execute(
            text(
                """
                INSERT INTO attachments (
                  created_by_user_id, storage_provider, storage_bucket, storage_key,
                  file_name, mime_type, file_size_bytes, sha256, uploaded_at
                ) VALUES (
                  :uid, 'minio', :bucket, :key, :fname, :mime, :size, :sha, NOW()
                )
                """
            ),
            {
                "uid": user["id"],
                "bucket": settings.MINIO_BUCKET,
                "key": object_key,
                "fname": file.filename or "incident_attachment",
                "mime": mime_type,
                "size": len(content),
                "sha": sha,
            },
        )
        attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        next_sort = db.execute(
            text(
                """
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM incident_attachments
                WHERE incident_id = :iid
                """
            ),
            {"iid": incident_id},
        ).scalar()
        db.execute(
            text(
                """
                INSERT INTO incident_attachments (incident_id, attachment_id, kind, sort_order)
                VALUES (:iid, :aid, :kind, :sort_order)
                """
            ),
            {
                "iid": incident_id,
                "aid": attachment_id,
                "kind": normalized_kind,
                "sort_order": int(next_sort or 0),
            },
        )
        db.commit()
        return {
            "incident_id": incident_id,
            "attachment_id": attachment_id,
            "kind": normalized_kind,
            "mime_type": mime_type,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
