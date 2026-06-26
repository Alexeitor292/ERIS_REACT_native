"""
Pure unit tests for app.services.terrain_grid.

No database, no MinIO, no network — `_fetch_elevation_ft` is mocked so these run
in the no-DB CI job.
"""

from __future__ import annotations

from unittest.mock import patch

from app.services import terrain_grid as tg


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

    def test_partial_samples(self):
        # Only points with non-negative along offset resolve; the rest are null.
        def fake(lat, lon):
            return 200.0 if lon >= -122.0 else None

        with patch.object(tg, "_fetch_elevation_ft", side_effect=fake):
            res = tg.fetch_terrain_grid(37.0, -122.0, road_bearing_deg=0.0)
        grid = res["grid"]
        assert 0 < grid["valid_sample_count"] < grid["sample_count"]
        # No error when at least one valid sample exists.
        assert res["error"] is None

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
