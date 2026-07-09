"""Regression tests for the tiled-imagery double-buildings/misalignment fix and the
road-bearing coverage fix (PR: fix/offline-terrain-tile-alignment-and-road-snap).

- tile_export_dims must MATCH the tile's metric aspect (never force square for a
  non-square bbox), so ImageServer does not expand the bbox to the requested aspect
  and make adjacent tiles overlap (double buildings).
- The synthetic road_bearing line must SPAN the AOI (clipped to bounds), not just a
  ~260 m stub near the incident, so a bearing-only package is tappable across the area.
"""

from __future__ import annotations

import math

from app.services import offline_scene_context as ctxmod

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
_M = 111_320.0


def _dist_m(a, b):
    mid = (a[1] + b[1]) / 2.0
    dx = (b[0] - a[0]) * _M * math.cos(math.radians(mid))
    dy = (b[1] - a[1]) * _M
    return math.hypot(dx, dy)


class TestTileExportDims:
    def test_square_bbox_stays_square(self):
        sq = {"min_lat": 0.0, "min_lon": 0.0, "max_lat": 0.02, "max_lon": 0.02}  # ~square at equator
        assert ctxmod.tile_export_dims(sq, 1024) == (1024, 1024)

    def test_wide_bbox_gets_wider_image_matching_aspect(self):
        wide = {"min_lat": 0.0, "min_lon": 0.0, "max_lat": 0.01, "max_lon": 0.04}  # 4x wider than tall
        w, h = ctxmod.tile_export_dims(wide, 1024)
        assert w == 1024 and h == 256  # aspect 4:1 -> 1024x256 (NOT forced square)

    def test_tall_bbox_gets_taller_image_matching_aspect(self):
        # cos-lat shrinks E-W; a lat-tall bbox stays tall.
        tall = {"min_lat": 38.40, "min_lon": -121.50, "max_lat": 38.60, "max_lon": -121.49}
        w, h = ctxmod.tile_export_dims(tall, 1024)
        assert h == 1024 and w < h

    def test_image_aspect_matches_bbox_metric_aspect(self):
        # The whole point: image W/H ~= metric width/height, so no bbox expansion.
        w_m = (BOUNDS["max_lon"] - BOUNDS["min_lon"]) * _M * math.cos(math.radians(38.5))
        h_m = (BOUNDS["max_lat"] - BOUNDS["min_lat"]) * _M
        w_px, h_px = ctxmod.tile_export_dims(BOUNDS, 1024)
        assert abs((w_px / h_px) - (w_m / h_m)) < 0.02

    def test_degenerate_bounds_fall_back_to_square(self):
        assert ctxmod.tile_export_dims({}, 512) == (512, 512)

    def test_export_params_use_matched_size(self):
        p = ctxmod._export_tile_params(BOUNDS, 1024, 85)
        w_px, h_px = ctxmod.tile_export_dims(BOUNDS, 1024)
        assert p["size"] == f"{w_px},{h_px}" and p["format"] == "jpg"


class TestBearingLineCoversAOI:
    def _ctx(self, bearing=45.0):
        return {
            "bounds": BOUNDS,
            "overlays": {"incident": {"lat": 38.5, "lon": -121.5}, "roadBearingDeg": bearing},
        }

    def test_bearing_line_spans_the_package_not_a_260m_stub(self):
        gj, count, _reason = ctxmod.roads_geojson_from_context(self._ctx(), buffer_m=250.0)
        assert count == 1
        coords = gj["features"][0]["geometry"]["coordinates"]
        span = _dist_m(coords[0], coords[-1])
        # Old behavior was a ~260 m line; now it spans (a large fraction of) the AOI.
        assert span > 2000, f"bearing line only spanned {span:.0f} m"
        assert gj["features"][0]["properties"]["kind"] == "road_bearing"

    def test_bearing_line_still_clipped_to_bounds(self):
        gj, _c, _reason = ctxmod.roads_geojson_from_context(self._ctx(bearing=90.0), buffer_m=250.0)  # due east
        buf = ctxmod.bounds_with_buffer(BOUNDS, 250.0)
        for lon, lat in gj["features"][0]["geometry"]["coordinates"]:
            assert buf["min_lon"] - 1e-6 <= lon <= buf["max_lon"] + 1e-6
            assert buf["min_lat"] - 1e-6 <= lat <= buf["max_lat"] + 1e-6
