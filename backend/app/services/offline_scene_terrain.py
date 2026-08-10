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

The grid encode/decode/validate and local hillshade rendering are unit-tested.
The TIFF decode (decode_dem_tiff) uses rasterio, which ships in the geospatial
worker image. Hillshade is derived locally from the already verified DEM grid;
it never performs another network request or carries an independent extent.
"""

from __future__ import annotations

import hashlib
import io
import math

import numpy as np

HEIGHT_GRID_FILE = "elevation-grid.bin"
HILLSHADE_FILE = "hillshade.png"
HILLSHADE_ALGORITHM = "local_verified_dem_gradient_v1"
HILLSHADE_AZIMUTH_DEG = 315.0
HILLSHADE_ALTITUDE_DEG = 45.0
HILLSHADE_AMBIENT = 0.22
HILLSHADE_NO_DATA_GRAY = 128

DEFAULT_NO_DATA = -9999.0
MAX_GRID_DIM = 4096
MIN_GRID_DIM = 2
_M_PER_DEG_LAT = 111_320.0


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


def ground_sample_spacing_m(
    bounds: dict,
    rows: int,
    columns: int,
) -> tuple[float, float]:
    """Return east-west and north-south sample spacing in physical metres.

    The height grid spans its verified WGS84 bounds from edge sample to edge
    sample. Longitude degrees are converted at the AOI midpoint latitude; the
    latitude conversion uses the same local approximation as the rest of the
    offline terrain pipeline.
    """

    if not isinstance(bounds, dict):
        raise ValueError("hillshade bounds must be an object")

    try:
        min_lat = float(bounds["min_lat"])
        min_lon = float(bounds["min_lon"])
        max_lat = float(bounds["max_lat"])
        max_lon = float(bounds["max_lon"])
        row_count = int(rows)
        column_count = int(columns)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(
            "hillshade bounds or dimensions are invalid"
        ) from exc

    values = (
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    )

    if not all(math.isfinite(value) for value in values):
        raise ValueError("hillshade bounds are non-finite")

    if (
        max_lat <= min_lat
        or max_lon <= min_lon
        or row_count < MIN_GRID_DIM
        or column_count < MIN_GRID_DIM
    ):
        raise ValueError(
            "hillshade bounds or dimensions are degenerate"
        )

    midpoint_lat = (min_lat + max_lat) / 2.0
    cosine = abs(math.cos(math.radians(midpoint_lat)))

    if not math.isfinite(cosine) or cosine <= 1.0e-9:
        raise ValueError(
            "hillshade longitude spacing is undefined"
        )

    width_m = (
        (max_lon - min_lon)
        * _M_PER_DEG_LAT
        * cosine
    )
    height_m = (
        (max_lat - min_lat)
        * _M_PER_DEG_LAT
    )

    x_spacing_m = width_m / (column_count - 1)
    y_spacing_m = height_m / (row_count - 1)

    if not (
        math.isfinite(x_spacing_m)
        and math.isfinite(y_spacing_m)
        and x_spacing_m > 0.0
        and y_spacing_m > 0.0
    ):
        raise ValueError(
            "hillshade ground spacing is invalid"
        )

    return x_spacing_m, y_spacing_m


def render_hillshade_png(
    heights,
    bounds: dict,
    *,
    azimuth_deg: float = HILLSHADE_AZIMUTH_DEG,
    altitude_deg: float = HILLSHADE_ALTITUDE_DEG,
) -> tuple[bytes, dict]:
    """Render deterministic grayscale hillshade from a verified DEM grid.

    Gradients use physical east-west and north-south metre spacing, so a degree
    of longitude is never treated as the same ground distance as a degree of
    latitude. Row zero is north; the row-axis derivative is therefore inverted
    before constructing the surface normal.

    Non-finite source cells are replaced by the finite-grid median only for
    gradient calculation and are emitted as a neutral gray pixel. The source
    height grid itself is never mutated.
    """

    arr = np.asarray(heights, dtype=np.float64)

    if (
        arr.ndim != 2
        or arr.shape[0] < MIN_GRID_DIM
        or arr.shape[1] < MIN_GRID_DIM
    ):
        raise ValueError(
            "hillshade requires a two-dimensional terrain grid"
        )

    rows = int(arr.shape[0])
    columns = int(arr.shape[1])

    if rows > MAX_GRID_DIM or columns > MAX_GRID_DIM:
        raise ValueError(
            "hillshade grid exceeds the supported dimensions"
        )

    finite = np.isfinite(arr)

    if not finite.any():
        raise ValueError(
            "hillshade terrain grid has no valid elevation data"
        )

    try:
        azimuth = float(azimuth_deg)
        altitude = float(altitude_deg)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "hillshade illumination is invalid"
        ) from exc

    if (
        not math.isfinite(azimuth)
        or not math.isfinite(altitude)
        or altitude <= 0.0
        or altitude > 90.0
    ):
        raise ValueError(
            "hillshade illumination is invalid"
        )

    x_spacing_m, y_spacing_m = ground_sample_spacing_m(
        bounds,
        rows,
        columns,
    )

    fill_value = float(np.median(arr[finite]))
    working = np.where(finite, arr, fill_value)

    # Axis zero increases toward the south. Convert its derivative to a
    # north-positive derivative before constructing the physical surface normal.
    dz_d_south, dz_d_east = np.gradient(
        working,
        y_spacing_m,
        x_spacing_m,
        edge_order=1,
    )
    dz_d_north = -dz_d_south

    azimuth_rad = math.radians(azimuth % 360.0)
    altitude_rad = math.radians(altitude)

    sun_east = (
        math.sin(azimuth_rad)
        * math.cos(altitude_rad)
    )
    sun_north = (
        math.cos(azimuth_rad)
        * math.cos(altitude_rad)
    )
    sun_up = math.sin(altitude_rad)

    normal_east = -dz_d_east
    normal_north = -dz_d_north
    normal_up = np.ones_like(working)

    normal_length = np.sqrt(
        normal_east * normal_east
        + normal_north * normal_north
        + normal_up * normal_up
    )

    illumination = (
        normal_east * sun_east
        + normal_north * sun_north
        + normal_up * sun_up
    ) / normal_length

    illumination = np.clip(
        illumination,
        0.0,
        1.0,
    )

    shade = (
        HILLSHADE_AMBIENT
        + (1.0 - HILLSHADE_AMBIENT) * illumination
    )

    pixels = np.rint(
        np.clip(shade, 0.0, 1.0) * 255.0
    ).astype(np.uint8)

    pixels[~finite] = np.uint8(
        HILLSHADE_NO_DATA_GRAY
    )

    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - worker dependency gate
        raise RuntimeError(
            "local hillshade rendering requires Pillow"
        ) from exc

    output = io.BytesIO()
    Image.fromarray(pixels).save(
        output,
        format="PNG",
        optimize=False,
        compress_level=9,
    )
    data = output.getvalue()

    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError(
            "local hillshade encoder did not produce a PNG"
        )

    metadata = {
        "file": HILLSHADE_FILE,
        "algorithm": HILLSHADE_ALGORITHM,
        "source": "verified_dem_grid",
        "width_px": columns,
        "height_px": rows,
        "bounds": dict(bounds),
        "azimuth_deg": azimuth,
        "altitude_deg": altitude,
        "x_spacing_m": round(x_spacing_m, 6),
        "y_spacing_m": round(y_spacing_m, 6),
        "no_data_pixels": int((~finite).sum()),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
    }

    return data, metadata


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


def inspect_hillshade_png(data) -> dict | None:
    """Read the dependency-free PNG header expected from the local renderer."""

    if (
        not isinstance(data, (bytes, bytearray))
        or len(data) < 26
        or bytes(data[:8]) != b"\x89PNG\r\n\x1a\n"
        or bytes(data[12:16]) != b"IHDR"
    ):
        return None

    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    bit_depth = int(data[24])
    color_type = int(data[25])

    if width <= 0 or height <= 0:
        return None

    return {
        "width_px": width,
        "height_px": height,
        "bit_depth": bit_depth,
        "color_type": color_type,
    }


def validate_hillshade_metadata(
    metadata,
    terrain,
) -> tuple[bool, str | None]:
    """Validate metadata for hillshade derived from the verified terrain grid."""

    if not isinstance(metadata, dict):
        return False, "missing local hillshade metadata"

    if metadata.get("file") != HILLSHADE_FILE:
        return False, "invalid local hillshade filename"

    if metadata.get("algorithm") != HILLSHADE_ALGORITHM:
        return False, "unsupported local hillshade algorithm"

    if metadata.get("source") != "verified_dem_grid":
        return False, "invalid local hillshade source"

    if not isinstance(terrain, dict):
        return False, "missing terrain metadata"

    try:
        rows = int(terrain["rows"])
        columns = int(terrain["columns"])
        width = int(metadata["width_px"])
        height = int(metadata["height_px"])
    except (KeyError, TypeError, ValueError):
        return False, "invalid local hillshade dimensions"

    if width != columns or height != rows:
        return (
            False,
            "local hillshade dimensions do not match terrain",
        )

    terrain_bounds = terrain.get("bounds")
    hillshade_bounds = metadata.get("bounds")

    if (
        not isinstance(terrain_bounds, dict)
        or not isinstance(hillshade_bounds, dict)
    ):
        return False, "missing local hillshade bounds"

    for key in (
        "min_lat",
        "min_lon",
        "max_lat",
        "max_lon",
    ):
        try:
            terrain_value = float(terrain_bounds[key])
            hillshade_value = float(hillshade_bounds[key])
        except (KeyError, TypeError, ValueError):
            return False, "invalid local hillshade bounds"

        if (
            not math.isfinite(terrain_value)
            or not math.isfinite(hillshade_value)
            or abs(terrain_value - hillshade_value) > 1.0e-9
        ):
            return (
                False,
                "local hillshade bounds do not match terrain",
            )

    try:
        expected_x, expected_y = ground_sample_spacing_m(
            terrain_bounds,
            rows,
            columns,
        )
        actual_x = float(metadata["x_spacing_m"])
        actual_y = float(metadata["y_spacing_m"])
    except (KeyError, TypeError, ValueError):
        return False, "invalid local hillshade ground spacing"

    if (
        not math.isfinite(actual_x)
        or not math.isfinite(actual_y)
        or abs(actual_x - expected_x) > 1.0e-5
        or abs(actual_y - expected_y) > 1.0e-5
    ):
        return (
            False,
            "local hillshade ground spacing does not match terrain",
        )

    if metadata.get("azimuth_deg") != HILLSHADE_AZIMUTH_DEG:
        return False, "unexpected local hillshade azimuth"

    if metadata.get("altitude_deg") != HILLSHADE_ALTITUDE_DEG:
        return False, "unexpected local hillshade altitude"

    byte_count = metadata.get("bytes")

    if (
        isinstance(byte_count, bool)
        or not isinstance(byte_count, int)
        or byte_count <= 0
    ):
        return False, "invalid local hillshade byte count"

    digest = metadata.get("sha256")

    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(
            char not in "0123456789abcdef"
            for char in digest.lower()
        )
    ):
        return False, "invalid local hillshade checksum"

    no_data_pixels = metadata.get("no_data_pixels")

    if (
        isinstance(no_data_pixels, bool)
        or not isinstance(no_data_pixels, int)
        or no_data_pixels < 0
        or no_data_pixels > rows * columns
    ):
        return False, "invalid local hillshade no-data count"

    return True, None


def validate_hillshade_asset(
    data,
    metadata,
) -> tuple[bool, str | None]:
    """Verify the actual packaged PNG against its declared metadata."""

    header = inspect_hillshade_png(data)

    if header is None:
        return False, "local hillshade is not a valid PNG"

    if (
        header["bit_depth"] != 8
        or header["color_type"] != 0
    ):
        return False, "local hillshade is not 8-bit grayscale"

    if (
        header["width_px"] != metadata.get("width_px")
        or header["height_px"] != metadata.get("height_px")
    ):
        return (
            False,
            "local hillshade PNG dimensions do not match metadata",
        )

    if len(data) != metadata.get("bytes"):
        return False, "local hillshade byte count mismatch"

    if hashlib.sha256(data).hexdigest() != metadata.get("sha256"):
        return False, "local hillshade checksum mismatch"

    return True, None
