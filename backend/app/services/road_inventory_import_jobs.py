"""Async road inventory import job service.

Jobs are created by the POST /road-inventory/import-jobs route and executed
in a FastAPI BackgroundTask.  Each job has its own SQLAlchemy session; it
must NOT reuse the request session.

Lifecycle:  queued → processing (stage: storing→parsing→importing) → succeeded|failed
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)

from ..db import SessionLocal
from ..storage import get_object_bytes
from .road_inventory_parser import ParseError, parse_excel
from .road_inventory_lookup import bulk_insert_segments

_ROAD_INVENTORY_BUCKET = "road-inventory"


# ---------------------------------------------------------------------------
# Public CRUD helpers (called from request context with request session)
# ---------------------------------------------------------------------------

def create_import_job(
    db,
    *,
    filename: str,
    storage_key: str,
    file_size_bytes: int,
    version_tag: str | None,
    created_by: int,
) -> str:
    """Insert a queued job row and return its UUID."""
    import uuid as _uuid
    job_uuid = str(_uuid.uuid4())
    db.execute(text("""
        INSERT INTO road_inventory_import_jobs
            (job_uuid, status, stage, message,
             upload_filename, requested_version_tag,
             storage_key, file_size_bytes, created_by)
        VALUES
            (:job_uuid, 'queued', 'queued', 'Waiting to start',
             :filename, :version_tag,
             :storage_key, :file_size_bytes, :created_by)
    """), {
        "job_uuid": job_uuid,
        "filename": filename,
        "version_tag": version_tag,
        "storage_key": storage_key,
        "file_size_bytes": file_size_bytes,
        "created_by": created_by,
    })
    db.commit()
    return job_uuid


def get_import_job(db, job_uuid: str) -> dict | None:
    row = db.execute(text("""
        SELECT id, job_uuid, status, stage, message,
               upload_filename, requested_version_tag,
               storage_key, file_size_bytes, dataset_version_id,
               row_count, skipped_count, warnings_json, error_message,
               created_by, created_at, started_at, finished_at, updated_at
        FROM road_inventory_import_jobs
        WHERE job_uuid = :job_uuid
    """), {"job_uuid": job_uuid}).mappings().first()
    return _serialize_job(row) if row else None


def list_import_jobs(db, limit: int = 25) -> list[dict]:
    rows = db.execute(text("""
        SELECT id, job_uuid, status, stage, message,
               upload_filename, requested_version_tag,
               storage_key, file_size_bytes, dataset_version_id,
               row_count, skipped_count, warnings_json, error_message,
               created_by, created_at, started_at, finished_at, updated_at
        FROM road_inventory_import_jobs
        ORDER BY created_at DESC
        LIMIT :limit
    """), {"limit": limit}).mappings().all()
    return [_serialize_job(r) for r in rows]


# ---------------------------------------------------------------------------
# Background worker — creates its own session
# ---------------------------------------------------------------------------

def run_import_job(job_uuid: str) -> None:
    """Execute an import job in a background thread.

    Opens a fresh DB session independently of the request session.
    """
    db = SessionLocal()
    try:
        _update(db, job_uuid,
                status="processing",
                stage="storing",
                message="Retrieving file from storage",
                started_at=_now())

        job = db.execute(text("""
            SELECT storage_key, upload_filename, requested_version_tag,
                   file_size_bytes, created_by
            FROM road_inventory_import_jobs
            WHERE job_uuid = :job_uuid
        """), {"job_uuid": job_uuid}).mappings().first()

        if not job:
            return

        # Fetch raw Excel from MinIO
        try:
            file_bytes, _ = get_object_bytes(
                object_key=job["storage_key"],
                bucket=_ROAD_INVENTORY_BUCKET,
            )
        except Exception as exc:
            _update(db, job_uuid,
                    status="failed",
                    stage="failed",
                    message="Storage read failed",
                    error_message=str(exc),
                    finished_at=_now())
            return

        # Parse
        _update(db, job_uuid, stage="parsing", message="Parsing Excel file")
        try:
            result = parse_excel(file_bytes)
        except ParseError as exc:
            _update(db, job_uuid,
                    status="failed",
                    stage="failed",
                    message="Excel parse error",
                    error_message=str(exc),
                    finished_at=_now())
            return
        except Exception as exc:
            _update(db, job_uuid,
                    status="failed",
                    stage="failed",
                    message="Unexpected parse error",
                    error_message=str(exc),
                    finished_at=_now())
            return

        # Create pending dataset row
        _update(db, job_uuid,
                stage="importing",
                message=f"Importing {result.row_count} segments")

        tag = job["requested_version_tag"] or (
            result.extract_date.isoformat()
            if result.extract_date
            else _now().strftime("%Y-%m-%d")
        )

        db.execute(text("""
            INSERT INTO road_inventory_datasets
                (version_tag, upload_filename, extract_date, row_count, skipped_count,
                 status, storage_key, uploaded_by)
            VALUES
                (:tag, :filename, :extract_date, :row_count, :skipped_count,
                 'pending', :storage_key, :uploaded_by)
        """), {
            "tag": tag,
            "filename": job["upload_filename"],
            "extract_date": result.extract_date,
            "row_count": result.row_count,
            "skipped_count": result.skipped_count,
            "storage_key": job["storage_key"],
            "uploaded_by": job["created_by"],
        })
        db.flush()
        dataset_version_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())

        bulk_insert_segments(db, dataset_version_id, result.rows)
        db.commit()

        warnings_json = json.dumps(result.warnings[:50]) if result.warnings else None
        _update(db, job_uuid,
                status="succeeded",
                stage="succeeded",
                message=f"Imported {result.row_count} segments",
                dataset_version_id=dataset_version_id,
                row_count=result.row_count,
                skipped_count=result.skipped_count,
                warnings_json=warnings_json,
                finished_at=_now())

    except Exception as exc:
        try:
            db.rollback()
            _update(db, job_uuid,
                    status="failed",
                    stage="failed",
                    message="Unexpected error",
                    error_message=str(exc),
                    finished_at=_now())
        except Exception:
            pass
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _update(db, job_uuid: str, **fields: Any) -> None:
    """SET arbitrary columns on a job row and commit."""
    set_clause = ", ".join(f"{col} = :{col}" for col in fields)
    db.execute(
        text(f"UPDATE road_inventory_import_jobs SET {set_clause} WHERE job_uuid = :job_uuid"),
        {**fields, "job_uuid": job_uuid},
    )
    db.commit()


def _serialize_job(r: Any) -> dict:
    def _dt(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.isoformat()
        return str(v)

    warnings = r["warnings_json"]
    if isinstance(warnings, str):
        try:
            warnings = json.loads(warnings)
        except Exception:
            warnings = []
    elif isinstance(warnings, list):
        pass
    else:
        warnings = []

    return {
        "id":                    r["id"],
        "job_uuid":              r["job_uuid"],
        "status":                r["status"],
        "stage":                 r["stage"],
        "message":               r["message"],
        "upload_filename":       r["upload_filename"],
        "requested_version_tag": r["requested_version_tag"],
        "storage_key":           r["storage_key"],
        "file_size_bytes":       r["file_size_bytes"],
        "dataset_version_id":    r["dataset_version_id"],
        "row_count":             r["row_count"],
        "skipped_count":         r["skipped_count"],
        "warnings":              warnings,
        "error_message":         r["error_message"],
        "created_by":            r["created_by"],
        "created_at":            _dt(r["created_at"]),
        "started_at":            _dt(r["started_at"]),
        "finished_at":           _dt(r["finished_at"]),
        "updated_at":            _dt(r.get("updated_at")),
    }
