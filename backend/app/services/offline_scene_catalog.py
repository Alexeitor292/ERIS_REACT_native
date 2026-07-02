"""
Offline scene-package catalog registration (shared by the ADMIN endpoint and the
automatic generation worker).

Verifies the MinIO object (exists, size, SHA-256) and the canonical immutable key
BEFORE marking a package READY, retires any prior READY version, and records
durable object identity + provenance. Raises PackageRegistrationError (with an
HTTP-ish status_code) on any rejection so callers can map it.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..storage import bucket_exists, sha256_of_object, stat_object
from . import offline_scene as offline_scene_svc


class PackageRegistrationError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


class JobCancelledError(PackageRegistrationError):
    """The generation job was CANCELLED before its package could be registered.
    Nothing is written to the catalog; the already-uploaded immutable object is
    orphaned (never referenced by a READY row) and recorded for operator cleanup."""


def register_ready_package(
    db: Session,
    *,
    submission_id: int,
    package_version: str,
    sha256: str,
    size_bytes: int,
    min_lat: float, min_lon: float, max_lat: float, max_lon: float,
    center_lat: float, center_lon: float, radius_m: float,
    elevation_source: str,
    elevation_dataset: str,
    elevation_version: str,
    elevation_resolution: str,
    basemap_or_imagery_source: str,
    content_signature: str,
    package_format: str = "eristerrain",
    object_key: str | None = None,
    uploaded_by: int | None = None,
    notes: str | None = None,
    verify_sha: bool = True,
    job_id: int | None = None,
) -> dict:
    if elevation_source != offline_scene_svc.ELEVATION_SOURCE_3DEP:
        raise PackageRegistrationError("elevation_source must be USGS_3DEP", 422)
    for label, val in (
        ("elevation_dataset", elevation_dataset),
        ("elevation_version", elevation_version),
        ("elevation_resolution", elevation_resolution),
        ("basemap_or_imagery_source", basemap_or_imagery_source),
    ):
        if not val or not str(val).strip():
            raise PackageRegistrationError(f"{label} is required for a READY package", 422)

    if not offline_scene_svc.validate_bounds(min_lat, min_lon, max_lat, max_lon):
        raise PackageRegistrationError("Invalid bounds (need min < max, within lat/lon ranges).", 422)

    bucket = settings.MINIO_OFFLINE_SCENES_BUCKET
    canonical_key = offline_scene_svc.make_scene_object_key(submission_id, package_version, package_format)
    if object_key is not None and object_key != canonical_key:
        raise PackageRegistrationError(
            f"object_key must be the canonical immutable key '{canonical_key}' (or omitted).", 422
        )
    key = canonical_key

    # Duplicate (immutable) version or object key.
    if db.execute(text("SELECT id FROM offline_scene_packages WHERE submission_id=:s AND package_version=:v"),
                  {"s": submission_id, "v": package_version}).first():
        raise PackageRegistrationError("A package with this version already exists (immutable).", 409)
    if db.execute(text("SELECT id FROM offline_scene_packages WHERE object_key=:k"), {"k": key}).first():
        raise PackageRegistrationError("This object key is already registered (immutable).", 409)

    # Bucket must be pre-provisioned (never silently created here).
    try:
        exists = bucket_exists(bucket)
    except Exception as e:
        raise PackageRegistrationError(f"Offline-scenes storage unreachable: {e}", 503)
    if not exists:
        raise PackageRegistrationError(
            f"Offline-scenes bucket '{bucket}' does not exist; provision it privately first.", 409
        )

    # HEAD: exists + size.
    st = stat_object(object_key=key, bucket=bucket)
    if st is None:
        raise PackageRegistrationError(f"MinIO object not found: {bucket}/{key}", 404)
    if int(st["size"]) != int(size_bytes):
        raise PackageRegistrationError(
            f"Object size mismatch: stored {st['size']} bytes != expected {size_bytes}.", 409
        )

    # Verify SHA-256 before READY.
    if verify_sha:
        actual = sha256_of_object(object_key=key, bucket=bucket)
        if actual.lower() != str(sha256).lower():
            raise PackageRegistrationError("SHA-256 mismatch; refusing to mark READY.", 409)

    try:
        # If this registration belongs to a generation job, do a FINAL cancellation
        # re-check under a row lock, INSIDE the same transaction as the catalog
        # insert + job READY mark. Either the job was not cancelled -> catalog READY
        # row AND job READY commit atomically; or it was cancelled -> the whole
        # transaction rolls back, so a cancelled job NEVER yields a READY catalog row.
        if job_id is not None:
            jrow = db.execute(
                text("SELECT status FROM offline_scene_jobs WHERE id=:j FOR UPDATE"), {"j": job_id}
            ).first()
            if jrow and jrow[0] == "CANCELLED":
                db.rollback()
                raise JobCancelledError("Job was cancelled before registration; package not registered.", 409)

        db.execute(text("""
            UPDATE offline_scene_packages SET status='RETIRED', retired_at=NOW()
            WHERE submission_id=:s AND status='READY'
        """), {"s": submission_id})
        ins = db.execute(text("""
            INSERT INTO offline_scene_packages
              (submission_id, status, package_version, package_format, minio_bucket, object_key,
               sha256, size_bytes, object_version_id, object_etag,
               min_lat, min_lon, max_lat, max_lon, center_lat, center_lon, radius_m,
               elevation_source, elevation_dataset, elevation_version, elevation_resolution,
               basemap_or_imagery_source, content_signature, uploaded_at, uploaded_by, notes)
            VALUES
              (:submission_id, 'READY', :package_version, :package_format, :bucket, :object_key,
               :sha256, :size_bytes, :object_version_id, :object_etag,
               :min_lat, :min_lon, :max_lat, :max_lon, :center_lat, :center_lon, :radius_m,
               :elevation_source, :elevation_dataset, :elevation_version, :elevation_resolution,
               :basemap, :content_signature, NOW(), :uploaded_by, :notes)
        """), {
            "submission_id": submission_id, "package_version": package_version,
            "package_format": package_format, "bucket": bucket, "object_key": key,
            "sha256": str(sha256).lower(), "size_bytes": int(size_bytes),
            "object_version_id": st.get("version_id"), "object_etag": st.get("etag"),
            "min_lat": min_lat, "min_lon": min_lon, "max_lat": max_lat, "max_lon": max_lon,
            "center_lat": center_lat, "center_lon": center_lon, "radius_m": radius_m,
            "elevation_source": elevation_source, "elevation_dataset": elevation_dataset,
            "elevation_version": elevation_version, "elevation_resolution": elevation_resolution,
            "basemap": basemap_or_imagery_source, "content_signature": content_signature,
            "uploaded_by": uploaded_by, "notes": notes,
        })
        # Mark the owning job READY in the SAME transaction (conditional: a cancel
        # that landed after our re-check but before commit cannot be overwritten).
        if job_id is not None:
            db.execute(text("""
                UPDATE offline_scene_jobs
                SET status='READY', progress_pct=100,
                    status_message='Offline 3D package ready to download',
                    result_package_id=:pid, result_package_version=:pv
                WHERE id=:j AND status NOT IN ('READY','FAILED','CANCELLED')
            """), {"pid": ins.lastrowid, "pv": package_version, "j": job_id})
        db.commit()
    except PackageRegistrationError:
        raise
    except Exception as e:
        db.rollback()
        raise PackageRegistrationError(f"Catalog insert failed: {e}", 500)

    row = db.execute(text("""
        SELECT * FROM offline_scene_packages WHERE submission_id=:s AND package_version=:v
    """), {"s": submission_id, "v": package_version}).mappings().first()
    return dict(row) if row else {}
