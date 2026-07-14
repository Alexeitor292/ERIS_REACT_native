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
IMAGERY_FILE = "imagery.png"          # legacy single-image aerial drape
IMAGERY_TILE_DIR = "imagery"          # tiled aerial imagery -> imagery/{row}/{col}.jpg
IMAGERY_TILE_EXT = "jpg"
OVERVIEW_FILE = "overview.png"
ROAD_CROSS_SECTION_FILE = "road_cross_section.json"


def imagery_tile_file(row: int, column: int, ext: str = IMAGERY_TILE_EXT) -> str:
    return f"{IMAGERY_TILE_DIR}/{int(row)}/{int(column)}.{ext}"

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


def _clip_segment_to_bounds(p0, p1, bounds: dict):
    """Liang-Barsky clip of segment p0->p1 ([lon,lat]) to the bounds rectangle. Returns
    the clipped [[lon,lat],[lon,lat]] (endpoints ON the bounds edges) or None if the
    segment does not intersect the rectangle."""
    x0, y0 = float(p0[0]), float(p0[1])
    x1, y1 = float(p1[0]), float(p1[1])
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    checks = (
        (-dx, x0 - bounds["min_lon"]), (dx, bounds["max_lon"] - x0),
        (-dy, y0 - bounds["min_lat"]), (dy, bounds["max_lat"] - y0),
    )
    for p, q in checks:
        if p == 0:
            if q < 0:
                return None  # parallel to an edge and outside it
        else:
            t = q / p
            if p < 0:
                if t > t1:
                    return None
                t0 = max(t0, t)
            else:
                if t < t0:
                    return None
                t1 = min(t1, t)
    if t0 > t1:
        return None
    return [[x0 + t0 * dx, y0 + t0 * dy], [x0 + t1 * dx, y0 + t1 * dy]]


def _aoi_span_m(bounds: dict) -> float:
    """Diagonal length (metres, cos-lat adjusted) of the AOI bounds; 0 on bad bounds."""
    try:
        min_lat, max_lat = float(bounds["min_lat"]), float(bounds["max_lat"])
        min_lon, max_lon = float(bounds["min_lon"]), float(bounds["max_lon"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    mid_lat = (min_lat + max_lat) / 2.0
    cos_lat = math.cos(math.radians(mid_lat)) or 1e-6
    w = (max_lon - min_lon) * _M_PER_DEG_LAT * abs(cos_lat)
    h = (max_lat - min_lat) * _M_PER_DEG_LAT
    return math.hypot(max(0.0, w), max(0.0, h))


def lonlat_in_bounds(lon: float, lat: float, bounds: dict) -> bool:
    if not (_finite(lon) and _finite(lat)):
        return False
    return (
        bounds["min_lon"] <= lon <= bounds["max_lon"]
        and bounds["min_lat"] <= lat <= bounds["max_lat"]
    )


def sanitize_source(source: dict | None) -> dict:
    """Keep only provenance keys; from a `service` URL strip the query string (tokens/
    keys) AND any embedded userinfo (user:password@host — basic-auth credentials).
    Never emits credentials/internal endpoints into the shipped manifest."""
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
                # Rebuild netloc from host[:port] only — drops any user:password@.
                host = p.hostname or ""
                netloc = f"{host}:{p.port}" if p.port else host
                v = urlunparse((p.scheme, netloc, p.path, "", "", ""))  # no userinfo/params/query/fragment
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


def _iter_line_only(geom):
    """Yield ONLY genuinely line-like parts from a geometry: GeoJSON LineString /
    MultiLineString and Esri paths. Polygons/rings are deliberately NOT treated as
    roads (we never invent a road centerline from a polygon boundary)."""
    if not isinstance(geom, dict):
        return
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString" and isinstance(coords, list):
        yield coords
    elif gtype == "MultiLineString" and isinstance(coords, list):
        for part in coords:
            if isinstance(part, list):
                yield part
    elif isinstance(geom.get("paths"), list):  # Esri polyline
        for path in geom["paths"]:
            if isinstance(path, list):
                yield path


_PT_EPS = 1e-9  # ~0.1 mm in degrees — joins/duplicates below this are the same point


def _finite_points(coords) -> list:
    """Finite [lon,lat] vertices only (defensive; nothing invented)."""
    pts = []
    for c in coords or []:
        if isinstance(c, (list, tuple)) and len(c) >= 2 and _finite(c[0]) and _finite(c[1]):
            pts.append([float(c[0]), float(c[1])])
    return pts


def _pt_eq(a, b) -> bool:
    return abs(a[0] - b[0]) <= _PT_EPS and abs(a[1] - b[1]) <= _PT_EPS


def _dedupe_adjacent(pts: list) -> list:
    out: list = []
    for p in pts:
        if not out or not _pt_eq(out[-1], p):
            out.append(p)
    return out


def clip_line_to_bounds(coords, bounds: dict) -> list:
    """TRUE polyline clipping to the (buffered) bounds rectangle.

    Every consecutive segment is clipped with Liang-Barsky (_clip_segment_to_bounds), so:
      * a segment that CROSSES the bounds with BOTH endpoints outside is retained, cut to
        the two boundary intersections (the old filter dropped it);
      * out-of-bounds coordinates are NEVER packaged (the old filter kept the whole
        original line whenever a single vertex happened to be inside);
      * a line that leaves and re-enters yields SEPARATE disconnected parts;
      * duplicate vertices created at segment joins are collapsed;
      * parts with fewer than two distinct finite points are rejected.

    Returns a list of clipped parts (each a list of [lon,lat]); [] when the line does not
    intersect the bounds at all. Only boundary intersections are introduced — no other
    coordinate is invented.
    """
    pts = _finite_points(coords)
    if len(pts) < 2:
        return []
    parts: list = []
    cur: list = []
    for i in range(len(pts) - 1):
        seg = _clip_segment_to_bounds(pts[i], pts[i + 1], bounds)
        if seg is None:  # segment entirely outside -> current part ends here
            if len(cur) >= 2:
                parts.append(cur)
            cur = []
            continue
        a, b = seg
        if cur and not _pt_eq(cur[-1], a):
            # The clipped piece does not continue the current part (the line left the
            # bounds and re-entered elsewhere) -> start a new disconnected part.
            if len(cur) >= 2:
                parts.append(cur)
            cur = []
        if not cur:
            cur = [a]
        if not _pt_eq(cur[-1], b):
            cur.append(b)
    if len(cur) >= 2:
        parts.append(cur)
    out = []
    for p in parts:
        d = _dedupe_adjacent(p)
        if len(d) >= 2:
            out.append(d)
    return out


# Precise reasons roads.geojson has no usable snap geometry (never a generic "no_data").
ROADS_REASON_NO_INVENTORY = "no_road_inventory_geometry"
ROADS_REASON_NO_BEARING = "no_road_bearing"
ROADS_REASON_NO_SOURCE = "no_centerline_source_configured"
ROADS_REASON_NO_FEATURES = "no_centerline_features_in_area"


def roads_geojson_from_context(ctx: dict, buffer_m: float, *, external_configured: bool = False) -> tuple[dict, int, str | None]:
    """Assemble roads.geojson (a FeatureCollection) for the offline Cross Section snap,
    in PRIORITY order. Returns (geojson, count, reason) — reason is a PRECISE token when
    count == 0 (never a generic "no_data"):

      A. external road_centerline features (arcgis_feature_service adapter, pre-fetched
         into ctx['external_road_features']) — the richest, real road network.
      B. road-inventory line geometry (ctx['road_inventory_geometry']).
      C. submitted incident geometry, but ONLY the genuinely line-like parts
         (LineString/MultiLineString/paths) -> kind 'submitted_road_geometry'.
      D. a synthetic AOI-spanning road_bearing LineString (incident + roadBearingDeg),
         clipped to bounds — the snap/orientation fallback.

    ALL geometry is TRULY CLIPPED to bounds + buffer (Liang-Barsky per segment, see
    clip_line_to_bounds): a line crossing the AOI with both endpoints outside is retained
    cut to the boundary, out-of-bounds coordinates are never packaged, and a line that
    leaves and re-enters becomes separate LineString features. When nothing is available,
    the reason tells the operator exactly what is missing / what to configure.
    """
    bounds = bounds_with_buffer(ctx["bounds"], buffer_m)
    overlays = ctx.get("overlays") or {}
    features: list = []

    def _emit(line, props: dict) -> None:
        """Clip a raw line to the buffered bounds and emit ONE LineString Feature per
        surviving (disconnected) part. No out-of-bounds coordinate is ever packaged."""
        for part in clip_line_to_bounds(line, bounds):
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": part},
                "properties": dict(props),
            })

    # A. External centerlines (already road_centerline kind); clipped to bounds.
    external_count = 0
    for feat in ctx.get("external_road_features") or []:
        if not isinstance(feat, dict):
            continue
        external_count += 1
        props = feat.get("properties") if isinstance(feat.get("properties"), dict) else {}
        for line in _iter_line_only((feat or {}).get("geometry")):
            _emit(line, {**props, "kind": props.get("kind") or "road_centerline"})

    # B. Road-inventory line geometry (route/postmile metadata when available).
    inv_meta = {}
    rxs_attrs = ((ctx.get("road_cross_section") or {}).get("attributes")) if isinstance(ctx.get("road_cross_section"), dict) else None
    if isinstance(rxs_attrs, dict):
        for k in ("route_name", "county_code", "begin_pm", "end_pm"):
            if rxs_attrs.get(k) is not None:
                inv_meta[k] = rxs_attrs[k]
    for line in _iter_line_only(ctx.get("road_inventory_geometry")):
        _emit(line, {"kind": "road_inventory", **inv_meta})

    # C. Submitted incident geometry — ONLY line-like parts (never polygons).
    for line in _iter_line_only(overlays.get("geometry")):
        _emit(line, {"kind": "submitted_road_geometry"})

    # D. Synthetic AOI-spanning road-bearing fallback (snap + orientation).
    incident = overlays.get("incident")
    bearing = overlays.get("roadBearingDeg")
    if isinstance(incident, dict) and _finite(incident.get("lat")) and _finite(incident.get("lon")) and _finite(bearing):
        span_m = _aoi_span_m(ctx.get("bounds") or {}) * 2.0 + 260.0
        long_line = road_bearing_line(incident, float(bearing), length_m=span_m)
        _emit(long_line, {"kind": "road_bearing", "bearing_deg": round(float(bearing), 1)})

    count = len(features)
    reason = None
    if count == 0:
        if external_configured:
            reason = ROADS_REASON_NO_FEATURES  # a source is configured but returned nothing here
        elif ctx.get("road_inventory_geometry") is None and not _finite(bearing):
            # No inventory geometry and no bearing: the confirmed field blocker. The
            # operator's lever is to configure a real centerline source.
            reason = ROADS_REASON_NO_BEARING if isinstance(incident, dict) else ROADS_REASON_NO_INVENTORY
        elif ctx.get("road_inventory_geometry") is None:
            reason = ROADS_REASON_NO_INVENTORY
        else:
            reason = ROADS_REASON_NO_SOURCE
    return {"type": "FeatureCollection", "features": features}, count, reason


# ---- road cross-section context (Road Inventory layout, packaged for offline) ----

def road_cross_section_block(ctx: dict) -> dict | None:
    """Assemble the packaged road_cross_section.json content: the Road Inventory-
    derived roadway layout (RoadCrossSection attributes) + route/postmile metadata +
    the UPSTATION bearing (from the resolved road bearing) + provenance. Returns None
    when no cross-section attributes are available.

    Elevation is deliberately NOT in this block — the native Cross Section tool samples
    ground elevation from the packaged terrain grid at tap time. There is no
    authoritative centerline geometry in the tabular Road Inventory (road_segments has
    no geometry), so snapping uses the packaged roads.geojson; centerline is null here.
    """
    rxs = ctx.get("road_cross_section") if isinstance(ctx.get("road_cross_section"), dict) else None
    attrs = rxs.get("attributes") if isinstance(rxs, dict) else None
    if not isinstance(attrs, dict) or not attrs:
        return None
    overlays = ctx.get("overlays") or {}
    bearing = overlays.get("roadBearingDeg")
    source = attrs.get("source", "DEFAULT")
    block: dict = {
        "attributes": attrs,
        "route_name": attrs.get("route_name"),
        "county_code": attrs.get("county_code"),
        "begin_pm": attrs.get("begin_pm"),
        "end_pm": attrs.get("end_pm"),
        # Upstation = increasing postmile; the resolved road bearing already points
        # upstation. The native tool uses this to orient LT/RT canonically.
        "upstation_bearing_deg": float(bearing) if _finite(bearing) else None,
        "orientation_available": bool(_finite(bearing)),
        "postmile_increases_upstation": True,
        "layout_source": source,
        "source": source,
        "centerline": None,
        "provenance": {
            "roadLayoutSource": source,
            "layoutSourceLabel": layout_source_label(source),
            # Truthful note — DEFAULT is NOT Road Inventory.
            "note": _layout_note(source),
        },
    }
    return block


# Truthful human label for the roadway-layout provenance. DEFAULT must NEVER read as
# if it came from Road Inventory.
LAYOUT_SOURCE_LABELS = {
    "ROAD_INVENTORY": "ERIS Road Inventory",
    "FORM_FIELDS": "Submission/form fields",
    "DEFAULT": "Default roadway assumptions",
}


def layout_source_label(source) -> str:
    return LAYOUT_SOURCE_LABELS.get(str(source).upper(), "Default roadway assumptions")


def _layout_note(source) -> str:
    label = layout_source_label(source)
    if str(source).upper() == "ROAD_INVENTORY":
        return "Roadway layout from ERIS Road Inventory; schematic surface (no crown/superelevation)."
    return f"Roadway layout: {label}; schematic surface (no crown/superelevation) — not measured from Road Inventory."


# Precise reasons a road-cross-section layer is degraded (surfaced in the manifest so
# the mobile UI never implies the Cross Section tool is usable when it is not).
RXS_REASON_NO_SNAP = "no_road_snap_geometry"
RXS_REASON_NO_BEARING = "no_upstation_bearing"
RXS_REASON_DEFAULT_ONLY = "default_layout_only"


def road_cross_section_usability(
    *, layout_available: bool, layout_source, snap_available: bool, orientation_available: bool
) -> dict:
    """Explicit usability flags for the packaged road-cross-section layer. The Cross
    Section tool is FULLY usable only when a roadway layout exists AND the app can
    either snap to real road geometry OR orient from an upstation bearing. Missing
    snap geometry + missing bearing => not usable (the confirmed field blocker)."""
    fully_usable = bool(layout_available and (snap_available or orientation_available))
    if not fully_usable:
        reason = RXS_REASON_NO_SNAP
    elif not orientation_available:
        reason = RXS_REASON_NO_BEARING  # usable via snap tangent, but no explicit upstation bearing
    elif str(layout_source).upper() == "DEFAULT":
        reason = RXS_REASON_DEFAULT_ONLY  # usable, but roadway dimensions are default assumptions
    else:
        reason = None
    return {
        "layout_available": bool(layout_available),
        "layout_source": layout_source,
        "layout_source_label": layout_source_label(layout_source),
        "snap_available": bool(snap_available),
        "orientation_available": bool(orientation_available),
        "fully_usable": fully_usable,
        "reason": reason,
    }


# ---- context-layer manifest metadata ---------------------------------------

def available_layer(file: str, data: bytes, source: dict | None = None, **extra) -> dict:
    meta = {"available": True, "file": file, "sha256": sha256_hex(data), "bytes": len(data)}
    if source:
        meta["source"] = sanitize_source(source)
    meta.update(extra)
    return meta


def unavailable_layer(reason: str) -> dict:
    return {"available": False, "reason": str(reason)[:80]}


# ---- truthful road-context description --------------------------------------
# Do NOT claim "roads" / "routes" / "street network" when the package only holds a
# derived road-bearing line. Describe exactly what was packaged.
ROAD_CONTEXT_NONE = "No road context packaged"
ROAD_CONTEXT_BEARING = "Road bearing context"
ROAD_CONTEXT_INVENTORY = "Road inventory geometry"
ROAD_CONTEXT_FEATURE_SERVICE = "Feature service road network"
ROAD_CONTEXT_SUBMITTED = "Submitted road-aligned geometry"


def road_kinds_from_geojson(geojson: dict | None) -> list:
    """Distinct feature `properties.kind` values present in a roads FeatureCollection
    (e.g. road_bearing / road_inventory / road_centerline). Sorted, defensive."""
    kinds: list = []
    for f in (geojson or {}).get("features") or []:
        props = (f or {}).get("properties") if isinstance(f, dict) else None
        k = props.get("kind") if isinstance(props, dict) else None
        if isinstance(k, str) and k and k not in kinds:
            kinds.append(k)
    return sorted(kinds)


def describe_road_context(roads_layer: dict | None) -> str:
    """Truthful one-line description of the packaged road context, by richest kind
    present: feature-service centerlines > road-inventory geometry > bearing line."""
    if not isinstance(roads_layer, dict) or not roads_layer.get("available"):
        return ROAD_CONTEXT_NONE
    kinds = roads_layer.get("road_kinds") or []
    if "road_centerline" in kinds:
        return ROAD_CONTEXT_FEATURE_SERVICE
    if "road_inventory" in kinds:
        return ROAD_CONTEXT_INVENTORY
    if "submitted_road_geometry" in kinds:
        return ROAD_CONTEXT_SUBMITTED
    if "road_bearing" in kinds:
        return ROAD_CONTEXT_BEARING
    # available but unclassified kinds -> honest, non-overstating fallback.
    return "Road context packaged"


def validate_context_layers(context_layers) -> tuple[bool, str | None]:
    """Structural validation of the manifest context_layers block (metadata only;
    asset presence/CRC/SHA is checked by the bundle validator). Absent block or
    absent layer => unavailable, NOT an error."""
    if context_layers is None:
        return True, None
    if not isinstance(context_layers, dict):
        return False, "context_layers must be an object"
    for name in ("roads", "imagery", "overview", "road_cross_section"):
        layer = context_layers.get(name)
        if layer is None:
            continue
        if not isinstance(layer, dict):
            return False, f"context_layers.{name} must be an object"
        if not layer.get("available"):
            continue
        # Tiled imagery declares an array of tiles instead of a single `file`.
        if name == "imagery" and layer.get("format") == "tiled":
            ok, reason = _validate_tiled_imagery_meta(layer)
            if not ok:
                return False, reason
            continue
        if not isinstance(layer.get("file"), str) or not layer["file"]:
            return False, f"context_layers.{name} available but missing file"
        sha = layer.get("sha256")
        if not (isinstance(sha, str) and len(sha) == 64):
            return False, f"context_layers.{name} available but missing/invalid sha256"
    return True, None


def imagery_is_tiled(imagery_layer) -> bool:
    """True when the imagery layer is the tiled (multi-tile JPEG) format with tiles.
    Matches the TS/ObjC readers (require a non-empty tiles array), not just format."""
    return (
        isinstance(imagery_layer, dict)
        and imagery_layer.get("available")
        and imagery_layer.get("format") == "tiled"
        and isinstance(imagery_layer.get("tiles"), list)
        and len(imagery_layer["tiles"]) > 0
    )


def _validate_tiled_imagery_meta(layer: dict) -> tuple[bool, str | None]:
    """Structure of a tiled imagery layer (metadata only; per-tile asset presence/
    CRC/SHA is checked by the bundle validator). Every tile needs file + 64-hex sha256."""
    tiles = layer.get("tiles")
    if not isinstance(tiles, list) or not tiles:
        return False, "context_layers.imagery tiled but has no tiles"
    if not isinstance(layer.get("columns"), int) or not isinstance(layer.get("rows"), int):
        return False, "context_layers.imagery tiled but missing columns/rows"
    if int(layer["columns"]) * int(layer["rows"]) != len(tiles):
        return False, "context_layers.imagery tile count does not match columns*rows"
    seen = set()
    for t in tiles:
        if not isinstance(t, dict):
            return False, "context_layers.imagery tile must be an object"
        f = t.get("file")
        if not isinstance(f, str) or not f:
            return False, "context_layers.imagery tile missing file"
        sha = t.get("sha256")
        if not (isinstance(sha, str) and len(sha) == 64):
            return False, f"context_layers.imagery tile {f} missing/invalid sha256"
        rc = (t.get("row"), t.get("column"))
        if rc in seen:
            return False, f"context_layers.imagery duplicate tile {rc}"
        seen.add(rc)
    return True, None


def tiled_imagery_tiles(imagery_layer) -> list:
    """Declared tiles for a tiled imagery layer, else []. Defensive."""
    if not imagery_is_tiled(imagery_layer):
        return []
    tiles = imagery_layer.get("tiles")
    return tiles if isinstance(tiles, list) else []


def tiled_imagery_layer(plan: dict, tile_metas: list, source: dict | None) -> dict:
    """Assemble the manifest `context_layers.imagery` block for a TILED package from a
    tile plan and the per-tile packaged metadata (file/bounds/sha256/bytes). Reports
    the actual source + effective resolution + total imagery storage — never claims
    ArcGIS equivalence."""
    total_bytes = sum(int(t.get("bytes") or 0) for t in tile_metas)
    layer = {
        "available": True,
        "format": "tiled",
        "tile_size_px": int(plan["tile_size_px"]),
        "columns": int(plan["columns"]),
        "rows": int(plan["rows"]),
        "target_meters_per_pixel": plan.get("target_meters_per_pixel"),
        "effective_meters_per_pixel": plan.get("effective_meters_per_pixel"),
        "bounds": dict(plan["bounds"]),
        "tile_count": len(tile_metas),
        "bytes": total_bytes,
        "tiles": tile_metas,
    }
    if source:
        layer["source"] = sanitize_source(source)
    return layer


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


def tile_export_dims(bounds: dict, px: int) -> tuple[int, int]:
    """Pixel (width, height) for a tile export whose ASPECT MATCHES the tile's metric
    footprint (cos-lat adjusted). Requesting a SQUARE image for a non-square bbox lets
    ImageServer adjust/expand the bbox to the requested aspect, so adjacent tiles cover
    overlapping ground -> the SAME building appears in two tiles (double buildings) and
    the imagery is misaligned to the terrain. Matching the aspect eliminates that: the
    longer axis gets `px`, the shorter is scaled proportionally (min 1)."""
    tp = max(1, int(px))
    try:
        min_lat, max_lat = float(bounds["min_lat"]), float(bounds["max_lat"])
        min_lon, max_lon = float(bounds["min_lon"]), float(bounds["max_lon"])
        mid_lat = (min_lat + max_lat) / 2.0
        cos_lat = math.cos(math.radians(mid_lat)) or 1e-6
        w_m = (max_lon - min_lon) * _M_PER_DEG_LAT * abs(cos_lat)
        h_m = (max_lat - min_lat) * _M_PER_DEG_LAT
    except (KeyError, TypeError, ValueError):
        return tp, tp
    if not (w_m > 0 and h_m > 0):
        return tp, tp
    if w_m >= h_m:
        return tp, max(1, round(tp * h_m / w_m))
    return max(1, round(tp * w_m / h_m)), tp


def _export_tile_params(bounds: dict, px: int, jpeg_quality: int) -> dict:
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    w_px, h_px = tile_export_dims(bounds, px)
    return {
        "bbox": bbox, "bboxSR": "4326", "imageSR": "4326",
        "size": f"{w_px},{h_px}", "format": "jpg", "compressionQuality": str(int(jpeg_quality)),
        "f": "image",
    }


def encode_jpeg(data: bytes, quality: int) -> bytes:
    """Normalise an image to a baseline RGB JPEG at `quality` (Pillow — worker image).
    Used only when the upstream export was not already JPEG, so aerial tiles always
    package as compact JPEG regardless of what the service returned."""
    from io import BytesIO

    from PIL import Image

    img = Image.open(BytesIO(data)).convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=int(quality), optimize=True)
    return buf.getvalue()


def fetch_imagery_tile(
    bounds: dict, *, export_url: str, tile_px: int, timeout_s: int, jpeg_quality: int = 85, session=None
) -> tuple[bytes, dict]:
    """Fetch ONE aerial-imagery tile (JPEG) aligned to `bounds` from an ArcGIS
    ImageServer exportImage endpoint (default NAIP, public domain). Worker-only.

    Validates the response is a real image (not a JSON/HTML service error), and
    normalises to JPEG when the service returned another format. Returns
    (jpeg_bytes, source_meta). Raises on any failure so the caller's bounded retry
    can decide transient-vs-terminal. NEVER embeds credentials in source_meta.
    """
    import requests

    from . import offline_scene_imagery as imagery

    s = session or requests.Session()
    url = export_url.rstrip("/") + "/exportImage"
    resp = s.get(url, params=_export_tile_params(bounds, tile_px, jpeg_quality), timeout=timeout_s)
    resp.raise_for_status()
    ctype = resp.headers.get("Content-Type", "")
    if "json" in ctype or "html" in ctype:  # ArcGIS returns errors as JSON/HTML with HTTP 200
        raise RuntimeError(f"imagery tile export error: {resp.text[:180]}")
    data = resp.content
    if not imagery.is_supported_image(data):
        raise RuntimeError("imagery tile export did not return an image")
    if not imagery.is_jpeg(data):
        data = encode_jpeg(data, jpeg_quality)
    source = {
        "provider": "usgs_naip",
        "dataset": "USGS/USDA NAIP (public domain)",
        "attribution": "USDA NAIP via USGS The National Map",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "service": export_url,
    }
    return data, source


def _esri_paths_to_geometry(geom: dict) -> dict | None:
    """Convert an Esri polyline ({paths:[[[x,y],...],...]}) to a GeoJSON LineString /
    MultiLineString. Returns None if not an Esri polyline."""
    paths = geom.get("paths") if isinstance(geom, dict) else None
    if not isinstance(paths, list):
        return None
    lines = [p for p in paths if isinstance(p, list) and len(p) >= 2]
    if not lines:
        return None
    if len(lines) == 1:
        return {"type": "LineString", "coordinates": lines[0]}
    return {"type": "MultiLineString", "coordinates": lines}


# Safe, non-sensitive attribute allowlist for packaged road centerlines (TIGERweb).
# Nothing else from the provider is carried into the offline package.
TIGER_ROAD_PROPS = ("NAME", "BASENAME", "MTFCC", "RTTYP")

# --- Road class (ERIS-TRUSTED, derived from the TIGERweb layer we queried) -------------
# The configured TIGERweb Transportation layers:
#   2 = Primary Roads, 6 = Secondary Roads, 8 = Local Roads
# The class is decided by ERIS from the LAYER ID we asked for — never from a provider
# attribute — so a provider field can never spoof it.
TIGERWEB_LAYER_CLASS = {2: "primary", 6: "secondary", 8: "local"}
ROAD_CLASS_LABELS = {
    "primary": "Primary road / highway",
    "secondary": "Secondary road",
    "local": "Local road",
    "unclassified": "Unclassified road",
}
# Explicit, order-INDEPENDENT dedupe priority: a duplicate geometry keeps its highest
# classification (a freeway that also appears in the local layer stays primary).
ROAD_CLASS_PRIORITY = {"primary": 3, "secondary": 2, "local": 1, "unclassified": 0}
# ERIS-trusted property names that provider attributes may NEVER override.
TRUSTED_ROAD_PROPS = ("kind", "source_layer_id", "road_class", "road_class_label")


def road_class_for_layer(layer_id) -> str:
    """TIGERweb layer id -> ERIS road class. Unknown/misconfigured layer ids are honestly
    'unclassified' (lowest dedupe priority) rather than silently claimed as a highway."""
    try:
        return TIGERWEB_LAYER_CLASS.get(int(layer_id), "unclassified")
    except (TypeError, ValueError):
        return "unclassified"


def road_class_label(road_class) -> str:
    return ROAD_CLASS_LABELS.get(str(road_class), ROAD_CLASS_LABELS["unclassified"])


def road_class_priority(road_class) -> int:
    return ROAD_CLASS_PRIORITY.get(str(road_class), 0)


def road_class_counts(geojson: dict | None) -> dict:
    """Counts of packaged features by road_class (only classes actually present)."""
    counts: dict = {}
    for f in (geojson or {}).get("features") or []:
        props = (f or {}).get("properties") if isinstance(f, dict) else None
        rc = props.get("road_class") if isinstance(props, dict) else None
        if isinstance(rc, str) and rc:
            counts[rc] = counts.get(rc, 0) + 1
    return counts


def _safe_props(feature: dict, keep_props) -> dict:
    """Extract ONLY allowlisted scalar attributes from a GeoJSON (`properties`) or Esri
    (`attributes`) feature. Never carries provider internals/credentials."""
    if not keep_props:
        return {}
    src = feature.get("properties") if isinstance(feature.get("properties"), dict) else None
    if src is None:
        src = feature.get("attributes") if isinstance(feature.get("attributes"), dict) else {}
    out: dict = {}
    for k in keep_props:
        v = src.get(k)
        if v is None:
            continue
        if isinstance(v, (str, int, float)):  # scalars only — no nested provider objects
            out[k] = v
    return out


def normalize_road_features(features, *, keep_props=None, trusted: dict | None = None) -> list:
    """Normalise an ArcGIS REST query response's features (MapServer OR FeatureServer)
    into GeoJSON line Features tagged kind='road_centerline'. Accepts BOTH GeoJSON
    (geometry.type LineString/MultiLineString) and Esri JSON (geometry.paths). Non-line
    features are dropped.

    Only allowlisted provider attributes are preserved (keep_props). The ERIS-TRUSTED
    properties (`trusted`: source_layer_id / road_class / road_class_label) and `kind` are
    written LAST, so a provider attribute can NEVER spoof them."""
    out = []
    safe_trusted = {k: v for k, v in (trusted or {}).items() if k in TRUSTED_ROAD_PROPS}
    for f in features or []:
        if not isinstance(f, dict):
            continue
        geom = f.get("geometry") or {}
        if not isinstance(geom, dict):
            continue
        if geom.get("type") in ("LineString", "MultiLineString") and isinstance(geom.get("coordinates"), list):
            gj = {"type": geom["type"], "coordinates": geom["coordinates"]}
        else:
            gj = _esri_paths_to_geometry(geom)
        if gj is None:
            continue
        out.append({
            "type": "Feature",
            "geometry": gj,
            # provider attrs first; ERIS-trusted values last (unspoofable)
            "properties": {**_safe_props(f, keep_props), **safe_trusted, "kind": "road_centerline"},
        })
    return out


def _line_key(coords, precision: int):
    pts = tuple(
        (round(float(c[0]), precision), round(float(c[1]), precision))
        for c in coords or []
        if isinstance(c, (list, tuple)) and len(c) >= 2
    )
    rev = tuple(reversed(pts))
    return min(pts, rev)  # direction-agnostic


def _feature_key(geom: dict, precision: int):
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "LineString":
        parts = [c]
    elif t == "MultiLineString":
        parts = c or []
    else:
        return None
    keys = sorted(_line_key(p, precision) for p in parts if isinstance(p, list))
    return tuple(keys) or None


def dedupe_line_features(features, *, precision: int = 6) -> list:
    """Drop identical / effectively-identical line features (same geometry regardless of
    vertex order/direction, to `precision` decimal degrees ~0.1 m). Layers 2/6/8 can
    return the same road, and paged queries can repeat features.

    DETERMINISTIC CLASS PRIORITY: when the same geometry appears in several layers, the
    HIGHEST classification wins (primary > secondary > local > unclassified) — a freeway
    that is also present in the local-roads layer stays `primary`, regardless of the order
    the layers were queried in. The winning feature keeps its OWN safe metadata; provider
    attributes from the duplicates are never merged. Ties keep the first-seen feature, so
    the output is stable.
    """
    best: dict = {}
    order: list = []
    for f in features or []:
        geom = (f or {}).get("geometry") or {}
        key = _feature_key(geom, precision) if isinstance(geom, dict) else None
        if key is None:
            continue
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        prio = road_class_priority(props.get("road_class"))
        if key not in best:
            best[key] = (prio, f)
            order.append(key)
        elif prio > best[key][0]:
            best[key] = (prio, f)  # strictly higher class wins; ties keep the first seen
    return [best[k][1] for k in order]


def fetch_arcgis_line_layer(
    layer_url: str, bounds: dict, *, timeout_s: int, session=None, out_fields: str = "",
    keep_props=None, trusted: dict | None = None,
) -> list:
    """Query ONE ArcGIS REST line layer (`<layer_url>/query`) intersecting `bounds`.
    Works for BOTH `MapServer/<id>` and `FeatureServer/<id>`. Requests WGS84 (4326) and
    prefers GeoJSON, defensively falling back to Esri JSON (paths) when a service does
    not support `f=geojson`. ArcGIS returns errors as JSON with HTTP 200 — that is
    detected and raised. Worker-only; no credentials/tokens are ever sent or stored.
    `trusted` holds ERIS-derived properties (e.g. the road class implied by WHICH layer
    was queried); they are written AFTER provider attributes and can never be spoofed."""
    import requests

    s = session or requests.Session()
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    url = layer_url.rstrip("/") + "/query"
    last_err = None
    for fmt in ("geojson", "json"):  # prefer GeoJSON; fall back to Esri JSON
        params = {
            "where": "1=1", "geometry": bbox, "geometryType": "esriGeometryEnvelope",
            "inSR": "4326", "outSR": "4326", "spatialRel": "esriSpatialRelIntersects",
            "outFields": out_fields, "returnGeometry": "true", "f": fmt,
        }
        try:
            resp = s.get(url, params=params, timeout=timeout_s)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and data.get("error"):
                last_err = str(data["error"])[:160]
                continue  # unsupported format / query error -> try the next format
            feats = data.get("features") if isinstance(data, dict) else None
            return normalize_road_features(feats, keep_props=keep_props, trusted=trusted)
        except Exception as e:  # noqa: BLE001 - try the next format, else fail this layer
            last_err = str(e)[:160]
            continue
    raise RuntimeError(f"road layer query failed: {last_err}")


def fetch_arcgis_road_features(bounds: dict, *, source_url: str, timeout_s: int, session=None) -> list:
    """Opt-in adapter (`arcgis_feature_service`): query a single configured ArcGIS
    FeatureServer/MapServer LINE layer intersecting the (buffered) bounds. Retained for a
    future authorized Caltrans/ArcGIS Enterprise centerline layer. Worker-only; NO
    credentials are placed in the manifest/logs/mobile. No attributes are packaged."""
    return fetch_arcgis_line_layer(
        source_url, bounds, timeout_s=timeout_s, session=session, out_fields="", keep_props=None
    )


def parse_tigerweb_layers(spec) -> list:
    """Parse "2,6,8" -> [2, 6, 8]. Defensive: junk entries are ignored."""
    out: list = []
    for part in str(spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if n >= 0 and n not in out:
            out.append(n)
    return out


def tigerweb_source_meta(base_url: str) -> dict:
    """TRUTHFUL provenance for packaged TIGERweb road centerlines. TIGERweb is public
    U.S. Census road geometry used as SNAP CONTEXT — it must NEVER be labelled Caltrans,
    ERIS Road Inventory, ArcGIS Enterprise, engineering-grade or survey-grade."""
    return {
        "provider": "us_census_tigerweb",
        "dataset": "U.S. Census Bureau TIGERweb Transportation Roads",
        "attribution": "U.S. Census Bureau",
        "service": base_url,  # sanitized (query/userinfo stripped) by sanitize_source
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


def fetch_tigerweb_road_features(
    bounds: dict, *, base_url: str, layers, timeout_s: int, session=None
) -> list:
    """Query the configured public TIGERweb Transportation road layers (default 2=Primary,
    6=Secondary, 8=Local) against the (buffered) bounds and COMBINE the results.

    One layer failing must NOT discard the successful layers. If EVERY layer fails, this
    raises (the builder degrades the roads layer to reason='source_error'). Results carry
    only the safe attribute allowlist plus the ERIS-TRUSTED road class derived from the
    LAYER ID we queried (source_layer_id / road_class / road_class_label), and are
    de-duplicated keeping the HIGHEST class (primary > secondary > local) regardless of
    query order. Credential-free, worker-only.
    """
    ids = parse_tigerweb_layers(layers)
    if not base_url or not ids:
        raise RuntimeError("TIGERweb base URL / layers not configured")
    combined: list = []
    failures = 0
    for lid in ids:
        layer_url = f"{base_url.rstrip('/')}/{int(lid)}"
        rc = road_class_for_layer(lid)
        trusted = {
            "source_layer_id": int(lid),
            "road_class": rc,
            "road_class_label": road_class_label(rc),
        }
        try:
            combined.extend(
                fetch_arcgis_line_layer(
                    layer_url, bounds, timeout_s=timeout_s, session=session,
                    out_fields="*", keep_props=TIGER_ROAD_PROPS, trusted=trusted,
                )
            )
        except Exception:  # noqa: BLE001 - a single layer failing is tolerated
            failures += 1
    if failures == len(ids):
        raise RuntimeError(f"all {len(ids)} TIGERweb road layers failed")
    return dedupe_line_features(combined)
