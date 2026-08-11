import json
import math

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..permissions import is_admin, is_operational_user, is_reviewer
from ..storage import object_access_url

router = APIRouter(tags=["photo-map"])

_MAX_MAPPED_PHOTO_ACCURACY_M = 20.0
_MIN_MAPPED_HEADING_ACCURACY_CODE = 2


def _can_view_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user) or is_reviewer(user) or is_operational_user(user):
        return True
    row = db.execute(text("""
        SELECT s.created_by_user_id AS owner_id,
               EXISTS(SELECT 1 FROM submission_visibility v WHERE v.submission_id=s.id AND v.user_id=:uid) AS has_view_grant,
               EXISTS(SELECT 1 FROM submission_editors e WHERE e.submission_id=s.id AND e.user_id=:uid) AS has_edit_grant
        FROM submissions s WHERE s.id=:sid LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()
    return bool(row) and (int(row["owner_id"]) == int(user["id"]) or bool(row["has_view_grant"]) or bool(row["has_edit_grant"]))


def _json_value(value):
    if value is None or isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return None


def _finite(value):
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int_or_none(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _quality_gated_capture(row) -> dict:
    """Return telemetry safe to present as mapped evidence.

    The database keeps the original observation for auditability. The map API is
    stricter: weak GPS fixes and weak/non-true-north headings are withheld rather
    than displayed as if they were exact.
    """
    latitude = _finite(row["latitude"])
    longitude = _finite(row["longitude"])
    horizontal_accuracy = _finite(row["horizontal_accuracy_m"])
    location_ok = (
        latitude is not None
        and longitude is not None
        and horizontal_accuracy is not None
        and 0 <= horizontal_accuracy <= _MAX_MAPPED_PHOTO_ACCURACY_M
    )

    heading = _finite(row["camera_heading_deg"])
    heading_accuracy = _int_or_none(row["camera_heading_accuracy_code"])
    heading_reference = row["heading_reference"]
    heading_ok = (
        heading is not None
        and heading_accuracy is not None
        and heading_accuracy >= _MIN_MAPPED_HEADING_ACCURACY_CODE
        and heading_reference == "TRUE_NORTH"
    )

    return {
        "latitude": latitude if location_ok else None,
        "longitude": longitude if location_ok else None,
        "horizontal_accuracy_m": horizontal_accuracy,
        "altitude_m": _finite(row["altitude_m"]) if location_ok else None,
        "camera_heading_deg": heading if heading_ok else None,
        "camera_heading_accuracy_code": heading_accuracy,
        "heading_reference": heading_reference if heading_ok else None,
        "location_source": row["location_source"] if location_ok else None,
        "heading_source": row["heading_source"] if heading_ok else None,
    }


@router.get("/submissions/{submission_id}/photo-map")
def submission_photo_map(submission_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(get_current_user)):
    if not _can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission")
    if not db.execute(text("SELECT 1 FROM submissions WHERE id=:sid LIMIT 1"), {"sid": submission_id}).first():
        raise HTTPException(status_code=404, detail="Submission not found")

    gisa = db.execute(text("SELECT latitude, longitude, geometry_json FROM submission_gisa WHERE submission_id=:sid LIMIT 1"), {"sid": submission_id}).mappings().first()
    incident = db.execute(text("""
        SELECT i.id, i.latitude, i.longitude
        FROM incident_submission_links l JOIN incidents i ON i.id=l.incident_id
        WHERE l.submission_id=:sid LIMIT 1
    """), {"sid": submission_id}).mappings().first()

    rows = db.execute(text("""
        SELECT a.id attachment_id, a.file_name, a.mime_type, a.storage_bucket, a.storage_key,
               al.section_key, 'SUBMISSION' source_scope, COALESCE(cm.captured_at,a.captured_at) captured_at,
               cm.latitude, cm.longitude, cm.horizontal_accuracy_m, cm.altitude_m,
               cm.camera_heading_deg, cm.camera_heading_accuracy_code, cm.heading_reference,
               cm.location_source, cm.heading_source
        FROM attachment_links al
        JOIN attachments a ON a.id=al.attachment_id
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        WHERE al.submission_id=:sid AND al.kind='PHOTO'
        UNION ALL
        SELECT a.id attachment_id, a.file_name, a.mime_type, a.storage_bucket, a.storage_key,
               NULL section_key, 'INCIDENT' source_scope, COALESCE(cm.captured_at,a.captured_at) captured_at,
               cm.latitude, cm.longitude, cm.horizontal_accuracy_m, cm.altitude_m,
               cm.camera_heading_deg, cm.camera_heading_accuracy_code, cm.heading_reference,
               cm.location_source, cm.heading_source
        FROM incident_submission_links l
        JOIN incident_attachments ia ON ia.incident_id=l.incident_id
        JOIN attachments a ON a.id=ia.attachment_id
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        WHERE l.submission_id=:sid AND ia.kind='PHOTO'
    """), {"sid": submission_id}).mappings().all()

    deduped = {}
    for row in rows:
        aid = int(row["attachment_id"])
        if aid in deduped and deduped[aid]["source_scope"] == "SUBMISSION":
            continue
        capture = _quality_gated_capture(row)
        deduped[aid] = {
            "attachment_id": aid,
            "file_name": row["file_name"], "mime_type": row["mime_type"],
            "section_key": row["section_key"], "source_scope": row["source_scope"],
            "captured_at": row["captured_at"].isoformat() if row["captured_at"] else None,
            **capture,
            "download_url": object_access_url(str(row["storage_bucket"] or settings.MINIO_BUCKET), str(row["storage_key"]), expires_seconds=900),
        }

    photos = list(deduped.values())
    mapped = [p for p in photos if p["latitude"] is not None and p["longitude"] is not None]
    headed = [p for p in mapped if p["camera_heading_deg"] is not None]
    lat = _finite(gisa["latitude"] if gisa else None)
    lon = _finite(gisa["longitude"] if gisa else None)
    if (lat is None or lon is None) and incident:
        lat, lon = _finite(incident["latitude"]), _finite(incident["longitude"])

    return {
        "submission_id": submission_id,
        "incident_id": int(incident["id"]) if incident else None,
        "incident": {"latitude": lat, "longitude": lon},
        "affected_geometry": _json_value(gisa["geometry_json"] if gisa else None),
        "summary": {"photos_total": len(photos), "photos_geotagged": len(mapped),
                    "photos_with_heading": len(headed), "photos_unmapped": len(photos)-len(mapped)},
        "photos": photos,
    }
