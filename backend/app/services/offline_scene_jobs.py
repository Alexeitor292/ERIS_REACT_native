"""
Offline 3D scene-package GENERATION job model + state machine.

Durable, DB-backed queue for the automatic pipeline. Pure state helpers (testable
without a DB) plus thin raw-SQL DB operations used by the endpoints and the worker.
"""

from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.orm import Session

JOB_STATES = [
    "QUEUED",
    "FETCHING_USGS_3DEP",
    "BUILDING_TERRAIN",
    "BUILDING_BASEMAP",
    "PACKAGING",
    "VERIFYING",
    "UPLOADING",
    "REGISTERING",
    "READY",
    "FAILED",
    "CANCELLED",
]

TERMINAL_STATES = {"READY", "FAILED", "CANCELLED"}
RUNNING_STATES = {
    "FETCHING_USGS_3DEP",
    "BUILDING_TERRAIN",
    "BUILDING_BASEMAP",
    "PACKAGING",
    "VERIFYING",
    "UPLOADING",
    "REGISTERING",
}
# A submission may not have two of these at once (duplicate-job prevention).
ACTIVE_STATES = {"QUEUED"} | RUNNING_STATES

STEP_PROGRESS = {
    "QUEUED": 0,
    "FETCHING_USGS_3DEP": 10,
    "BUILDING_TERRAIN": 40,
    "BUILDING_BASEMAP": 55,
    "PACKAGING": 70,
    "VERIFYING": 80,
    "UPLOADING": 88,
    "REGISTERING": 95,
    "READY": 100,
    "FAILED": 0,
    "CANCELLED": 0,
}


def is_terminal(status: str) -> bool:
    return status in TERMINAL_STATES


def is_active(status: str) -> bool:
    return status in ACTIVE_STATES


def can_cancel(status: str) -> bool:
    # Safe to cancel anything not already terminal; the worker checks for CANCELLED
    # before each step and aborts cleanly.
    return status in ACTIVE_STATES


def can_retry(status: str) -> bool:
    return status == "FAILED"


def progress_for(status: str) -> int:
    return STEP_PROGRESS.get(status, 0)


# ---- DB operations ---------------------------------------------------------

_COLS = """
    id, submission_id, requested_by, status, progress_pct, status_message,
    center_lat, center_lon, radius_m, min_lat, min_lon, max_lat, max_lon,
    retry_count, error_details, result_package_id, result_package_version,
    usgs_source_metadata, basemap_source_metadata, worker_id, worker_log_ref,
    claimed_at, created_at, updated_at
"""


def get_job(db: Session, job_id: int) -> dict | None:
    row = db.execute(text(f"SELECT {_COLS} FROM offline_scene_jobs WHERE id=:id"), {"id": job_id}).mappings().first()
    return dict(row) if row else None


def get_active_job(db: Session, submission_id: int) -> dict | None:
    placeholders = ",".join(f"'{s}'" for s in ACTIVE_STATES)
    row = db.execute(
        text(f"""
            SELECT {_COLS} FROM offline_scene_jobs
            WHERE submission_id=:s AND status IN ({placeholders})
            ORDER BY id DESC LIMIT 1
        """),
        {"s": submission_id},
    ).mappings().first()
    return dict(row) if row else None


def get_latest_job(db: Session, submission_id: int) -> dict | None:
    row = db.execute(
        text(f"SELECT {_COLS} FROM offline_scene_jobs WHERE submission_id=:s ORDER BY id DESC LIMIT 1"),
        {"s": submission_id},
    ).mappings().first()
    return dict(row) if row else None


def create_job(
    db: Session, *, submission_id: int, requested_by: int | None, aoi: dict
) -> dict:
    db.execute(
        text("""
            INSERT INTO offline_scene_jobs
              (submission_id, requested_by, status, progress_pct, status_message,
               center_lat, center_lon, radius_m, min_lat, min_lon, max_lat, max_lon)
            VALUES
              (:s, :u, 'QUEUED', 0, 'Queued for terrain preparation',
               :clat, :clon, :r, :minlat, :minlon, :maxlat, :maxlon)
        """),
        {
            "s": submission_id, "u": requested_by,
            "clat": aoi["center"]["lat"], "clon": aoi["center"]["lon"], "r": aoi["radius_m"],
            "minlat": aoi["bounds"]["min_lat"], "minlon": aoi["bounds"]["min_lon"],
            "maxlat": aoi["bounds"]["max_lat"], "maxlon": aoi["bounds"]["max_lon"],
        },
    )
    db.commit()
    return get_latest_job(db, submission_id)  # type: ignore[return-value]


def update_job(db: Session, job_id: int, **fields) -> dict | None:
    if not fields:
        return get_job(db, job_id)
    # JSON columns are serialized here.
    for jcol in ("usgs_source_metadata", "basemap_source_metadata"):
        if jcol in fields and not isinstance(fields[jcol], (str, type(None))):
            fields[jcol] = json.dumps(fields[jcol])
    sets = ", ".join(f"{k}=:{k}" for k in fields)
    params = dict(fields)
    params["id"] = job_id
    db.execute(text(f"UPDATE offline_scene_jobs SET {sets} WHERE id=:id"), params)
    db.commit()
    return get_job(db, job_id)


def claim_next_job(db: Session, worker_id: str) -> dict | None:
    """Atomically claim one QUEUED job (FOR UPDATE SKIP LOCKED), transition it to
    FETCHING_USGS_3DEP. Returns the claimed job or None. Prevents duplicate
    processing across workers."""
    row = db.execute(
        text("""
            SELECT id FROM offline_scene_jobs
            WHERE status='QUEUED' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    ).first()
    if not row:
        db.commit()
        return None
    job_id = row[0]
    db.execute(
        text("""
            UPDATE offline_scene_jobs
            SET status='FETCHING_USGS_3DEP', progress_pct=:p,
                status_message='Fetching USGS 3DEP elevation',
                worker_id=:w, claimed_at=NOW()
            WHERE id=:id AND status='QUEUED'
        """),
        {"p": STEP_PROGRESS["FETCHING_USGS_3DEP"], "w": worker_id, "id": job_id},
    )
    db.commit()
    return get_job(db, job_id)


def recover_stale_jobs(db: Session, stale_seconds: int = 600) -> int:
    """Requeue running jobs whose worker died (no update within stale_seconds).
    Returns the number requeued. Run on worker startup / periodically."""
    placeholders = ",".join(f"'{s}'" for s in RUNNING_STATES)
    res = db.execute(
        text(f"""
            UPDATE offline_scene_jobs
            SET status='QUEUED', progress_pct=0,
                status_message='Requeued after interruption',
                worker_id=NULL, claimed_at=NULL
            WHERE status IN ({placeholders})
              AND updated_at < (NOW() - INTERVAL :sec SECOND)
        """),
        {"sec": stale_seconds},
    )
    db.commit()
    return int(res.rowcount or 0)


def cancel_job(db: Session, job_id: int) -> dict | None:
    db.execute(
        text("""
            UPDATE offline_scene_jobs
            SET status='CANCELLED', status_message='Cancelled by user'
            WHERE id=:id AND status NOT IN ('READY','FAILED','CANCELLED')
        """),
        {"id": job_id},
    )
    db.commit()
    return get_job(db, job_id)


def retry_job(db: Session, job_id: int) -> dict | None:
    db.execute(
        text("""
            UPDATE offline_scene_jobs
            SET status='QUEUED', progress_pct=0, retry_count=retry_count+1,
                status_message='Re-queued for retry', error_details=NULL,
                worker_id=NULL, claimed_at=NULL
            WHERE id=:id AND status='FAILED'
        """),
        {"id": job_id},
    )
    db.commit()
    return get_job(db, job_id)
