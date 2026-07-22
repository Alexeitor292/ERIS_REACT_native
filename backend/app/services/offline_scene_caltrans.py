"""
Caltrans CRS Functional Classification offline road-context source (``caltrans_crs``).

OPTIONAL, operator-selected road provider (``OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs``)
that packages **Caltrans freeway/expressway road context** for the package AOI into the
``.eristerrain`` bundle's ``roads.geojson``, from the PUBLIC Caltrans CRS Functional
Classification ArcGIS Feature Service:

    https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0

WHAT THIS SOURCE IS — AND IS NOT
--------------------------------
This layer publishes **functional classification** (how a road FUNCTIONS in the network),
NOT **ownership or jurisdiction**. Therefore:

  * ``F_System`` does **not** prove a road belongs to the California State Highway System
    (SHS), and ERIS must never describe a filtered subset of it as "the state highway
    system".
  * Returned features are **not** necessarily Caltrans-owned, nor necessarily State
    Routes. Many functionally-classified roads are city/county facilities.
  * ``RouteID`` (e.g. ``"SHS_050._P"``) is a provider LRS route identifier. Its prefix is
    a provider naming convention and is treated as a *display* hint only — never as proof
    of ownership.

A true SHS/ownership provider must come from a source that explicitly represents the SHS
(e.g. the Caltrans Postmile / LRS network), not from inferring ownership out of
``F_System``. See docs/adr-offline-road-context-source.md ("Future state-highway provider
boundary").

Design boundaries (mirrors the ADR):
  * PURE filter/normalization/identity here (unit-tested, no network); the paginated fetch
    is WORKER-ONLY (``requests``) and is imported by the package builder.
  * Selection is EXPLICIT — a reachable endpoint never activates a provider on its own.
    No credentials are required (public service) and none are sent, logged, or packaged.
  * Upstream ArcGIS data is UNTRUSTED input: JSON shape, geometry type, coordinates,
    response size, and field values are validated/allow-listed before packaging, and
    upstream text is NEVER injected into manifest/UI attribution.
  * Package file names are fixed by trusted code; nothing is derived from upstream data.

Layer fields (verified against the live service):
    OBJECTID (OID) · EventID (persistent provider event id) · RouteID (str) ·
    F_System (SmallInteger functional-classification code) ·
    County_label (str) · Caltrans_District (SmallInteger)
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from . import offline_scene_context as context_fmt

# ---- provider identity -----------------------------------------------------

CALTRANS_PROVIDER = "caltrans_crs"
# Human-facing display name. Truthful: names the dataset, claims no ownership.
CALTRANS_DISPLAY_NAME = "Caltrans CRS Functional Classification"

CALTRANS_DEFAULT_LAYER_URL = (
    "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/"
    "CHhighway/CRS_Functional_Classification/FeatureServer/0"
)

# Layer attribute field names (verified against the live service metadata).
OBJECTID_FIELD = "OBJECTID"
EVENT_ID_FIELD = "EventID"
ROUTE_FIELD = "RouteID"
FUNCTIONAL_CLASS_FIELD = "F_System"
COUNTY_FIELD = "County_label"
DISTRICT_FIELD = "Caltrans_District"
# Explicit outFields allowlist — never "*". Only what ERIS packages/derives.
OUT_FIELDS: tuple[str, ...] = (
    OBJECTID_FIELD,
    EVENT_ID_FIELD,
    ROUTE_FIELD,
    FUNCTIONAL_CLASS_FIELD,
    COUNTY_FIELD,
    DISTRICT_FIELD,
)

# F_System functional-classification codes -> human labels (verbatim from the layer).
# These describe FUNCTION, not ownership.
FUNCTIONAL_CLASS_LABELS: dict[int, str] = {
    1: "Interstate",
    2: "Principal Arterial - Other Freeways and Expressways",
    3: "Principal Arterial - Other",
    4: "Minor Arterial",
    5: "Major Collector",
    6: "Minor Collector",
    7: "Local",
}

# PRODUCT POLICY (default): freeway/expressway-focused context.
#   1 = Interstate, 2 = Other Freeways and Expressways.
# Class 3 ("Principal Arterial - Other") is a SURFACE arterial — it is NOT a freeway and is
# therefore NOT included by default. Operators may opt in (e.g. "1,2,3") when they want
# broader principal-arterial context. Classes 4-7 (minor arterial / collectors / local) are
# outside ERIS's highway scope. Tunable via OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES.
DEFAULT_FUNCTIONAL_CLASSES: tuple[int, ...] = (1, 2)

# F_System -> ERIS-trusted road_class (the 4-value vocabulary the manifest + native
# renderer understand: primary > secondary > local > unclassified). Only the
# freeway/expressway classes are "primary"; a surface principal arterial (3) is
# deliberately NOT presented as a freeway.
FUNCTIONAL_CLASS_TO_ROAD_CLASS: dict[int, str] = {
    1: "primary",    # Interstate (freeway)
    2: "primary",    # Other Freeways and Expressways
    3: "secondary",  # Principal Arterial - Other (surface arterial, NOT a freeway)
    4: "secondary",  # Minor Arterial
    5: "local",
    6: "local",
    7: "local",
}

# Versioned identity of the inclusion/normalization policy. v2 = freeway/expressway
# default (1,2) + truthful class mapping + durable feature identity. The effective version
# folds in the included F_System set (see caltrans_filter_version) so a package's
# content_signature + manifest ``filter_version`` change when the filter changes.
CALTRANS_FILTER_BASE = "caltrans_crs.v2"

# Version of the durable feature-identity formula (bump only on a deliberate change).
IDENTITY_VERSION = 1

# Defensive bound on a single feature's vertex count (a malformed/huge geometry is dropped
# rather than packaged). Real Caltrans segments are far below this.
DEFAULT_MAX_COORDS_PER_FEATURE = 20_000
# Deterministic coordinate precision (~0.11 m at 6 dp) so equivalent input serializes to
# equivalent bytes.
COORD_PRECISION = 6


class CaltransFetchError(RuntimeError):
    """A Caltrans road fetch failed. Operator-safe message; no secrets."""


class CaltransPermanentError(CaltransFetchError):
    """A non-transient failure (bad query, HTML/non-JSON body, oversized response,
    non-https URL). Not retried."""


class CaltransIncompleteSourceError(CaltransFetchError):
    """A configured pagination cap (max pages / max features) was reached while the
    service indicated MORE matching features remain. The result is a known-truncated
    subset and must NEVER be packaged as a complete, available road layer."""


class CaltransFetchCancelled(CaltransFetchError):
    """The generation job was cancelled between pages."""


# ---- pure: functional-class filter (injection-proof) -----------------------


def parse_functional_classes(spec) -> tuple[int, ...]:
    """Parse a functional-class selection STRICTLY: "1,2" -> (1, 2); "2,1,2" -> (1, 2).

    A wholly or partly invalid operator value is REJECTED (ValueError) rather than silently
    collapsing to the default — an operator who mistypes the policy must be told, not
    quietly given a different road scope. Rejects malformed entries ("1,x"), floating-point
    values ("1.9"), out-of-range codes ("8", "0") and an empty effective set ("", ",").
    Duplicates collapse and the result is deterministically ordered.

    The declared configuration default applies only when the setting is genuinely omitted
    (pydantic does not validate field defaults), never as a fallback for a supplied value."""
    raw = str(spec if spec is not None else "")
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if not re.fullmatch(r"[+-]?\d+", part):
            raise ValueError(
                f"invalid functional class {part!r}: expected an integer F_System code 1-7"
            )
        n = int(part)
        if n not in FUNCTIONAL_CLASS_LABELS:
            raise ValueError(f"functional class {n} is not a known F_System code (1-7)")
        if n not in out:
            out.append(n)
    if not out:
        raise ValueError(
            "no functional classes selected: expected a comma-separated list of F_System codes 1-7"
        )
    return tuple(sorted(out))


def build_where_clause(classes) -> str:
    """Build the ArcGIS ``where`` clause ``F_System IN (1, 2)`` from a validated set of
    integer functional-class codes.

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


_SHS_ROUTE_RE = re.compile(r"^SHS[_\-]", re.IGNORECASE)


def caltrans_route_label(route_id) -> str | None:
    """A conservative display label from the provider's LRS ``RouteID``.

    ``"SHS_050._P"`` -> ``"Route 50"``. This reflects the PROVIDER'S route identifier only;
    it asserts no Interstate/US/State designation and no ownership. A route id that does
    not use the provider's route-naming convention is passed through verbatim (clipped)
    rather than being reshaped into a "Route N" claim. None when empty."""
    if not isinstance(route_id, str):
        return None
    s = route_id.strip()
    if not s:
        return None
    if _SHS_ROUTE_RE.match(s):
        m = re.search(r"(\d{1,3})", s)
        if m:
            return f"Route {int(m.group(1))}"
    return s[:48]


# ---- pure: durable feature identity ----------------------------------------


def caltrans_layer_key(layer_url: str) -> str:
    """Canonical, credential-free provider/layer context for the durable identity: the
    provider enum plus the service path + layer id (lowercased; host, query and userinfo
    removed so a mirror/host change or a token never alters identity)."""
    try:
        path = (urlparse(str(layer_url or "")).path or "").rstrip("/").lower()
    except Exception:  # noqa: BLE001 - defensive
        path = ""
    return f"{CALTRANS_PROVIDER}:{path}" if path else CALTRANS_PROVIDER


DEFAULT_LAYER_KEY = caltrans_layer_key(CALTRANS_DEFAULT_LAYER_URL)


def canonical_geometry_key(geom) -> list:
    """ORDER-INVARIANT canonical geometry key.

    Coordinates are rounded to COORD_PRECISION; each part is normalized to
    ``min(part, reversed(part))`` so a reversed digitization yields the same key; parts are
    sorted so multi-part ordering cannot change it. Returns a JSON-serializable list."""
    parts: list[tuple] = []
    if isinstance(geom, dict):
        gtype, coords = geom.get("type"), geom.get("coordinates")
        if gtype == "LineString" and isinstance(coords, list):
            raw = [coords]
        elif gtype == "MultiLineString" and isinstance(coords, list):
            raw = [p for p in coords if isinstance(p, list)]
        elif isinstance(geom.get("paths"), list):
            # Esri polyline form — accepted here too, mirroring _geometry_to_geojson_line, so
            # a caller passing raw upstream geometry can never silently get an EMPTY key
            # (which would degrade identity to route+class and collapse distinct segments).
            raw = [p for p in geom["paths"] if isinstance(p, list)]
        else:
            raw = []
        for part in raw:
            pts = tuple(
                (round(float(c[0]), COORD_PRECISION), round(float(c[1]), COORD_PRECISION))
                for c in part
                if isinstance(c, (list, tuple)) and len(c) >= 2 and _finite_lonlat(c[0], c[1])
            )
            if len(pts) >= 2:
                parts.append(min(pts, tuple(reversed(pts))))
    return [[list(pt) for pt in part] for part in sorted(parts)]


def validated_event_id(value) -> str | None:
    """The provider's persistent event identifier (``EventID``) when it is present and
    plausible: a non-empty, bounded, control-character-free string that is not a degenerate
    placeholder (an all-zero GUID or a single repeated character). Anything else is rejected
    so a malformed/placeholder upstream value can never become ERIS identity.

    NOTE: this validates SHAPE only — it cannot prove the provider's ids are unique. Callers
    must therefore never collapse two features on the event-derived identity alone; see
    ``_dedupe_key``."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or len(s) > 128:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in s):
        return None
    stripped = re.sub(r"[{}\-\s]", "", s)
    if stripped and len(set(stripped)) == 1:
        return None  # "{00000000-0000-0000-0000-000000000000}", "0000", "----"
    return s


def _dedupe_key(props: dict, geometry) -> tuple | None:
    """Dedupe key for a normalized feature: the durable identity.

    Safe as a dedupe key because ``source_feature_id`` now ALWAYS folds in canonical
    geometry (plus route + class), so two rows collapse only when they are the same original
    road feature. A shape-valid but non-unique upstream ``EventID`` can no longer make
    distinct geometries share an identity, so it can no longer silently drop roads."""
    sfid = props.get("source_feature_id")
    if not isinstance(sfid, str) or not sfid:
        return None
    return ("sfid", sfid)


def caltrans_source_feature_id(
    *, layer_key: str, event_id=None, route_id=None, functional_class=None, geometry=None
) -> str:
    """DURABLE ERIS identity for ONE original Caltrans road feature.

    ONE formula is used for every feature — canonical geometry is ALWAYS included, even when
    an ``EventID`` is present:

        sha256(identity_version | layer_key | validated EventID or "" |
               normalized RouteID | F_System | canonical_geometry_key)

    Why geometry is always included: ``EventID`` is validated for SHAPE only — the provider
    does not guarantee (and ERIS cannot prove) that it is unique. An earlier event-only
    formula gave several distinct geometries sharing one shape-valid EventID the SAME
    identity, which violates the one-feature-one-identity contract that
    ``road_corridor_pairing`` consumes via ``provider_feature_id``. Including geometry makes
    every distinct original road feature uniquely identified.

    Guarantees (all unit-tested):
      * OBJECTID is excluded — a republication may reassign it, identity must not change;
      * coordinate-order invariant (a reversed digitization yields the same id);
      * multipart-order invariant;
      * independent of response/page ordering;
      * two distinct geometries sharing one EventID get DIFFERENT ids;
      * two distinct RouteID events sharing identical geometry get DIFFERENT ids.

    The provider's event value remains separately available as ``provider_event_id`` for
    provenance and cross-version correlation — that, not ``source_feature_id``, is what
    represents "the same provider event across releases"."""
    try:
        fc = int(functional_class) if functional_class is not None else None
    except (TypeError, ValueError):
        fc = None
    payload = {
        "v": IDENTITY_VERSION,
        "layer": layer_key,
        "event": validated_event_id(event_id) or "",
        "route": (route_id or "").strip().upper() if isinstance(route_id, str) else "",
        "fc": fc,
        "geom": canonical_geometry_key(geometry),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "caltrans:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


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
    """An INTEGRAL value only. A non-integral float/decimal string is rejected rather than
    truncated — silently turning 1.9 into class 1 would fabricate a classification."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if math.isfinite(v) and float(v).is_integer() else None
    if isinstance(v, str):
        s = v.strip()
        if not re.fullmatch(r"[+-]?\d+", s):
            return None  # "1.9", "1e3", "abc" -> not an integral representation
        try:
            return int(s)
        except ValueError:
            return None
    return None


def _clean_part(coords, precision: int) -> list | None:
    """Round one line part to ``precision``, collapsing adjacent duplicate vertices.

    FAIL-CLOSED: returns None if ANY declared vertex is malformed, non-finite, or outside
    WGS84 bounds. ERIS never drops a bad vertex and joins its neighbours, because that would
    INVENT a straight chord across the corrupt point that does not exist in the source. Only
    exact duplicate adjacent vertices are collapsed; no coordinate is created or moved."""
    out: list = []
    for c in coords or []:
        if not (isinstance(c, (list, tuple)) and len(c) >= 2):
            return None
        lon, lat = c[0], c[1]
        if not _finite_lonlat(lon, lat):
            return None
        p = [round(float(lon), precision), round(float(lat), precision)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def _geometry_to_geojson_line(geom, precision: int, max_coords: int):
    """Coerce a GeoJSON (LineString/MultiLineString) or Esri (paths) geometry into a clean
    GeoJSON line geometry.

    Returns None (rejecting the WHOLE feature) for anything that is not a valid line:
    points/polygons, an empty geometry, a part with fewer than two distinct vertices, more
    than ``max_coords`` vertices, or ANY malformed/out-of-range vertex in ANY declared part.
    Rejecting the whole feature is deliberate: a partially-repaired line from an untrusted
    source could silently bridge a gap, and one malformed member of a multipart geometry
    must not be able to create a false connection in the packaged road network."""
    if not isinstance(geom, dict):
        return None
    gtype = geom.get("type")
    raw_parts: list = []
    if gtype == "LineString" and isinstance(geom.get("coordinates"), list):
        raw_parts = [geom["coordinates"]]
    elif gtype == "MultiLineString" and isinstance(geom.get("coordinates"), list):
        if any(not isinstance(p, list) for p in geom["coordinates"]):
            return None  # a malformed multipart member rejects the feature
        raw_parts = list(geom["coordinates"])
    elif isinstance(geom.get("paths"), list):  # Esri polyline
        if any(not isinstance(p, list) for p in geom["paths"]):
            return None
        raw_parts = list(geom["paths"])
    else:
        return None

    total = 0
    parts: list = []
    for rp in raw_parts:
        cleaned = _clean_part(rp, precision)
        if cleaned is None:
            return None  # an invalid vertex rejects the whole feature (never a fabricated chord)
        if len(cleaned) < 2:
            return None  # a declared part with fewer than two distinct vertices is not a line
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


def build_caltrans_properties(attrs: dict, fsys: int, *, layer_key: str, geometry: dict) -> dict:
    """Minimal, explicit property schema for a normalized Caltrans road feature.

    Identity roles are deliberately separated:
      * ``provider_object_id`` — the provider's OBJECTID. Provenance + stable pagination
        ordering + within-response dedupe ONLY. NOT a durable identity (a republication may
        reassign it).
      * ``provider_event_id`` — the provider's persistent ``EventID`` verbatim, when
        published and validated. Provenance/audit.
      * ``source_feature_id`` — the DURABLE ERIS identity (see caltrans_source_feature_id).
      * ``provider_feature_id`` — the provider-scoped durable identity handed to the
        divided-corridor pairing pass, which PREFERS it over its own geometry-only hash
        (``road_corridor_pairing.PROVIDER_ID_KEYS``). It carries the same value as
        ``source_feature_id``; supplying it keeps the pairing pass's derived ids unique per
        source feature, because that pass's fallback context (source_layer_id/kind/
        road_class) is identical for every Caltrans feature and would otherwise collide for
        two distinct route events sharing one alignment.

    The ERIS-TRUSTED fields (road_class/road_class_label/kind) are written LAST and derived
    from ``fsys`` only (never from an upstream attribute) so no provider value can spoof
    them. Oversized string fields are clipped."""
    props: dict = {}
    oid = _int_or_none(attrs.get(OBJECTID_FIELD))
    if oid is not None:
        props["provider_object_id"] = oid
    event_id = validated_event_id(attrs.get(EVENT_ID_FIELD))
    if event_id is not None:
        props["provider_event_id"] = event_id
    route_id = _clip_str(attrs.get(ROUTE_FIELD), 64)
    if route_id:
        props["route_id"] = route_id
        name = caltrans_route_label(route_id)
        if name:
            props["NAME"] = name[:48]  # display label in the native identification callout
    durable_id = caltrans_source_feature_id(
        layer_key=layer_key, event_id=event_id, route_id=route_id,
        functional_class=fsys, geometry=geometry,
    )
    props["source_feature_id"] = durable_id
    props["provider_feature_id"] = durable_id
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
    layer_key: str = DEFAULT_LAYER_KEY,
    coord_precision: int = COORD_PRECISION,
    max_coords_per_feature: int = DEFAULT_MAX_COORDS_PER_FEATURE,
) -> list:
    """Normalize an ArcGIS query response's features (GeoJSON or Esri JSON) into ERIS line
    Features tagged ``kind='road_centerline'`` with the minimal Caltrans schema.

    Client-side filtering: a feature is DROPPED unless its ``F_System`` is one of
    ``included_classes`` (belt-and-suspenders with the server ``where`` clause; the behavior
    for unknown/missing classification is 'drop, never guess'). Non-line and
    invalid-coordinate geometries are dropped. Deterministic — coordinates are rounded to
    ``coord_precision``."""
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
        out.append({
            "type": "Feature",
            "geometry": geom,
            "properties": build_caltrans_properties(attrs, fsys, layer_key=layer_key, geometry=geom),
        })
    return out


def _sort_key(feature: dict):
    """Deterministic output ordering by the DURABLE identity (so the serialized bytes do
    not change merely because the provider reassigned OBJECTIDs), with the canonical
    geometry as a stable tiebreak."""
    props = feature.get("properties") or {}
    return (str(props.get("source_feature_id") or ""), json.dumps(
        canonical_geometry_key(feature.get("geometry")), separators=(",", ":")
    ))


def dedupe_caltrans_features(features) -> list:
    """Deterministically drop repeats.

    Within a response the provider's ``OBJECTID`` (``provider_object_id``) identifies a
    repeated row; ``_dedupe_key`` (durable identity + canonical geometry) additionally
    collapses genuinely identical features that arrived under different OBJECTIDs — while
    never collapsing two DIFFERENT geometries that happen to share an upstream event id.
    Output is sorted by the durable identity so it is reproducible."""
    seen_oids: set = set()
    seen_ids: set = set()
    out: list = []
    for f in features or []:
        props = f.get("properties") or {}
        oid = props.get("provider_object_id")
        key = _dedupe_key(props, f.get("geometry"))
        if isinstance(oid, int) and oid in seen_oids:
            continue
        if key is not None and key in seen_ids:
            continue
        if isinstance(oid, int):
            seen_oids.add(oid)
        if key is not None:
            seen_ids.add(key)
        out.append(f)
    out.sort(key=_sort_key)
    return out


# ---- pure: provenance ------------------------------------------------------


def caltrans_source_meta(layer_url: str, retrieved_at: str | None = None) -> dict:
    """TRUTHFUL provenance for packaged Caltrans road context.

    Attribution is TRUSTED and BUILT IN: ERIS always emits its own expected Caltrans credit
    and never copies upstream service text into the manifest/UI, so a missing, changed, or
    malformed upstream ``copyrightText`` can neither remove the credit nor inject arbitrary
    content. This is functional-classification road CONTEXT, not an ownership dataset and
    not survey/engineering-grade centerline; ERIS does not own or author it. Only
    provenance keys are emitted (sanitized downstream by ``sanitize_source``)."""
    return {
        "provider": CALTRANS_PROVIDER,
        "dataset": CALTRANS_DISPLAY_NAME,
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
    """GET one page and validate it is a well-formed, bounded ArcGIS JSON response. ArcGIS
    returns errors as JSON (or an HTML page) with HTTP 200 — both are detected."""
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
    """Query the Caltrans CRS Functional Classification line layer for the (buffered) AOI
    envelope and return normalized, de-duplicated ERIS road features.

    WORKER-ONLY (uses ``requests``). Safety + reliability, per the ADR:
      * https-only, operator-configured URL (never a client/runtime-supplied URL);
      * bounded pagination via ``resultOffset``/``resultRecordCount`` with
        ``exceededTransferLimit`` detection, hard-capped by ``max_pages``/``max_features``;
      * FAIL-CLOSED on truncation: if a cap is reached while the service indicates more
        matching features remain, this raises CaltransIncompleteSourceError rather than
        returning a partial subset — a known-truncated result must never be packaged as an
        available road layer;
      * bounded retry with backoff + jitter for transient failures (permanent errors — bad
        query, HTML/non-JSON, oversize — are not retried);
      * cancellation re-checked between pages when ``cancel_check`` is supplied;
      * every response is validated (JSON shape, geometry type, coordinate ranges) and
        de-duplicated deterministically.

    Returns [] when the AOI genuinely contains no matching features. Raises
    CaltransFetchError (or a subclass) on an unrecoverable/incomplete result; the builder
    then degrades or fails per the required/optional policy. No credentials are ever sent,
    logged, or packaged."""
    from . import offline_scene_imagery as imagery  # run_with_retries (bounded, injectable clock)

    _require_https(layer_url)
    where = build_where_clause(functional_classes)
    included = parse_functional_classes(",".join(str(int(c)) for c in functional_classes))
    layer_key = caltrans_layer_key(layer_url)
    if session is None:
        import requests

        session = requests.Session()
    query_url = layer_url.rstrip("/") + "/query"
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    out_fields = ",".join(OUT_FIELDS)
    page_size = max(1, int(page_size))
    max_features = int(max_features)
    max_pages = int(max_pages)

    def _retryable(exc: Exception) -> bool:
        return not isinstance(exc, (CaltransPermanentError, CaltransFetchCancelled))

    features: list = []
    seen_oids: set = set()
    seen_ids: set = set()
    offset = 0
    pages = 0
    truncated = False
    truncation_reason = ""
    while True:
        if cancel_check is not None and cancel_check():
            raise CaltransFetchCancelled("Caltrans road fetch cancelled between pages")
        if pages >= max_pages:
            # We only re-enter the loop when more results were indicated, so hitting the
            # page cap here means the result set is genuinely incomplete.
            truncated = True
            truncation_reason = f"page cap ({max_pages}) reached with more features available"
            break
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
        page_feats = normalize_caltrans_features(raw, included_classes=included, layer_key=layer_key)
        hit_cap = False
        for feat in page_feats:
            props = feat["properties"]
            oid = props.get("provider_object_id")
            key = _dedupe_key(props, feat.get("geometry"))
            # Dedupe FIRST: an already-seen row is not "dropped work", so it must not trip
            # the feature cap and turn a complete result into a false truncation.
            if (isinstance(oid, int) and oid in seen_oids) or (key is not None and key in seen_ids):
                continue
            if len(features) >= max_features:
                hit_cap = True  # a genuinely new feature had to be dropped
                break
            if isinstance(oid, int):
                seen_oids.add(oid)
            if key is not None:
                seen_ids.add(key)
            features.append(feat)

        pages += 1
        hard_more = _exceeded_transfer_limit(data)
        more_may_exist = hard_more or len(raw) >= page_size
        if hit_cap:
            truncated = True
            truncation_reason = f"feature cap ({max_features}) reached with more features available"
            break
        if len(raw) == 0:
            if hard_more:
                # The service says more records remain but returned none: we cannot make
                # forward progress, so the result is incomplete rather than finished.
                truncated = True
                truncation_reason = "service reported more records but returned an empty page"
            break
        if not more_may_exist:
            break  # short page and no more-records flag -> complete
        if len(features) >= max_features:
            truncated = True
            truncation_reason = f"feature cap ({max_features}) reached with more features available"
            break
        # Advance by what the service ACTUALLY returned, never by the requested page size:
        # ArcGIS clamps resultRecordCount to the layer's maxRecordCount (and may truncate on
        # internal transfer limits), so advancing by page_size would skip the unfetched rows
        # and then exit as if complete — silently losing roads.
        offset += len(raw)

    if truncated:
        raise CaltransIncompleteSourceError(
            f"Caltrans road result is incomplete for this area: {truncation_reason}. "
            "Refusing to package a truncated road layer."
        )
    return dedupe_caltrans_features(features)
