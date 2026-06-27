"""
Pure unit tests for app.services.terrain_grid.

No database, no MinIO, no network — `_fetch_elevation_ft` is mocked so these run
in the no-DB CI job.
"""

from __future__ import annotations

import threading
import time
from unittest.mock import patch

import pytest

from app.services import terrain_grid as tg


def _wait_for_guard_free(timeout: float = 5.0) -> bool:
    """Poll until the process-wide build guard is free (acquirable), e.g. after a
    timed-out build's background cleanup has drained the in-flight workers."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tg._BUILD_SEMAPHORE.acquire(blocking=False):
            tg._BUILD_SEMAPHORE.release()
            return True
        time.sleep(0.02)
    return False


class TestOddDimensions:
    def test_even_rows_rejected(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            with pytest.raises(ValueError, match="odd"):
                tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=10, cols=11)

    def test_even_cols_rejected(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            with pytest.raises(ValueError, match="odd"):
                tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=11, cols=8)

    def test_odd_out_of_range_is_clamped_and_stays_odd(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=99, cols=99)
        assert res["grid"]["rows"] == tg.MAX_DIM and res["grid"]["columns"] == tg.MAX_DIM
        assert res["grid"]["rows"] % 2 == 1 and res["grid"]["columns"] % 2 == 1

    def test_center_is_a_real_sample_for_odd_grid(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=42.0):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=90.0, rows=11, cols=11)
        pts = res["grid"]["points"]
        center = next(p for p in pts if p["row"] == 5 and p["column"] == 5)
        assert abs(center["lat"] - 37.0) < 1e-6 and abs(center["lon"] - (-122.0)) < 1e-6
        assert center["elevation_ft"] == 42.0


class TestTimeBudget:
    def test_partial_data_on_slow_upstream(self, monkeypatch):
        # Tiny budget; some points resolve instantly, the rest "hang" past the
        # budget -> we keep the partial valid data and never fabricate elevations.
        monkeypatch.setattr(tg, "TOTAL_BUILD_BUDGET_S", 0.4)
        calls = {"n": 0}

        def slow(lat, lon):
            calls["n"] += 1
            if calls["n"] <= 5:
                return 100.0
            time.sleep(1.0)  # exceeds the 0.4s budget
            return 100.0

        with patch.object(tg, "_fetch_elevation_ft", side_effect=slow):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=11, cols=11)
        grid = res["grid"]
        assert 0 < grid["valid_sample_count"] < grid["sample_count"]
        assert grid["partial"] is True
        assert res["error"] and "partial" in res["error"].lower()
        # Unresolved points stay null — no synthetic elevations.
        assert any(p["elevation_ft"] is None for p in grid["points"])
        # Let the deferred cleanup drain so the guard does not leak to the next test.
        assert _wait_for_guard_free(timeout=5.0)

    def test_full_outage_within_budget_reports_no_data(self, monkeypatch):
        monkeypatch.setattr(tg, "TOTAL_BUILD_BUDGET_S", 0.4)

        def hang(lat, lon):
            time.sleep(1.0)
            return 100.0

        with patch.object(tg, "_fetch_elevation_ft", side_effect=hang):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
        assert res["grid"]["valid_sample_count"] == 0
        assert res["error"] is not None
        # Let the deferred cleanup drain so the guard does not leak to the next test.
        assert _wait_for_guard_free(timeout=5.0)


class TestGlobalConcurrencyGuard:
    def test_busy_raises_when_guard_held(self):
        # Simulate an in-flight build by holding the process-wide guard, then a
        # second build must fail fast (not block, not exceed the worker cap).
        assert tg._BUILD_SEMAPHORE.acquire(blocking=False)
        try:
            with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
                with pytest.raises(tg.TerrainBuildBusyError):
                    tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
        finally:
            tg._BUILD_SEMAPHORE.release()

    def test_guard_released_after_success(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
        # The guard is free again — a fresh non-blocking acquire succeeds.
        assert tg._BUILD_SEMAPHORE.acquire(blocking=False)
        tg._BUILD_SEMAPHORE.release()

    def test_guard_released_after_internal_failure(self, monkeypatch):
        # Force the build to blow up inside the executor block; the finally must
        # still release the process-wide guard so the backend is not wedged.
        def boom(*args, **kwargs):
            raise RuntimeError("scheduler exploded")

        monkeypatch.setattr(tg, "as_completed", boom)
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
        assert res["error"] is not None  # the failure was reported, not swallowed
        # ...and crucially the guard was released despite the error.
        assert tg._BUILD_SEMAPHORE.acquire(blocking=False)
        tg._BUILD_SEMAPHORE.release()

    def test_guard_released_after_timeout(self, monkeypatch):
        # A time-budget timeout defers executor cleanup to a background thread; the
        # guard stays held until the in-flight workers finish, THEN is released.
        monkeypatch.setattr(tg, "TOTAL_BUILD_BUDGET_S", 0.3)

        def hang(lat, lon):
            time.sleep(1.0)
            return 100.0

        with patch.object(tg, "_fetch_elevation_ft", side_effect=hang):
            tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
        # Eventually (after the in-flight workers finish) the guard is released.
        assert _wait_for_guard_free(timeout=5.0)

    def test_guard_held_until_inflight_workers_finish(self, monkeypatch):
        """Timeout must NOT release the guard while in-flight EPQS calls are alive.

        1. First build times out with workers still blocked.
        2. A second build immediately gets TerrainBuildBusyError.
        3. After the blocked workers finish and cleanup releases the guard, a new
           build can proceed.
        """
        monkeypatch.setattr(tg, "TOTAL_BUILD_BUDGET_S", 0.3)
        release_workers = threading.Event()

        def blocking(lat, lon):
            # Hold the worker (a live EPQS call) until the test releases it.
            release_workers.wait(timeout=10)
            return 100.0

        try:
            with patch.object(tg, "_fetch_elevation_ft", side_effect=blocking):
                # 1. First build times out; its workers stay blocked (alive).
                first = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
                assert first["grid"]["valid_sample_count"] == 0

                # 2. Guard still held by the draining cleanup -> fast busy error.
                with pytest.raises(tg.TerrainBuildBusyError):
                    tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
                # ...and a raw non-blocking acquire also fails meanwhile.
                assert tg._BUILD_SEMAPHORE.acquire(blocking=False) is False

                # 3. Release the workers; cleanup drains and frees the guard.
                release_workers.set()
                assert _wait_for_guard_free(timeout=5.0)

                # A fresh build now proceeds (workers return immediately).
                third = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0, rows=3, cols=3)
                assert third["grid"]["valid_sample_count"] == 9
        finally:
            release_workers.set()  # never leave daemon workers blocked


class TestBuildGridPoints:
    def test_size_and_indices(self):
        pts = tg.build_grid_points(37.0, -122.0, 90.0, rows=11, cols=11, along_spacing_m=20.0, cross_spacing_m=20.0)
        assert len(pts) == 121
        # row/column indices span the full grid
        rows = {p["row"] for p in pts}
        cols = {p["column"] for p in pts}
        assert rows == set(range(11)) and cols == set(range(11))

    def test_center_point_is_origin(self):
        pts = tg.build_grid_points(37.0, -122.0, 90.0, 11, 11, 20.0, 20.0)
        center = next(p for p in pts if p["row"] == 5 and p["column"] == 5)
        assert abs(center["lat"] - 37.0) < 1e-6
        assert abs(center["lon"] - (-122.0)) < 1e-6
        assert center["along_offset_m"] == 0.0 and center["cross_offset_m"] == 0.0

    def test_respects_bearing_along_axis(self):
        # bearing 90 (east): the along-road axis (rows) runs east -> increasing row
        # (positive along offset, upstation) increases longitude.
        pts = tg.build_grid_points(37.0, -122.0, 90.0, 11, 11, 20.0, 20.0)
        center = next(p for p in pts if p["row"] == 5 and p["column"] == 5)
        upstation = next(p for p in pts if p["row"] == 10 and p["column"] == 5)
        assert upstation["lon"] > center["lon"]
        assert abs(upstation["lat"] - center["lat"]) < 1e-3  # due-east keeps lat ~constant

    def test_respects_bearing_cross_axis(self):
        # bearing 0 (north): cross axis (columns, +=right) runs east -> increasing
        # column increases longitude.
        pts = tg.build_grid_points(37.0, -122.0, 0.0, 11, 11, 20.0, 20.0)
        center = next(p for p in pts if p["row"] == 5 and p["column"] == 5)
        right = next(p for p in pts if p["row"] == 5 and p["column"] == 10)
        assert right["lon"] > center["lon"]


class TestFetchTerrainGrid:
    def test_all_valid_samples(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=100.0):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=90.0)
        grid = res["grid"]
        assert grid["rows"] == 11 and grid["columns"] == 11
        assert grid["sample_count"] == 121
        assert grid["valid_sample_count"] == 121
        assert grid["along_road_spacing_m"] == 20.0
        assert grid["extent_along_m"] == 200.0 and grid["extent_cross_m"] == 200.0
        assert res["source"] == "USGS_EPQS_3DEP"
        assert res["road_bearing_deg_used"] == 90.0
        # Full coverage: not partial, no error.
        assert grid["partial"] is False
        assert res["error"] is None
        assert all(p["elevation_ft"] == 100.0 for p in grid["points"])

    def test_usgs_failure_no_data(self):
        # USGS returns nothing for every point -> no synthetic elevations, error set.
        with patch.object(tg, "_fetch_elevation_ft", return_value=None):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=45.0)
        grid = res["grid"]
        assert grid["valid_sample_count"] == 0
        assert all(p["elevation_ft"] is None for p in grid["points"])
        assert res["error"] is not None

    def test_partial_samples_without_timeout(self):
        # Ordinary USGS no-data: some points resolve, the rest return None (no
        # timeout involved). This must still be flagged partial with a clear error
        # that includes the valid/requested counts; missing cells stay null.
        def fake(lat, lon):
            return 200.0 if lon >= -122.0 else None

        with patch.object(tg, "_fetch_elevation_ft", side_effect=fake):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0)
        grid = res["grid"]
        valid, total = grid["valid_sample_count"], grid["sample_count"]
        assert 0 < valid < total
        assert grid["partial"] is True
        assert res["error"] is not None
        assert f"{valid} of {total}" in res["error"]
        # Reason mentions unavailable / no-data (not the time budget).
        assert "no data" in res["error"].lower()
        # Missing cells stay null — never interpolated or invented.
        assert any(p["elevation_ft"] is None for p in grid["points"])

    def test_dimension_and_spacing_clamped(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=10.0):
            res = tg.fetch_terrain_grid(
                37.0, -122.0, road_bearing_deg=0.0, rows=99, cols=99, along_spacing_m=1.0, cross_spacing_m=999.0
            )
        grid = res["grid"]
        assert grid["rows"] == tg.MAX_DIM and grid["columns"] == tg.MAX_DIM
        assert grid["along_road_spacing_m"] == tg.MIN_SPACING_M
        assert grid["cross_road_spacing_m"] == tg.MAX_SPACING_M

    def test_no_bearing_falls_back_to_north_and_reports_none(self):
        with patch.object(tg, "_fetch_elevation_ft", return_value=50.0):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=None)
        # Grid still built (north-aligned), but the reported bearing is honestly None.
        assert res["road_bearing_deg_used"] is None
        assert res["grid"]["valid_sample_count"] == 121
