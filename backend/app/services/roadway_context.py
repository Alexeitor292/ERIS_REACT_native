"""Road geometry for measuring how far a slide encroaches on the roadway.

Two parts, joined in the browser (web/src/features/submissions/roadwayModel.ts):
- the cross-section at the site: lanes, traveled way, shoulders and median, from the
  published road inventory (the Caltrans TSN highway extract). Left and right are as
  the extract records them, relative to the direction of increasing postmile;
- the centerline near the site, from the configured line source
  (ROADWAY_CENTERLINE_SOURCE).

Widths are in feet, as the inventory records them.
"""
from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from .offline_scene_context import fetch_arcgis_line_layer, fetch_tigerweb_road_features
from .road_inventory_lookup import get_published_version_id
from .road_inventory_parser import normalize_route

CENTERLINE_SOURCES = ("caltrans_shn", "census_tigerweb", "caltrans_crs")
CENTERLINE_PROVENANCE = {
    "caltrans_shn": "Caltrans State Highway Network lines (SHN Lines, linear referencing system)",
    "census_tigerweb": "U.S. Census Bureau TIGERweb roads",
    "caltrans_crs": "Caltrans CRS Functional Classification (All Roads LRS)",
}

# Inventory columns kept in raw_json (the named road_segments columns hold the rest).
_TRAVELED_WAY = {"left": "THY_LT_TRAV_WAY_WIDTH_AMT", "right": "THY_RT_TRAV_WAY_WIDTH_AMT"}
_INSIDE_SHOULDER = {"left": "THY_LT_I_SHD_TOT_WIDTH_AMT", "right": "THY_RT_I_SHD_TOT_WIDTH_AMT"}
_HIGHWAY_GROUP = "THY_HIGHWAY_GROUP_CODE"

_SHN_PROPS = ("Route", "RteSuffix", "County", "AlignCode", "Direction", "PMPrefix", "bPM", "ePM")


def _width(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _count(value: Any) -> int | None:
    number = _width(value)
    return int(number) if number is not None else None


def cross_section(db: Session, *, county_code: str, route: str, postmile: float, district_code: str | None = None) -> dict | None:
    """The inventory cross-section covering county + route + postmile, or None."""
    version_id = get_published_version_id(db)
    route_norm = normalize_route(route)
    if version_id is None or not route_norm:
        return None
    row = db.execute(text("""
        SELECT district_code, county_code, route_name, pm_prefix_code, begin_pm, end_pm,
               left_lanes, right_lanes, left_shoulder_width, right_shoulder_width,
               median_type, median_width, extract_date, raw_json
        FROM road_segments
        WHERE dataset_version_id = :version_id
          AND county_code = :county_code
          AND route_name = :route_norm
          AND begin_pm <= :pm AND end_pm >= :pm
        ORDER BY
            CASE WHEN :district_code IS NOT NULL AND district_code = :district_code THEN 0 ELSE 1 END,
            (end_pm - begin_pm) ASC
        LIMIT 1
    """), {
        "version_id": version_id,
        "county_code": county_code.strip().upper(),
        "route_norm": route_norm,
        "pm": postmile,
        "district_code": district_code,
    }).mappings().first()
    if not row:
        return None
    try:
        raw = json.loads(row["raw_json"] or "{}")
    except (TypeError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    def side(name: str) -> dict:
        return {
            "lanes": _count(row[f"{name}_lanes"]),
            "traveled_way_ft": _width(raw.get(_TRAVELED_WAY[name])),
            "outside_shoulder_ft": _width(row[f"{name}_shoulder_width"]),
            "inside_shoulder_ft": _width(raw.get(_INSIDE_SHOULDER[name])),
        }

    group = raw.get(_HIGHWAY_GROUP)
    return {
        "route": row["route_name"],
        "county": row["county_code"],
        "district": row["district_code"],
        "pm_prefix": row["pm_prefix_code"],
        "begin_pm": float(row["begin_pm"]),
        "end_pm": float(row["end_pm"]),
        "extract_date": row["extract_date"].isoformat() if row["extract_date"] else None,
        "highway_group": str(group).strip() if group not in (None, "") else None,
        "median_type": row["median_type"],
        "median_width_ft": _width(row["median_width"]),
        "left": side("left"),
        "right": side("right"),
    }


def _route_number(route: str) -> int | None:
    match = re.search(r"\d+", route or "")
    return int(match.group()) if match else None


def _clip(coords: list, bounds: dict) -> list[list]:
    """Runs of a line inside the bounds, each with one vertex beyond on either side."""
    inside = [
        bounds["min_lon"] <= c[0] <= bounds["max_lon"] and bounds["min_lat"] <= c[1] <= bounds["max_lat"]
        for c in coords
    ]
    runs, start = [], None
    for i, flag in enumerate(inside + [False]):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            lo, hi = max(0, start - 1), min(len(coords) - 1, i)
            run = [[float(c[0]), float(c[1])] for c in coords[lo:hi + 1]]
            if len(run) >= 2:
                runs.append(run)
            start = None
    return runs


def _lines(features: list, bounds: dict, keep) -> list[dict]:
    out = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        parts = [geometry.get("coordinates")] if geometry.get("type") == "LineString" else geometry.get("coordinates") or []
        props = feature.get("properties") or {}
        if not keep(props):
            continue
        for part in parts:
            for run in _clip(part or [], bounds):
                out.append({
                    "coordinates": run,
                    "align": props.get("AlignCode"),
                    "direction": props.get("Direction"),
                    "begin_pm": props.get("bPM"),
                    "end_pm": props.get("ePM"),
                    "name": props.get("NAME") or (f"Route {props['Route']}" if props.get("Route") else None),
                })
    return out


def centerlines(bounds: dict, *, route: str, county_code: str | None, session=None) -> dict:
    """The state highway's centerline within `bounds` from the configured source."""
    source = settings.ROADWAY_CENTERLINE_SOURCE
    timeout = settings.ROADWAY_FETCH_TIMEOUT_S
    number = _route_number(route)
    if source == "caltrans_shn":
        features = fetch_arcgis_line_layer(
            settings.ROADWAY_SHN_LINES_URL, bounds, timeout_s=timeout, session=session,
            out_fields=",".join(_SHN_PROPS), keep_props=_SHN_PROPS,
        )

        def keep(props):
            same_route = number is None or props.get("Route") == number
            same_county = not county_code or str(props.get("County", "")).upper() == county_code.upper()
            return same_route and same_county
    elif source == "census_tigerweb":
        features = fetch_tigerweb_road_features(
            bounds, base_url=settings.OFFLINE_SCENE_TIGERWEB_BASE_URL, layers="2,6", timeout_s=timeout, session=session,
        )
        names = {f"State Rte {number}", f"US Hwy {number}", f"I- {number}", f"Interstate {number}"} if number else set()
        named = [f for f in features if any(n.lower() in str((f.get("properties") or {}).get("NAME", "")).lower() for n in names)]
        features = named or features

        def keep(props):
            return True
    elif source == "caltrans_crs":
        where = f"RouteID LIKE 'SHS_{number:03d}%'" if number else "RouteID LIKE 'SHS_%'"
        features = fetch_arcgis_line_layer(
            settings.OFFLINE_SCENE_CALTRANS_ROADS_URL, bounds, timeout_s=timeout, session=session, where=where,
        )

        def keep(props):
            return True
    else:  # validated at startup; kept for safety
        raise RuntimeError(f"unknown centerline source {source!r}")
    return {"source": source, "provenance": CENTERLINE_PROVENANCE[source], "lines": _lines(features, bounds, keep)}
