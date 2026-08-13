from __future__ import annotations

import re

from fastapi import Depends, HTTPException, Path
from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..services.photo_metadata_export import PhotoMetadataExportUnsupported, render_corrected_jpeg
from ..storage import get_object_bytes
from .photo_map import _can_view_submission, _effective_capture, _photo_belongs_to_submission, router


def _safe_export_filename(file_name: str | None, attachment_id: int) -> str:
    raw = (file_name or f"photo-{attachment_id}.jpg").strip()
    stem = raw.rsplit(".", 1)[0] if "." in raw else raw
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")[:100]
    if not stem:
        stem = f"photo-{attachment_id}"
    return f"{stem}_ERIS-corrected.jpg"


def _photo_export_row(db: Session, attachment_id: int):
    return db.execute(text("""
        SELECT a.id attachment_id, a.file_name, a.mime_type, a.storage_bucket, a.storage_key, a.sha256,
               cm.latitude, cm.longitude, cm.horizontal_accuracy_m, cm.altitude_m,
               cm.camera_heading_deg, cm.camera_heading_accuracy_code, cm.heading_reference,
               cm.location_source, cm.heading_source,
               cc.id correction_id, cc.location_is_override correction_location_is_override,
               cc.latitude correction_latitude, cc.longitude correction_longitude,
               cc.heading_is_override correction_heading_is_override,
               cc.camera_heading_deg correction_camera_heading_deg,
               cc.corrected_by_user_id correction_corrected_by_user_id,
               cc.created_at correction_created_at
        FROM attachments a
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        LEFT JOIN attachment_capture_corrections cc ON cc.id=(
          SELECT c2.id FROM attachment_capture_corrections c2
          WHERE c2.attachment_id=a.id ORDER BY c2.id DESC LIMIT 1
        )
        WHERE a.id=:aid
        LIMIT 1
    """), {"aid": attachment_id}).mappings().first()


@router.get("/submissions/{submission_id}/photo-map/photos/{attachment_id}/corrected-export")
def export_photo_with_effective_metadata(
    submission_id: int = Path(..., ge=1),
    attachment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Return a derived JPEG with the current ERIS map metadata embedded in EXIF.

    The original attachment object and its stored SHA-256 are never modified. The
    export is generated from the immutable original plus the latest correction
    history each time it is requested, so a second correction can never leave a
    stale permanent derivative behind.
    """
    if not _can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission photo map")
    if not _photo_belongs_to_submission(db, submission_id=submission_id, attachment_id=attachment_id):
        raise HTTPException(status_code=404, detail="Photo attachment not found in this submission")

    row = _photo_export_row(db, attachment_id)
    if not row:
        raise HTTPException(status_code=404, detail="Photo attachment not found")
    if str(row["mime_type"] or "").lower() not in {"image/jpeg", "image/jpg"}:
        raise HTTPException(status_code=415, detail="Corrected metadata export currently supports JPEG photos only")

    effective = _effective_capture(row)
    bucket = str(row["storage_bucket"] or settings.MINIO_BUCKET)
    object_key = str(row["storage_key"] or "")
    if not object_key:
        raise HTTPException(status_code=409, detail="Photo attachment has no storage object")

    try:
        original_bytes, _content_type = get_object_bytes(object_key=object_key, bucket=bucket)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Photo storage is unavailable") from exc

    try:
        exported = render_corrected_jpeg(
            original_bytes,
            latitude=effective.get("latitude"),
            longitude=effective.get("longitude"),
            camera_heading_deg=effective.get("camera_heading_deg"),
            location_is_manual=effective.get("location_source") == "MANUAL",
        )
    except PhotoMetadataExportUnsupported as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc

    filename = _safe_export_filename(row["file_name"], attachment_id)
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
        "X-ERIS-Export": "effective-photo-metadata",
        "X-ERIS-Original-SHA256": str(row["sha256"] or ""),
    }
    return Response(content=exported, media_type="image/jpeg", headers=headers)
