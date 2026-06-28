"""
Offline 3D scene-package GENERATION (jobs + endpoints + worker) DB tests.
MinIO is mocked. Run: pytest -m db tests/test_offline_scene_generation.py
"""

from __future__ import annotations

import hashlib
from unittest.mock import patch

import pytest

from app.services import offline_scene_jobs as jobs
from app.services.offline_scene_builder import OfflineScenePackageBuilder, OfflineSceneBuildError
from app.worker import offline_scene_worker as worker

pytestmark = pytest.mark.db

_GEN = "/submissions/{sid}/gisa/offline-scene-package/generate"
_JOB = "/submissions/{sid}/gisa/offline-scene-package/job"
_CANCEL = "/submissions/{sid}/gisa/offline-scene-package/job/cancel"
_RETRY = "/submissions/{sid}/gisa/offline-scene-package/job/retry"

_PKG_BYTES = b"PKGBYTES-bundle"
_PKG_SHA = hashlib.sha256(_PKG_BYTES).hexdigest()


def _create_submission_with_gisa(client_db, admin_token, lat=37.7, lon=-122.4) -> tuple[int, int]:
    payload = {
        "first_observed_at": "2026-06-10T00:00:00", "latitude": lat, "longitude": lon,
        "district": "04", "county": "ALA", "route": "080", "post_mile": "5.0",
    }
    resp = client_db.post("/incidents", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    incident_id = resp.json()["incident"]["id"]
    client_db.post(f"/incidents/{incident_id}/location-link", json={"mode": "CREATE_NEW"},
                   headers={"Authorization": f"Bearer {admin_token}"})
    fwd = client_db.post(f"/incidents/{incident_id}/coordinator/forward", json={"comment": "gen"},
                         headers={"Authorization": f"Bearer {admin_token}"})
    assert fwd.status_code == 200, fwd.text
    return incident_id, fwd.json()["linked_submission_id"]


def _cleanup(incident_id, sub_id=None):
    from app.db import engine
    from sqlalchemy import text
    with engine.begin() as conn:
        if sub_id is not None:
            conn.execute(text("DELETE FROM offline_scene_jobs WHERE submission_id=:s"), {"s": sub_id})
            conn.execute(text("DELETE FROM offline_scene_packages WHERE submission_id=:s"), {"s": sub_id})
        conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})


class _FakeBuilder(OfflineScenePackageBuilder):
    """In-test builder: no network/raster; uses the base upload_and_register so the
    REAL catalog registration runs (with mocked MinIO)."""

    def __init__(self, *, fail_validate=False, raise_prepare=False):
        self.fail_validate = fail_validate
        self.raise_prepare = raise_prepare

    def prepare_source_data(self, ctx, progress=None):
        if progress:
            progress("BUILDING_TERRAIN", "fake terrain")
        if self.raise_prepare:
            raise OfflineSceneBuildError("USGS 3DEP coverage unavailable")
        return {
            "dem_bytes": b"II*\x00" + b"\x00" * 400,
            "hillshade_bytes": b"",
            "usgs_meta": {"dataset": "USGS 3DEP", "version": "2026-06-27", "resolution": "3.4 m/px"},
            "basemap_meta": {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade", "has_imagery": False},
        }

    def build_package(self, ctx, source, progress=None):
        return _PKG_BYTES

    def validate_package(self, package_bytes):
        return (False, "forced invalid") if self.fail_validate else (True, None)


def _run_worker_once(builder):
    """Run the worker against the live DB with MinIO mocked for the success path."""
    from app.db import SessionLocal
    with patch("app.services.offline_scene_builder.put_object_bytes", return_value=None), \
         patch("app.services.offline_scene_catalog.bucket_exists", return_value=True), \
         patch("app.services.offline_scene_catalog.stat_object",
               return_value={"size": len(_PKG_BYTES), "etag": "e1", "version_id": "v1"}), \
         patch("app.services.offline_scene_catalog.sha256_of_object", return_value=_PKG_SHA):
        with SessionLocal() as db:
            return worker.run_once(db, builder=builder)


class TestGenerateEndpoints:
    def test_requires_auth(self, client_db):
        assert client_db.post(_GEN.format(sid=1)).status_code == 401

    def test_permission_denied_for_non_editor(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            login = client_db.post("/auth/login", json={"email": "reviewer@local", "password": "password"})
            other = login.json()["access_token"]
            r = client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {other}"})
            assert r.status_code == 403
        finally:
            _cleanup(incident_id, sub_id)

    def test_no_coordinates_rejected(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            with engine.begin() as conn:
                conn.execute(text("UPDATE submission_gisa SET latitude=NULL, longitude=NULL WHERE submission_id=:s"), {"s": sub_id})
            r = client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 400
        finally:
            _cleanup(incident_id, sub_id)

    def test_generate_creates_queued_job_with_bounded_aoi(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            r = client_db.post(_GEN.format(sid=sub_id) + "?radius_m=1200", headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 202, r.text
            job = r.json()["job"]
            assert job["status"] == "QUEUED"
            assert job["area"]["radius_m"] == 1200.0
            assert job["area"]["bounds"]["min_lat"] < job["area"]["center"]["lat"] < job["area"]["bounds"]["max_lat"]
        finally:
            _cleanup(incident_id, sub_id)

    def test_duplicate_active_job_prevented(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            r1 = client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r1.status_code == 202
            r2 = client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r2.status_code == 409
        finally:
            _cleanup(incident_id, sub_id)

    def test_job_status_and_cancel(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            s = client_db.get(_JOB.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert s.status_code == 200 and s.json()["job"]["status"] == "QUEUED"
            c = client_db.post(_CANCEL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert c.status_code == 200 and c.json()["job"]["status"] == "CANCELLED"
            # No active job after cancel.
            c2 = client_db.post(_CANCEL.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert c2.status_code == 404
        finally:
            _cleanup(incident_id, sub_id)

    def test_retry_only_failed(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            # QUEUED job cannot be retried.
            r = client_db.post(_RETRY.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert r.status_code == 409
        finally:
            _cleanup(incident_id, sub_id)


class TestWorker:
    def test_worker_generates_ready_package(self, client_db, admin_token):
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert _run_worker_once(_FakeBuilder()) is True
            # Job READY with a result package version.
            s = client_db.get(_JOB.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            job = s.json()["job"]
            assert job["status"] == "READY" and job["progress_pct"] == 100
            assert job["result_package_version"]
            # A READY catalog package now exists; the descriptor is available.
            with patch("app.main.stat_object", return_value={"size": len(_PKG_BYTES), "etag": "e1", "version_id": "v1"}):
                d = client_db.get(f"/submissions/{sub_id}/gisa/offline-scene-package",
                                  headers={"Authorization": f"Bearer {admin_token}"})
            assert d.json()["available"] is True
            assert d.json()["package"]["format"] == "eristerrain"
            assert d.json()["package"]["elevation_source"] == "USGS_3DEP"
        finally:
            _cleanup(incident_id, sub_id)

    def test_failed_generation_creates_no_ready_catalog_entry(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            _run_worker_once(_FakeBuilder(raise_prepare=True))
            s = client_db.get(_JOB.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert s.json()["job"]["status"] == "FAILED"
            with engine.connect() as conn:
                n = conn.execute(text("SELECT COUNT(*) FROM offline_scene_packages WHERE submission_id=:s"), {"s": sub_id}).scalar()
            assert n == 0  # no catalog record without a validated/uploaded package
        finally:
            _cleanup(incident_id, sub_id)

    def test_no_catalog_record_until_validation_passes(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            _run_worker_once(_FakeBuilder(fail_validate=True))
            s = client_db.get(_JOB.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            assert s.json()["job"]["status"] == "FAILED"
            with engine.connect() as conn:
                n = conn.execute(text("SELECT COUNT(*) FROM offline_scene_packages WHERE submission_id=:s"), {"s": sub_id}).scalar()
            assert n == 0
        finally:
            _cleanup(incident_id, sub_id)

    def test_claim_prevents_duplicate_processing(self, client_db, admin_token):
        from app.db import engine, SessionLocal
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            with SessionLocal() as db1:
                first = jobs.claim_next_job(db1, "w1")
            with SessionLocal() as db2:
                second = jobs.claim_next_job(db2, "w2")
            assert first is not None and first["submission_id"] == sub_id
            assert second is None  # already claimed -> no duplicate
        finally:
            _cleanup(incident_id, sub_id)

    def test_recover_requeues_stale_running_job(self, client_db, admin_token):
        from app.db import engine, SessionLocal
        from sqlalchemy import text
        incident_id, sub_id = _create_submission_with_gisa(client_db, admin_token)
        try:
            client_db.post(_GEN.format(sid=sub_id), headers={"Authorization": f"Bearer {admin_token}"})
            with engine.begin() as conn:
                conn.execute(text("""
                    UPDATE offline_scene_jobs
                    SET status='BUILDING_TERRAIN', worker_id='dead', updated_at='2020-01-01 00:00:00'
                    WHERE submission_id=:s
                """), {"s": sub_id})
            with SessionLocal() as db:
                requeued = jobs.recover_stale_jobs(db, stale_seconds=60)
                assert requeued >= 1
                job = jobs.get_latest_job(db, sub_id)
            assert job["status"] == "QUEUED"
        finally:
            _cleanup(incident_id, sub_id)
