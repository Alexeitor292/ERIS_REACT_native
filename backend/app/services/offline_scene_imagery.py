"""
High-definition TILED offline aerial imagery: pure tile PLANNING, bounded RETRY
scheduling, and image-response validation.

Everything here is pure (no network, no settings import, no DB) so it unit-tests
under the no-DB job. The worker's network fetch lives in offline_scene_context
(fetch_imagery_tile); this module decides WHAT to fetch (the tile grid) and HOW to
retry, and validates that a response is a real image.

Design goals:
  * Split the AOI into a grid of JPEG tiles so each upstream export stays well below
    the source ImageServer max width/height and a conservative request size — total
    packaged detail can far exceed a single 4000px export.
  * Never over-request beyond source-native useful detail (clamp target m/px to the
    operator-declared source-native GSD).
  * Exact, gap-free, overlap-free tile bounds (adjacent tiles share the identical
    edge value, computed from a single edges array).
  * A conservative tile-count budget: fail with a precise operator-visible reason
    BEFORE uncontrolled package growth.
"""

from __future__ import annotations

import math

_M_PER_DEG_LAT = 111_320.0

# JPEG (SOI FF D8 FF) and PNG magic — used to reject JSON/HTML/service-error bodies.
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

IMAGERY_TILE_DIR = "imagery"


class ImageryPlanError(Exception):
    """The tile plan is impossible/over-budget — surfaced to the operator verbatim
    (precise, no secrets) so a package never grows uncontrollably."""


class ImageryDeadlineError(Exception):
    """The overall imagery worker deadline was exhausted before a tile succeeded."""


def _finite_pos(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def resolve_target_mpp(target_cfg, source_native_mpp) -> float:
    """Resolve the configured target metres/pixel.

    A bare number (or numeric string like "0.6") forces that GSD. The sentinel
    "source_native..." uses the operator-declared source-native GSD (or 0.6 when
    that is unknown/<=0). The result is clamped so it is NEVER finer than the
    source-native GSD — we do not over-request beyond useful source detail.
    """
    native = float(source_native_mpp) if _finite_pos(source_native_mpp) else 0.0
    forced: float | None = None
    if isinstance(target_cfg, (int, float)) and not isinstance(target_cfg, bool):
        forced = float(target_cfg)
    elif isinstance(target_cfg, str):
        s = target_cfg.strip().lower()
        if s.startswith("source_native"):
            forced = None  # use native (below)
        else:
            try:
                forced = float(s)
            except ValueError:
                forced = None
    if forced is not None and _finite_pos(forced):
        target = forced
    else:
        target = native if native > 0 else 0.6
    # Never request finer than the source can actually provide.
    if native > 0:
        target = max(target, native)
    return round(target, 4)


def footprint_meters(bounds: dict) -> tuple[float, float]:
    """(widthM, heightM) of geographic bounds (cos-lat adjusted). Raises on bad."""
    for k in ("min_lat", "min_lon", "max_lat", "max_lon"):
        if not (isinstance(bounds.get(k), (int, float)) and math.isfinite(bounds[k])):
            raise ImageryPlanError(f"invalid bounds ({k})")
    min_lat, min_lon = float(bounds["min_lat"]), float(bounds["min_lon"])
    max_lat, max_lon = float(bounds["max_lat"]), float(bounds["max_lon"])
    if not (max_lat > min_lat and max_lon > min_lon):
        raise ImageryPlanError("degenerate bounds (min >= max)")
    mid_lat = (min_lat + max_lat) / 2.0
    cos_lat = math.cos(math.radians(mid_lat)) or 1e-6
    width_m = (max_lon - min_lon) * _M_PER_DEG_LAT * abs(cos_lat)
    height_m = (max_lat - min_lat) * _M_PER_DEG_LAT
    return width_m, height_m


def _edges(lo: float, hi: float, n: int) -> list[float]:
    """n+1 evenly-spaced edge values from lo..hi, endpoints forced EXACT. Adjacent
    cells share the identical interior edge value (no gaps/overlaps, no float drift)."""
    out = [lo + (hi - lo) * (i / n) for i in range(n + 1)]
    out[0] = lo
    out[n] = hi
    return out


def plan_imagery_tiles(
    bounds: dict,
    *,
    tile_px: int,
    target_mpp: float,
    source_native_mpp: float | None = None,
    max_export_px: int = 4096,
    max_tiles: int = 64,
    file_ext: str = "jpg",
) -> dict:
    """Plan the tile grid for `bounds`.

    Returns a plan dict (format "tiled") with columns/rows, the resolved target and
    achieved effective m/px, and a `tiles` list of {row, column, file, bounds}. Each
    tile is exported square at tile_px (<= max_export_px, so an upstream request never
    approaches the service maximum). Raises ImageryPlanError on impossible/over-budget
    plans (precise reason, no secrets).
    """
    tp = int(tile_px)
    if tp < 256 or tp > int(max_export_px):
        raise ImageryPlanError(
            f"tile_px {tp} must be within [256, max_export_px={int(max_export_px)}]"
        )
    if not _finite_pos(target_mpp):
        raise ImageryPlanError("invalid target metres-per-pixel")

    width_m, height_m = footprint_meters(bounds)
    # Never plan finer than source-native useful detail.
    planned_mpp = float(target_mpp)
    if _finite_pos(source_native_mpp):
        planned_mpp = max(planned_mpp, float(source_native_mpp))

    width_px = width_m / planned_mpp
    height_px = height_m / planned_mpp
    columns = max(1, math.ceil(width_px / tp))
    rows = max(1, math.ceil(height_px / tp))
    total = columns * rows
    if total > int(max_tiles):
        raise ImageryPlanError(
            f"imagery tile plan needs {total} tiles ({columns}x{rows}) at "
            f"{planned_mpp:.2f} m/px, exceeding the max of {int(max_tiles)}. "
            f"Reduce the area, raise the target m/px, or raise OFFLINE_SCENE_IMAGERY_MAX_TILES."
        )

    lon_edges = _edges(float(bounds["min_lon"]), float(bounds["max_lon"]), columns)
    lat_edges = _edges(float(bounds["max_lat"]), float(bounds["min_lat"]), rows)  # north -> south

    tiles: list[dict] = []
    for r in range(rows):
        for c in range(columns):
            tiles.append({
                "row": r,
                "column": c,
                "file": f"{IMAGERY_TILE_DIR}/{r}/{c}.{file_ext}",
                "bounds": {
                    "min_lon": lon_edges[c],
                    "max_lon": lon_edges[c + 1],
                    "max_lat": lat_edges[r],
                    "min_lat": lat_edges[r + 1],
                },
            })

    # Effective (achieved) m/px given integer tiling: coarser (larger) of the two axes.
    eff = max(width_m / (columns * tp), height_m / (rows * tp))
    return {
        "format": "tiled",
        "tile_size_px": tp,
        "columns": columns,
        "rows": rows,
        "target_meters_per_pixel": round(planned_mpp, 3),
        "effective_meters_per_pixel": round(eff, 3),
        "bounds": {
            "min_lat": float(bounds["min_lat"]),
            "min_lon": float(bounds["min_lon"]),
            "max_lat": float(bounds["max_lat"]),
            "max_lon": float(bounds["max_lon"]),
        },
        "tiles": tiles,
    }


def assert_no_gaps_or_overlaps(plan: dict, *, eps: float = 1e-9) -> None:
    """Structural self-check: tiles tile the AOI exactly (shared edges, full cover,
    no overlap). Raises ImageryPlanError on any violation. Cheap — run before packaging."""
    cols, rows = int(plan["columns"]), int(plan["rows"])
    by_rc = {(t["row"], t["column"]): t["bounds"] for t in plan["tiles"]}
    if len(by_rc) != cols * rows:
        raise ImageryPlanError("tile plan has missing/duplicate (row,column) cells")
    aoi = plan["bounds"]
    for r in range(rows):
        for c in range(cols):
            b = by_rc[(r, c)]
            if b["min_lon"] >= b["max_lon"] or b["min_lat"] >= b["max_lat"]:
                raise ImageryPlanError(f"degenerate tile ({r},{c})")
            if c + 1 < cols and abs(b["max_lon"] - by_rc[(r, c + 1)]["min_lon"]) > eps:
                raise ImageryPlanError(f"gap/overlap between columns at ({r},{c})")
            if r + 1 < rows and abs(b["min_lat"] - by_rc[(r + 1, c)]["max_lat"]) > eps:
                raise ImageryPlanError(f"gap/overlap between rows at ({r},{c})")
    nw, se = by_rc[(0, 0)], by_rc[(rows - 1, cols - 1)]
    if (abs(nw["min_lon"] - aoi["min_lon"]) > eps or abs(nw["max_lat"] - aoi["max_lat"]) > eps
            or abs(se["max_lon"] - aoi["max_lon"]) > eps or abs(se["min_lat"] - aoi["min_lat"]) > eps):
        raise ImageryPlanError("tile plan does not exactly cover the AOI bounds")


# ---- image-response validation ---------------------------------------------

def is_jpeg(data: bytes | None) -> bool:
    return bool(data) and data[:3] == _JPEG_MAGIC


def is_png(data: bytes | None) -> bool:
    return bool(data) and data[:8] == _PNG_MAGIC


def is_supported_image(data: bytes | None) -> bool:
    return is_jpeg(data) or is_png(data)


# ---- bounded retry with exponential backoff + jitter -----------------------

def backoff_delay(attempt: int, *, base_delay_s: float, max_delay_s: float) -> float:
    """Exponential backoff for a 0-based attempt index (no jitter): base * 2^attempt,
    capped at max_delay_s. Deterministic — jitter is added separately/injectably."""
    return min(float(max_delay_s), float(base_delay_s) * (2 ** max(0, int(attempt))))


def run_with_retries(
    fn,
    *,
    retries: int,
    base_delay_s: float = 1.0,
    max_delay_s: float = 30.0,
    deadline_s: float | None = None,
    sleep=None,
    monotonic=None,
    jitter=None,
    is_retryable=None,
):
    """Call fn(attempt) with bounded retries + exponential backoff + jitter.

    Total attempts = retries + 1. A single transient failure (timeout/5xx) does NOT
    fail the whole thing; only exhausted retries (or the overall deadline) raise —
    the last exception, so the caller can attach exact tile coordinates + a sanitized
    upstream reason. `sleep`/`monotonic`/`jitter` are injectable for deterministic
    tests (no real sleeping). `is_retryable(exc)` (default: everything) decides whether
    a failure is transient.
    """
    import time

    _sleep = sleep or time.sleep
    _mono = monotonic or time.monotonic
    _jitter = jitter if jitter is not None else (lambda attempt: 0.0)
    start = _mono()
    attempt = 0
    last_exc: Exception | None = None
    while True:
        if deadline_s is not None and (_mono() - start) > float(deadline_s):
            raise ImageryDeadlineError(
                f"imagery worker deadline ({deadline_s}s) exhausted after {attempt} attempt(s)"
            ) from last_exc
        try:
            return fn(attempt)
        except Exception as e:  # noqa: BLE001 - retry policy decides terminal vs transient
            last_exc = e
            if is_retryable is not None and not is_retryable(e):
                raise
            if attempt >= int(retries):
                raise
            delay = backoff_delay(attempt, base_delay_s=base_delay_s, max_delay_s=max_delay_s) + float(_jitter(attempt))
            if deadline_s is not None and (_mono() - start) + delay > float(deadline_s):
                raise ImageryDeadlineError(
                    f"imagery worker deadline ({deadline_s}s) would be exceeded before retry"
                ) from e
            _sleep(delay)
            attempt += 1


def sanitize_reason(exc: Exception, *, limit: int = 160) -> str:
    """A short, secrets-free description of an upstream failure for the job's
    error_details. Strips URL query strings (tokens) and truncates."""
    import re

    msg = str(exc) or exc.__class__.__name__
    msg = re.sub(r"([?&])[^\s]*", r"\1<redacted>", msg)  # drop query strings/tokens
    msg = msg.replace("\n", " ").strip()
    return msg[:limit]
