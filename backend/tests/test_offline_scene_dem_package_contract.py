"""
Content identity and strict package-validation tests for exact 3DEP terrain.

No live network, database, MinIO, or ArcGIS credential is used.
"""

from __future__ import annotations

import io
import json
import zipfile

import numpy as np
import pytest

from app.services import offline_scene as scene
from app.services import offline_scene_builder as builder
from app.services import offline_scene_dem as dem
from app.services import offline_scene_terrain as terrain
from app.worker import offline_scene_worker as worker


BOUNDS = {
    "min_lat": 40.680000,
    "min_lon": -123.100000,
    "max_lat": 40.707000,
    "max_lon": -123.064000,
}


def _verification(rows: int, columns: int) -> dict:
    pixel_width = (
        BOUNDS["max_lon"] - BOUNDS["min_lon"]
    ) / columns
    pixel_height = (
        BOUNDS["max_lat"] - BOUNDS["min_lat"]
    ) / rows
    sample_bounds = dem.sample_center_bounds(
        BOUNDS,
        pixel_width_deg=pixel_width,
        pixel_height_deg=pixel_height,
    )

    return {
        "export_contract": dem.DEM_EXPORT_CONTRACT,
        "adjust_aspect_ratio": False,
        "extent_verified": True,
        "extent_max_delta_deg": 0.0,
        "extent_tolerance_deg": dem.DEM_EXTENT_TOLERANCE_DEG,
        "requested_width_px": columns,
        "requested_height_px": rows,
        "returned_width_px": columns,
        "returned_height_px": rows,
        "requested_bounds": dict(BOUNDS),
        "returned_bounds": dict(BOUNDS),
        "raster_verified": True,
        "raster_driver": "GTiff",
        "raster_width_px": columns,
        "raster_height_px": rows,
        "raster_band_count": 1,
        "raster_dtype": "float32",
        "raster_crs_wkid": 4326,
        "raster_transform_verified": True,
        "raster_bounds": dict(BOUNDS),
        "raster_sample_bounds": sample_bounds,
        "raster_pixel_width_deg": pixel_width,
        "raster_pixel_height_deg": pixel_height,
        "raster_bounds_max_delta_deg": 0.0,
        "raster_pixel_size_max_delta_deg": 0.0,
    }

def _ctx() -> dict:
    return {
        "submission_id": 21,
        "package_version": "g-pr58-contract-test",
        "center": {
            "lat": 40.6935,
            "lon": -123.082,
        },
        "radius_m": 1500.0,
        "bounds": dict(BOUNDS),
        "content_signature": "0123456789abcdef",
        "overlays": {},
    }


def _exact_package() -> bytes:
    rows = 5
    columns = 7
    heights = np.linspace(
        100.0,
        250.0,
        rows * columns,
        dtype=np.float32,
    ).reshape(rows, columns)

    grid, stats = terrain.encode_height_grid(heights)
    verification = _verification(rows, columns)
    sample_bounds = verification["raster_sample_bounds"]

    terrain_meta = terrain.build_terrain_metadata(
        stats,
        sample_bounds,
        terrain.grid_sha256(grid),
    )
    hillshade, hillshade_meta = terrain.render_hillshade_png(
        heights,
        sample_bounds,
    )

    manifest = builder.build_manifest(
        _ctx(),
        {
            "dataset": "USGS 3DEP",
            "version": "test",
            "resolution": "test",
            "service": "https://elevation.example.gov/ImageServer",
            "export_contract": dem.DEM_EXPORT_CONTRACT,
            "extent_verified": True,
            "verification": verification,
        },
        {
            "provider": "usgs_hillshade",
            "source_label": (
                "Local hillshade derived from verified USGS 3DEP DEM"
            ),
            "has_imagery": False,
            "has_hillshade": True,
            "hillshade": hillshade_meta,
        },
        terrain_meta,
    )

    return builder.assemble_bundle(
        grid,
        hillshade,
        {},
        manifest,
    )


def _rewrite_package(
    package: bytes,
    mutate_manifest,
    *,
    drop: set[str] | None = None,
) -> bytes:
    with zipfile.ZipFile(io.BytesIO(package)) as source:
        entries = {
            name: source.read(name)
            for name in source.namelist()
        }

    manifest = json.loads(entries["manifest.json"])
    mutate_manifest(manifest)
    entries["manifest.json"] = json.dumps(
        manifest,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    output = io.BytesIO()

    with zipfile.ZipFile(
        output,
        "w",
        zipfile.ZIP_STORED,
    ) as target:
        for name, data in entries.items():
            if name not in (drop or set()):
                target.writestr(name, data)

    return output.getvalue()


def test_terrain_contract_changes_content_signature():
    base = {
        "gisa_updated_at": "2026-07-24T00:00:00",
        "geometry_json": None,
        "road_bearing_deg": 90.0,
        "radius_m": 1500.0,
        "road_provider": "caltrans_crs",
        "road_filter_version": "classes:1,2,3",
        "imagery_export_contract": "imagery-v3",
    }

    legacy = scene.content_signature(**base)
    exact = scene.content_signature(
        **base,
        terrain_export_contract=dem.DEM_EXPORT_CONTRACT,
    )
    changed = scene.content_signature(
        **base,
        terrain_export_contract="future-terrain-contract",
    )

    assert exact == scene.content_signature(
        **base,
        terrain_export_contract=dem.DEM_EXPORT_CONTRACT,
    )
    assert legacy != exact
    assert exact != changed
    assert len(exact) == 16


def test_worker_uses_current_terrain_contract_identity():
    assert worker._terrain_content_identity() == (
        f"{dem.DEM_EXPORT_CONTRACT}:{terrain.HILLSHADE_ALGORITHM}"
    )


def test_worker_terrain_identity_changes_with_hillshade_algorithm(
    monkeypatch,
):
    original = worker._terrain_content_identity()
    monkeypatch.setattr(
        terrain,
        "HILLSHADE_ALGORITHM",
        "local_verified_dem_gradient_v2",
    )

    changed = worker._terrain_content_identity()

    assert changed != original
    assert changed == (
        f"{dem.DEM_EXPORT_CONTRACT}:local_verified_dem_gradient_v2"
    )


def test_complete_exact_contract_package_passes():
    ok, reason = builder.validate_bundle_bytes(
        _exact_package()
    )

    assert ok is True, reason


def test_absent_contract_remains_legacy_unverified():
    package = _rewrite_package(
        _exact_package(),
        lambda manifest: manifest["elevation"].update(
            {
                "export_contract": None,
                "extent_verified": False,
                "verification": None,
            }
        ),
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is True, reason


def test_unknown_terrain_contract_fails_closed():
    package = _rewrite_package(
        _exact_package(),
        lambda manifest: manifest["elevation"].update(
            {
                "export_contract": "unknown-terrain-contract",
            }
        ),
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "unsupported terrain export contract" in reason


def test_claimed_contract_requires_complete_verification():
    package = _rewrite_package(
        _exact_package(),
        lambda manifest: manifest["elevation"].update(
            {"verification": None}
        ),
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "verification" in reason


def test_verified_terrain_bounds_must_match_raster():
    def mutate(manifest):
        manifest["terrain"]["bounds"]["min_lon"] += 0.001

    package = _rewrite_package(
        _exact_package(),
        mutate,
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "terrain bounds" in reason


def test_verified_terrain_transform_must_match_bounds():
    def mutate(manifest):
        manifest["terrain"]["local_transform"][
            "origin_lon"
        ] += 0.001

    package = _rewrite_package(
        _exact_package(),
        mutate,
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "local transform" in reason


def test_exact_contract_requires_hillshade_asset():
    package = _rewrite_package(
        _exact_package(),
        lambda manifest: None,
        drop={"hillshade.png"},
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "missing local hillshade" in reason


def test_exact_contract_rejects_hillshade_checksum_mismatch():
    def mutate(manifest):
        manifest["basemap"]["hillshade"]["sha256"] = "0" * 64

    package = _rewrite_package(
        _exact_package(),
        mutate,
    )

    ok, reason = builder.validate_bundle_bytes(package)

    assert ok is False
    assert "hillshade checksum" in reason


def test_exact_package_terrain_uses_raster_sample_centers():
    package = _exact_package()

    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        manifest = json.loads(
            archive.read("manifest.json")
        )

    verification = manifest["elevation"]["verification"]

    assert (
        manifest["terrain"]["bounds"]
        == verification["raster_sample_bounds"]
    )
    assert (
        manifest["terrain"]["bounds"]
        != verification["raster_bounds"]
    )
    assert (
        manifest["terrain"]["local_transform"]["lon_per_col"]
        == pytest.approx(
            verification["raster_pixel_width_deg"],
            rel=0.0,
            abs=dem.DEM_EXTENT_TOLERANCE_DEG,
        )
    )
    assert (
        manifest["terrain"]["local_transform"]["lat_per_row"]
        == pytest.approx(
            -verification["raster_pixel_height_deg"],
            rel=0.0,
            abs=dem.DEM_EXTENT_TOLERANCE_DEG,
        )
    )
