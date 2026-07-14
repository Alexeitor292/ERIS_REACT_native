"""Proves REAL polyline clipping to the buffered package bounds (PR #49 review finding).

The previous helper only FILTERED (kept a line whole if any single vertex was inside, and
dropped a line that crossed the AOI with all vertices outside). clip_line_to_bounds does
true Liang-Barsky per-segment clipping and is applied to EVERY road source that
roads_geojson_from_context claims to clip: external/TIGERweb centerlines, road-inventory
geometry, submitted line geometry, and the synthetic road-bearing line.
"""

from __future__ import annotations

from app.services import offline_scene_context as ctxmod
from app.services.road_cross_section_build import build_road_cross_section

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}
BUF = 250.0
BB = ctxmod.bounds_with_buffer(BOUNDS, BUF)  # the buffered rectangle actually used


def _in_bb(lon, lat, eps=1e-9):
    return (BB["min_lon"] - eps <= lon <= BB["max_lon"] + eps) and (BB["min_lat"] - eps <= lat <= BB["max_lat"] + eps)


def _all_coords(gj):
    for f in gj["features"]:
        for lon, lat in f["geometry"]["coordinates"]:
            yield lon, lat


def _ctx(*, bearing=None, external=None, inventory=None, submitted=None):
    return {
        "submission_id": 31, "package_version": "gclip-1", "center": INCIDENT,
        "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
        "road_inventory_geometry": inventory,
        "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
        "external_road_features": external or [],
        "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": submitted, "sampleExtent": None},
    }


def _ext(coords, props=None):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {**(props or {}), "kind": "road_centerline"}}


class TestClipLineToBounds:
    def test_A_crossing_segment_both_endpoints_outside_is_retained_and_clipped(self):
        # Due-east line passing straight through the AOI; BOTH endpoints outside.
        line = [[-121.60, 38.50], [-121.40, 38.50]]
        parts = ctxmod.clip_line_to_bounds(line, BB)
        assert len(parts) == 1
        (x0, y0), (x1, y1) = parts[0][0], parts[0][-1]
        # cut to the two boundary intersections (the OLD filter dropped this line entirely)
        assert abs(x0 - BB["min_lon"]) < 1e-9 and abs(x1 - BB["max_lon"]) < 1e-9
        assert y0 == y1 == 38.50
        assert all(_in_bb(x, y) for x, y in parts[0])

    def test_B_partially_inside_line_gets_outside_endpoint_moved_to_boundary(self):
        line = [[-121.50, 38.50], [-121.30, 38.50]]  # inside -> far outside (east)
        parts = ctxmod.clip_line_to_bounds(line, BB)
        assert len(parts) == 1
        assert parts[0][0] == [-121.50, 38.50]                 # the inside vertex is preserved
        assert abs(parts[0][-1][0] - BB["max_lon"]) < 1e-9     # far endpoint replaced by the boundary
        assert all(_in_bb(x, y) for x, y in parts[0])

    def test_C_entirely_outside_non_intersecting_line_is_dropped(self):
        assert ctxmod.clip_line_to_bounds([[-121.60, 38.60], [-121.55, 38.60]], BB) == []
        assert ctxmod.clip_line_to_bounds([[-100.0, 20.0], [-99.0, 21.0]], BB) == []

    def test_D_line_entering_leaving_and_re_entering_yields_disconnected_parts(self):
        line = [
            [-121.60, 38.50], [-121.49, 38.50], [-121.40, 38.50],   # in ... out (east)
            [-121.30, 38.51], [-121.51, 38.51], [-121.60, 38.51],   # back in ... out (west)
        ]
        parts = ctxmod.clip_line_to_bounds(line, BB)
        assert len(parts) == 2, f"expected 2 disconnected parts, got {len(parts)}"
        for p in parts:
            assert len(p) >= 2
            assert all(_in_bb(x, y) for x, y in p)

    def test_no_duplicate_adjacent_vertices_and_degenerate_parts_rejected(self):
        # repeated vertices + a zero-length hop must not create duplicate/degenerate output
        line = [[-121.50, 38.50], [-121.50, 38.50], [-121.49, 38.50], [-121.49, 38.50]]
        parts = ctxmod.clip_line_to_bounds(line, BB)
        assert len(parts) == 1
        assert parts[0] == [[-121.50, 38.50], [-121.49, 38.50]]
        # fewer than two distinct finite points -> rejected
        assert ctxmod.clip_line_to_bounds([[-121.50, 38.50]], BB) == []
        assert ctxmod.clip_line_to_bounds([[-121.50, 38.50], [-121.50, 38.50]], BB) == []
        assert ctxmod.clip_line_to_bounds([["x", None], [1, 2]], BB) == []


class TestClippingAppliedToEveryRoadSource:
    def test_E_every_packaged_coordinate_is_inside_the_buffered_bounds(self):
        gj, count, _ = ctxmod.roads_geojson_from_context(
            _ctx(
                bearing=45.0,                                                   # synthetic bearing line
                external=[_ext([[-121.60, 38.50], [-121.40, 38.50]], {"NAME": "Cross Rd", "MTFCC": "S1400"})],
                inventory={"type": "LineString", "coordinates": [[-121.50, 38.49], [-121.20, 38.49]]},
                submitted={"type": "LineString", "coordinates": [[-121.60, 38.51], [-121.50, 38.51]]},
            ),
            BUF,
            external_configured=True,
        )
        assert count >= 4  # centerline + inventory + submitted + bearing
        coords = list(_all_coords(gj))
        assert coords, "no coordinates packaged"
        out_of_bounds = [(x, y) for x, y in coords if not _in_bb(x, y)]
        assert not out_of_bounds, f"packaged coordinates outside buffered bounds: {out_of_bounds[:5]}"

    def test_external_centerline_crossing_aoi_is_kept_clipped_with_props(self):
        # A TIGERweb centerline that passes straight through with both ends outside must
        # survive (previously it was dropped) and keep its safe props + kind.
        gj, count, reason = ctxmod.roads_geojson_from_context(
            _ctx(external=[_ext([[-121.60, 38.50], [-121.40, 38.50]], {"NAME": "US-50", "MTFCC": "S1100"})]),
            BUF, external_configured=True,
        )
        assert count == 1 and reason is None
        f = gj["features"][0]
        assert f["properties"]["kind"] == "road_centerline"
        assert f["properties"]["NAME"] == "US-50" and f["properties"]["MTFCC"] == "S1100"
        assert all(_in_bb(x, y) for x, y in f["geometry"]["coordinates"])

    def test_external_line_re_entering_becomes_two_features(self):
        line = [[-121.60, 38.50], [-121.49, 38.50], [-121.40, 38.50],
                [-121.30, 38.51], [-121.51, 38.51], [-121.60, 38.51]]
        gj, count, _ = ctxmod.roads_geojson_from_context(
            _ctx(external=[_ext(line, {"NAME": "Loop"})]), BUF, external_configured=True,
        )
        assert count == 2  # disconnected sections -> separate LineString features
        for f in gj["features"]:
            assert f["geometry"]["type"] == "LineString"   # mobile snap parser handles LineString
            assert f["properties"]["kind"] == "road_centerline" and f["properties"]["NAME"] == "Loop"
            assert all(_in_bb(x, y) for x, y in f["geometry"]["coordinates"])

    def test_inventory_and_submitted_lines_are_clipped_not_just_filtered(self):
        gj, count, _ = ctxmod.roads_geojson_from_context(
            _ctx(
                inventory={"type": "LineString", "coordinates": [[-121.50, 38.49], [-121.20, 38.49]]},
                submitted={"type": "LineString", "coordinates": [[-121.60, 38.51], [-121.50, 38.51]]},
            ),
            BUF,
        )
        kinds = {f["properties"]["kind"] for f in gj["features"]}
        assert kinds == {"road_inventory", "submitted_road_geometry"}
        for f in gj["features"]:
            assert all(_in_bb(x, y) for x, y in f["geometry"]["coordinates"])

    def test_F_road_bearing_line_still_clipped_to_bounds(self):
        gj, count, _ = ctxmod.roads_geojson_from_context(_ctx(bearing=90.0), BUF)  # due east
        assert count == 1 and gj["features"][0]["properties"]["kind"] == "road_bearing"
        assert all(_in_bb(x, y) for x, y in gj["features"][0]["geometry"]["coordinates"])

    def test_fully_outside_sources_still_drop_with_precise_reason(self):
        gj, count, reason = ctxmod.roads_geojson_from_context(
            _ctx(external=[_ext([[-100.0, 20.0], [-99.0, 21.0]])]), BUF, external_configured=True,
        )
        assert count == 0 and reason == ctxmod.ROADS_REASON_NO_FEATURES
