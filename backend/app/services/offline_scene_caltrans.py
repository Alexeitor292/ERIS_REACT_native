"""
Caltrans CRS Functional Classification offline road-centerline source (``caltrans_crs``).

OPTIONAL, operator-selected road provider (``OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs``).
It packages the California STATE HIGHWAY SYSTEM — highways and freeways, NOT every
local street — into the ``.eristerrain`` bundle's ``roads.geojson`` from the PUBLIC
Caltrans CRS Functional Classification ArcGIS Feature Service:

    https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0

Design boundaries (mirrors docs/adr-offline-road-context-source.md):
  * This module holds the PURE filter/normalization (unit-tested, no network) and the
    WORKER-ONLY paginated fetch (``requests``); it is imported by the package builder.
  * Selection is EXPLICIT — the endpoint being reachable is never enough; the operator
    must set the provider. No credentials are required (public service) and none are
    ever sent, logged, or placed in the manifest.
  * Upstream ArcGIS data is UNTRUSTED input: geometry type, coordinates, JSON shape,
    response size, and field values are all validated/allow-listed before packaging.
  * Package file names are fixed by trusted code; nothing here is derived from upstream
    data.

The layer exposes exactly these fields (verified against the live service):
    OBJECTID (OID) · EventID · RouteID (str, e.g. "SHS_050._P") ·
    F_System (SmallInteger functional-classification code) ·
    County_label (str) · Caltrans_District (SmallInteger)

The ONLY classification lever the layer offers is ``F_System`` (there is no explicit
state-highway/ownership field), so the ERIS highway/freeway filter is built on it.
``RouteID`` values confirm the included classes are State Highway System routes
("SHS_" prefix), and are preserved as display metadata for feature identification.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from . import offline_scene_context as context_fmt

# ---- provider identity -----------------------------------------------------

CALTRANS_PROVIDER = "caltrans_crs"
CALTRANS_DEFAULT_LAYER_URL = (
    "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/"
    "CHhighway/CRS_Functional_Classification/FeatureServer/0"
)

# Layer attribute field names (verified against the live service metadata).
OBJECTID_FIELD = "OBJECTID"
ROUTE_FIELD = "RouteID"
FUNCTIONAL_CLASS_FIELD = "F_System"
COUNTY_FIELD = "County_label"
DISTRICT_FIELD = "Caltrans_District"
# Explicit outFields allowlist — never "*". Only what ERIS packages/derives.
OUT_FIELDS: tuple[str, ...] = (
    OBJECTID_FIELD,
    ROUTE_FIELD,
    FUNCTIONAL_CLASS_FIELD,
    COUNTY_FIELD,
    DISTRICT_FIELD,
)

# F_System functional-classification codes -> human labels (verbatim from the layer).
FUNCTIONAL_CLASS_LABELS: dict[int, str] = {
    1: "Interstate",
    2: "Principal Arterial - Other Freeways and Expressways",
    3: "Principal Arterial - Other",
    4: "Minor Arterial",
    5: "Major Collector",
    6: "Minor Collector",
    7: "Local",
}

# ERIS scope = California highways/freeways. The DEFAULT inclusion set captures the
# state highway system while excluding ordinary local streets:
#   1 Interstate, 2 Other Freeways & Expressways, 3 Other Principal Arterials.
# Rationale + known gaps are documented in the ADR/runbook: some rural State Routes are
# functionally classified as Minor Arterial (4) or Major Collector (5) and are excluded
# by default (operator can widen the set); conversely a few F_System 3 principal
# arterials are not state highways. F_System is the only classification lever the layer
# exposes. Operator-tunable via OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES.
DEFAULT_FUNCTIONAL_CLASSES: tuple[int, ...] = (1, 2, 3)

# F_System -> ERIS-trusted road_class (the 4-value vocabulary the manifest + native
# renderer understand: primary > secondary > local > unclassified). Everything ERIS
# packages by default (1,2,3) is a highway -> "primary" (visible + selectable by the
# native highway-first UI). If an operator widens the set, arterials/collectors map to
# lower classes so the hierarchy still reads. The exact interstate/freeway/arterial
# distinction is preserved separately in ``functional_class``/``functional_class_label``.
FUNCTIONAL_CLASS_TO_ROAD_CLASS: dict[int, str] = {
    1: "primary",
    2: "primary",
    3: "primary",
    4: "secondary",
    5: "secondary",
    6: "local",
    7: "local",
}

# Versioned identity of the inclusion/normalization policy. The effective version folds
# in the included F_System set (see caltrans_filter_version) so a package's
# content_signature + manifest ``filter_version`` change when the filter changes.
CALTRANS_FILTER_BASE = "caltrans_crs.v1"

# Defensive bound on a single feature's vertex count (a malformed/huge geometry is
# dropped rather than packaged). Real Caltrans segments are far below this.
DEFAULT_MAX_COORDS_PER_FEATURE = 20_000
# Deterministic coordinate precision (~0.11 m at 6 dp) so equivalent input serializes to
# equivalent bytes.
COORD_PRECISION = 6


class CaltransFetchError(RuntimeError):
    """A Caltrans road fetch failed. Operator-safe message; no secrets."""


class CaltransPermanentError(CaltransFetchError):
    """A non-transient failure (bad query, HTML/non-JSON body, oversized response,
    non-https URL). Not retried."""


class CaltransFetchCancelled(CaltransFetchError):
    """The generation job was cancelled between pages."""


# ---- pure: functional-class filter (injection-proof) -----------------------


def parse_functional_classes(spec, default: tuple[int, ...] = DEFAULT_FUNCTIONAL_CLASSES) -> tuple[int, ...]:
    """Parse "1,2,3" -> (1, 2, 3). Junk entries and out-of-range codes are ignored;
    duplicates collapsed; result sorted. An empty/invalid spec falls back to ``default``
    so a typo never silently queries an empty set."""
    out: list[int] = []
    for part in str(spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if n in FUNCTIONAL_CLASS_LABELS and n not in out:
            out.append(n)
    return tuple(sorted(out)) if out else tuple(sorted(set(default)))


def build_where_clause(classes) -> str:
    """Build the ArcGIS ``where`` clause ``F_System IN (1, 2, 3)`` from a validated set
    of integer functional-class codes.

    SECURITY: only ints that exist in FUNCTIONAL_CLASS_LABELS are ever interpolated — no
    untrusted string is ever concatenated into a where clause. Raises ValueError on an
    empty or invalid set."""
    codes: list[int] = []
    for c in classes or []:
        try:
            n = int(c)
        except (TypeError, ValueError) as e:
            raise ValueError(f"functional class {c!r} is not an integer") from e
        if n not in FUNCTIONAL_CLASS_LABELS:
            raise ValueError(f"functional class {n} is not a known F_System code (1-7)")
        codes.append(n)
    if not codes:
        raise ValueError("no functional classes selected for the Caltrans road filter")
    codes = sorted(set(codes))
    return f"{FUNCTIONAL_CLASS_FIELD} IN ({', '.join(str(n) for n in codes)})"


def caltrans_filter_version(classes) -> str:
    """Versioned identity of the filter, embedding the included F_System set so the
    package content signature/manifest change when the inclusion policy changes."""
    codes = ",".join(str(n) for n in sorted({int(c) for c in (classes or [])}))
    return f"{CALTRANS_FILTER_BASE}:F_System[{codes}]"


def functional_class_label(code) -> str:
    try:
        return FUNCTIONAL_CLASS_LABELS.get(int(code), "Unknown functional class")
    except (TypeError, ValueError):
        return "Unknown functional class"


def road_class_for_functional_class(code) -> str:
    """Map an F_System code to the ERIS-trusted road_class vocabulary. Unknown codes are
    honestly 'unclassified' (never silently a highway)."""
    try:
        return FUNCTIONAL_CLASS_TO_ROAD_CLASS.get(int(code), "unclassified")
    except (TypeError, ValueError):
        return "unclassified"


def caltrans_route_label(route_id) -> str | None:
    """A conservative human route label from a Caltrans RouteID (e.g. "SHS_050._P" ->
    "Route 50"). Does not assert Interstate/US/State prefix (the id does not encode it).
    Falls back to the trimmed raw id when no route number is present; None when empty."""
    if not isinstance(route_id, str):
        return None
    s = route_id.strip()
    if not s:
        return None
    m = re.search(r"(\d{1,3})", s)
    if m:
        return f"Route {int(m.group(1))}"
    return s[:48]


# ---- pure: normalization (untrusted upstream -> deterministic GeoJSON) ------


def _finite_lonlat(lon, lat) -> bool:
    return (
        isinstance(lon, (int, float))
        and isinstance(lat, (int, float))
        and not isinstance(lon, bool)
        and not isinstance(lat, bool)
        and math.isfinite(lon)
        and math.isfinite(lat)
        and -180.0 <= lon <= 180.0
        and -90.0 <= lat <= 90.0
    )


def _int_or_none(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v):
        return int(v)
    if isinstance(v, str):
        try:
            return int(v.strip())
        except ValueError:
            return None
    return None


def _clean_part(coords, precision: int) -> list:
    """Finite, in-range [lon,lat] vertices only, rounded to ``precision`` and with
    adjacent duplicates collapsed. Defensive — nothing is invented."""
    out: list = []
    for c in coords or []:
        if not (isinstance(c, (list, tuple)) and len(c) >= 2):
            continue
        lon, lat = c[0], c[1]
        if not _finite_lonlat(lon, lat):
            continue
        p = [round(float(lon), precision), round(float(lat), precision)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def _geometry_to_geojson_line(geom, precision: int, max_coords: int):
    """Coerce a GeoJSON (LineString/MultiLineString) or Esri (paths) geometry into a
    clean GeoJSON line geometry. Returns None for anything that is not a valid line
    (points/polygons, empty, or exceeding ``max_coords`` vertices)."""
    if not isinstance(geom, dict):
        return None
    gtype = geom.get("type")
    raw_parts: list = []
    if gtype == "LineString" and isinstance(geom.get("coordinates"), list):
        raw_parts = [geom["coordinates"]]
    elif gtype == "MultiLineString" and isinstance(geom.get("coordinates"), list):
        raw_parts = [p for p in geom["coordinates"] if isinstance(p, list)]
    elif isinstance(geom.get("paths"), list):  # Esri polyline
        raw_parts = [p for p in geom["paths"] if isinstance(p, list)]
    else:
        return None

    total = 0
    parts: list = []
    for rp in raw_parts:
        cleaned = _clean_part(rp, precision)
        if len(cleaned) < 2:
            continue
        total += len(cleaned)
        if total > max_coords:
            return None  # excessive coordinate count -> reject the whole feature
        parts.append(cleaned)
    if not parts:
        return None
    if len(parts) == 1:
        return {"type": "LineString", "coordinates": parts[0]}
    return {"type": "MultiLineString", "coordinates": parts}


def _attributes(feature: dict) -> dict:
    """Attribute bag from a GeoJSON (``properties``) or Esri (``attributes``) feature."""
    props = feature.get("properties")
    if isinstance(props, dict):
        return props
    attrs = feature.get("attributes")
    return attrs if isinstance(attrs, dict) else {}


def _clip_str(v, limit: int) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s[:limit] if s else None


def build_caltrans_properties(attrs: dict, fsys: int) -> dict:
    """Minimal, explicit property schema for a normalized Caltrans road feature. The
    ERIS-TRUSTED fields (road_class/road_class_label/kind) are written LAST and derived
    from ``fsys`` (never from an upstream attribute) so no provider value can spoof
    them. Oversized string fields are clipped."""
    props: dict = {}
    oid = _int_or_none(attrs.get(OBJECTID_FIELD))
    if oid is not None:
        props["source_feature_id"] = oid
    route_id = _clip_str(attrs.get(ROUTE_FIELD), 64)
    if route_id:
        props["route_id"] = route_id
        name = caltrans_route_label(route_id)
        if name:
            props["NAME"] = name[:48]  # candidate/callout title in the native renderer
    props["functional_class"] = fsys
    props["functional_class_label"] = functional_class_label(fsys)
    county = _clip_str(attrs.get(COUNTY_FIELD), 48)
    if county:
        props["county"] = county
    district = _int_or_none(attrs.get(DISTRICT_FIELD))
    if district is not None:
        props["district"] = district
    props["provider"] = CALTRANS_PROVIDER
    # ERIS-trusted (unspoofable) — written last, derived from F_System only.
    rc = road_class_for_functional_class(fsys)
    props["road_class"] = rc
    props["road_class_label"] = context_fmt.road_class_label(rc)
    props["kind"] = "road_centerline"
    return props


def normalize_caltrans_features(
    features,
    *,
    included_classes,
    coord_precision: int = COORD_PRECISION,
    max_coords_per_feature: int = DEFAULT_MAX_COORDS_PER_FEATURE,
) -> list:
    """Normalize an ArcGIS query response's features (GeoJSON or Esri JSON) into ERIS
    line Features tagged ``kind='road_centerline'`` with the minimal Caltrans schema.

    Client-side filtering: a feature is DROPPED unless its ``F_System`` is one of
    ``included_classes`` (belt-and-suspenders with the server ``where`` clause, and the
    behavior for unknown/missing classification is 'drop, never guess'). Non-line and
    invalid-coordinate geometries are dropped. Deterministic — coordinates are rounded
    to ``coord_precision``."""
    included = {int(c) for c in included_classes}
    out: list = []
    for f in features or []:
        if not isinstance(f, dict):
            continue
        attrs = _attributes(f)
        fsys = _int_or_none(attrs.get(FUNCTIONAL_CLASS_FIELD))
        if fsys is None or fsys not in included:
            continue
        geom = _geometry_to_geojson_line(f.get("geometry"), coord_precision, max_coords_per_feature)
        if geom is None:
            continue
        out.append({"type": "Feature", "geometry": geom, "properties": build_caltrans_properties(attrs, fsys)})
    return out


def _geometry_key(feature: dict) -> tuple:
    geom = feature.get("geometry") or {}
    t = geom.get("type")
    coords = geom.get("coordinates")
    if t == "LineString":
        parts = [coords]
    elif t == "MultiLineString":
        parts = coords or []
    else:
        parts = []
    return tuple(
        tuple((round(float(c[0]), 6), round(float(c[1]), 6)) for c in p if isinstance(c, (list, tuple)) and len(c) >= 2)
        for p in parts
        if isinstance(p, list)
    )


def _sort_key(feature: dict):
    fid = (feature.get("properties") or {}).get("source_feature_id")
    # Deterministic ordering: by stable feature id when present (id-bearing features
    # first), then by geometry so the serialized bytes are reproducible.
    return (0, int(fid)) if isinstance(fid, int) else (1, 0), _geometry_key(feature)


def dedupe_caltrans_features(features) -> list:
    """Deterministically drop repeats by stable feature id (OBJECTID -> source_feature_id),
    falling back to a direction-agnostic geometry key when a feature carries no id.
    Returns features in a stable, reproducible order."""
    seen: set = set()
    out: list = []
    for f in features or []:
        fid = (f.get("properties") or {}).get("source_feature_id")
        key = ("id", int(fid)) if isinstance(fid, int) else ("geom", _geometry_key(f))
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    out.sort(key=_sort_key)
    return out


# ---- pure: provenance ------------------------------------------------------


def caltrans_source_meta(layer_url: str, retrieved_at: str | None = None) -> dict:
    """TRUTHFUL provenance for packaged Caltrans road centerlines. This is authoritative
    Caltrans functional-classification linework used as ERIS road CONTEXT — it is not
    survey/engineering-grade centerline and ERIS does not own or author it. Only
    provenance keys are emitted (sanitized downstream by ``sanitize_source``)."""
    return {
        "provider": CALTRANS_PROVIDER,
        "dataset": "Caltrans CRS Functional Classification (California highways & freeways)",
        "attribution": (
            "California Department of Transportation (Caltrans), CRS Functional "
            "Classification / Linear Reference System-derived data"
        ),
        "service": layer_url,  # sanitize_source strips any query/userinfo
        "retrieved_at": retrieved_at or datetime.now(timezone.utc).isoformat(),
    }


# ---- worker-only: paginated network fetch ----------------------------------


def _require_https(url: str) -> None:
    p = urlparse(url or "")
    if p.scheme != "https":
        raise CaltransPermanentError("Caltrans layer URL must be https (operator-configured, trusted)")
    if not p.hostname:
        raise CaltransPermanentError("Caltrans layer URL is missing a host")


def _timeout(timeout_s: int) -> tuple[float, float]:
    """(connect, read) timeouts — a short connect bound, the configured read bound."""
    t = float(max(1, int(timeout_s)))
    return (min(10.0, t), t)


def _page_params(where: str, bbox: str, out_fields: str, offset: int, page_size: int) -> dict:
    """One page's ArcGIS query params. Only the AOI envelope is queried; WGS84 in/out;
    stable OBJECTID ordering for deterministic pagination."""
    return {
        "where": where,
        "geometry": bbox,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": out_fields,
        "returnGeometry": "true",
        "orderByFields": OBJECTID_FIELD,
        "resultOffset": str(int(offset)),
        "resultRecordCount": str(int(page_size)),
        "f": "geojson",
    }


def _fetch_page(session, url: str, params: dict, timeout_s: int, max_response_bytes: int) -> dict:
    """GET one page and validate it is a well-formed, bounded ArcGIS JSON response.
    ArcGIS returns errors as JSON (or an HTML page) with HTTP 200 — both are detected."""
    resp = session.get(url, params=params, timeout=_timeout(timeout_s))
    resp.raise_for_status()
    headers = getattr(resp, "headers", {}) or {}
    ctype = str(headers.get("Content-Type", "")).lower()
    content = getattr(resp, "content", None)
    if content is not None and max_response_bytes and len(content) > int(max_response_bytes):
        raise CaltransPermanentError(f"Caltrans response exceeded the {max_response_bytes}-byte limit")
    if "html" in ctype:
        raise CaltransPermanentError("Caltrans returned an HTML error page, not JSON")
    try:
        data = resp.json()
    except Exception as e:  # noqa: BLE001 - malformed body is permanent
        raise CaltransPermanentError(f"Caltrans returned a non-JSON body: {str(e)[:120]}") from e
    if not isinstance(data, dict):
        raise CaltransPermanentError("Caltrans response was not a JSON object")
    if data.get("error"):
        raise CaltransPermanentError(f"Caltrans query error: {str(data['error'])[:160]}")
    return data


def _exceeded_transfer_limit(data: dict) -> bool:
    """True when the service signals more records remain. Checked both at the
    FeatureCollection top level and under ``properties`` (Esri varies by output/version)."""
    if data.get("exceededTransferLimit") is True:
        return True
    props = data.get("properties")
    return isinstance(props, dict) and props.get("exceededTransferLimit") is True


def fetch_caltrans_road_features(
    bounds: dict,
    *,
    layer_url: str,
    functional_classes,
    timeout_s: int,
    page_size: int = 1000,
    max_features: int = 20_000,
    max_pages: int = 100,
    max_response_bytes: int = 32 * 1024 * 1024,
    retries: int = 2,
    base_delay_s: float = 0.5,
    session=None,
    sleep=None,
    monotonic=None,
    jitter=None,
    cancel_check=None,
) -> list:
    """Query the Caltrans CRS Functional Classification FeatureServer line layer for the
    (buffered) AOI envelope and return normalized, de-duplicated ERIS road features.

    WORKER-ONLY (uses ``requests``). Safety + reliability, per the ADR:
      * https-only, operator-configured URL (never a client/runtime-supplied URL);
      * bounded pagination via ``resultOffset``/``resultRecordCount`` with
        ``exceededTransferLimit`` detection, hard-capped by ``max_pages``/``max_features``
        so it can never loop forever or download the statewide dataset;
      * bounded retry with backoff + jitter for transient failures (permanent errors —
        bad query, HTML/non-JSON, oversize — are not retried);
      * cancellation re-checked between pages when ``cancel_check`` is supplied;
      * every response is validated (JSON shape, geometry type, coordinate ranges) and
        de-duplicated deterministically by OBJECTID.

    Returns [] when the AOI genuinely contains no matching highway features. Raises
    CaltransFetchError on an unrecoverable failure (the builder degrades or fails per the
    required/optional policy). No credentials are ever sent, logged, or packaged."""
    from . import offline_scene_imagery as imagery  # run_with_retries (bounded, injectable clock)

    _require_https(layer_url)
    where = build_where_clause(functional_classes)
    included = parse_functional_classes(",".join(str(int(c)) for c in functional_classes))
    if session is None:
        import requests

        session = requests.Session()
    query_url = layer_url.rstrip("/") + "/query"
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    out_fields = ",".join(OUT_FIELDS)
    page_size = max(1, int(page_size))

    def _retryable(exc: Exception) -> bool:
        return not isinstance(exc, (CaltransPermanentError, CaltransFetchCancelled))

    features: list = []
    seen: set = set()
    offset = 0
    pages = 0
    while True:
        if cancel_check is not None and cancel_check():
            raise CaltransFetchCancelled("Caltrans road fetch cancelled between pages")
        if pages >= int(max_pages):
            break  # bound reached; caller logs the (rare) truncation
        params = _page_params(where, bbox, out_fields, offset, page_size)

        def _do(_attempt, _params=params):
            return _fetch_page(session, query_url, _params, timeout_s, max_response_bytes)

        try:
            data = imagery.run_with_retries(
                _do, retries=int(retries), base_delay_s=float(base_delay_s),
                sleep=sleep, monotonic=monotonic, jitter=jitter, is_retryable=_retryable,
            )
        except CaltransFetchError:
            raise
        except Exception as e:  # noqa: BLE001 - normalize any transport failure
            raise CaltransFetchError(f"Caltrans road fetch failed: {imagery.sanitize_reason(e)}") from e

        raw = data.get("features") if isinstance(data.get("features"), list) else []
        page_feats = normalize_caltrans_features(raw, included_classes=included)
        for feat in page_feats:
            fid = feat["properties"].get("source_feature_id")
            key = ("id", int(fid)) if isinstance(fid, int) else ("geom", _geometry_key(feat))
            if key in seen:
                continue
            seen.add(key)
            features.append(feat)
            if len(features) >= int(max_features):
                break

        pages += 1
        if len(features) >= int(max_features):
            break
        if len(raw) == 0:
            break  # empty (final) page
        # Continue only while the service says more remain OR the page was full; the
        # max_pages/max_features caps still bound the loop in every case.
        if not (_exceeded_transfer_limit(data) or len(raw) >= page_size):
            break
        offset += page_size

    return dedupe_caltrans_features(features)
