"""
Canonical mobile terrain height-grid format for the ERIS offline terrain bundle
('eristerrain'). The phone cannot decode a raw GeoTIFF, so the worker decodes the
USGS 3DEP DEM and emits this deliberate, self-describing format that the native
SceneKit renderer consumes directly:

  elevation-grid.bin : raw little-endian float32, row-major (row 0 = north edge),
                       rows*columns values; no-data cells store no_data_value.
  manifest.terrain   : rows, columns, encoding, byte_order, no_data_value,
                       min/max elevation, vertical_units, geographic bounds, a
                       local (col,row)->(lon,lat) transform, and the grid SHA-256.

The grid encode/decode/validate here is pure numpy (unit-tested). The TIFF decode
(decode_dem_tiff) uses rasterio, which ships in the geospatial worker image.
"""

from __future__ import annotations

import hashlib

import numpy as np

HEIGHT_GRID_FILE = "elevation-grid.bin"
DEFAULT_NO_DATA = -9999.0
MAX_GRID_DIM = 4096
MIN_GRID_DIM = 2


def encode_height_grid(heights, no_data_out: float = DEFAULT_NO_DATA) -> tuple[bytes, dict]:
    """Encode a 2D elevation array (NaN = no-data) to canonical bytes + stats.
    Replaces NaN/non-finite with no_data_out; min/max computed over valid cells."""
    arr = np.asarray(heights, dtype=np.float32)
    if arr.ndim != 2 or arr.size == 0:
        raise ValueError("height grid must be a non-empty 2D array")
    rows, cols = int(arr.shape[0]), int(arr.shape[1])
    finite = np.isfinite(arr)
    if not finite.any():
        raise ValueError("height grid has no valid elevation data")
    valid = arr[finite]
    vmin, vmax = float(valid.min()), float(valid.max())
    out = np.where(finite, arr, np.float32(no_data_out)).astype("<f4")
    data = out.tobytes(order="C")
    stats = {
        "rows": rows,
        "columns": cols,
        "no_data_value": float(no_data_out),
        "min_elevation_m": round(vmin, 2),
        "max_elevation_m": round(vmax, 2),
        "valid_count": int(finite.sum()),
    }
    return data, stats


def decode_height_grid(data: bytes, rows: int, cols: int) -> np.ndarray:
    expected = int(rows) * int(cols) * 4
    if len(data) != expected:
        raise ValueError(f"height grid byte length {len(data)} != expected {expected}")
    return np.frombuffer(data, dtype="<f4").reshape(int(rows), int(cols))


def grid_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_terrain_metadata(stats: dict, bounds: dict, grid_sha: str) -> dict:
    rows, cols = int(stats["rows"]), int(stats["columns"])
    lon_per_col = (bounds["max_lon"] - bounds["min_lon"]) / max(1, cols - 1)
    lat_per_row = -(bounds["max_lat"] - bounds["min_lat"]) / max(1, rows - 1)
    return {
        "file": HEIGHT_GRID_FILE,
        "rows": rows,
        "columns": cols,
        "encoding": "float32",
        "byte_order": "little",
        "no_data_value": stats["no_data_value"],
        "min_elevation_m": stats["min_elevation_m"],
        "max_elevation_m": stats["max_elevation_m"],
        "vertical_units": "meters",
        "bounds": dict(bounds),
        # Maps grid (col,row) -> (lon,lat). Row 0 is the north edge.
        "local_transform": {
            "origin_lon": bounds["min_lon"],
            "origin_lat": bounds["max_lat"],
            "lon_per_col": lon_per_col,
            "lat_per_row": lat_per_row,
        },
        "sha256": grid_sha,
    }


def validate_terrain_metadata(meta: dict) -> tuple[bool, str | None]:
    if not isinstance(meta, dict):
        return False, "missing terrain metadata"
    try:
        rows, cols = int(meta["rows"]), int(meta["columns"])
    except Exception:
        return False, "missing/invalid rows or columns"
    if not (MIN_GRID_DIM <= rows <= MAX_GRID_DIM and MIN_GRID_DIM <= cols <= MAX_GRID_DIM):
        return False, "invalid grid dimensions"
    if meta.get("encoding") != "float32":
        return False, "unsupported terrain encoding"
    if "no_data_value" not in meta:
        return False, "missing no_data_value"
    b = meta.get("bounds") or {}
    if not all(k in b for k in ("min_lat", "min_lon", "max_lat", "max_lon")):
        return False, "missing terrain bounds"
    if not (b["min_lat"] < b["max_lat"] and b["min_lon"] < b["max_lon"]):
        return False, "invalid terrain bounds"
    return True, None


def decode_dem_tiff(tiff_bytes: bytes, max_dim: int = 512):
    """Decode a USGS 3DEP DEM GeoTIFF to a float32 2D array (NaN = no-data),
    downsampled to <= max_dim per side. Requires rasterio (geospatial worker image).
    Raises RuntimeError with a clear message if rasterio is unavailable."""
    try:
        import rasterio  # noqa: F401
        from rasterio.io import MemoryFile
    except Exception as e:  # pragma: no cover - exercised in the worker image
        raise RuntimeError(
            "DEM decoding requires the geospatial worker image (rasterio/GDAL). "
            "Build the worker from Dockerfile.worker."
        ) from e

    with MemoryFile(tiff_bytes) as mf, mf.open() as ds:
        band = ds.read(1).astype("float32")
        nodata = ds.nodata
    # Downsample to keep the mobile terrain mesh manageable.
    rs = max(1, band.shape[0] // max_dim)
    cs = max(1, band.shape[1] // max_dim)
    if rs > 1 or cs > 1:
        band = band[::rs, ::cs]
    if nodata is not None:
        band = np.where(band == np.float32(nodata), np.nan, band)
    # Treat absurd sentinels as no-data too.
    band = np.where(band < -1.0e6, np.nan, band)
    return band
