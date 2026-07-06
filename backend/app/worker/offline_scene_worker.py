"""
Offline 3D scene-package generation worker.

A SEPARATE process (its own Docker service) — long terrain jobs must not run in
the FastAPI request process. It safely claims QUEUED jobs from MariaDB, runs the
builder pipeline (fetch USGS 3DEP -> build -> validate -> upload -> register),
writes progress to the DB, recovers interrupted jobs, and only registers a READY
catalog package after validation + verified upload succeed.
"""

from __future__ import annotations

import logging
import os
import socket
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..services import offline_scene as offline_scene_svc
from ..services import offline_scene_jobs as jobs
from ..services.offline_scene_builder import OfflineSceneBuildError, get_builder
from ..services.offline_scene_catalog import JobCancelledError, PackageRegistrationError

logger = logging.getLogger("eris.offline_scene_worker")

WORKER_ID = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


class _JobAborted(Exception):
    """Internal: the job became terminal (cancelled) mid-flight — abort cleanly
    WITHOUT marking FAILED, so a user CANCELLED is never overwritten."""


def _job_cancelled(db: Session, job_id: int) -> bool:
    row = db.execute(text("SELECT status FROM offline_scene_jobs WHERE id=:id"), {"id": job_id}).first()
    return bool(row and row[0] == "CANCELLED")


def _build_context(db: Session, job: dict) -> dict:
    """Assemble the build context (AOI + overlays + provenance signature) from the
    submission's GISA data. Overlays are drawn from real ERIS data only."""
    sid = job["submission_id"]
    row = db.execute(text("""
        SELECT latitude, longitude, geometry_json, road_inventory_snapshot_json,
               elevation_terrain_grid_json, updated_at
        FROM submission_gisa WHERE submission_id=:s LIMIT 1
    """), {"s": sid}).mappings().first()
    if not row or row["latitude"] is None or row["longitude"] is None:
        raise OfflineSceneBuildError("Submission has no coordinates; cannot build a bounded area.")

    # All three fields may be malformed / JSON strings / wrong shape. Parse them
    # through defensive helpers that never call .get() on a non-dict, so a bad row
    # degrades to "no overlay" rather than crashing the job.
    geometry = offline_scene_svc.parse_geometry(row["geometry_json"])
    bearing = offline_scene_svc.extract_road_bearing(row["road_inventory_snapshot_json"])
    sample_extent = offline_scene_svc.extract_sample_extent(row["elevation_terrain_grid_json"])
    # Line geometry from the road-inventory snapshot (for the packaged roads layer);
    # defensively parsed — absent/wrong-shape degrades to "no road inventory line".
    _snap = offline_scene_svc.coerce_json_obj(row["road_inventory_snapshot_json"])
    road_inv_geom = _snap.get("geometry") if isinstance(_snap, dict) else None

    # Enforce the ONE authoritative AOI maximum at worker execution too — never
    # trust the stored/client radius or bounds blindly. Recompute the AOI from the
    # incident centre + clamped radius so a tampered/oversized job row cannot make
    # the worker fetch a statewide extent.
    center_lat, center_lon = float(row["latitude"]), float(row["longitude"])
    radius_m = offline_scene_svc.clamp_radius_m(job["radius_m"], settings.OFFLINE_SCENE_MAX_RADIUS_M)
    bounds = offline_scene_svc.bounding_box(center_lat, center_lon, radius_m)
    content_sig = offline_scene_svc.content_signature(
        gisa_updated_at=str(row["updated_at"]) if row["updated_at"] is not None else None,
        geometry_json=geometry,
        road_bearing_deg=bearing,
        radius_m=radius_m,
    )
    version = "g" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + f"-{job['id']}"
    return {
        "submission_id": sid,
        "package_version": version,
        "requested_by": job.get("requested_by"),
        "center": {"lat": center_lat, "lon": center_lon},
        "radius_m": radius_m,
        "bounds": bounds,
        "content_signature": content_sig,
        "road_inventory_geometry": road_inv_geom,
        "overlays": {
            "incident": {"lat": float(row["latitude"]), "lon": float(row["longitude"])},
            "geometry": geometry,
            "roadBearingDeg": bearing,
            "sampleExtent": sample_extent,
        },
    }


def process_job(db: Session, job: dict, builder=None) -> dict:
    """Run the full pipeline for one claimed job. Returns the final job row.

    Cancellation is authoritative at every stage: all progress transitions are
    CONDITIONAL (update_job_if_active) so they can never overwrite a user CANCELLED;
    cancellation is re-checked before each irreversible boundary; and the final
    catalog registration + job READY happen atomically with a last cancel re-check
    (see register_ready_package), so a cancelled job never yields a READY catalog
    row. An object uploaded just before a cancel is orphaned + audited, never
    presented as downloadable."""
    builder = builder or get_builder()
    job_id = job["id"]

    def progress(status: str, message: str):
        # Conditional: if it doesn't apply, the job is terminal (cancelled) -> abort.
        if not jobs.update_job_if_active(
            db, job_id, status=status, progress_pct=jobs.progress_for(status), status_message=message
        ):
            raise _JobAborted()

    def ensure_active():
        if _job_cancelled(db, job_id):
            raise _JobAborted()

    try:
        ensure_active()
        ctx = _build_context(db, job)

        # FETCHING_USGS_3DEP (already set by claim) -> prepare source data.
        source = builder.prepare_source_data(ctx, progress=progress)
        if not jobs.update_job_if_active(
            db, job_id, status="BUILDING_BASEMAP",
            progress_pct=jobs.progress_for("BUILDING_BASEMAP"),
            status_message="Preparing terrain relief basemap",
            usgs_source_metadata=source.get("usgs_meta"),
            basemap_source_metadata=source.get("basemap_meta"),
        ):
            raise _JobAborted()

        progress("PACKAGING", "Assembling offline terrain package")
        package_bytes = builder.build_package(ctx, source, progress=progress)

        progress("VERIFYING", "Validating offline package")
        ok, reason = builder.validate_package(package_bytes)
        if not ok:
            raise OfflineSceneBuildError(f"Package failed validation: {reason}")

        # Enforce the max package-size policy BEFORE any upload/registration, so an
        # oversized package is never stored or presented as downloadable.
        if offline_scene_svc.exceeds_size_limit(len(package_bytes), settings.OFFLINE_SCENE_MAX_PACKAGE_MB):
            raise OfflineSceneBuildError(
                f"Package is {len(package_bytes)} bytes, exceeding the "
                f"{settings.OFFLINE_SCENE_MAX_PACKAGE_MB} MB policy limit."
            )

        # Irreversible boundary: re-check cancellation immediately before upload.
        ensure_active()
        progress("UPLOADING", "Uploading verified package to secure storage")
        if not jobs.update_job_if_active(
            db, job_id, status="REGISTERING", progress_pct=jobs.progress_for("REGISTERING"),
            status_message="Registering package in catalog",
        ):
            raise _JobAborted()

        # Upload + atomic finalize: registers the catalog READY row AND marks the
        # job READY in one transaction, guarded by a final cancel re-check. Raises
        # JobCancelledError (object orphaned + audited) if cancelled at the last moment.
        builder.upload_and_register(db, ctx, package_bytes, source, job_id=job_id)
        return jobs.get_job(db, job_id)  # type: ignore[return-value]
    except _JobAborted:
        logger.info("offline-scene job %s aborted: cancelled by user", job_id)
        return jobs.get_job(db, job_id)  # type: ignore[return-value]
    except JobCancelledError:
        logger.info("offline-scene job %s cancelled during registration; object orphaned + audited", job_id)
        return jobs.get_job(db, job_id)  # type: ignore[return-value]
    except (OfflineSceneBuildError, PackageRegistrationError) as e:
        logger.warning("offline-scene job %s failed: %s", job_id, e)
        # Conditional so a cancel that raced the failure is not overwritten.
        jobs.update_job_if_active(db, job_id, status="FAILED", progress_pct=0,
                                  status_message="Generation failed", error_details=str(e))
        return jobs.get_job(db, job_id)  # type: ignore[return-value]
    except Exception as e:  # pragma: no cover - defensive
        logger.exception("offline-scene job %s crashed", job_id)
        jobs.update_job_if_active(db, job_id, status="FAILED", progress_pct=0,
                                  status_message="Generation failed", error_details=str(e))
        return jobs.get_job(db, job_id)  # type: ignore[return-value]


def _slog(msg: str, job: dict | None = None, **ctx) -> None:
    """Structured worker log: always carries worker_id, and job/submission/version
    /stage when available. One key=value line, easy to grep/ship."""
    fields = {"worker_id": WORKER_ID}
    if job:
        fields.update({
            "job_id": job.get("id"),
            "submission_id": job.get("submission_id"),
            "stage": job.get("status"),
            "package_version": job.get("result_package_version"),
        })
    fields.update(ctx)
    logger.info("offline_scene_worker %s | %s", msg, " ".join(f"{k}={v}" for k, v in fields.items() if v is not None))


def verify_bucket_posture_or_fail() -> None:
    """Startup fail-closed check that the private offline-scenes bucket exists. In
    production (DEV_MODE off) a missing/unreachable bucket EXITS the worker nonzero
    so orchestration surfaces it; in dev it only warns so a laptop can iterate."""
    from ..storage import bucket_exists
    bucket = settings.MINIO_OFFLINE_SCENES_BUCKET
    try:
        ok = bucket_exists(bucket)
        problem = None if ok else f"offline-scenes bucket '{bucket}' does not exist"
    except Exception as e:
        problem = f"offline-scenes storage unreachable: {e}"
    if problem:
        if settings.OFFLINE_SCENE_DEV_MODE:
            logger.warning("DEV_MODE: %s (continuing; provision via the minio-init service)", problem)
        else:
            logger.error("FAIL-CLOSED: %s — provision the private bucket (minio-init) first", problem)
            raise SystemExit(2)


def run_once(db: Session, builder=None) -> bool:
    """Claim and process one job. Returns True if a job was processed."""
    jobs.recover_stale_jobs(db, settings.OFFLINE_SCENE_JOB_STALE_SECONDS)
    claimed = jobs.claim_next_job(db, WORKER_ID)
    if not claimed:
        return False
    _slog("claimed job", claimed)
    final = process_job(db, claimed, builder=builder)
    jobs.heartbeat(db, WORKER_ID, last_stage=(final or {}).get("status"), increment_processed=1)
    _slog("finished job", final)
    return True


def run_worker() -> None:  # pragma: no cover - long-running loop
    logging.basicConfig(level=logging.INFO)
    logger.info("offline-scene worker %s starting (poll=%ss)", WORKER_ID, settings.OFFLINE_SCENE_WORKER_POLL_SECONDS)
    verify_bucket_posture_or_fail()
    # Startup recovery so interrupted jobs are requeued promptly.
    with SessionLocal() as db:
        n = jobs.recover_stale_jobs(db, settings.OFFLINE_SCENE_JOB_STALE_SECONDS)
        if n:
            logger.info("requeued %s interrupted job(s) on startup", n)
        jobs.heartbeat(db, WORKER_ID, last_stage="starting")
    while True:
        try:
            with SessionLocal() as db:
                worked = run_once(db)
                if not worked:
                    jobs.heartbeat(db, WORKER_ID, last_stage="idle")
        except Exception:
            logger.exception("worker loop error")
            worked = False
        if not worked:
            time.sleep(max(1, int(settings.OFFLINE_SCENE_WORKER_POLL_SECONDS)))


if __name__ == "__main__":  # pragma: no cover
    run_worker()
