import re
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Path, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
import hashlib

from .deps import require_roles
from .db import get_db
from .storage import put_object_bytes, make_object_key
from .config import settings
from .permissions import require_is_owner_or_admin


router = APIRouter(tags=["photos"])

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

async def _store_submission_attachment(
    *,
    submission_id: int,
    file: UploadFile,
    section_key: str | None,
    kind: str,
    db: Session,
    user: dict,
) -> dict:
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    mime_type = file.content_type or "application/octet-stream"
    normalized_section = _normalize_section_key(section_key)
    normalized_kind = _normalize_kind(kind, mime_type)
    sha = hashlib.sha256(content).hexdigest()
    object_key = make_object_key(file.filename or "attachment.bin")

    put_object_bytes(
        object_key=object_key,
        data=content,
        content_type=mime_type,
        bucket=settings.MINIO_BUCKET,
    )

    db.execute(text("""
        INSERT INTO attachments (
          created_by_user_id, storage_provider, storage_bucket, storage_key,
          file_name, mime_type, file_size_bytes, sha256, uploaded_at
        ) VALUES (
          :uid, 'minio', :bucket, :key, :fname, :mime, :size, :sha, NOW()
        )
    """), {
        "uid": user["id"],
        "bucket": settings.MINIO_BUCKET,
        "key": object_key,
        "fname": file.filename or "attachment",
        "mime": mime_type,
        "size": len(content),
        "sha": sha,
    })
    attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
    next_sort = db.execute(text("""
        SELECT COALESCE(MAX(sort_order), -1) + 1
        FROM attachment_links
        WHERE submission_id = :sid
    """), {"sid": submission_id}).scalar()
    db.execute(text("""
        INSERT INTO attachment_links (submission_id, attachment_id, kind, sort_order, section_key)
        VALUES (:sid, :aid, :kind, :sort_order, :section_key)
    """), {
        "sid": submission_id,
        "aid": attachment_id,
        "kind": normalized_kind,
        "sort_order": int(next_sort or 0),
        "section_key": normalized_section,
    })
    db.commit()
    return {
        "attachment_id": attachment_id,
        "kind": normalized_kind,
        "section_key": normalized_section,
        "mime_type": mime_type,
    }

@router.post("/submissions/{submission_id}/photos")
async def upload_submission_photo(
    submission_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    section_key: str | None = Query(default=None, max_length=64),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    created = await _store_submission_attachment(
        submission_id=submission_id,
        file=file,
        section_key=section_key,
        kind="PHOTO",
        db=db,
        user=user,
    )
    return {
        "attachment_id": created["attachment_id"],
        "photo_id": created["attachment_id"],
        "section_key": created["section_key"],
    }

@router.post("/submissions/{submission_id}/attachments")
async def upload_submission_attachment(
    submission_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    section_key: str | None = Query(default=None, max_length=64),
    kind: str = Query(default="DOC", max_length=16),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    return await _store_submission_attachment(
        submission_id=submission_id,
        file=file,
        section_key=section_key,
        kind=kind,
        db=db,
        user=user,
    )
