from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Path
from sqlalchemy.orm import Session
from sqlalchemy import text
import hashlib

from .deps import require_roles
from .db import get_db
from .storage import put_object_bytes, make_object_key
from .config import settings
from .permissions import require_is_owner_or_admin


router = APIRouter(tags=["photos"])

@router.post("/submissions/{submission_id}/photos")
async def upload_submission_photo(
    submission_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    sha = hashlib.sha256(content).hexdigest()
    object_key = make_object_key(file.filename or "photo.jpg")

    # Upload to MinIO from backend
    put_object_bytes(
        object_key=object_key,
        data=content,
        content_type=file.content_type or "application/octet-stream",
        bucket=settings.MINIO_BUCKET,
    )

    # Save metadata + link as PHOTO
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
        "fname": file.filename or "photo",
        "mime": file.content_type or "application/octet-stream",
        "size": len(content),
        "sha": sha,
    })

    attachment_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    db.execute(text("""
        INSERT INTO attachment_links (submission_id, attachment_id, kind, sort_order)
        VALUES (:sid, :aid, 'PHOTO', 0)
        ON DUPLICATE KEY UPDATE kind='PHOTO'
    """), {"sid": submission_id, "aid": int(attachment_id)})

    db.commit()
    return {"attachment_id": int(attachment_id), "photo_id": int(attachment_id)}
