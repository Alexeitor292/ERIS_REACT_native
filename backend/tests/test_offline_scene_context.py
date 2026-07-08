"""Pure tests for offline terrain CONTEXT LAYERS (roads / imagery / overview).

No DB / no network. Overview PNG uses Pillow (present in the worker image and the
local venv); the test skips only if Pillow is unavailable.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.config import settings
from app.services import offline_scene_builder as builder
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder, OfflineSceneBuildError

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}


def _ctx(**overlays_extra):
    overlays = {"incident": INCIDENT, "roadBearingDeg": 90.0, "geometry": None, "sampleExtent": None}
    overlays.update(overlays_extra)
    return {
        "submission_id": 7,
        "package_version": "gtest-1",
        "center": INCIDENT,
        "radius_m": 1500.0,
        "bounds": BOUNDS,
        "content_signature": "sig",
        "overlays": overlays,
    }


class TestRoadsGeoJson:
    def test_road_bearing_feature_from_real_bearing(self):
        gj, count = ctxmod.roads_geojson_from_context(_ctx(), buffer_m=250.0)
        assert gj["type"] == "FeatureCollection"
        assert count == 1
        f = gj["features"][0]
        assert f["geometry"]["type"] == "LineString"
        assert f["properties"]["kind"] == "road_bearing"
        # Vertices are near the incident and within the buffered bounds.
        for lon, lat in f["geometry"]["coordinates"]:
            assert -121.53 < lon < -121.47 and 38.47 < lat < 38.53

    def test_no_bearing_no_invented_roads(self):
        gj, count = ctxmod.roads_geojson_from_context(_ctx(roadBearingDeg=None), buffer_m=250.0)
        assert count == 0 and gj["features"] == []

    def test_road_inventory_linestrings_included_and_clipped(self):
        ctx = _ctx()
        ctx["road_inventory_geometry"] = {
            "type": "LineString",
            "coordinates": [[-121.5, 38.5], [-121.49, 38.49]],  # inside
        }
        gj, count = ctxmod.roads_geojson_from_context(ctx, buffer_m=250.0)
        kinds = {f["properties"]["kind"] for f in gj["features"]}
        assert "road_inventory" in kinds and count == 2

    def test_road_inventory_far_outside_is_dropped(self):
        ctx = _ctx()
        ctx["road_inventory_geometry"] = {"type": "LineString", "coordinates": [[-100.0, 20.0], [-99.0, 21.0]]}
        gj, count = ctxmod.roads_geojson_from_context(ctx, buffer_m=250.0)
        # Only the bearing feature survives; the far line is not in bounds.
        assert count == 1 and gj["features"][0]["properties"]["kind"] == "road_bearing"

    def test_malformed_road_inventory_never_raises(self):
        for bad in ("garbage", 5, {"type": "LineString"}, {"paths": "nope"}, {"coordinates": [[1]]}):
            ctx = _ctx(roadBearingDeg=None)
            ctx["road_inventory_geometry"] = bad
            gj, count = ctxmod.roads_geojson_from_context(ctx, buffer_m=250.0)
            assert count == 0


class TestRoadContextDescription:
    """Truthful road-context labels — never claim 'roads'/'routes'/'street map'
    when the package only holds a derived road-bearing line."""

    def test_no_road_context(self):
        assert ctxmod.describe_road_context(None) == ctxmod.ROAD_CONTEXT_NONE
        assert ctxmod.describe_road_context({"available": False, "reason": "no_data"}) == ctxmod.ROAD_CONTEXT_NONE

    def test_bearing_only(self):
        layer = ctxmod.available_layer(ctxmod.ROADS_FILE, b"{}", None, road_kinds=["road_bearing"])
        assert ctxmod.describe_road_context(layer) == ctxmod.ROAD_CONTEXT_BEARING
        assert ctxmod.describe_road_context(layer) == "Road bearing context"

    def test_road_inventory_geometry(self):
        layer = ctxmod.available_layer(ctxmod.ROADS_FILE, b"{}", None, road_kinds=["road_bearing", "road_inventory"])
        assert ctxmod.describe_road_context(layer) == ctxmod.ROAD_CONTEXT_INVENTORY

    def test_feature_service_network(self):
        layer = ctxmod.available_layer(
            ctxmod.ROADS_FILE, b"{}", None, road_kinds=["road_bearing", "road_inventory", "road_centerline"]
        )
        assert ctxmod.describe_road_context(layer) == ctxmod.ROAD_CONTEXT_FEATURE_SERVICE

    def test_kinds_extracted_from_geojson(self):
        gj = {"features": [
            {"properties": {"kind": "road_bearing"}},
            {"properties": {"kind": "road_inventory"}},
            {"properties": {"kind": "road_inventory"}},
            {"nope": 1},
        ]}
        assert ctxmod.road_kinds_from_geojson(gj) == ["road_bearing", "road_inventory"]
        assert ctxmod.road_kinds_from_geojson(None) == []
        assert ctxmod.road_kinds_from_geojson({"features": "bad"}) == []


class TestSourceSanitization:
    def test_strips_query_and_disallowed_keys(self):
        src = {
            "provider": "usgs_naip",
            "attribution": "USDA NAIP",
            "service": "https://imagery.example.gov/arcgis/rest/ImageServer?token=SECRET&f=json",
            "token": "SECRET",          # disallowed key -> dropped
            "api_key": "abc",           # disallowed -> dropped
        }
        out = ctxmod.sanitize_source(src)
        assert out["provider"] == "usgs_naip"
        assert "token" not in out and "api_key" not in out
        assert "SECRET" not in json.dumps(out)  # query string stripped from service URL
        assert out["service"] == "https://imagery.example.gov/arcgis/rest/ImageServer"

    def test_available_layer_never_leaks_secret_source(self):
        meta = ctxmod.available_layer("roads.geojson", b"{}", {"provider": "x", "token": "SECRET"})
        assert "SECRET" not in json.dumps(meta)
        assert meta["available"] and meta["sha256"] and meta["bytes"] == 2


class TestOverviewPixelMapping:
    def test_lonlat_to_px_corners_north_up(self):
        px = 100
        # NW corner -> (0,0); SE corner -> (px-1, px-1); centre -> middle.
        assert ctxmod.lonlat_to_px(BOUNDS["min_lon"], BOUNDS["max_lat"], BOUNDS, px) == (0, 0)
        assert ctxmod.lonlat_to_px(BOUNDS["max_lon"], BOUNDS["min_lat"], BOUNDS, px) == (px - 1, px - 1)
        cx, cy = ctxmod.lonlat_to_px(-121.5, 38.5, BOUNDS, px)
        assert abs(cx - (px - 1) / 2) <= 1 and abs(cy - (px - 1) / 2) <= 1

    def test_render_overview_png(self):
        pytest.importorskip("PIL")
        gj, _ = ctxmod.roads_geojson_from_context(_ctx(), 250.0)
        png = ctxmod.render_overview_png(
            bounds=BOUNDS, incident=INCIDENT, roads_geojson=gj, geometry=None, sample_extent=None, px=128
        )
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        from PIL import Image
        img = Image.open(io.BytesIO(png))
        assert img.size == (128, 128)


class TestContextLayersValidation:
    def test_absent_block_is_ok(self):
        assert ctxmod.validate_context_layers(None) == (True, None)
        assert ctxmod.validate_context_layers({}) == (True, None)

    def test_available_requires_file_and_sha(self):
        ok, _ = ctxmod.validate_context_layers({"roads": {"available": True}})
        assert not ok
        ok, _ = ctxmod.validate_context_layers({"roads": {"available": True, "file": "roads.geojson", "sha256": "x"}})
        assert not ok  # bad sha length
        ok, _ = ctxmod.validate_context_layers(
            {"roads": {"available": True, "file": "roads.geojson", "sha256": "a" * 64}}
        )
        assert ok

    def test_unavailable_layer_ok(self):
        assert ctxmod.validate_context_layers({"imagery": {"available": False, "reason": "not_configured"}}) == (True, None)


class TestBundleWithContextLayers:
    """End-to-end through the builder assemble/validate path (no network)."""

    def _terrain(self):
        import numpy as np
        from app.services import offline_scene_terrain as tf
        heights = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        meta = tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))
        return grid, meta

    def _usgs(self):
        return {"dataset": "USGS 3DEP", "version": "2026-07-02", "resolution": "3 m/px", "service": "svc"}

    def _basemap(self, hs=True):
        return {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade", "has_imagery": False, "has_hillshade": hs}

    def test_legacy_v2_bundle_without_context_layers_still_valid(self):
        grid, meta = self._terrain()
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(hs=False), meta)  # no context_layers
        pkg = builder.assemble_bundle(grid, b"", {}, manifest)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
        assert json.loads(zipfile.ZipFile(io.BytesIO(pkg)).read("manifest.json"))["context_layers"] == {}

    def test_bundle_with_roads_and_overview_validates(self):
        pytest.importorskip("PIL")
        grid, meta = self._terrain()
        ctx = _ctx()
        gj, count = ctxmod.roads_geojson_from_context(ctx, 250.0)
        roads = json.dumps(gj, separators=(",", ":")).encode()
        png = ctxmod.render_overview_png(bounds=BOUNDS, incident=INCIDENT, roads_geojson=gj, geometry=None, sample_extent=None, px=96)
        cl = {
            "roads": ctxmod.available_layer(ctxmod.ROADS_FILE, roads, {"provider": "eris_internal"}, feature_count=count),
            "overview": ctxmod.available_layer(ctxmod.OVERVIEW_FILE, png, {"provider": "eris_render"}, width=96, height=96),
            "imagery": ctxmod.unavailable_layer("not_configured"),
        }
        manifest = builder.build_manifest(ctx, self._usgs(), self._basemap(), meta, cl)
        pkg = builder.assemble_bundle(grid, b"HS", {}, manifest, {ctxmod.ROADS_FILE: roads, ctxmod.OVERVIEW_FILE: png})
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
        m = json.loads(zipfile.ZipFile(io.BytesIO(pkg)).read("manifest.json"))
        assert m["context_layers"]["roads"]["available"] is True
        assert m["context_layers"]["imagery"]["available"] is False
        assert m["files"]["roads"] == "roads.geojson" and m["files"]["overview"] == "overview.png"

    def test_declared_asset_missing_fails_closed(self):
        grid, meta = self._terrain()
        roads = b'{"type":"FeatureCollection","features":[]}'
        cl = {"roads": ctxmod.available_layer(ctxmod.ROADS_FILE, roads, {"provider": "eris_internal"})}
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, cl)
        # Assemble WITHOUT the roads asset -> declared available but missing.
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, {})
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "roads.geojson" in reason

    def test_declared_asset_corrupt_checksum_fails_closed(self):
        grid, meta = self._terrain()
        roads = b'{"type":"FeatureCollection","features":[]}'
        cl = {"roads": ctxmod.available_layer(ctxmod.ROADS_FILE, roads, {"provider": "eris_internal"})}
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, cl)
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, {ctxmod.ROADS_FILE: roads + b"TAMPER"})
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "checksum mismatch" in reason


class TestBuilderContextLayers:
    """HillshadeReliefBuilder._build_context_layers graceful degradation + sizing."""

    def _b(self):
        return HillshadeReliefBuilder()

    def test_imagery_disabled_by_default_does_not_break_generation(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=1000)
        assert layers["imagery"]["available"] is False
        assert layers["imagery"]["reason"] == "not_configured"
        assert layers["roads"]["available"] is True            # from the real bearing
        assert ctxmod.ROADS_FILE in assets
        # overview packaged when Pillow present
        assert layers["overview"]["available"] in (True, False)

    def test_roads_disabled_marks_unavailable(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", False)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"] == {"available": False, "reason": "disabled"}
        assert ctxmod.ROADS_FILE not in assets

    def test_size_limit_skips_assets_too_large(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_MAX_PACKAGE_MB", 1)  # 1 MB
        # base already at the limit -> every context asset is skipped (too_large),
        # never raising / corrupting the terrain package.
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=1024 * 1024)
        assert assets == {}
        assert layers["roads"]["reason"] == "too_large"
        assert layers["overview"]["reason"] in ("too_large", "render_error")

    def test_external_road_source_failure_never_raises(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "arcgis_feature_service")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE_URL", "https://example.gov/FeatureServer/0")

        def _boom(*a, **k):
            raise RuntimeError("feature service down")

        monkeypatch.setattr(ctxmod, "fetch_arcgis_road_features", _boom)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=0)
        # A source error degrades roads (never raises, never corrupts the package).
        assert layers["roads"]["available"] is False and layers["roads"]["reason"] == "source_error"

    def test_mandatory_imagery_failure_raises(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "single")  # legacy single-image path
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MANDATORY", True)

        def _boom(*a, **k):
            raise RuntimeError("naip down")

        monkeypatch.setattr(ctxmod, "fetch_imagery_png", _boom)
        with pytest.raises(OfflineSceneBuildError):
            self._b()._build_context_layers(_ctx(), base_bytes=0)

    def test_optional_imagery_failure_degrades(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "single")  # legacy single-image path
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MANDATORY", False)

        def _boom(*a, **k):
            raise RuntimeError("naip down")

        monkeypatch.setattr(ctxmod, "fetch_imagery_png", _boom)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=0)
        assert layers["imagery"]["available"] is False and layers["imagery"]["reason"] == "source_error"
        assert ctxmod.IMAGERY_FILE not in assets
