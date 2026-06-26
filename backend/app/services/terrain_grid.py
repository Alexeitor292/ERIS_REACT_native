"""
Road-aligned 2D terrain elevation grid from USGS 3DEP / EPQS.

Builds a real two-dimensional grid of point elevations around an incident/road
location for the "3D Terrain" / "Terrain Relief" visualization. This is NOT a 3D
extrusion of the one-dimensional cross-section — it queries an actual grid of
USGS EPQS points.

Grid geometry (road-aligned):
  * Rows run ALONG the road (upstation/downstation), positive = upstation
    (increasing postmile), i.e. along road_bearing_deg.
  * Columns run ACROSS the road (left/right), positive = right of the upstation
    direction, i.e. along road_bearing_deg + 90.
  * The grid is centered on (lat, lon). For an N×N grid with spacing s, the
    extent is (N-1)·s in each axis (default 11×11 @ 20 m ≈ 200 m × 200 m).

When no road bearing is available the grid falls back to true-north alignment
(bearing 0) so the relief is still useful; road_bearing_deg_used is reported as
None so the UI can label it.

USGS calls use bounded concurrency + the shared _fetch_elevation_ft (which
already retries). No synthetic elevations are produced — points USGS cannot
resolve are returned with elevation_ft = null.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from .elevation_profile import EPQS_SOURCE, _fetch_elevation_ft, _offset_point

logger = logging.getLogger("eris.terrain")

# Server-side limits.
DEFAULT_ROWS = 11
DEFAULT_COLS = 11
DEFAULT_ALONG_SPACING_M = 20.0
DEFAULT_CROSS_SPACING_M = 20.0
MIN_DIM = 3
MAX_DIM = 15          # caps total points at 15×15 = 225
MIN_SPACING_M = 5.0
MAX_SPACING_M = 50.0
_MAX_WORKERS = 6      # bounded concurrency against USGS EPQS


def _clamp_int(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(value)))


def _clamp_float(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(value)))


def _grid_point_latlon(
    lat: float,
    lon: float,
    bearing_deg: float,
    along_offset_m: float,
    cross_offset_m: float,
) -> tuple[float, float]:
    """Resolve a grid point's lat/lon by composing an along-road offset and a
    cross-road (perpendicular) offset from the center."""
    cur_lat, cur_lon = lat, lon
    if abs(along_offset_m) >= 0.5:
        along_bearing = bearing_deg if along_offset_m > 0 else (bearing_deg + 180.0) % 360.0
        cur_lat, cur_lon = _offset_point(cur_lat, cur_lon, along_bearing, abs(along_offset_m))
    if abs(cross_offset_m) >= 0.5:
        cross_bearing = (bearing_deg + 90.0) % 360.0 if cross_offset_m > 0 else (bearing_deg + 270.0) % 360.0
        cur_lat, cur_lon = _offset_point(cur_lat, cur_lon, cross_bearing, abs(cross_offset_m))
    return (cur_lat, cur_lon)


def build_grid_points(
    lat: float,
    lon: float,
    bearing_deg: float,
    rows: int,
    cols: int,
    along_spacing_m: float,
    cross_spacing_m: float,
) -> list[dict]:
    """Generate the grid point coordinates (without elevations). Pure/geometry
    only — no network. Useful for unit testing the coordinate math."""
    center_row = (rows - 1) / 2.0
    center_col = (cols - 1) / 2.0
    points: list[dict] = []
    for r in range(rows):
        along = (r - center_row) * along_spacing_m
        for c in range(cols):
            cross = (c - center_col) * cross_spacing_m
            pt_lat, pt_lon = _grid_point_latlon(lat, lon, bearing_deg, along, cross)
            points.append(
                {
                    "row": r,
                    "column": c,
                    "along_offset_m": round(along, 1),
                    "cross_offset_m": round(cross, 1),
                    "lat": round(pt_lat, 7),
                    "lon": round(pt_lon, 7),
                    "elevation_ft": None,
                }
            )
    return points


def fetch_terrain_grid(
    lat: float,
    lon: float,
    road_bearing_deg: float | None = None,
    rows: int = DEFAULT_ROWS,
    cols: int = DEFAULT_COLS,
    along_spacing_m: float = DEFAULT_ALONG_SPACING_M,
    cross_spacing_m: float = DEFAULT_CROSS_SPACING_M,
) -> dict:
    """
    Sample a road-aligned 2D elevation grid around (lat, lon) from USGS EPQS.

    Returns a dict with: source, checked_at, road_bearing_deg_used,
    road_bearing_source (None — the endpoint fills this in), grid{...}, error.
    """
    rows = _clamp_int(rows, MIN_DIM, MAX_DIM)
    cols = _clamp_int(cols, MIN_DIM, MAX_DIM)
    along_spacing_m = _clamp_float(along_spacing_m, MIN_SPACING_M, MAX_SPACING_M)
    cross_spacing_m = _clamp_float(cross_spacing_m, MIN_SPACING_M, MAX_SPACING_M)

    checked_at = datetime.utcnow().isoformat()
    # North-align when no road bearing is available; report the real value (None).
    bearing_for_geometry = road_bearing_deg if road_bearing_deg is not None else 0.0

    points = build_grid_points(
        lat, lon, bearing_for_geometry, rows, cols, along_spacing_m, cross_spacing_m
    )

    error: str | None = None
    valid = 0
    try:
        # Bounded concurrency — never fire an unbounded number of USGS requests.
        with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as executor:
            elevations = list(
                executor.map(lambda p: _fetch_elevation_ft(p["lat"], p["lon"]), points)
            )
        for p, elev in zip(points, elevations):
            if elev is not None:
                p["elevation_ft"] = round(elev, 2)
                valid += 1
        if valid == 0:
            error = "USGS EPQS returned no valid elevation samples for this grid."
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Terrain grid failed lat=%.6f lon=%.6f: %s", lat, lon, exc)
        error = str(exc)

    return {
        "source": EPQS_SOURCE,
        "checked_at": checked_at,
        "road_bearing_deg_used": road_bearing_deg,
        "road_bearing_source": None,  # endpoint fills this after resolving the source
        "grid": {
            "rows": rows,
            "columns": cols,
            "along_road_spacing_m": along_spacing_m,
            "cross_road_spacing_m": cross_spacing_m,
            "extent_along_m": round(along_spacing_m * (rows - 1), 1),
            "extent_cross_m": round(cross_spacing_m * (cols - 1), 1),
            "sample_count": rows * cols,
            "valid_sample_count": valid,
            "points": points,
        },
        "error": error,
    }
