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
from ..services.offline_scene_catalog import PackageRegistrationError

logger = logging.getLogger("eris.offline_scene_worker")

WORKER_ID = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


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
        "overlays": {
            "incident": {"lat": float(row["latitude"]), "lon": float(row["longitude"])},
            "geometry": geometry,
            "roadBearingDeg": bearing,
            "sampleExtent": sample_extent,
        },
    }


def process_job(db: Session, job: dict, builder=None) -> dict:
    """Run the full pipeline for one claimed job. Returns the final job row."""
    builder = builder or get_builder()
    job_id = job["id"]

    def progress(status: str, message: str):
        jobs.update_job(db, job_id, status=status, progress_pct=jobs.progress_for(status), status_message=message)

    try:
        if _job_cancelled(db, job_id):
            return jobs.get_job(db, job_id)  # type: ignore[return-value]

        ctx = _build_context(db, job)

        # FETCHING_USGS_3DEP (already set by claim) -> prepare source data.
        source = builder.prepare_source_data(ctx, progress=progress)
        jobs.update_job(
            db, job_id, status="BUILDING_BASEMAP",
            progress_pct=jobs.progress_for("BUILDING_BASEMAP"),
            status_message="Preparing terrain relief basemap",
            usgs_source_metadata=source.get("usgs_meta"),
            basemap_source_metadata=source.get("basemap_meta"),
        )
        if _job_cancelled(db, job_id):
            return jobs.get_job(db, job_id)  # type: ignore[return-value]

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

        progress("UPLOADING", "Uploading verified package to secure storage")
        jobs.update_job(db, job_id, status="REGISTERING", progress_pct=jobs.progress_for("REGISTERING"),
                        status_message="Registering package in catalog")
        catalog_row = builder.upload_and_register(db, ctx, package_bytes, source)

        return jobs.update_job(
            db, job_id, status="READY", progress_pct=100,
            status_message="Offline 3D package ready to download",
            result_package_id=catalog_row.get("id"),
            result_package_version=ctx["package_version"],
        )  # type: ignore[return-value]
    except (OfflineSceneBuildError, PackageRegistrationError) as e:
        logger.warning("offline-scene job %s failed: %s", job_id, e)
        return jobs.update_job(db, job_id, status="FAILED", progress_pct=0,
                               status_message="Generation failed", error_details=str(e))  # type: ignore[return-value]
    except Exception as e:  # pragma: no cover - defensive
        logger.exception("offline-scene job %s crashed", job_id)
        return jobs.update_job(db, job_id, status="FAILED", progress_pct=0,
                               status_message="Generation failed", error_details=str(e))  # type: ignore[return-value]


def run_once(db: Session, builder=None) -> bool:
    """Claim and process one job. Returns True if a job was processed."""
    jobs.recover_stale_jobs(db, settings.OFFLINE_SCENE_JOB_STALE_SECONDS)
    claimed = jobs.claim_next_job(db, WORKER_ID)
    if not claimed:
        return False
    process_job(db, claimed, builder=builder)
    return True


def run_worker() -> None:  # pragma: no cover - long-running loop
    logging.basicConfig(level=logging.INFO)
    logger.info("offline-scene worker %s starting (poll=%ss)", WORKER_ID, settings.OFFLINE_SCENE_WORKER_POLL_SECONDS)
    # Startup recovery so interrupted jobs are requeued promptly.
    with SessionLocal() as db:
        n = jobs.recover_stale_jobs(db, settings.OFFLINE_SCENE_JOB_STALE_SECONDS)
        if n:
            logger.info("requeued %s interrupted job(s) on startup", n)
    while True:
        try:
            with SessionLocal() as db:
                worked = run_once(db)
        except Exception:
            logger.exception("worker loop error")
            worked = False
        if not worked:
            time.sleep(max(1, int(settings.OFFLINE_SCENE_WORKER_POLL_SECONDS)))


if __name__ == "__main__":  # pragma: no cover
    run_worker()
