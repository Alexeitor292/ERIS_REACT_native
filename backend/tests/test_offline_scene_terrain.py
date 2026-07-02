"""Pure tests for the canonical mobile terrain height-grid format (numpy, no rasterio)."""

from __future__ import annotations

import numpy as np
import pytest

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
