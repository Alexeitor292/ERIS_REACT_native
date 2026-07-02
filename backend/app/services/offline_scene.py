"""
Offline 3D scene-package catalog + descriptor service.

Authoritative model (automatic generation — no manual ArcGIS Pro authoring):
  * USGS 3DEP is the offline elevation/terrain source.
  * When an authorized user requests it, ERIS AUTOMATICALLY generates a bounded
    `eristerrain` package (worker: fetch 3DEP -> build height grid + hillshade ->
    validate -> upload -> register). `.mspk` remains an optional future
    enterprise/ArcGIS path handled by the same catalog/download layer.
  * The package binary lives in a PRIVATE MinIO bucket (eris-offline-scenes) under
    an immutable key submissions/{submission_id}/{package_version}/scene.{ext}.
  * ERIS owns the authorization, catalog, lifecycle, and signed-download layer.

A submission is "available for offline 3D" ONLY when ERIS has a READY catalog row
AND the exact MinIO object still exists with the catalog's size + durable identity.
Availability is NEVER inferred from a configured base URL.

This module is pure (no DB, no MinIO, no settings import) so it unit-tests in the
no-DB job; the DB catalog rows and MinIO HEAD are supplied by the endpoint/worker
layer, and the authoritative configured maxima are INJECTED by those callers.
"""

from __future__ import annotations

import hashlib
import json
import math

ELEVATION_SOURCE_3DEP = "USGS_3DEP"

# Bounded-by-default download scope. Statewide is never the default.
DEFAULT_RADIUS_M = 1500.0
MIN_RADIUS_M = 250.0
# Absolute hard ceiling (~200 km^2). The CONFIGURED max (settings
# OFFLINE_SCENE_MAX_RADIUS_M) is the authoritative operational maximum and is
# itself capped by this so a misconfiguration can never go statewide/unbounded.
HARD_MAX_RADIUS_M = 8000.0
MAX_RADIUS_M = HARD_MAX_RADIUS_M  # back-compat alias (absolute ceiling)

# Rough size model used ONLY for operator sanity checks, never surfaced as if a
# package already exists (the UI shows the real catalog size_bytes instead).
_IMAGERY_MB_PER_KM2 = 6.5
_ELEVATION_MB_PER_KM2 = 1.8
_PACKAGE_OVERHEAD_MB = 4.0

_M_PER_DEG_LAT = 111_320.0


def effective_max_radius_m(max_radius_m: float | None = None) -> float:
    """The authoritative operational maximum, capped by the absolute hard ceiling.
    Callers pass settings.OFFLINE_SCENE_MAX_RADIUS_M; the module never imports
    settings (stays pure/testable). A misconfigured/oversized value is clamped to
    HARD_MAX_RADIUS_M so a package can never be statewide/unbounded."""
    if max_radius_m is None:
        return HARD_MAX_RADIUS_M
    try:
        m = float(max_radius_m)
    except (TypeError, ValueError):
        return HARD_MAX_RADIUS_M
    if not math.isfinite(m) or m <= 0:
        return HARD_MAX_RADIUS_M
    return max(MIN_RADIUS_M, min(HARD_MAX_RADIUS_M, m))


def clamp_radius_m(radius_m: float | None, max_radius_m: float | None = None) -> float:
    """Clamp a (possibly client-supplied) radius into [MIN_RADIUS_M, effective max].
    The SAME call is used at the generate endpoint, job creation, and worker
    execution, so all three enforce the one authoritative maximum — the worker
    never trusts a stored/client radius blindly."""
    hi = effective_max_radius_m(max_radius_m)
    if radius_m is None:
        return min(DEFAULT_RADIUS_M, hi)
    try:
        r = float(radius_m)
    except (TypeError, ValueError):
        return min(DEFAULT_RADIUS_M, hi)
    if not math.isfinite(r):
        return min(DEFAULT_RADIUS_M, hi)
    return max(MIN_RADIUS_M, min(hi, r))


def exceeds_size_limit(size_bytes: int | None, max_mb: int | float | None) -> bool:
    """True when a package exceeds the configured size policy. Used before catalog
    registration AND before minting a mobile download grant. A non-positive/invalid
    limit disables the check (returns False). Device memory is never the limit."""
    try:
        if max_mb is None:
            return False
        limit = float(max_mb) * 1024.0 * 1024.0
        if limit <= 0:
            return False
        return int(size_bytes or 0) > limit
    except (TypeError, ValueError):
        return False


def bounding_box(lat: float, lon: float, radius_m: float) -> dict:
    """Square-ish geographic bounds centered on (lat, lon) with a half-extent of
    radius_m. Local equirectangular approximation — fine for a few-km field area."""
    d_lat = radius_m / _M_PER_DEG_LAT
    cos_lat = math.cos(math.radians(lat)) or 1e-6
    d_lon = radius_m / (_M_PER_DEG_LAT * cos_lat)
    return {
        "min_lat": round(lat - d_lat, 6),
        "min_lon": round(lon - d_lon, 6),
        "max_lat": round(lat + d_lat, 6),
        "max_lon": round(lon + d_lon, 6),
    }


def area_km2(radius_m: float) -> float:
    side_km = (2.0 * radius_m) / 1000.0
    return side_km * side_km


def estimate_package_size_mb(radius_m: float) -> float:
    a = area_km2(radius_m)
    mb = a * (_IMAGERY_MB_PER_KM2 + _ELEVATION_MB_PER_KM2) + _PACKAGE_OVERHEAD_MB
    return round(mb, 1)


def content_signature(
    *,
    gisa_updated_at: str | None,
    geometry_json: object | None,
    road_bearing_deg: float | None,
    radius_m: float,
) -> str:
    """Stable short signature of the inputs that affect the packaged scene. Stored
    with a registered package; the mobile app re-downloads when the newest READY
    catalog package's signature differs from the one it downloaded."""
    payload = {
        "u": gisa_updated_at or "",
        "g": geometry_json if isinstance(geometry_json, (dict, list)) else None,
        "b": round(float(road_bearing_deg), 2) if road_bearing_deg is not None else None,
        "r": round(float(radius_m), 1),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# ---- defensive parsing of stored GISA metadata -----------------------------
# Stored geometry / road-inventory snapshot / terrain grid JSON may be malformed,
# a JSON string, or the wrong shape. These helpers NEVER raise and NEVER call
# .get()/index into a value before confirming its type, so a bad row degrades to
# "no overlay" instead of crashing the worker.

def coerce_json_obj(raw):
    """Return raw as a dict/list (parsing a JSON string if needed), else None."""
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
        except Exception:
            return None
        return v if isinstance(v, (dict, list)) else None
    return None


def _finite_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse_geometry(raw):
    """Uploaded incident geometry as a dict/list (GeoJSON or Esri JSON), else None."""
    return coerce_json_obj(raw)


def extract_road_bearing(snapshot) -> float | None:
    """Road bearing (deg) from a road-inventory snapshot, or None. Defensive."""
    snap = coerce_json_obj(snapshot)
    if not isinstance(snap, dict):
        return None
    val = snap.get("road_bearing_deg")
    if not _finite_number(val):
        return None
    return float(val)


def extract_sample_extent(terrain) -> dict | None:
    """Bounding box {minLat,minLon,maxLat,maxLon} of the USGS grid points, or None.
    Every level is type-checked before .get()/indexing so malformed stored terrain
    JSON (grid not a dict, points not a list, point not a dict) never raises."""
    t = coerce_json_obj(terrain)
    if not isinstance(t, dict):
        return None
    grid = t.get("grid")
    if not isinstance(grid, dict):
        return None
    pts = grid.get("points")
    if not isinstance(pts, list) or not pts:
        return None
    lats: list[float] = []
    lons: list[float] = []
    for p in pts:
        if not isinstance(p, dict):
            continue
        la, lo = p.get("lat"), p.get("lon")
        if _finite_number(la) and _finite_number(lo):
            lats.append(float(la))
            lons.append(float(lo))
    if not lats or not lons:
        return None
    return {"minLat": min(lats), "minLon": min(lons), "maxLat": max(lats), "maxLon": max(lons)}


PACKAGE_FORMAT_EXT = {"eristerrain": "scene.eristerrain", "mspk": "scene.mspk"}


def make_scene_object_key(submission_id: int, package_version: str, package_format: str = "eristerrain") -> str:
    """Immutable, versioned object key. Never reused/overwritten."""
    safe_ver = "".join(c for c in str(package_version) if c.isalnum() or c in "-_.")
    filename = PACKAGE_FORMAT_EXT.get(package_format, "scene.eristerrain")
    return f"submissions/{int(submission_id)}/{safe_ver}/{filename}"


def validate_bounds(min_lat, min_lon, max_lat, max_lon) -> bool:
    try:
        a, b, c, d = float(min_lat), float(min_lon), float(max_lat), float(max_lon)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(v) for v in (a, b, c, d)):
        return False
    if not (-90 <= a <= 90 and -90 <= c <= 90 and -180 <= b <= 180 and -180 <= d <= 180):
        return False
    return a < c and b < d


def unavailable(submission_id: int, reason: str) -> dict:
    return {
        "submission_id": submission_id,
        "available": False,
        "reason": reason,
        "area": None,
        "package": None,
        "content_signature": None,
    }


def descriptor_from_catalog(
    *,
    submission_id: int,
    catalog: dict | None,
    object_present: bool,
    download_path: str | None,
) -> dict:
    """Build the descriptor from the newest READY catalog row.

    available is True ONLY when a READY catalog row exists AND its MinIO object is
    present (object_present). Otherwise available is False with a precise reason.
    All values come from the catalog row — never from a base-URL string.
    """
    if catalog is None:
        return unavailable(submission_id, "No offline 3D package has been prepared for this incident yet.")

    if not object_present:
        return unavailable(
            submission_id,
            "The prepared offline package is missing from secure storage; an operator must re-upload/re-register it.",
        )

    return {
        "submission_id": submission_id,
        "available": True,
        "reason": None,
        "area": {
            "center": {
                "lat": _f(catalog.get("center_lat")),
                "lon": _f(catalog.get("center_lon")),
            },
            "radius_m": _f(catalog.get("radius_m")),
            "bounds": {
                "min_lat": _f(catalog.get("min_lat")),
                "min_lon": _f(catalog.get("min_lon")),
                "max_lat": _f(catalog.get("max_lat")),
                "max_lon": _f(catalog.get("max_lon")),
            },
        },
        "package": {
            "format": catalog.get("package_format") or "eristerrain",
            "version": catalog.get("package_version"),
            "size_bytes": int(catalog.get("size_bytes") or 0),
            "sha256": catalog.get("sha256"),
            "elevation_source": catalog.get("elevation_source") or ELEVATION_SOURCE_3DEP,
            "elevation": {
                "dataset": catalog.get("elevation_dataset"),
                "version": catalog.get("elevation_version"),
                "resolution": catalog.get("elevation_resolution"),
            },
            "basemap_or_imagery_source": catalog.get("basemap_or_imagery_source"),
            "created_at": _s(catalog.get("created_at")),
            "uploaded_at": _s(catalog.get("uploaded_at")),
            # Protected, role-checked download (short-lived presigned URL minted by
            # the download endpoint). Mobile never receives MinIO credentials.
            "download_path": download_path,
        },
        "content_signature": catalog.get("content_signature"),
    }


def _f(v) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _s(v) -> str | None:
    return None if v is None else str(v)
