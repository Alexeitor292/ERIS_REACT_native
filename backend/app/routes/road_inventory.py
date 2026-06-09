"""
Road inventory admin + lookup routes.

POST   /road-inventory/import-jobs          ADMIN  — async upload: store Excel, queue job, 202
GET    /road-inventory/import-jobs          ADMIN  — list latest 25 import jobs
GET    /road-inventory/import-jobs/{uuid}   ADMIN  — get single import job status
POST   /road-inventory/upload               ADMIN  — (legacy sync) upload Excel inline
GET    /road-inventory/versions             ADMIN  — list all dataset versions
POST   /road-inventory/versions/{id}/publish ADMIN — publish a version
POST   /road-inventory/versions/{id}/rollback ADMIN — re-publish a superseded version
GET    /road-inventory/manifest             auth   — latest published version + download URL
GET    /road-inventory/lookup               auth   — postmile range query
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, UploadFile, File, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user, require_roles
from ..storage import ensure_bucket_exists, put_object_bytes, object_access_url
from ..config import settings
from ..services.road_inventory_parser import ParseError, parse_excel
from ..services.road_inventory_lookup import (
    bulk_insert_segments,
    get_published_version_id,
    lookup_segments,
)
from ..services.road_inventory_import_jobs import (
    create_import_job as create_import_job_svc,
    get_import_job as get_import_job_svc,
    list_import_jobs as list_import_jobs_svc,
    run_import_job as run_import_job_svc,
)

router = APIRouter(prefix="/road-inventory", tags=["road-inventory"])

_ALLOWED_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",  # some clients omit a specific xlsx mime
}
_ROAD_INVENTORY_BUCKET = "road-inventory"


# ---------------------------------------------------------------------------
# Admin: Async import jobs
# ---------------------------------------------------------------------------

@router.post("/import-jobs", status_code=202)
def create_import_job_route(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    version_tag: str = Query(default="", description="Optional label, e.g. '2025-06-08'"),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """Store Excel in MinIO, create a queued import job, return 202.

    Background processing: parse Excel + bulk insert road_segments.
    Poll GET /road-inventory/import-jobs/{job_uuid} to track progress.
    """
    filename = file.filename or "upload.xlsx"
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only .xlsx files are accepted.",
        )

    file_bytes = file.file.read()
    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is empty.",
        )

    object_key = f"uploads/{uuid.uuid4()}.xlsx"
    try:
        ensure_bucket_exists(_ROAD_INVENTORY_BUCKET)
        put_object_bytes(
            object_key=object_key,
            data=file_bytes,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bucket=_ROAD_INVENTORY_BUCKET,
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Road inventory storage is unavailable. Please check MinIO bucket configuration.",
        )

    tag = version_tag.strip() or None
    job_uuid = create_import_job_svc(
        db,
        filename=filename,
        storage_key=object_key,
        file_size_bytes=len(file_bytes),
        version_tag=tag,
        created_by=user["id"],
    )

    background_tasks.add_task(run_import_job_svc, job_uuid)

    return get_import_job_svc(db, job_uuid)


@router.get("/import-jobs")
def list_import_jobs_route(
    db: Session = Depends(get_db),
    _user=Depends(require_roles(["ADMIN"])),
):
    """Return the latest 25 import jobs, newest first."""
    return list_import_jobs_svc(db)


@router.get("/import-jobs/{job_uuid}")
def get_import_job_route(
    job_uuid: str,
    db: Session = Depends(get_db),
    _user=Depends(require_roles(["ADMIN"])),
):
    """Return a single import job by UUID."""
    job = get_import_job_svc(db, job_uuid)
    if not job:
        raise HTTPException(status_code=404, detail="Import job not found")
    return job


# ---------------------------------------------------------------------------
# Admin: Upload (legacy sync — kept for backwards compatibility)
# ---------------------------------------------------------------------------

@router.post("/upload", status_code=201)
def upload_road_inventory(
    file: UploadFile = File(...),
    version_tag: str = Query(default="", description="Optional label, e.g. '2025-06-08'"),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """Upload a Caltrans TSN highway inventory Excel file.

    Creates a new dataset version with status=pending.
    Returns version_id, row_count, skipped_count, and any row-level warnings.
    """
    filename = file.filename or "upload.xlsx"
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only .xlsx files are accepted.",
        )

    file_bytes = file.file.read()
    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is empty.",
        )

    try:
        result = parse_excel(file_bytes)
    except ParseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    # Archive raw Excel in MinIO (non-fatal: version record is inserted regardless)
    object_key = f"uploads/{uuid.uuid4()}.xlsx"
    sha256 = hashlib.sha256(file_bytes).hexdigest()
    try:
        ensure_bucket_exists(_ROAD_INVENTORY_BUCKET)
        put_object_bytes(
            object_key=object_key,
            data=file_bytes,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bucket=_ROAD_INVENTORY_BUCKET,
        )
        storage_key = object_key
    except Exception:
        storage_key = None  # non-fatal: we still insert the version record

    tag = version_tag.strip() or (
        result.extract_date.isoformat() if result.extract_date else datetime.utcnow().strftime("%Y-%m-%d")
    )

    db.execute(text("""
        INSERT INTO road_inventory_datasets
            (version_tag, upload_filename, extract_date, row_count, skipped_count,
             status, storage_key, uploaded_by)
        VALUES
            (:tag, :filename, :extract_date, :row_count, :skipped_count,
             'pending', :storage_key, :uploaded_by)
    """), {
        "tag":          tag,
        "filename":     filename,
        "extract_date": result.extract_date,
        "row_count":    result.row_count,
        "skipped_count": result.skipped_count,
        "storage_key":  storage_key,
        "uploaded_by":  user["id"],
    })
    db.flush()

    version_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    bulk_insert_segments(db, int(version_id), result.rows)
    db.commit()

    return {
        "version_id":    version_id,
        "version_tag":   tag,
        "row_count":     result.row_count,
        "skipped_count": result.skipped_count,
        "warnings":      result.warnings[:50],  # cap to 50 lines in response
        "status":        "pending",
    }


# ---------------------------------------------------------------------------
# Admin: List versions
# ---------------------------------------------------------------------------

@router.get("/versions")
def list_versions(
    db: Session = Depends(get_db),
    _user=Depends(require_roles(["ADMIN"])),
):
    rows = db.execute(text("""
        SELECT id, version_tag, upload_filename, extract_date, row_count,
               skipped_count, status, uploaded_by, created_at, published_at
        FROM road_inventory_datasets
        ORDER BY created_at DESC
        LIMIT 100
    """)).mappings().all()
    return [_serialize_version(r) for r in rows]


# ---------------------------------------------------------------------------
# Admin: Publish
# ---------------------------------------------------------------------------

@router.post("/versions/{version_id}/publish")
def publish_version(
    version_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_roles(["ADMIN"])),
):
    """Publish a pending or superseded dataset version.

    Sets any currently published version to superseded first.
    """
    target = db.execute(text("""
        SELECT id, status FROM road_inventory_datasets WHERE id = :id
    """), {"id": version_id}).mappings().first()

    if not target:
        raise HTTPException(status_code=404, detail="Dataset version not found")
    if target["status"] == "published":
        raise HTTPException(status_code=409, detail="Version is already published")

    # Supersede current published version (if any)
    db.execute(text("""
        UPDATE road_inventory_datasets
        SET status = 'superseded'
        WHERE status = 'published'
    """))

    db.execute(text("""
        UPDATE road_inventory_datasets
        SET status = 'published', published_at = NOW()
        WHERE id = :id
    """), {"id": version_id})
    db.commit()

    return {"version_id": version_id, "status": "published"}


# ---------------------------------------------------------------------------
# Admin: Rollback
# ---------------------------------------------------------------------------

@router.post("/versions/{version_id}/rollback")
def rollback_version(
    version_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_roles(["ADMIN"])),
):
    """Re-publish a superseded version, superseding the current published one."""
    target = db.execute(text("""
        SELECT id, status FROM road_inventory_datasets WHERE id = :id
    """), {"id": version_id}).mappings().first()

    if not target:
        raise HTTPException(status_code=404, detail="Dataset version not found")
    if target["status"] == "pending":
        raise HTTPException(
            status_code=409,
            detail="Cannot rollback a pending version — use /publish instead",
        )
    if target["status"] == "published":
        raise HTTPException(status_code=409, detail="Version is already published")

    db.execute(text("""
        UPDATE road_inventory_datasets
        SET status = 'superseded'
        WHERE status = 'published'
    """))

    db.execute(text("""
        UPDATE road_inventory_datasets
        SET status = 'published', published_at = NOW()
        WHERE id = :id
    """), {"id": version_id})
    db.commit()

    return {"version_id": version_id, "status": "published", "action": "rollback"}


# ---------------------------------------------------------------------------
# Authenticated: Manifest
# ---------------------------------------------------------------------------

@router.get("/manifest")
def get_manifest(
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return the latest published dataset version metadata.

    Includes a download_url for the mobile SQLite package if one has been
    generated (Phase 2).  Returns 404 when no published dataset exists.
    """
    version = db.execute(text("""
        SELECT id, version_tag, extract_date, row_count, published_at
        FROM road_inventory_datasets
        WHERE status = 'published'
        ORDER BY published_at DESC
        LIMIT 1
    """)).mappings().first()

    if not version:
        raise HTTPException(status_code=404, detail="No published road inventory dataset")

    pkg = db.execute(text("""
        SELECT storage_key, file_size_bytes, sha256, generated_at
        FROM road_inventory_packages
        WHERE dataset_version_id = :vid AND package_type = 'sqlite_gz'
        LIMIT 1
    """), {"vid": version["id"]}).mappings().first()

    download_url = None
    if pkg:
        try:
            download_url = object_access_url(
                _ROAD_INVENTORY_BUCKET,
                pkg["storage_key"],
            )
        except Exception:
            download_url = None

    return {
        "version_id":   version["id"],
        "version_tag":  version["version_tag"],
        "extract_date": version["extract_date"].isoformat() if version["extract_date"] else None,
        "row_count":    version["row_count"],
        "published_at": version["published_at"].isoformat() if version["published_at"] else None,
        "package": {
            "available":      pkg is not None,
            "download_url":   download_url,
            "file_size_bytes": pkg["file_size_bytes"] if pkg else None,
            "sha256":         pkg["sha256"] if pkg else None,
            "generated_at":   pkg["generated_at"].isoformat() if pkg and pkg["generated_at"] else None,
        },
    }


# ---------------------------------------------------------------------------
# Authenticated: Lookup
# ---------------------------------------------------------------------------

@router.get("/lookup")
def lookup(
    county: str = Query(..., description="3-letter Caltrans county code, e.g. 'SAC'"),
    route: str = Query(..., description="Route name, e.g. '50', '101', 'US 101'"),
    postmile: float = Query(..., description="Postmile value"),
    district: str | None = Query(default=None, description="District code, e.g. '03'"),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return road segments matching county + route + postmile range.

    Returns an empty list when no published dataset exists or no match found.
    """
    segments = lookup_segments(
        db,
        county_code=county,
        route=route,
        postmile=postmile,
        district_code=district,
    )
    return {"segments": [_serialize_segment(s) for s in segments]}


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _serialize_version(r: Any) -> dict:
    return {
        "id":            r["id"],
        "version_tag":   r["version_tag"],
        "upload_filename": r["upload_filename"],
        "extract_date":  r["extract_date"].isoformat() if r["extract_date"] else None,
        "row_count":     r["row_count"],
        "skipped_count": r["skipped_count"],
        "status":        r["status"],
        "uploaded_by":   r["uploaded_by"],
        "created_at":    r["created_at"].isoformat() if r["created_at"] else None,
        "published_at":  r["published_at"].isoformat() if r["published_at"] else None,
    }


def _serialize_segment(r: dict) -> dict:
    out = {}
    for k, v in r.items():
        if isinstance(v, (date, datetime)):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out
