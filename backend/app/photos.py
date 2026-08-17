import json
import math
import re
from datetime import datetime

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Path, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
import hashlib

from .deps import get_current_user, require_roles
from .db import get_db
from .storage import put_object_bytes, make_object_key
from .config import settings
from .permissions import is_admin, is_reviewer, require_is_owner_or_admin

router = APIRouter(tags=["photos"])

_LOCATION_SOURCES = {"DEVICE_AT_CAPTURE", "EXIF_GPS", "MANUAL", "UNKNOWN"}
_HEADING_SOURCES = {"DEVICE_TRUE_HEADING", "DEVICE_MAGNETIC_HEADING", "EXIF_GPS_IMG_DIRECTION", "MANUAL", "UNKNOWN"}
_HEADING_REFERENCES = {"TRUE_NORTH", "MAGNETIC_NORTH", "UNKNOWN"}
_SUBMISSION_STATUSES = {"DRAFT", "SUBMITTED", "APPROVED", "REJECTED"}


def _normalize_section_key(section_key: str | None) -> str | None:
    raw = (section_key or "").strip().lower()
    if not raw:
        return None
    if not re.fullmatch(r"[a-z0-9_\-]{2,64}", raw):
        raise HTTPException(status_code=400, detail="Invalid section_key format")
    return raw


def _normalize_kind(kind: str | None, fallback_mime: str | None) -> str:
    value = (kind or "").strip().upper()
    if value in {"PHOTO", "VIDEO", "DOC", "SKETCH"}:
        return value
    mime = (fallback_mime or "").strip().lower()
    if mime.startswith("image/"):
        return "PHOTO"
    if mime.startswith("video/"):
        return "VIDEO"
    return "DOC"


def _finite(value, *, name: str, minimum=None, maximum=None):
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be numeric")
    if not math.isfinite(out):
        raise HTTPException(status_code=400, detail=f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise HTTPException(status_code=400, detail=f"{name} is below the allowed range")
    if maximum is not None and out > maximum:
        raise HTTPException(status_code=400, detail=f"{name} is above the allowed range")
    return out


def _enum(value, *, name: str, allowed: set[str]):
    if value is None or str(value).strip() == "":
        return None
    out = str(value).strip().upper()
    if out not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid {name}")
    return out


def _captured_at(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            from datetime import timezone
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        raise HTTPException(status_code=400, detail="captured_at must be ISO-8601")


def _normalize_capture_metadata(raw_json: str | None) -> dict | None:
    if raw_json is None or not raw_json.strip():
        return None
    try:
        raw = json.loads(raw_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="capture_metadata_json must be valid JSON")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="capture_metadata_json must be an object")

    lat = _finite(raw.get("latitude"), name="latitude", minimum=-90, maximum=90)
    lon = _finite(raw.get("longitude"), name="longitude", minimum=-180, maximum=180)
    if (lat is None) != (lon is None):
        raise HTTPException(status_code=400, detail="latitude and longitude must be supplied together")

    heading = _finite(raw.get("camera_heading_deg"), name="camera_heading_deg", minimum=0)
    if heading is not None and heading >= 360:
        raise HTTPException(status_code=400, detail="camera_heading_deg must be less than 360")

    heading_accuracy = raw.get("camera_heading_accuracy_code")
    if heading_accuracy is not None and heading_accuracy != "":
        try:
            heading_accuracy = int(heading_accuracy)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="camera_heading_accuracy_code must be an integer")
        if heading_accuracy < 0 or heading_accuracy > 3:
            raise HTTPException(status_code=400, detail="camera_heading_accuracy_code must be between 0 and 3")
    else:
        heading_accuracy = None

    location_source = _enum(raw.get("location_source"), name="location_source", allowed=_LOCATION_SOURCES)
    heading_source = _enum(raw.get("heading_source"), name="heading_source", allowed=_HEADING_SOURCES)
    heading_reference = _enum(raw.get("heading_reference"), name="heading_reference", allowed=_HEADING_REFERENCES)
    if lat is not None and location_source is None:
        location_source = "UNKNOWN"
    if heading is not None and heading_source is None:
        heading_source = "UNKNOWN"
    if heading is not None and heading_reference is None:
        heading_reference = "UNKNOWN"

    provenance = raw.get("provenance")
    safe_provenance = None
    if isinstance(provenance, dict):
        safe_provenance = {
            "asset_id": str(provenance.get("asset_id"))[:160] if provenance.get("asset_id") else None,
            "exif_tags_present": [str(v)[:64] for v in (provenance.get("exif_tags_present") or [])][:32],
        }

    normalized = {
        "captured_at": _captured_at(raw.get("captured_at")),
        "latitude": lat,
        "longitude": lon,
        "horizontal_accuracy_m": _finite(raw.get("horizontal_accuracy_m"), name="horizontal_accuracy_m", minimum=0),
        "altitude_m": _finite(raw.get("altitude_m"), name="altitude_m"),
        "camera_heading_deg": heading,
        "camera_heading_accuracy_code": heading_accuracy,
        "heading_reference": heading_reference,
        "location_source": location_source,
        "heading_source": heading_source,
        "metadata_json": safe_provenance,
    }
    return normalized if any(v is not None for v in normalized.values()) else None


def _store_capture_metadata(db: Session, attachment_id: int, metadata: dict | None) -> None:
    if metadata is None:
        return
    params = {"aid": attachment_id, **metadata}
    params["metadata_json"] = json.dumps(metadata["metadata_json"], separators=(",", ":")) if metadata.get("metadata_json") is not None else None
    exists = db.execute(text("SELECT 1 FROM attachment_capture_metadata WHERE attachment_id = :aid"), {"aid": attachment_id}).first()
    if exists:
        db.execute(text("""
            UPDATE attachment_capture_metadata
            SET captured_at=:captured_at, latitude=:latitude, longitude=:longitude,
                horizontal_accuracy_m=:horizontal_accuracy_m, altitude_m=:altitude_m,
                camera_heading_deg=:camera_heading_deg, camera_heading_accuracy_code=:camera_heading_accuracy_code,
                heading_reference=:heading_reference, location_source=:location_source,
                heading_source=:heading_source, metadata_json=:metadata_json,
                updated_at=CURRENT_TIMESTAMP
            WHERE attachment_id=:aid
        """), params)
    else:
        db.execute(text("""
            INSERT INTO attachment_capture_metadata (
              attachment_id, captured_at, latitude, longitude,
              horizontal_accuracy_m, altitude_m, camera_heading_deg,
              camera_heading_accuracy_code, heading_reference,
              location_source, heading_source, metadata_json
            ) VALUES (
              :aid, :captured_at, :latitude, :longitude,
              :horizontal_accuracy_m, :altitude_m, :camera_heading_deg,
              :camera_heading_accuracy_code, :heading_reference,
              :location_source, :heading_source, :metadata_json
            )
        """), params)


async def _store_submission_attachment(*, submission_id: int, file: UploadFile, section_key: str | None,
                                       kind: str, capture_metadata_json: str | None,
                                       db: Session, user: dict) -> dict:
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    mime_type = file.content_type or "application/octet-stream"
    normalized_section = _normalize_section_key(section_key)
    normalized_kind = _normalize_kind(kind, mime_type)
    capture_metadata = _normalize_capture_metadata(capture_metadata_json)
    if capture_metadata is not None and normalized_kind != "PHOTO":
        raise HTTPException(status_code=400, detail="Capture metadata is supported only for PHOTO attachments")

    sha = hashlib.sha256(content).hexdigest()
    object_key = make_object_key(file.filename or "attachment.bin")
    put_object_bytes(object_key=object_key, data=content, content_type=mime_type, bucket=settings.MINIO_BUCKET)

    db.execute(text("""
        INSERT INTO attachments (
          created_by_user_id, storage_provider, storage_bucket, storage_key,
          file_name, mime_type, file_size_bytes, sha256, captured_at, uploaded_at
        ) VALUES (
          :uid, 'minio', :bucket, :key, :fname, :mime, :size, :sha, :captured_at, NOW()
        )
    """), {
        "uid": user["id"], "bucket": settings.MINIO_BUCKET, "key": object_key,
        "fname": file.filename or "attachment", "mime": mime_type,
        "size": len(content), "sha": sha,
        "captured_at": capture_metadata.get("captured_at") if capture_metadata else None,
    })
    attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
    next_sort = db.execute(text("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM attachment_links WHERE submission_id=:sid"), {"sid": submission_id}).scalar()
    db.execute(text("""
        INSERT INTO attachment_links (submission_id, attachment_id, kind, sort_order, section_key)
        VALUES (:sid, :aid, :kind, :sort_order, :section_key)
    """), {"sid": submission_id, "aid": attachment_id, "kind": normalized_kind,
             "sort_order": int(next_sort or 0), "section_key": normalized_section})
    _store_capture_metadata(db, attachment_id, capture_metadata)
    db.commit()
    return {
        "attachment_id": attachment_id,
        "kind": normalized_kind,
        "section_key": normalized_section,
        "mime_type": mime_type,
        "capture_metadata": {
            key: value.isoformat() if isinstance(value, datetime) else value
            for key, value in (capture_metadata or {}).items() if key != "metadata_json"
        } if capture_metadata else None,
    }


@router.post("/submissions/{submission_id}/photos")
async def upload_submission_photo(submission_id: int = Path(..., ge=1), file: UploadFile = File(...),
                                  capture_metadata_json: str | None = Form(default=None),
                                  section_key: str | None = Query(default=None, max_length=64),
                                  db: Session = Depends(get_db),
                                  user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))):
    created = await _store_submission_attachment(
        submission_id=submission_id, file=file, section_key=section_key, kind="PHOTO",
        capture_metadata_json=capture_metadata_json, db=db, user=user,
    )
    return {"attachment_id": created["attachment_id"], "photo_id": created["attachment_id"],
            "section_key": created["section_key"], "capture_metadata": created["capture_metadata"]}


@router.post("/submissions/{submission_id}/attachments")
async def upload_submission_attachment(submission_id: int = Path(..., ge=1), file: UploadFile = File(...),
                                       capture_metadata_json: str | None = Form(default=None),
                                       section_key: str | None = Query(default=None, max_length=64),
                                       kind: str = Query(default="DOC", max_length=16),
                                       db: Session = Depends(get_db),
                                       user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))):
    return await _store_submission_attachment(
        submission_id=submission_id, file=file, section_key=section_key, kind=kind,
        capture_metadata_json=capture_metadata_json, db=db, user=user,
    )


@router.get("/submissions/page")
def list_submissions_page(
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    status_filter: str | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Cursor-paginated submission worklist preserving the legacy visibility rules."""
    params: dict[str, object] = {"limit_plus_one": limit + 1}
    predicates: list[str] = []

    if before_id is not None:
        params["before_id"] = before_id
        predicates.append("s.id < :before_id")

    if status_filter:
        normalized_status = status_filter.strip().upper()
        if normalized_status not in _SUBMISSION_STATUSES:
            raise HTTPException(status_code=400, detail="Invalid status filter")
        params["status"] = normalized_status
        predicates.append("s.status = :status")

    select_sql = """
        SELECT DISTINCT s.id, s.created_by_user_id, s.status, s.client_submission_uuid, s.title,
               s.created_at, s.submitted_at, s.reviewed_at,
               g.district, g.county, g.route, g.post_mile
        FROM submissions s
    """

    if is_admin(user) or is_reviewer(user):
        joins_sql = "LEFT JOIN submission_gisa g ON g.submission_id = s.id"
    else:
        params["uid"] = int(user["id"])
        joins_sql = """
            LEFT JOIN submission_visibility v
              ON v.submission_id = s.id AND v.user_id = :uid
            LEFT JOIN submission_editors e
              ON e.submission_id = s.id AND e.user_id = :uid
            LEFT JOIN submission_gisa g ON g.submission_id = s.id
        """
        predicates.insert(0, "(s.created_by_user_id = :uid OR v.user_id IS NOT NULL OR e.user_id IS NOT NULL)")

    where_sql = f"WHERE {' AND '.join(predicates)}" if predicates else ""
    rows = db.execute(text(f"""
        {select_sql}
        {joins_sql}
        {where_sql}
        ORDER BY s.id DESC
        LIMIT :limit_plus_one
    """), params).mappings().all()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    items = [dict(row) for row in page_rows]
    next_cursor = int(page_rows[-1]["id"]) if has_more and page_rows else None

    return {
        "items": items,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }
