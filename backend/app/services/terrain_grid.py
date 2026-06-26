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
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import datetime

from .elevation_profile import EPQS_SOURCE, _fetch_elevation_ft, _offset_point

logger = logging.getLogger("eris.terrain")


class TerrainBuildBusyError(RuntimeError):
    """Raised when another terrain-grid build is already in progress process-wide.

    The endpoint maps this to HTTP 503 so a (forced) rebuild fails fast instead of
    queuing behind an in-flight build for up to the whole time budget."""

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
# Overall wall-clock budget for one grid build. A USGS EPQS outage must not leave
# the request hanging for minutes — when the budget is hit we stop waiting and
# return whatever valid points we have (partial terrain), never fabricating data.
TOTAL_BUILD_BUDGET_S = 25.0

# Process-wide guard. Each build already caps USGS EPQS at _MAX_WORKERS concurrent
# requests, but several simultaneous (forced) rebuilds would multiply that. A
# binary semaphore lets only ONE build run at a time across the whole backend, so
# total live EPQS requests never exceed the per-build _MAX_WORKERS maximum. It is
# acquired non-blocking: a second concurrent build fails fast (TerrainBuildBusyError
# -> HTTP 503) rather than waiting up to TOTAL_BUILD_BUDGET_S behind the first.
_BUILD_SEMAPHORE = threading.BoundedSemaphore(1)


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


def _drain_and_release(executor: ThreadPoolExecutor, lat: float, lon: float) -> None:
    """Background cleanup for a timed-out build.

    Waits for the up-to-_MAX_WORKERS in-flight EPQS calls to actually finish
    (queued futures were already cancelled), then releases the process-wide
    guard. Holding the guard until the executor fully drains keeps total live
    EPQS requests at or below _MAX_WORKERS even though the partial response was
    already returned at the time budget."""
    try:
        executor.shutdown(wait=True)
    except Exception:  # pragma: no cover - defensive
        logger.exception(
            "Terrain grid background cleanup failed lat=%.6f lon=%.6f", lat, lon
        )
    finally:
        _BUILD_SEMAPHORE.release()


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

    rows/cols must be ODD so the incident location is an actual center sample;
    even values raise ValueError. Dimensions are clamped to [MIN_DIM, MAX_DIM]
    and spacing to [MIN_SPACING_M, MAX_SPACING_M].

    Returns a dict with: source, checked_at, road_bearing_deg_used,
    road_bearing_source (None — the endpoint fills this in), grid{...}, error.
    """
    if int(rows) % 2 == 0 or int(cols) % 2 == 0:
        raise ValueError(
            "Terrain grid rows and columns must be odd so the incident location is a center sample"
        )
    # Clamping odd values to the odd bounds [3, 15] preserves oddness.
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
    timed_out = False
    sample_count = rows * cols

    # Acquire the process-wide build guard BEFORE submitting any USGS work. Fail
    # fast if another build holds it (or a previous build's workers are still
    # draining) — do not wait behind it.
    if not _BUILD_SEMAPHORE.acquire(blocking=False):
        raise TerrainBuildBusyError(
            "Terrain sampling is already in progress. Please try again shortly."
        )

    # The guard is normally released synchronously below. On a time-budget timeout
    # we instead hand it to a background cleanup thread so it stays held until the
    # up-to-_MAX_WORKERS in-flight EPQS calls actually finish — otherwise a new
    # build could start six more calls while these are still alive, exceeding the
    # ceiling on total live EPQS requests.
    deferred_cleanup = False
    executor = ThreadPoolExecutor(max_workers=_MAX_WORKERS)
    try:
        # Bounded concurrency + an overall time budget. We submit all points, then
        # collect results until either everything is done or the budget elapses; on
        # timeout we stop waiting and keep the partial (real) data we already have.
        future_to_idx = {
            executor.submit(_fetch_elevation_ft, p["lat"], p["lon"]): i
            for i, p in enumerate(points)
        }
        try:
            for fut in as_completed(future_to_idx, timeout=TOTAL_BUILD_BUDGET_S):
                idx = future_to_idx[fut]
                try:
                    elev = fut.result()
                except Exception:
                    elev = None
                if elev is not None:
                    points[idx]["elevation_ft"] = round(elev, 2)
                    valid += 1
        except FuturesTimeoutError:
            timed_out = True
            logger.warning(
                "Terrain grid time budget (%.0fs) exceeded lat=%.6f lon=%.6f; returning %d/%d points",
                TOTAL_BUILD_BUDGET_S, lat, lon, valid, sample_count,
            )
            # Cancel queued (not-yet-started) work so only the in-flight EPQS
            # calls remain alive, then drain + release the guard in the
            # background. The partial response returns now; the guard stays held
            # (new uncached builds get a fast 503) until those in-flight calls
            # finish, so total live EPQS requests never exceed _MAX_WORKERS.
            for f in future_to_idx:
                f.cancel()
            threading.Thread(
                target=_drain_and_release,
                args=(executor, lat, lon),
                name="terrain-grid-cleanup",
                daemon=True,
            ).start()
            deferred_cleanup = True
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Terrain grid failed lat=%.6f lon=%.6f: %s", lat, lon, exc)
        error = str(exc)
    finally:
        if not deferred_cleanup:
            # Synchronous path: every future is finished (or failed). Shut the
            # executor down and release the guard immediately.
            executor.shutdown(wait=False, cancel_futures=True)
            _BUILD_SEMAPHORE.release()

    # Partial terrain = some-but-not-all samples resolved, regardless of cause
    # (time-budget timeout OR ordinary USGS no-data/null samples).
    partial = 0 < valid < sample_count
    if error is None:
        if valid == 0:
            error = (
                "USGS EPQS did not return any valid elevation samples"
                + (" within the time budget." if timed_out else " for this grid.")
            )
        elif partial:
            # Always report partial coverage (the UI shows an amber notice) and
            # never fabricate the missing cells.
            if timed_out:
                error = (
                    f"USGS EPQS was slow or unavailable; built partial terrain "
                    f"({valid} of {sample_count} samples within the time budget). "
                    f"Missing cells are left blank, not interpolated."
                )
            else:
                error = (
                    f"USGS EPQS returned no data for some points; built partial "
                    f"terrain ({valid} of {sample_count} samples). "
                    f"Missing cells are left blank, not interpolated."
                )

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
            "sample_count": sample_count,
            "valid_sample_count": valid,
            "partial": partial,
            "points": points,
        },
        "error": error,
    }
