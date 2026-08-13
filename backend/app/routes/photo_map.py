import json
import math
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Path
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
_CLIENT_CORRECTION_UUID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")


def _owns_linked_incident(db: Session, *, user_id: int, submission_id: int) -> bool:
    return bool(db.execute(text("""
        SELECT 1
        FROM incident_submission_links l
        JOIN incidents i ON i.id=l.incident_id
        WHERE l.submission_id=:sid AND i.created_by_user_id=:uid
        LIMIT 1
    """), {"sid": submission_id, "uid": user_id}).first())


def _can_view_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user) or is_reviewer(user) or is_operational_user(user):
        return True
    row = db.execute(text("""
        SELECT s.created_by_user_id AS owner_id,
               EXISTS(SELECT 1 FROM submission_visibility v WHERE v.submission_id=s.id AND v.user_id=:uid) AS has_view_grant,
               EXISTS(SELECT 1 FROM submission_editors e WHERE e.submission_id=s.id AND e.user_id=:uid) AS has_edit_grant
        FROM submissions s WHERE s.id=:sid LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()
    if bool(row) and (int(row["owner_id"]) == int(user["id"]) or bool(row["has_view_grant"]) or bool(row["has_edit_grant"])):
        return True
    return _owns_linked_incident(db, user_id=int(user["id"]), submission_id=submission_id)


def _can_edit_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user):
        return True
    row = db.execute(text("""
        SELECT s.created_by_user_id AS owner_id,
               EXISTS(SELECT 1 FROM submission_editors e WHERE e.submission_id=s.id AND e.user_id=:uid) AS has_edit_grant
        FROM submissions s WHERE s.id=:sid LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()
    return bool(row) and (int(row["owner_id"]) == int(user["id"]) or bool(row["has_edit_grant"]))


def _photo_belongs_to_submission(db: Session, *, submission_id: int, attachment_id: int) -> bool:
    return bool(db.execute(text("""
        SELECT 1
        FROM attachment_links al
        WHERE al.submission_id=:sid AND al.attachment_id=:aid AND al.kind='PHOTO'
        UNION ALL
        SELECT 1
        FROM incident_submission_links l
        JOIN incident_attachments ia ON ia.incident_id=l.incident_id
        WHERE l.submission_id=:sid AND ia.attachment_id=:aid AND ia.kind='PHOTO'
        LIMIT 1
    """), {"sid": submission_id, "aid": attachment_id}).first())


def _owns_incident_photo(db: Session, *, user_id: int, submission_id: int, attachment_id: int) -> bool:
    return bool(db.execute(text("""
        SELECT 1
        FROM incident_submission_links l
        JOIN incidents i ON i.id=l.incident_id
        JOIN incident_attachments ia ON ia.incident_id=i.id
        WHERE l.submission_id=:sid
          AND ia.attachment_id=:aid
          AND ia.kind='PHOTO'
          AND i.created_by_user_id=:uid
        LIMIT 1
    """), {"sid": submission_id, "aid": attachment_id, "uid": user_id}).first())


def _can_edit_photo(db: Session, *, user: dict, submission_id: int, attachment_id: int) -> bool:
    return _can_edit_submission(db, user=user, submission_id=submission_id) or _owns_incident_photo(
        db,
        user_id=int(user["id"]),
        submission_id=submission_id,
        attachment_id=attachment_id,
    )


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


def _required_finite(value, *, name: str, minimum: float, maximum: float) -> float:
    out = _finite(value)
    if out is None:
        raise HTTPException(status_code=400, detail=f"{name} must be a finite number")
    if out < minimum or out > maximum:
        raise HTTPException(status_code=400, detail=f"{name} is outside the allowed range")
    return out


def _int_or_none(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_correction_payload(raw) -> dict:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Photo correction must be a JSON object")

    client_uuid = str(raw.get("client_correction_uuid") or "").strip()
    if not _CLIENT_CORRECTION_UUID_RE.fullmatch(client_uuid):
        raise HTTPException(status_code=400, detail="Invalid client_correction_uuid")

    location_raw = raw.get("location_override")
    if location_raw is None:
        latitude = longitude = None
        location_is_override = False
    else:
        if not isinstance(location_raw, dict):
            raise HTTPException(status_code=400, detail="location_override must be an object or null")
        latitude = _required_finite(location_raw.get("latitude"), name="latitude", minimum=-90, maximum=90)
        longitude = _required_finite(location_raw.get("longitude"), name="longitude", minimum=-180, maximum=180)
        location_is_override = True

    heading_raw = raw.get("heading_override_deg")
    if heading_raw is None:
        heading = None
        heading_is_override = False
    else:
        heading = _required_finite(heading_raw, name="heading_override_deg", minimum=0, maximum=359.999999)
        heading_is_override = True

    return {
        "client_correction_uuid": client_uuid,
        "location_is_override": location_is_override,
        "latitude": latitude,
        "longitude": longitude,
        "heading_is_override": heading_is_override,
        "camera_heading_deg": heading,
    }


def _quality_gated_capture(row) -> dict:
    """Return original device telemetry safe to present as mapped evidence."""
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


def _captured_metadata(row) -> dict:
    return {
        "latitude": _finite(row["latitude"]),
        "longitude": _finite(row["longitude"]),
        "horizontal_accuracy_m": _finite(row["horizontal_accuracy_m"]),
        "altitude_m": _finite(row["altitude_m"]),
        "camera_heading_deg": _finite(row["camera_heading_deg"]),
        "camera_heading_accuracy_code": _int_or_none(row["camera_heading_accuracy_code"]),
        "heading_reference": row["heading_reference"],
        "location_source": row["location_source"],
        "heading_source": row["heading_source"],
    }


def _effective_capture(row) -> dict:
    original = _quality_gated_capture(row)
    correction_id = _int_or_none(row.get("correction_id"))
    location_overridden = bool(row.get("correction_location_is_override")) if correction_id else False
    heading_overridden = bool(row.get("correction_heading_is_override")) if correction_id else False

    effective = dict(original)
    if location_overridden:
        effective.update({
            "latitude": _finite(row.get("correction_latitude")),
            "longitude": _finite(row.get("correction_longitude")),
            "horizontal_accuracy_m": None,
            "altitude_m": None,
            "location_source": "MANUAL",
        })
    if heading_overridden:
        effective.update({
            "camera_heading_deg": _finite(row.get("correction_camera_heading_deg")),
            "camera_heading_accuracy_code": None,
            "heading_reference": "TRUE_NORTH",
            "heading_source": "MANUAL",
        })

    corrected_at = row.get("correction_created_at")
    effective["captured_metadata"] = _captured_metadata(row)
    effective["correction"] = {
        "has_history": correction_id is not None,
        "location_overridden": location_overridden,
        "heading_overridden": heading_overridden,
        "location_override": {
            "latitude": _finite(row.get("correction_latitude")),
            "longitude": _finite(row.get("correction_longitude")),
        } if location_overridden else None,
        "heading_override_deg": _finite(row.get("correction_camera_heading_deg")) if heading_overridden else None,
        "corrected_by_user_id": _int_or_none(row.get("correction_corrected_by_user_id")),
        "corrected_at": corrected_at.isoformat() if corrected_at else None,
    }
    return effective


def _current_correction(db: Session, attachment_id: int):
    return db.execute(text("""
        SELECT id, attachment_id, client_correction_uuid, location_is_override, latitude, longitude,
               heading_is_override, camera_heading_deg, corrected_by_user_id, created_at
        FROM attachment_capture_corrections
        WHERE attachment_id=:aid
        ORDER BY id DESC
        LIMIT 1
    """), {"aid": attachment_id}).mappings().first()


def _correction_response(row) -> dict:
    if not row:
        return {
            "location_override": None,
            "heading_override_deg": None,
            "corrected_by_user_id": None,
            "corrected_at": None,
        }
    location_override = None
    if bool(row["location_is_override"]):
        location_override = {
            "latitude": _finite(row["latitude"]),
            "longitude": _finite(row["longitude"]),
        }
    return {
        "location_override": location_override,
        "heading_override_deg": _finite(row["camera_heading_deg"]) if bool(row["heading_is_override"]) else None,
        "corrected_by_user_id": int(row["corrected_by_user_id"]),
        "corrected_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


@router.put("/submissions/{submission_id}/photo-map/photos/{attachment_id}/correction")
def put_photo_correction(
    submission_id: int = Path(..., ge=1),
    attachment_id: int = Path(..., ge=1),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if not _can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission photo map")
    if not _photo_belongs_to_submission(db, submission_id=submission_id, attachment_id=attachment_id):
        raise HTTPException(status_code=404, detail="Photo attachment not found in this submission")
    if not _can_edit_photo(db, user=user, submission_id=submission_id, attachment_id=attachment_id):
        raise HTTPException(status_code=403, detail="Not allowed to correct this photo")

    normalized = _normalize_correction_payload(payload)
    existing = db.execute(text("""
        SELECT id, attachment_id, client_correction_uuid, location_is_override, latitude, longitude,
               heading_is_override, camera_heading_deg, corrected_by_user_id, created_at
        FROM attachment_capture_corrections
        WHERE client_correction_uuid=:uuid
        LIMIT 1
    """), {"uuid": normalized["client_correction_uuid"]}).mappings().first()
    if existing:
        if int(existing["attachment_id"]) != attachment_id:
            raise HTTPException(status_code=409, detail="client_correction_uuid is already bound to another photo")
        return {"attachment_id": attachment_id, "correction": _correction_response(existing), "idempotent_replay": True}

    db.execute(text("""
        INSERT INTO attachment_capture_corrections (
          attachment_id, client_correction_uuid, corrected_by_user_id,
          location_is_override, latitude, longitude,
          heading_is_override, camera_heading_deg
        ) VALUES (
          :attachment_id, :client_correction_uuid, :corrected_by_user_id,
          :location_is_override, :latitude, :longitude,
          :heading_is_override, :camera_heading_deg
        )
    """), {
        "attachment_id": attachment_id,
        "corrected_by_user_id": int(user["id"]),
        **normalized,
    })
    db.commit()
    current = _current_correction(db, attachment_id)
    return {"attachment_id": attachment_id, "correction": _correction_response(current), "idempotent_replay": False}


@router.get("/submissions/{submission_id}/photo-map")
def submission_photo_map(submission_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(get_current_user)):
    if not _can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission")
    if not db.execute(text("SELECT 1 FROM submissions WHERE id=:sid LIMIT 1"), {"sid": submission_id}).first():
        raise HTTPException(status_code=404, detail="Submission not found")

    submission_can_edit = _can_edit_submission(db, user=user, submission_id=submission_id)
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
               cm.location_source, cm.heading_source,
               cc.id correction_id, cc.location_is_override correction_location_is_override,
               cc.latitude correction_latitude, cc.longitude correction_longitude,
               cc.heading_is_override correction_heading_is_override,
               cc.camera_heading_deg correction_camera_heading_deg,
               cc.corrected_by_user_id correction_corrected_by_user_id,
               cc.created_at correction_created_at
        FROM attachment_links al
        JOIN attachments a ON a.id=al.attachment_id
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        LEFT JOIN attachment_capture_corrections cc ON cc.id=(
          SELECT c2.id FROM attachment_capture_corrections c2
          WHERE c2.attachment_id=a.id ORDER BY c2.id DESC LIMIT 1
        )
        WHERE al.submission_id=:sid AND al.kind='PHOTO'
        UNION ALL
        SELECT a.id attachment_id, a.file_name, a.mime_type, a.storage_bucket, a.storage_key,
               NULL section_key, 'INCIDENT' source_scope, COALESCE(cm.captured_at,a.captured_at) captured_at,
               cm.latitude, cm.longitude, cm.horizontal_accuracy_m, cm.altitude_m,
               cm.camera_heading_deg, cm.camera_heading_accuracy_code, cm.heading_reference,
               cm.location_source, cm.heading_source,
               cc.id correction_id, cc.location_is_override correction_location_is_override,
               cc.latitude correction_latitude, cc.longitude correction_longitude,
               cc.heading_is_override correction_heading_is_override,
               cc.camera_heading_deg correction_camera_heading_deg,
               cc.corrected_by_user_id correction_corrected_by_user_id,
               cc.created_at correction_created_at
        FROM incident_submission_links l
        JOIN incident_attachments ia ON ia.incident_id=l.incident_id
        JOIN attachments a ON a.id=ia.attachment_id
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        LEFT JOIN attachment_capture_corrections cc ON cc.id=(
          SELECT c2.id FROM attachment_capture_corrections c2
          WHERE c2.attachment_id=a.id ORDER BY c2.id DESC LIMIT 1
        )
        WHERE l.submission_id=:sid AND ia.kind='PHOTO'
    """), {"sid": submission_id}).mappings().all()

    deduped = {}
    for row in rows:
        aid = int(row["attachment_id"])
        if aid in deduped and deduped[aid]["source_scope"] == "SUBMISSION":
            continue
        capture = _effective_capture(row)
        can_edit_photo = submission_can_edit or _owns_incident_photo(
            db,
            user_id=int(user["id"]),
            submission_id=submission_id,
            attachment_id=aid,
        )
        deduped[aid] = {
            "attachment_id": aid,
            "file_name": row["file_name"], "mime_type": row["mime_type"],
            "section_key": row["section_key"], "source_scope": row["source_scope"],
            "can_edit_correction": can_edit_photo,
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
        "can_edit_corrections": any(bool(p["can_edit_correction"]) for p in photos),
        "incident": {"latitude": lat, "longitude": lon},
        "affected_geometry": _json_value(gisa["geometry_json"] if gisa else None),
        "summary": {"photos_total": len(photos), "photos_geotagged": len(mapped),
                    "photos_with_heading": len(headed), "photos_unmapped": len(photos)-len(mapped)},
        "photos": photos,
    }
