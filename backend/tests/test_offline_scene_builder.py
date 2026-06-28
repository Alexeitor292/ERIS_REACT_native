"""
Pure unit tests for the automatic offline package builder (no DB/network).
Run: pytest -m "not db" tests/test_offline_scene_builder.py
"""

from __future__ import annotations

from app.services import offline_scene_builder as bld


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


def _real_dem() -> bytes:
    # A minimal but real-looking TIFF (correct magic + enough bytes).
    return b"II*\x00" + b"\x00" * 400


def test_export_params_and_resolution():
    p = bld.export_image_params({"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}, 1024)
    assert p["bbox"] == "-121.52,38.48,-121.48,38.52"
    assert p["size"] == "1024,1024"
    assert p["bboxSR"] == "4326"
    res = bld.aoi_resolution_m({"min_lon": -121.52, "max_lon": -121.48, "min_lat": 38.48, "max_lat": 38.52}, 38.5, 1024)
    assert res > 0


def test_manifest_records_usgs_provenance():
    usgs = {"dataset": "USGS 3DEP", "version": "2026-06-27", "resolution": "3.4 m/px", "service": "https://x"}
    basemap = {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade (terrain relief)", "has_imagery": False}
    m = bld.build_manifest(_ctx(), usgs, basemap)
    assert m["format"] == "eristerrain"
    assert m["elevation"]["source"] == "USGS_3DEP"
    assert m["elevation"]["resolution"] == "3.4 m/px"
    assert m["content_signature"] == "sig123"
    assert m["files"]["dem"] == "dem.tif"


def test_assemble_and_validate_roundtrip_ok():
    usgs = {"dataset": "USGS 3DEP", "version": "2026-06-27", "resolution": "3.4 m/px"}
    basemap = {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade", "has_imagery": False}
    manifest = bld.build_manifest(_ctx(), usgs, basemap)
    pkg = bld.assemble_bundle(_real_dem(), b"\x89PNGfake", _ctx()["overlays"], manifest)
    ok, reason = bld.validate_bundle_bytes(pkg)
    assert ok is True and reason is None


def test_validate_rejects_bad_bundles():
    # Not a zip.
    ok, _ = bld.validate_bundle_bytes(b"not a zip")
    assert ok is False
    # Zip missing manifest / dem, wrong format, non-TIFF DEM, too-small DEM.
    usgs = {"dataset": "d", "version": "v", "resolution": "r"}
    basemap = {"source_label": "x"}
    good_manifest = bld.build_manifest(_ctx(), usgs, basemap)

    # DEM that is not a real TIFF.
    bad_dem = bld.assemble_bundle(b"\x00" * 400, b"", _ctx()["overlays"], good_manifest)
    ok, reason = bld.validate_bundle_bytes(bad_dem)
    assert ok is False and "TIFF" in reason

    # DEM too small.
    small = bld.assemble_bundle(b"II*\x00", b"", _ctx()["overlays"], good_manifest)
    ok, reason = bld.validate_bundle_bytes(small)
    assert ok is False and "small" in reason.lower()

    # Wrong format in manifest.
    bad_fmt = dict(good_manifest)
    bad_fmt["format"] = "mspk"
    ok, reason = bld.validate_bundle_bytes(bld.assemble_bundle(_real_dem(), b"", {}, bad_fmt))
    assert ok is False and "format" in reason.lower()
