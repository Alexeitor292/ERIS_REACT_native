"""Packaging tests for the road cross-section context layer (road_cross_section.json).

No DB / no network. Covers the block builder, the builder's graceful degradation +
size budgeting, end-to-end bundle assemble/validate, disabled/absent handling, and
legacy-package compatibility.
"""

from __future__ import annotations

import io
import json
import zipfile

from app.config import settings
from app.services import offline_scene_builder as builder
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder
from app.services.road_cross_section_build import build_road_cross_section

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}
SNAP = {"left_lanes": 2, "right_lanes": 2, "median_type": "R", "median_width": 22, "route_name": "SR-17", "county_code": "SCL", "begin_pm": 5, "end_pm": 6}


def _ctx(snapshot=SNAP, bearing=42.0):
    attrs = build_road_cross_section(snapshot, None)
    return {
        "submission_id": 7,
        "package_version": "gtest-1",
        "center": INCIDENT,
        "radius_m": 1500.0,
        "bounds": BOUNDS,
        "content_signature": "sig",
        "road_cross_section": {"attributes": attrs, "snapshot": snapshot},
        "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": None, "sampleExtent": None},
    }


class TestRoadCrossSectionBlock:
    def test_block_has_attributes_metadata_and_upstation_bearing(self):
        block = ctxmod.road_cross_section_block(_ctx())
        assert block is not None
        assert block["attributes"]["source"] == "ROAD_INVENTORY"
        assert block["attributes"]["median_category"] == "RAISED"
        assert block["route_name"] == "SR-17" and block["county_code"] == "SCL"
        assert block["upstation_bearing_deg"] == 42.0
        assert block["postmile_increases_upstation"] is True
        assert block["centerline"] is None  # no authoritative tabular geometry
        assert block["provenance"]["roadLayoutSource"] == "ROAD_INVENTORY"

    def test_block_none_when_no_attributes(self):
        assert ctxmod.road_cross_section_block({"overlays": {}}) is None
        assert ctxmod.road_cross_section_block({"road_cross_section": {"attributes": {}}}) is None

    def test_default_layout_when_no_snapshot_still_packages(self):
        block = ctxmod.road_cross_section_block(_ctx(snapshot=None, bearing=None))
        assert block is not None
        assert block["source"] == "DEFAULT"
        assert block["upstation_bearing_deg"] is None  # unknown bearing -> honest null


class TestBuilderPackaging:
    def _b(self):
        return HillshadeReliefBuilder()

    def test_packaged_available_with_asset(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=0)
        rxs = layers["road_cross_section"]
        assert rxs["available"] is True
        assert rxs["file"] == "road_cross_section.json"
        assert ctxmod.ROAD_CROSS_SECTION_FILE in assets
        parsed = json.loads(assets[ctxmod.ROAD_CROSS_SECTION_FILE])
        assert parsed["attributes"]["source"] == "ROAD_INVENTORY"

    def test_disabled_marks_unavailable(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", False)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=0)
        assert layers["road_cross_section"] == {"available": False, "reason": "disabled"}
        assert ctxmod.ROAD_CROSS_SECTION_FILE not in assets

    def test_too_large_skips_without_corrupting(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_MAX_PACKAGE_MB", 1)
        layers, assets = self._b()._build_context_layers(_ctx(), base_bytes=1024 * 1024)
        assert layers["road_cross_section"]["reason"] == "too_large"
        assert ctxmod.ROAD_CROSS_SECTION_FILE not in assets


class TestBundleIntegration:
    def _terrain(self):
        import numpy as np
        from app.services import offline_scene_terrain as tf
        heights = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        return grid, tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))

    def _usgs(self):
        return {"dataset": "USGS 3DEP", "version": "2026-07-08", "resolution": "3 m/px", "service": "svc"}

    def _basemap(self):
        return {"provider": "usgs_hillshade", "source_label": "hs", "has_imagery": False, "has_hillshade": True}

    def test_bundle_with_road_cross_section_validates(self):
        grid, meta = self._terrain()
        block = ctxmod.road_cross_section_block(_ctx())
        data = json.dumps(block, separators=(",", ":")).encode("utf-8")
        cl = {"road_cross_section": ctxmod.available_layer(ctxmod.ROAD_CROSS_SECTION_FILE, data, {"provider": "eris_road_inventory"})}
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, cl)
        pkg = builder.assemble_bundle(grid, b"HS", {}, manifest, {ctxmod.ROAD_CROSS_SECTION_FILE: data})
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
        m = json.loads(zipfile.ZipFile(io.BytesIO(pkg)).read("manifest.json"))
        assert m["context_layers"]["road_cross_section"]["available"] is True
        assert m["files"]["road_cross_section"] == "road_cross_section.json"

    def test_declared_but_missing_asset_fails_closed(self):
        grid, meta = self._terrain()
        block = ctxmod.road_cross_section_block(_ctx())
        data = json.dumps(block, separators=(",", ":")).encode("utf-8")
        cl = {"road_cross_section": ctxmod.available_layer(ctxmod.ROAD_CROSS_SECTION_FILE, data, {"provider": "eris_road_inventory"})}
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, cl)
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, {})  # asset omitted
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "road_cross_section.json" in reason

    def test_legacy_bundle_without_road_cross_section_still_valid(self):
        grid, meta = self._terrain()
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta)  # no context_layers
        pkg = builder.assemble_bundle(grid, b"", {}, manifest)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
