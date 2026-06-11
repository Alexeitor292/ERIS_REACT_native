"""
USGS 3DEP Elevation Point Query Service (EPQS) integration.

Fetches point elevations along a road cross-section perpendicular to the road
bearing and classifies the terrain shape (LEFT_HIGH, RIGHT_HIGH, BOWL, CROWN,
FLAT, UNKNOWN).

Source: USGS 3DEP / The National Map — no API key required.
Endpoint: https://epqs.nationalmap.gov/v1/json

Cross-section offsets:
  Negative offset_m = left of the upstation (increasing postmile) direction.
  Positive offset_m = right of the upstation direction.

Without road_bearing_deg the bearing of the perpendicular is unknown, so only
the center point is sampled and classification is always UNKNOWN.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import datetime
from urllib.parse import urlencode
from urllib.request import urlopen

logger = logging.getLogger("eris.elevation")

EPQS_SOURCE = "USGS_EPQS_3DEP"
_EPQS_BASE = "https://epqs.nationalmap.gov/v1/json"
_TIMEOUT = 8.0
_RETRIES = 2

VALID_CLASSIFICATIONS = frozenset(
    {"LEFT_HIGH", "RIGHT_HIGH", "BOWL", "CROWN", "FLAT", "UNKNOWN"}
)

# Minimum elevation difference (feet) on each side to consider it "high" or "low".
_THRESHOLD_FT = 5.0
# Denominator for normalising confidence to [0, 1].
_CONFIDENCE_SCALE_FT = 30.0


# ---------------------------------------------------------------------------
# Point elevation fetch
# ---------------------------------------------------------------------------

def _fetch_elevation_ft(lat: float, lon: float) -> float | None:
    """
    Query USGS EPQS for a single point.  Returns elevation in feet, or None on any error.
    Retries up to _RETRIES times on network failures.
    """
    params = urlencode({
        "x": str(lon),
        "y": str(lat),
        "wkid": "4326",
        "units": "Feet",
        "includeDate": "False",
    })
    url = f"{_EPQS_BASE}?{params}"

    for attempt in range(1, _RETRIES + 1):
        try:
            with urlopen(url, timeout=_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", errors="ignore")
            data = json.loads(raw)
            value = data.get("value")
            if value is None:
                return None
            fv = float(value)
            # USGS returns -1000000 for ocean / no-data areas
            if fv < -9000:
                return None
            return fv
        except Exception as exc:
            if attempt == _RETRIES:
                logger.warning("EPQS fetch failed lat=%.6f lon=%.6f: %s", lat, lon, exc)
            # else retry silently

    return None


# ---------------------------------------------------------------------------
# Geodesic offset
# ---------------------------------------------------------------------------

def _offset_point(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    """
    Move a point by distance_m metres along bearing_deg (clockwise from north).
    Uses spherical Earth (accurate to < 0.01 % for distances ≤ 1 km).
    Returns (lat, lon).
    """
    R = 6_371_000.0
    b = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    d_over_R = distance_m / R

    lat2 = math.asin(
        math.sin(lat1) * math.cos(d_over_R)
        + math.cos(lat1) * math.sin(d_over_R) * math.cos(b)
    )
    lon2 = lon1 + math.atan2(
        math.sin(b) * math.sin(d_over_R) * math.cos(lat1),
        math.cos(d_over_R) - math.sin(lat1) * math.sin(lat2),
    )
    return (math.degrees(lat2), math.degrees(lon2))


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _classify(profile_points: list[dict]) -> tuple[str, float | None]:
    """
    Classify terrain shape from cross-section elevation points.
    left  = offset_m < -1
    right = offset_m > +1
    center = |offset_m| <= 1
    Returns (classification, confidence 0-1 or None).
    """
    left_elevs = [
        p["elevation_ft"] for p in profile_points
        if p.get("offset_m", 0) < -1 and p.get("elevation_ft") is not None
    ]
    right_elevs = [
        p["elevation_ft"] for p in profile_points
        if p.get("offset_m", 0) > 1 and p.get("elevation_ft") is not None
    ]
    center_elevs = [
        p["elevation_ft"] for p in profile_points
        if abs(p.get("offset_m", 0)) <= 1 and p.get("elevation_ft") is not None
    ]

    if not left_elevs or not right_elevs or not center_elevs:
        return ("UNKNOWN", None)

    center = sum(center_elevs) / len(center_elevs)
    left_diff = (sum(left_elevs) / len(left_elevs)) - center   # positive = left is higher
    right_diff = (sum(right_elevs) / len(right_elevs)) - center # positive = right is higher

    t = _THRESHOLD_FT
    if left_diff > t and right_diff > t:
        cls = "BOWL"
        conf = min(1.0, min(left_diff, right_diff) / _CONFIDENCE_SCALE_FT)
    elif left_diff < -t and right_diff < -t:
        cls = "CROWN"
        conf = min(1.0, min(abs(left_diff), abs(right_diff)) / _CONFIDENCE_SCALE_FT)
    elif left_diff > t and right_diff < -t:
        cls = "LEFT_HIGH"
        conf = min(1.0, (left_diff - right_diff) / (2 * _CONFIDENCE_SCALE_FT))
    elif right_diff > t and left_diff < -t:
        cls = "RIGHT_HIGH"
        conf = min(1.0, (right_diff - left_diff) / (2 * _CONFIDENCE_SCALE_FT))
    elif abs(left_diff) <= t and abs(right_diff) <= t:
        cls = "FLAT"
        conf = min(1.0, 1.0 - max(abs(left_diff), abs(right_diff)) / t)
    else:
        cls = "UNKNOWN"
        conf = None

    return (cls, round(conf, 4) if conf is not None else None)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def fetch_elevation_profile(
    lat: float,
    lon: float,
    road_bearing_deg: float | None = None,
    half_width_m: float = 60.0,
    spacing_m: float = 10.0,
) -> dict:
    """
    Sample a cross-section elevation profile centred on (lat, lon) and classify
    the terrain shape.

    road_bearing_deg — compass bearing (degrees, clockwise from north) of the
        upstation direction.  Left side = negative offsets (perpendicular bearing
        = road_bearing_deg + 270).  Right side = positive offsets.

    If road_bearing_deg is None, only the centre point is sampled and
    classification is always UNKNOWN (cannot determine left/right without
    a road bearing).

    Returns a dict with keys:
        source, checked_at, classification, confidence, profile, error
    """
    checked_at = datetime.utcnow().isoformat()
    profile_points: list[dict] = []
    error: str | None = None
    classification = "UNKNOWN"
    confidence: float | None = None

    try:
        if road_bearing_deg is not None:
            perp_right = (road_bearing_deg + 90.0) % 360.0
            perp_left = (road_bearing_deg + 270.0) % 360.0

            n_steps = max(1, int(half_width_m / max(1.0, spacing_m)))
            offsets = [i * spacing_m for i in range(-n_steps, n_steps + 1)]

            for offset_m in offsets:
                if abs(offset_m) < 1:
                    pt_lat, pt_lon = lat, lon
                else:
                    bearing = perp_right if offset_m > 0 else perp_left
                    pt_lat, pt_lon = _offset_point(lat, lon, bearing, abs(offset_m))

                elev = _fetch_elevation_ft(pt_lat, pt_lon)
                profile_points.append({
                    "offset_m": round(offset_m, 1),
                    "lat": round(pt_lat, 7),
                    "lon": round(pt_lon, 7),
                    "elevation_ft": round(elev, 2) if elev is not None else None,
                    "source": EPQS_SOURCE,
                })

            classification, confidence = _classify(profile_points)

        else:
            # No road bearing — centre point only; classification is UNKNOWN
            elev = _fetch_elevation_ft(lat, lon)
            profile_points.append({
                "offset_m": 0.0,
                "lat": round(lat, 7),
                "lon": round(lon, 7),
                "elevation_ft": round(elev, 2) if elev is not None else None,
                "source": EPQS_SOURCE,
            })

    except Exception as exc:
        logger.error("Elevation profile failed lat=%.6f lon=%.6f: %s", lat, lon, exc)
        error = str(exc)

    profile_meta: dict = {
        "road_bearing_deg_used": road_bearing_deg,
        "road_bearing_source": None,  # endpoint fills this in after resolving source
        "half_width_m": half_width_m,
        "spacing_m": spacing_m,
        "classification_requires_bearing": True,
    }
    if road_bearing_deg is None:
        profile_meta["classification_note"] = (
            "No road bearing was provided; only center elevation was sampled."
        )

    return {
        "source": EPQS_SOURCE,
        "checked_at": checked_at,
        "classification": classification,
        "confidence": confidence,
        "profile": {"points": profile_points, "metadata": profile_meta},
        "error": error,
    }
