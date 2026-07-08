"""The enqueue endpoint is ENQUEUE-ONLY: it returns HTTP 202 with a job id + status
+ status_url and NEVER performs terrain/imagery/MinIO work inline. The frontend must
never hold a request open while the worker builds the package.

No DB / no network — the endpoint function is exercised directly with a fake DB and a
stubbed jobs service, and every heavy dependency is booby-trapped to raise if touched.
"""

from __future__ import annotations

import pytest

from app import main
from app.services import offline_scene_builder as builder
from app.services import offline_scene_context as ctxmod


class _Result:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return self

    def first(self):
        return self._row


class _FakeDB:
    """Only answers the single coordinates SELECT the enqueue endpoint runs."""

    def __init__(self, row):
        self._row = row
        self.executed = 0

    def execute(self, *a, **k):
        self.executed += 1
        return _Result(self._row)


def _trip(*a, **k):  # any heavy dependency touched -> loud failure
    raise AssertionError("enqueue must NOT fetch terrain/imagery/MinIO inline")


def test_enqueue_returns_202_shape_without_any_fetch(monkeypatch):
    monkeypatch.setattr(main, "require_can_edit_submission", lambda *a, **k: None)
    fake_job = {
        "id": 4242, "submission_id": 5, "status": "QUEUED", "progress_pct": 0,
        "status_message": "Queued for terrain preparation", "retry_count": 0,
        "error_details": None, "result_package_version": None,
        "center_lat": 38.5, "center_lon": -121.5, "radius_m": 1500.0,
        "min_lat": 38.4, "min_lon": -121.6, "max_lat": 38.6, "max_lon": -121.4,
        "created_at": None, "updated_at": None,
    }
    created_with = {}

    def _create(db, *, submission_id, requested_by, aoi):
        created_with.update(submission_id=submission_id, aoi=aoi)
        return fake_job, True

    monkeypatch.setattr(main.offline_scene_jobs_svc, "create_job_if_none_active", _create)
    # Booby-trap EVERY heavy path — if enqueue touches these the test fails loudly.
    monkeypatch.setattr(builder, "get_builder", _trip)
    monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _trip)
    monkeypatch.setattr(ctxmod, "fetch_imagery_png", _trip)

    db = _FakeDB({"latitude": 38.5, "longitude": -121.5})
    resp = main.generate_offline_scene_package(submission_id=5, radius_m=None, db=db, user={"id": 1})

    assert resp["accepted"] is True
    assert resp["job_id"] == 4242 and resp["status"] == "QUEUED"
    assert resp["status_url"] == "/submissions/5/gisa/offline-scene-package/job"
    assert resp["package_descriptor_url"] == "/submissions/5/gisa/offline-scene-package"
    assert resp["job"]["status"] == "QUEUED"
    # Only the coordinates SELECT ran; the AOI was bounded (never statewide).
    assert db.executed == 1
    assert created_with["submission_id"] == 5
    assert created_with["aoi"]["radius_m"] <= 3000.0


def test_enqueue_duplicate_active_job_conflicts(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(main, "require_can_edit_submission", lambda *a, **k: None)
    monkeypatch.setattr(
        main.offline_scene_jobs_svc, "create_job_if_none_active",
        lambda db, **k: ({"id": 1, "status": "PACKAGING"}, False),
    )
    monkeypatch.setattr(builder, "get_builder", _trip)
    db = _FakeDB({"latitude": 38.5, "longitude": -121.5})
    with pytest.raises(HTTPException) as ei:
        main.generate_offline_scene_package(submission_id=5, radius_m=None, db=db, user={"id": 1})
    assert ei.value.status_code == 409
