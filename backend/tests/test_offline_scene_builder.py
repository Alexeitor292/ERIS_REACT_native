"""
Pure unit tests for the automatic offline package builder (no DB/network/rasterio).
Run: pytest -m "not db" tests/test_offline_scene_builder.py
"""

from __future__ import annotations

import io
import json
import zipfile

import numpy as np

from app.services import offline_scene_builder as bld
from app.services import offline_scene_terrain as terrain_fmt


def _ctx():
    return {
        "submission_id": 7,
        "package_version": "g20260627000000-1",
        "center": {"lat": 38.5, "lon": -121.5},
        "radius_m": 1500.0,
        "bounds": {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48},
        "content_signature": "sig123",
        "overlays": {"incident": {"lat": 38.5, "lon": -121.5}, "roadBearingDeg": 90, "geometry": None, "sampleExtent": None},
    }


def _grid_and_meta(rows=4, cols=4):
    heights = np.arange(rows * cols, dtype=np.float32).reshape(rows, cols)
    data, stats = terrain_fmt.encode_height_grid(heights)
    meta = terrain_fmt.build_terrain_metadata(stats, _ctx()["bounds"], terrain_fmt.grid_sha256(data))
    return data, meta


def _usgs():
    return {"dataset": "USGS 3DEP", "version": "2026-06-27", "resolution": "3.4 m/px", "service": "https://x"}


def test_export_params_and_resolution():
    p = bld.export_image_params({"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}, 256)
    assert p["bbox"] == "-121.52,38.48,-121.48,38.52"
    assert p["size"] == "256,256"
    assert bld.aoi_resolution_m({"min_lon": -121.52, "max_lon": -121.48, "min_lat": 38.48, "max_lat": 38.52}, 38.5, 256) > 0


def test_manifest_records_terrain_and_provenance():
    _, meta = _grid_and_meta()
    basemap = {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade", "has_imagery": False, "has_hillshade": True}
    m = bld.build_manifest(_ctx(), _usgs(), basemap, meta)
    assert m["format"] == "eristerrain" and m["format_version"] == bld.FORMAT_VERSION
    assert m["elevation"]["source"] == "USGS_3DEP"
    assert m["terrain"]["encoding"] == "float32"
    assert m["files"]["terrain"] == "elevation-grid.bin"
    assert m["files"]["hillshade"] == "hillshade.png"  # included because has_hillshade


def test_assemble_and_validate_roundtrip_ok():
    grid, meta = _grid_and_meta()
    basemap = {"source_label": "USGS 3DEP hillshade", "has_hillshade": True}
    manifest = bld.build_manifest(_ctx(), _usgs(), basemap, meta)
    pkg = bld.assemble_bundle(grid, b"\x89PNGfake", _ctx()["overlays"], manifest)
    ok, reason = bld.validate_bundle_bytes(pkg)
    assert ok is True and reason is None
    # The grid is present and decodes to the expected dimensions.
    with zipfile.ZipFile(io.BytesIO(pkg)) as zf:
        g = zf.read("elevation-grid.bin")
    assert len(g) == meta["rows"] * meta["columns"] * 4


def test_validate_rejects_bad_bundles():
    assert bld.validate_bundle_bytes(b"not a zip")[0] is False

    grid, meta = _grid_and_meta()
    basemap = {"source_label": "x", "has_hillshade": False}
    manifest = bld.build_manifest(_ctx(), _usgs(), basemap, meta)

    # Wrong grid size for the declared dimensions.
    bad_size = bld.assemble_bundle(grid[:-4], b"", {}, manifest)
    ok, reason = bld.validate_bundle_bytes(bad_size)
    assert ok is False and "byte length" in reason

    # Corrupted grid bytes -> checksum mismatch (same length).
    corrupt = bytearray(grid)
    corrupt[0] ^= 0xFF
    ok, reason = bld.validate_bundle_bytes(bld.assemble_bundle(bytes(corrupt), b"", {}, manifest))
    assert ok is False and "checksum" in reason

    # Wrong format in manifest.
    bad_fmt = dict(manifest); bad_fmt["format"] = "mspk"
    ok, reason = bld.validate_bundle_bytes(bld.assemble_bundle(grid, b"", {}, bad_fmt))
    assert ok is False and "format" in reason.lower()

    # Missing terrain grid entry (build a zip without it).
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
    ok, reason = bld.validate_bundle_bytes(buf.getvalue())
    assert ok is False and "missing terrain grid" in reason
