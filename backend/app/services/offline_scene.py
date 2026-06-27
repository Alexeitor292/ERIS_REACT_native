"""
Offline 3D scene-package descriptor service.

ERIS does NOT stream Esri World Imagery/Elevation to the field offline (that is
neither licensed for redistribution nor available without a network). Instead the
mobile native 3D terrain viewer opens a *bounded, locally stored* offline scene
package (Esri Mobile Scene Package, .mspk) for a single incident area.

This module computes the bounded area descriptor the mobile app needs BEFORE it
downloads: the area bounds (from an incident radius), an estimated package size,
a content signature (for refresh detection), and the download URL when a package
host/generator is configured. Actually GENERATING the .mspk is server/enterprise
infrastructure (ArcGIS Pro / Enterprise offline packaging) — see the ADR; when no
host is configured this returns available=False with a clear reason rather than
pretending an offline package exists.

All functions here are pure (no DB, no network) so they unit-test in the no-DB job.
"""

from __future__ import annotations

import hashlib
import json
import math

# Bounded-by-default download scope. Statewide is never the default.
DEFAULT_RADIUS_M = 1500.0
MIN_RADIUS_M = 250.0
MAX_RADIUS_M = 8000.0  # ~200 km^2 ceiling keeps a field download sane

# Rough size model for a draped imagery + elevation scene package, per km^2.
# These are ESTIMATES surfaced to the user before download, not guarantees.
_IMAGERY_MB_PER_KM2 = 6.5
_ELEVATION_MB_PER_KM2 = 1.8
_PACKAGE_OVERHEAD_MB = 4.0

_M_PER_DEG_LAT = 111_320.0


def clamp_radius_m(radius_m: float | None) -> float:
    if radius_m is None:
        return DEFAULT_RADIUS_M
    try:
        r = float(radius_m)
    except (TypeError, ValueError):
        return DEFAULT_RADIUS_M
    if not math.isfinite(r):
        return DEFAULT_RADIUS_M
    return max(MIN_RADIUS_M, min(MAX_RADIUS_M, r))


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
    """Area of the (2*radius_m) square bounding box, in km^2."""
    side_km = (2.0 * radius_m) / 1000.0
    return side_km * side_km


def estimate_package_size_mb(radius_m: float) -> float:
    """Estimated offline scene-package size (imagery + elevation + overhead)."""
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
    """Stable short signature of the inputs that affect the packaged scene. The
    mobile app stores this with a downloaded package and re-downloads when the
    server signature changes (incident geometry/bearing/area moved)."""
    payload = {
        "u": gisa_updated_at or "",
        "g": geometry_json if isinstance(geometry_json, (dict, list)) else None,
        "b": round(float(road_bearing_deg), 2) if road_bearing_deg is not None else None,
        "r": round(float(radius_m), 1),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def build_scene_area_descriptor(
    *,
    submission_id: int,
    lat: float | None,
    lon: float | None,
    radius_m: float | None,
    gisa_updated_at: str | None,
    geometry_json: object | None,
    road_bearing_deg: float | None,
    package_base_url: str | None,
) -> dict:
    """Assemble the bounded offline scene-package descriptor for a submission.

    available=False (with a reason) when there are no coordinates or no package
    host is configured — the app then shows an honest "offline-unavailable" state
    instead of a broken download.
    """
    if lat is None or lon is None:
        return {
            "submission_id": submission_id,
            "available": False,
            "reason": "Incident has no coordinates; cannot bound an offline area.",
            "area": None,
            "package": None,
            "content_signature": None,
        }

    r = clamp_radius_m(radius_m)
    bounds = bounding_box(float(lat), float(lon), r)
    sig = content_signature(
        gisa_updated_at=gisa_updated_at,
        geometry_json=geometry_json,
        road_bearing_deg=road_bearing_deg,
        radius_m=r,
    )
    size_mb = estimate_package_size_mb(r)

    base = (package_base_url or "").rstrip("/")
    available = bool(base)
    download_url = f"{base}/submissions/{submission_id}/scene.mspk?sig={sig}" if available else None
    reason = None if available else (
        "No offline scene-package host is configured (ARCGIS_SCENE_PACKAGE_BASE_URL). "
        "A Caltrans/enterprise-hosted or pre-generated .mspk for this area is required."
    )

    return {
        "submission_id": submission_id,
        "available": available,
        "reason": reason,
        "area": {
            "center": {"lat": round(float(lat), 6), "lon": round(float(lon), 6)},
            "radius_m": r,
            "bounds": bounds,
        },
        "package": {
            "format": "mspk",
            "version": sig,
            "estimated_size_mb": size_mb,
            "download_url": download_url,
            "source": "configured_scene_package_host" if available else None,
        },
        "content_signature": sig,
    }
