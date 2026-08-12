"""Caltrans SHN postmile reference downloader for offline mobile packages.

This module intentionally runs server-side only. It snapshots the public Caltrans
SHN Postmiles Tenth feature layer into the existing authenticated, hashed ERIS
road-inventory package so mobile devices can resolve coordinates <-> postmiles in
Airplane Mode after a normal Road Inventory sync.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import settings

DEFAULT_POSTMILE_LAYER_URL = (
    "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/"
    "CHhighway/SHN_Postmiles_Tenth/FeatureServer/0"
)

_PAGE_SIZE = 2000
_OUT_FIELDS = (
    "OBJECTID,Route,RteSuffix,PMRouteID,County,District,PMPrefix,PM,"
    "PMSuffix,PMc,Odometer,PMInterval,HwySegment,AlignCode,Direction"
)


class PostmileReferenceError(RuntimeError):
    pass


def _layer_url() -> str:
    configured = (settings.POSTMILE_FEATURE_LAYER_URL or "").strip()
    return (configured or DEFAULT_POSTMILE_LAYER_URL).rstrip("/")


def _fetch_json(url: str, timeout_s: int = 45) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "ERIS-road-inventory-packager/1.0",
        },
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # pragma: no cover - exact network exception varies
        raise PostmileReferenceError(f"Caltrans postmile request failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise PostmileReferenceError("Caltrans postmile service returned a non-object response")
    if payload.get("error"):
        raise PostmileReferenceError(
            f"Caltrans postmile service returned an error: {payload['error']}"
        )
    return payload


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_feature(feature: dict[str, Any]) -> dict[str, Any] | None:
    attrs = feature.get("attributes") or {}
    geometry = feature.get("geometry") or {}
    if not isinstance(attrs, dict) or not isinstance(geometry, dict):
        return None

    lon = _num(geometry.get("x"))
    lat = _num(geometry.get("y"))
    pm = _num(attrs.get("PM"))
    route = _num(attrs.get("Route"))
    district = _num(attrs.get("District"))
    object_id = _num(attrs.get("OBJECTID"))
    county = _text(attrs.get("County"))

    if lon is None or lat is None or pm is None or route is None or county is None:
        return None
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None

    return {
        "object_id": int(object_id) if object_id is not None else None,
        "district_code": str(int(district)).zfill(2) if district is not None else None,
        "county_code": county.upper(),
        "route_name": str(int(route)),
        "route_suffix_code": _text(attrs.get("RteSuffix")),
        "pm_route_id": _text(attrs.get("PMRouteID")),
        "pm_prefix_code": _text(attrs.get("PMPrefix")),
        "postmile": pm,
        "pm_suffix_code": _text(attrs.get("PMSuffix")),
        "postmile_compound": _text(attrs.get("PMc")),
        "odometer": _num(attrs.get("Odometer")),
        "pm_interval": _num(attrs.get("PMInterval")),
        "highway_segment": _text(attrs.get("HwySegment")),
        "align_code": _text(attrs.get("AlignCode")),
        "direction": _text(attrs.get("Direction")),
        "latitude": lat,
        "longitude": lon,
    }


def fetch_postmile_reference_points() -> list[dict[str, Any]]:
    """Return the complete public SHN Postmiles Tenth point snapshot.

    ArcGIS caps a single response at 2,000 features. We page deterministically by
    OBJECTID and fail closed on malformed/truncated responses so an incomplete
    statewide reference is never published as a valid offline package.
    """

    base = _layer_url()
    offset = 0
    points: list[dict[str, Any]] = []
    seen_object_ids: set[int] = set()

    while True:
        params = {
            "f": "json",
            "where": "1=1",
            "outFields": _OUT_FIELDS,
            "returnGeometry": "true",
            "outSR": "4326",
            "orderByFields": "OBJECTID ASC",
            "resultOffset": str(offset),
            "resultRecordCount": str(_PAGE_SIZE),
        }
        payload = _fetch_json(f"{base}/query?{urlencode(params)}")
        raw_features = payload.get("features")
        if not isinstance(raw_features, list):
            raise PostmileReferenceError("Caltrans postmile response is missing features")

        page_added = 0
        for raw in raw_features:
            if not isinstance(raw, dict):
                continue
            point = _normalize_feature(raw)
            if not point:
                continue
            object_id = point.get("object_id")
            if isinstance(object_id, int):
                if object_id in seen_object_ids:
                    continue
                seen_object_ids.add(object_id)
            points.append(point)
            page_added += 1

        if len(raw_features) < _PAGE_SIZE:
            break
        if page_added == 0:
            raise PostmileReferenceError(
                "Caltrans postmile pagination made no progress; refusing partial package"
            )
        offset += len(raw_features)

    if not points:
        raise PostmileReferenceError("Caltrans postmile reference returned zero usable points")

    return points
