"""Pure tests for the canonical mobile terrain height-grid format (numpy, no rasterio)."""

from __future__ import annotations

import io
import math

import numpy as np
import pytest
from PIL import Image

from app.services import offline_scene_terrain as t


def test_encode_decode_roundtrip_and_stats():
    heights = np.array([[10.0, 20.0], [30.0, 40.0]], dtype=np.float32)
    data, stats = t.encode_height_grid(heights)
    assert stats["rows"] == 2 and stats["columns"] == 2
    assert stats["min_elevation_m"] == 10.0 and stats["max_elevation_m"] == 40.0
    assert stats["valid_count"] == 4
    assert len(data) == 2 * 2 * 4
    back = t.decode_height_grid(data, 2, 2)
    assert np.allclose(back, heights)


def test_no_data_handling():
    heights = np.array([[10.0, np.nan], [np.inf, 50.0]], dtype=np.float32)
    data, stats = t.encode_height_grid(heights, no_data_out=-9999.0)
    # min/max ignore the non-finite cells; valid_count counts only finite ones.
    assert stats["min_elevation_m"] == 10.0 and stats["max_elevation_m"] == 50.0
    assert stats["valid_count"] == 2
    back = t.decode_height_grid(data, 2, 2)
    assert back[0, 1] == -9999.0 and back[1, 0] == -9999.0
    assert back[0, 0] == 10.0 and back[1, 1] == 50.0


def test_encode_rejects_all_nodata_and_bad_shape():
    with pytest.raises(ValueError):
        t.encode_height_grid(np.array([[np.nan, np.nan]], dtype=np.float32))
    with pytest.raises(ValueError):
        t.encode_height_grid(np.array([1.0, 2.0], dtype=np.float32))  # 1-D


def test_decode_size_mismatch_raises():
    with pytest.raises(ValueError):
        t.decode_height_grid(b"\x00\x00\x00\x00", 2, 2)


def test_terrain_metadata_and_validation():
    heights = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    data, stats = t.encode_height_grid(heights)
    bounds = {"min_lat": 38.4, "min_lon": -121.6, "max_lat": 38.6, "max_lon": -121.4}
    meta = t.build_terrain_metadata(stats, bounds, t.grid_sha256(data))
    assert meta["rows"] == 2 and meta["columns"] == 3
    assert meta["encoding"] == "float32" and meta["byte_order"] == "little"
    # transform maps top-left to (min_lon, max_lat) and steps east/south.
    lt = meta["local_transform"]
    assert lt["origin_lon"] == -121.6 and lt["origin_lat"] == 38.6
    assert lt["lon_per_col"] > 0 and lt["lat_per_row"] < 0
    ok, reason = t.validate_terrain_metadata(meta)
    assert ok is True and reason is None


def test_validation_rejects_bad_metadata():
    base = {"rows": 4, "columns": 4, "encoding": "float32", "no_data_value": -9999.0,
            "bounds": {"min_lat": 1, "min_lon": 1, "max_lat": 2, "max_lon": 2}}
    assert t.validate_terrain_metadata(base)[0] is True
    bad_dim = dict(base); bad_dim["rows"] = 1
    assert t.validate_terrain_metadata(bad_dim)[0] is False
    bad_enc = dict(base); bad_enc["encoding"] = "int16"
    assert t.validate_terrain_metadata(bad_enc)[0] is False
    bad_bounds = dict(base); bad_bounds["bounds"] = {"min_lat": 2, "min_lon": 1, "max_lat": 1, "max_lon": 2}
    assert t.validate_terrain_metadata(bad_bounds)[0] is False


HILLSHADE_BOUNDS = {
    "min_lat": 40.680000,
    "min_lon": -123.100000,
    "max_lat": 40.707000,
    "max_lon": -123.064000,
}


def test_ground_sample_spacing_uses_physical_longitude_scale():
    rows = 7
    columns = 11

    x_spacing, y_spacing = t.ground_sample_spacing_m(
        HILLSHADE_BOUNDS,
        rows,
        columns,
    )

    midpoint_lat = (
        HILLSHADE_BOUNDS["min_lat"]
        + HILLSHADE_BOUNDS["max_lat"]
    ) / 2.0

    expected_x = (
        (
            HILLSHADE_BOUNDS["max_lon"]
            - HILLSHADE_BOUNDS["min_lon"]
        )
        * 111_320.0
        * math.cos(math.radians(midpoint_lat))
        / (columns - 1)
    )
    expected_y = (
        (
            HILLSHADE_BOUNDS["max_lat"]
            - HILLSHADE_BOUNDS["min_lat"]
        )
        * 111_320.0
        / (rows - 1)
    )

    assert x_spacing == pytest.approx(expected_x)
    assert y_spacing == pytest.approx(expected_y)
    assert x_spacing != pytest.approx(y_spacing)


def test_local_hillshade_is_deterministic_and_matches_grid_dimensions():
    y, x = np.mgrid[-1.0:1.0:9j, -1.0:1.0:13j]
    heights = (
        100.0
        + 80.0 * np.exp(-3.0 * (x * x + y * y))
        + 15.0 * x
    ).astype(np.float32)

    first, first_meta = t.render_hillshade_png(
        heights,
        HILLSHADE_BOUNDS,
    )
    second, second_meta = t.render_hillshade_png(
        heights,
        HILLSHADE_BOUNDS,
    )

    assert first == second
    assert first_meta == second_meta
    assert first.startswith(b"\x89PNG\r\n\x1a\n")
    assert (
        first_meta["algorithm"]
        == t.HILLSHADE_ALGORITHM
    )
    assert first_meta["source"] == "verified_dem_grid"
    assert first_meta["width_px"] == 13
    assert first_meta["height_px"] == 9
    assert first_meta["bounds"] == HILLSHADE_BOUNDS
    assert first_meta["sha256"] == t.grid_sha256(first)
    assert first_meta["bytes"] == len(first)

    image = Image.open(io.BytesIO(first))
    pixels = np.asarray(image)

    assert image.mode == "L"
    assert image.size == (13, 9)
    assert pixels.shape == heights.shape
    assert np.unique(pixels).size > 1


def test_local_hillshade_handles_no_data_without_mutating_source():
    heights = np.arange(
        35,
        dtype=np.float32,
    ).reshape(5, 7)
    heights[2, 3] = np.nan
    before = heights.copy()

    data, meta = t.render_hillshade_png(
        heights,
        HILLSHADE_BOUNDS,
    )

    pixels = np.asarray(
        Image.open(io.BytesIO(data))
    )

    assert np.array_equal(
        heights,
        before,
        equal_nan=True,
    )
    assert meta["no_data_pixels"] == 1
    assert pixels[2, 3] == t.HILLSHADE_NO_DATA_GRAY


def test_local_hillshade_rejects_all_no_data_and_bad_bounds():
    with pytest.raises(
        ValueError,
        match="no valid elevation",
    ):
        t.render_hillshade_png(
            np.full((4, 4), np.nan),
            HILLSHADE_BOUNDS,
        )

    with pytest.raises(
        ValueError,
        match="degenerate",
    ):
        t.render_hillshade_png(
            np.ones((4, 4), dtype=np.float32),
            {
                "min_lat": 2.0,
                "min_lon": 1.0,
                "max_lat": 1.0,
                "max_lon": 2.0,
            },
        )
