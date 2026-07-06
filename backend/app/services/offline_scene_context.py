"""
Offline terrain CONTEXT LAYERS for the .eristerrain bundle: roads/routes, an
optional aerial-imagery drape, and a north-up 2D overview inset.

All context data is collected/rendered at PACKAGE BUILD time on the worker and
written into the bundle; nothing here is fetched during the mobile download or
while viewing offline. Each layer degrades gracefully — a source failure marks
the layer unavailable (with a reason) and never corrupts the valid terrain
package.

Design:
  * roads.geojson  — a GeoJSON FeatureCollection built from ERIS-authoritative
    data (resolved road-bearing segment + road-inventory line geometry), clipped
    to the package bounds + a small buffer. An opt-in ArcGIS FeatureServer adapter
    can broaden coverage (worker network, documented + license-reviewed).
  * imagery.png    — optional aerial drape (NAIP, public domain) via a config
    adapter; OFF by default until validated on a live worker.
  * overview.png   — server-rendered (Pillow) north-up inset from bounds + roads +
    incident + geometry on a dark background.
  * context_layers manifest block — per-layer {available, file, sha256, bytes,
    source{provider,dataset,retrieved_at,attribution}} or {available:false,reason}.

Pure helpers (geometry, manifest metadata, validation, pixel mapping) are
unit-tested; the PNG raster uses Pillow (worker image) and the network adapters
use requests (worker), both optional-imported.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse

_M_PER_DEG_LAT = 111_320.0

ROADS_FILE = "roads.geojson"
IMAGERY_FILE = "imagery.png"
OVERVIEW_FILE = "overview.png"

# Keys allowed in a layer's `source` block (provenance only — never credentials).
_SOURCE_ALLOWED = ("provider", "dataset", "retrieved_at", "attribution", "resolution", "service")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def bounds_with_buffer(bounds: dict, buffer_m: float) -> dict:
    """Expand geographic bounds by buffer_m (approx, local equirectangular)."""
    d_lat = max(0.0, float(buffer_m)) / _M_PER_DEG_LAT
    mid_lat = (float(bounds["min_lat"]) + float(bounds["max_lat"])) / 2.0
    cos_lat = math.cos(math.radians(mid_lat)) or 1e-6
    d_lon = max(0.0, float(buffer_m)) / (_M_PER_DEG_LAT * abs(cos_lat))
    return {
        "min_lat": float(bounds["min_lat"]) - d_lat,
        "min_lon": float(bounds["min_lon"]) - d_lon,
        "max_lat": float(bounds["max_lat"]) + d_lat,
        "max_lon": float(bounds["max_lon"]) + d_lon,
    }


def lonlat_in_bounds(lon: float, lat: float, bounds: dict) -> bool:
    if not (_finite(lon) and _finite(lat)):
        return False
    return (
        bounds["min_lon"] <= lon <= bounds["max_lon"]
        and bounds["min_lat"] <= lat <= bounds["max_lat"]
    )


def sanitize_source(source: dict | None) -> dict:
    """Keep only provenance keys; strip any URL query string (could carry tokens/
    keys) from a `service` value. Never emits credentials/internal endpoints."""
    if not isinstance(source, dict):
        return {}
    out: dict = {}
    for k in _SOURCE_ALLOWED:
        v = source.get(k)
        if v is None:
            continue
        if k == "service" and isinstance(v, str):
            try:
                p = urlparse(v)
                v = urlunparse((p.scheme, p.netloc, p.path, "", "", ""))  # drop params/query/fragment
            except Exception:
                continue
        out[k] = v
    return out


# ---- road geometry (ERIS-authoritative, pure) ------------------------------

def road_bearing_line(incident: dict, bearing_deg: float, length_m: float = 260.0) -> list:
    """A short LineString (list of [lon,lat]) through the incident along the road
    bearing — the ONLY thing we know authoritatively about the road's local
    direction. Not a fabricated road network."""
    lat = float(incident["lat"])
    lon = float(incident["lon"])
    half = max(1.0, float(length_m)) / 2.0
    rad = math.radians(float(bearing_deg))
    d_lat = (math.cos(rad) * half) / _M_PER_DEG_LAT
    cos_lat = math.cos(math.radians(lat)) or 1e-6
    d_lon = (math.sin(rad) * half) / (_M_PER_DEG_LAT * abs(cos_lat))
    return [[lon - d_lon, lat - d_lat], [lon + d_lon, lat + d_lat]]


def _iter_linestrings(geom):
    """Yield lists of [lon,lat] from a GeoJSON/Esri-ish geometry, defensively.
    Only LineString-like parts (paths/rings) are yielded (roads are lines)."""
    if not isinstance(geom, dict):
        return
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString" and isinstance(coords, list):
        yield coords
    elif gtype in ("MultiLineString", "Polygon") and isinstance(coords, list):
        for part in coords:
            if isinstance(part, list):
                yield part
    elif gtype == "MultiPolygon" and isinstance(coords, list):
        for poly in coords:
            if isinstance(poly, list):
                for ring in poly:
                    if isinstance(ring, list):
                        yield ring
    # Esri paths
    elif isinstance(geom.get("paths"), list):
        for path in geom["paths"]:
            if isinstance(path, list):
                yield path


def _clean_line(coords, bounds: dict) -> list:
    """Keep finite [lon,lat] vertices; return the line only if it intersects the
    (buffered) bounds. No invented/interpolated coordinates."""
    pts = []
    any_in = False
    for c in coords or []:
        if isinstance(c, (list, tuple)) and len(c) >= 2 and _finite(c[0]) and _finite(c[1]):
            lon, lat = float(c[0]), float(c[1])
            pts.append([lon, lat])
            if lonlat_in_bounds(lon, lat, bounds):
                any_in = True
    return pts if (len(pts) >= 2 and any_in) else []


def roads_geojson_from_context(ctx: dict, buffer_m: float) -> tuple[dict, int]:
    """Assemble roads.geojson (a FeatureCollection) from ERIS-authoritative data in
    the build context: the resolved road-bearing segment + any line geometry in the
    road-inventory snapshot. Clipped to bounds + buffer. Returns (geojson, count)."""
    bounds = bounds_with_buffer(ctx["bounds"], buffer_m)
    overlays = ctx.get("overlays") or {}
    features: list = []

    incident = overlays.get("incident")
    bearing = overlays.get("roadBearingDeg")
    if isinstance(incident, dict) and _finite(incident.get("lat")) and _finite(incident.get("lon")) and _finite(bearing):
        line = _clean_line(road_bearing_line(incident, float(bearing)), bounds)
        if line:
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": line},
                "properties": {"kind": "road_bearing", "bearing_deg": round(float(bearing), 1)},
            })

    # Line geometry from the road-inventory snapshot (defensive).
    for line in _iter_linestrings(ctx.get("road_inventory_geometry")):
        cleaned = _clean_line(line, bounds)
        if cleaned:
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": cleaned},
                "properties": {"kind": "road_inventory"},
            })

    # Optional external adapter features (already clipped by the caller).
    for feat in ctx.get("external_road_features") or []:
        if isinstance(feat, dict):
            features.append(feat)

    return {"type": "FeatureCollection", "features": features}, len(features)


# ---- context-layer manifest metadata ---------------------------------------

def available_layer(file: str, data: bytes, source: dict | None = None, **extra) -> dict:
    meta = {"available": True, "file": file, "sha256": sha256_hex(data), "bytes": len(data)}
    if source:
        meta["source"] = sanitize_source(source)
    meta.update(extra)
    return meta


def unavailable_layer(reason: str) -> dict:
    return {"available": False, "reason": str(reason)[:80]}


def validate_context_layers(context_layers) -> tuple[bool, str | None]:
    """Structural validation of the manifest context_layers block (metadata only;
    asset presence/CRC/SHA is checked by the bundle validator). Absent block or
    absent layer => unavailable, NOT an error."""
    if context_layers is None:
        return True, None
    if not isinstance(context_layers, dict):
        return False, "context_layers must be an object"
    for name in ("roads", "imagery", "overview"):
        layer = context_layers.get(name)
        if layer is None:
            continue
        if not isinstance(layer, dict):
            return False, f"context_layers.{name} must be an object"
        if layer.get("available"):
            if not isinstance(layer.get("file"), str) or not layer["file"]:
                return False, f"context_layers.{name} available but missing file"
            sha = layer.get("sha256")
            if not (isinstance(sha, str) and len(sha) == 64):
                return False, f"context_layers.{name} available but missing/invalid sha256"
    return True, None


# ---- overview raster pixel mapping (pure) + PNG (Pillow) --------------------

def lonlat_to_px(lon: float, lat: float, bounds: dict, px: int) -> tuple[int, int]:
    """North-up mapping of lon/lat to (x,y) pixel in a px*px image. Row 0 = north."""
    w = max(1e-9, bounds["max_lon"] - bounds["min_lon"])
    h = max(1e-9, bounds["max_lat"] - bounds["min_lat"])
    x = (float(lon) - bounds["min_lon"]) / w * (px - 1)
    y = (bounds["max_lat"] - float(lat)) / h * (px - 1)
    return int(round(x)), int(round(y))


def render_overview_png(
    *, bounds: dict, incident: dict | None, roads_geojson: dict | None,
    geometry: dict | None, sample_extent: dict | None, px: int = 512,
) -> bytes:
    """North-up 2D overview inset (dark background): package boundary, roads,
    submitted geometry, incident marker. Requires Pillow (worker image)."""
    try:
        from PIL import Image, ImageDraw
    except Exception as e:  # pragma: no cover - exercised in the worker image
        raise RuntimeError("overview rendering requires Pillow (worker image)") from e

    px = max(64, min(2048, int(px)))
    img = Image.new("RGB", (px, px), (14, 18, 28))
    draw = ImageDraw.Draw(img)

    def pt(lon, lat):
        return lonlat_to_px(lon, lat, bounds, px)

    # Package boundary rectangle (inset by 1px).
    draw.rectangle([1, 1, px - 2, px - 2], outline=(70, 120, 160), width=2)

    # Roads.
    if isinstance(roads_geojson, dict):
        for feat in roads_geojson.get("features") or []:
            geom = (feat or {}).get("geometry") or {}
            if geom.get("type") == "LineString":
                pts = [pt(c[0], c[1]) for c in geom.get("coordinates") or [] if isinstance(c, (list, tuple)) and len(c) >= 2]
                if len(pts) >= 2:
                    draw.line(pts, fill=(250, 205, 90), width=2)

    # Submitted incident geometry (line/polygon outline in a distinct colour).
    for line in _iter_linestrings(geometry):
        pts = [pt(c[0], c[1]) for c in line if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(pts) >= 2:
            draw.line(pts, fill=(120, 235, 140), width=2)

    # Sample extent (thin rectangle).
    if isinstance(sample_extent, dict) and all(_finite(sample_extent.get(k)) for k in ("minLat", "minLon", "maxLat", "maxLon")):
        x0, y0 = pt(sample_extent["minLon"], sample_extent["maxLat"])
        x1, y1 = pt(sample_extent["maxLon"], sample_extent["minLat"])
        draw.rectangle([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], outline=(90, 190, 240), width=1)

    # Incident marker.
    if isinstance(incident, dict) and _finite(incident.get("lat")) and _finite(incident.get("lon")):
        cx, cy = pt(incident["lon"], incident["lat"])
        r = max(3, px // 90)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(60, 120, 235), outline=(255, 255, 255))

    from io import BytesIO
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---- network adapters (worker only) ----------------------------------------

def _export_image_params(bounds: dict, px: int) -> dict:
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    return {"bbox": bbox, "bboxSR": "4326", "imageSR": "4326", "size": f"{px},{px}", "format": "png", "f": "image"}


def fetch_imagery_png(bounds: dict, *, export_url: str, px: int, timeout_s: int, session=None) -> tuple[bytes, dict]:
    """Fetch an aerial-imagery PNG aligned to `bounds` from an ArcGIS ImageServer
    exportImage endpoint (default NAIP, public domain). Worker-only. Returns
    (png_bytes, source_meta). Raises on any failure (caller degrades to no imagery)."""
    import requests

    s = session or requests.Session()
    url = export_url.rstrip("/") + "/exportImage"
    resp = s.get(url, params=_export_image_params(bounds, px), timeout=timeout_s)
    resp.raise_for_status()
    ctype = resp.headers.get("Content-Type", "")
    if "json" in ctype:  # ArcGIS returns errors as JSON with HTTP 200
        raise RuntimeError(f"imagery export error: {resp.text[:180]}")
    data = resp.content
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("imagery export did not return a PNG")
    source = {
        "provider": "usgs_naip",
        "dataset": "USGS/USDA NAIP (public domain)",
        "attribution": "USDA NAIP via USGS The National Map",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "service": export_url,
    }
    return data, source


def fetch_arcgis_road_features(bounds: dict, *, source_url: str, timeout_s: int, session=None) -> list:
    """Opt-in adapter: query road/route line features from a configured ArcGIS
    FeatureServer layer within the (buffered) bounds. Worker-only, license reviewed
    by the operator. Returns a list of GeoJSON Features (may be empty)."""
    import requests

    s = session or requests.Session()
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    params = {
        "where": "1=1", "geometry": bbox, "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "outSR": "4326", "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*", "returnGeometry": "true", "f": "geojson",
    }
    resp = s.get(source_url.rstrip("/") + "/query", params=params, timeout=timeout_s)
    resp.raise_for_status()
    fc = resp.json()
    feats = fc.get("features") if isinstance(fc, dict) else None
    out = []
    for f in feats or []:
        geom = (f or {}).get("geometry") or {}
        if isinstance(geom, dict) and geom.get("type") in ("LineString", "MultiLineString"):
            out.append({"type": "Feature", "geometry": geom, "properties": {"kind": "road_centerline"}})
    return out
