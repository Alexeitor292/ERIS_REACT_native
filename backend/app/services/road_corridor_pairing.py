"""Deterministic station-local divided-highway corridor pairing.

TIGERweb packages a divided highway as TWO primary centerlines (one per carriageway), so
the offline viewer draws two yellow lines through one freeway corridor and offers two
competing selection candidates. This module decides — LOCALLY ALONG THE ROUTE, never
globally by route name or mere proximity — where two primary carriageways share one
corridor, and derives a midpoint centerline for those stretches.

Design (see docs/adr-divided-highway-corridor-pairing.md):

  1. Resample each candidate line at a fixed interval -> stations (lon, lat, s, bearing).
  2. Per station, find a partner by MUTUAL-NEAREST + AXIAL bearing (mod 180, so antiparallel
     carriageways read as 0 and coordinate order does not matter) + a PERPENDICULAR-offset
     gate (rejects end-to-end / merge proximity) + route compatibility + ramp exclusion.
  3. Confirm over a MOVING LONGITUDINAL WINDOW: same partner, real overlap, STABLE
     separation (stdev + |d(sep)/ds| slope), stable bearing, valid midpoint.
  4. Group consecutive paired stations into runs; drop runs shorter than a minimum length
     (this is what rejects brief interchange-only proximity and parallel ramps).
  5. Emit one corridor per ordered pair (feature_id(A) < feature_id(B)) so the A<->B mirror
     is never materialised twice.

STABILITY — NOT PROXIMITY — distinguishes a median from a divergence: a wide but stable
open median stays ONE corridor; a pair whose separation ramps apart is SPLIT even though
every sample sits inside the distance band. There is deliberately no single small
maximum-distance rule.

Pure + deterministic: no I/O, no network, no config import (thresholds are passed in), so
it is unit-testable in the non-DB backend job.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field

from . import road_role

M_PER_DEG_LAT = 111320.0

PAIRING_METHOD = "station_local_mutual_nearest"
PAIRING_VERSION = 1

# TIGER MTFCC for a ramp. Retained for the legacy `is_ramp` helper + tests. Ramp/connector
# exclusion now runs through the PROVIDER-NEUTRAL role model (road_role): pairing consults
# a trusted normalized `road_role` and falls back to this MTFCC signal for a legacy TIGER
# package that carries no role field. caltrans_crs has NO MTFCC, so its ramps/connectors are
# identified by the geometry-based route-chaining pass (road_route_chains), never by MTFCC.
RAMP_MTFCC = "S1630"

# ONLY a real road centerline may become a selection candidate. roads.geojson also carries
# ERIS CONTEXT geometry — the synthetic `road_bearing` line, `road_inventory` geometry and
# `submitted_road_geometry` — which must stay packaged (native still uses the bearing line
# for orientation fallback) but must NEVER be promoted into a selectable road.
ROAD_CENTERLINE_KIND = "road_centerline"

# The FOUR user-selectable candidate kinds. `selection_kind` describes ONLY selectable
# road candidates — a diagnostics-only role must never expand this enum.
SELECTION_DIVIDED_CORRIDOR = "divided_highway_corridor"
SELECTION_INDIVIDUAL_CARRIAGEWAY = "individual_carriageway"
SELECTION_ORDINARY_ROAD = "ordinary_road"
SELECTION_RAMP = "ramp"

SELECTABLE_KINDS = (
    SELECTION_DIVIDED_CORRIDOR,
    SELECTION_INDIVIDUAL_CARRIAGEWAY,
    SELECTION_ORDINARY_ROAD,
    SELECTION_RAMP,
)

# Diagnostics roles live in a SEPARATE namespace (`diagnostic_kind`), never in
# `selection_kind`. A raw paired carriageway segment is retained for the optional
# diagnostics layer but is never a selection candidate.
DIAGNOSTIC_CARRIAGEWAY_MEMBER = "carriageway_member"
DIAGNOSTIC_KINDS = (DIAGNOSTIC_CARRIAGEWAY_MEMBER,)

# Deterministic emission order: role rank, then feature_id. Provider response order must
# never influence roads.geojson bytes (and therefore the package hash).
_ROLE_RANK = {
    SELECTION_DIVIDED_CORRIDOR: 0,
    SELECTION_INDIVIDUAL_CARRIAGEWAY: 1,
    SELECTION_ORDINARY_ROAD: 2,
    SELECTION_RAMP: 3,
}
_DIAGNOSTIC_RANK = 4
_CONTEXT_RANK = 5

# Emitted-part role discriminator for a retained non-centerline context feature, so its
# identity can never collide with a selectable/diagnostic part of the same source geometry.
def context_role(kind) -> str:
    return "context:" + (kind if isinstance(kind, str) and kind else "unknown")

# Provider metadata carried INLINE on every selection candidate (one contract for all
# kinds — native never reads route metadata from two different places).
PROVIDER_INLINE_PROPS = ("NAME", "BASENAME", "MTFCC", "RTTYP", "source_layer_id")

# An authoritative provider feature id is PREFERRED for source identity when present.
# TIGERweb packages none today (the allowlist keeps only NAME/BASENAME/MTFCC/RTTYP), so
# identity falls back to canonicalized geometry. This is the hook for a future source.
PROVIDER_ID_KEYS = ("provider_feature_id",)


class PairingConfigError(ValueError):
    """A pairing threshold is missing, non-finite, or internally inconsistent."""


class DuplicateSourceIdentityError(ValueError):
    """Two DIFFERENT packaged road centerlines resolved to the SAME pairing source identity.

    Pairing keys candidate identity, self/partner exclusion, mutual-nearest exclusion, the
    corridor ordered-pair key, the ``runs`` dict and member-source references on that id — so
    proceeding could apply one component's paired range to another, or resolve the wrong
    partner. The packaging boundary is responsible for handing every independent LineString a
    unique per-part ``provider_feature_id``; this is the FAIL-CLOSED backstop if a duplicate
    still reaches pairing. Callers must not swallow it and publish misleading unpaired output."""


@dataclass(frozen=True)
class PairingParams:
    """Thresholds for the pairing pass. Conservative by default; all are named, validated,
    packaged in the manifest, and tested. See docs/adr-divided-highway-corridor-pairing.md."""

    sample_interval_m: float = 10.0        # deterministic resampling step
    window_m: float = 120.0                # moving longitudinal window
    min_separation_m: float = 4.0          # below this the lines are effectively duplicates
    max_separation_m: float = 120.0        # generous: wide stable medians are allowed
    max_bearing_diff_deg: float = 20.0     # axial (mod 180)
    max_offset_angle_dev_deg: float = 35.0  # offset must be ~perpendicular to the tangent
    sep_stdev_max_m: float = 12.0          # stability, not proximity
    sep_slope_max: float = 0.25            # |d(separation)/ds|; rejects sharp divergence
    min_window_coverage: float = 0.8       # fraction of window stations that must agree
    min_corridor_length_m: float = 150.0   # rejects brief interchange-only proximity
    # BEHAVIOUR-CHANGING (not an epsilon): how far the derived midpoint may sit off-centre
    # before the run splits. Configured + packaged like every other threshold.
    midpoint_tolerance_m: float = 3.0

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        """Fail fast on an unusable threshold set rather than silently mis-pairing."""
        positive = (
            "sample_interval_m", "window_m", "min_separation_m", "max_separation_m",
            "max_bearing_diff_deg", "max_offset_angle_dev_deg", "sep_stdev_max_m",
            "sep_slope_max", "min_corridor_length_m", "midpoint_tolerance_m",
        )
        for name in positive + ("min_window_coverage",):
            v = getattr(self, name)
            if not isinstance(v, (int, float)) or not math.isfinite(float(v)):
                raise PairingConfigError(f"{name} must be a finite number (got {v!r})")
        for name in positive:
            if float(getattr(self, name)) <= 0:
                raise PairingConfigError(f"{name} must be > 0 (got {getattr(self, name)})")
        if not (0.0 < float(self.min_window_coverage) <= 1.0):
            raise PairingConfigError(
                f"min_window_coverage must be in (0, 1] (got {self.min_window_coverage})"
            )
        if float(self.min_separation_m) >= float(self.max_separation_m):
            raise PairingConfigError(
                f"min_separation_m ({self.min_separation_m}) must be < "
                f"max_separation_m ({self.max_separation_m})"
            )
        if float(self.sample_interval_m) < 1.0:
            raise PairingConfigError("sample_interval_m must be >= 1.0 m")
        if float(self.window_m) < 3.0 * float(self.sample_interval_m):
            raise PairingConfigError(
                "window_m must span at least 3 sample intervals "
                f"(>= {3.0 * float(self.sample_interval_m)} m)"
            )
        if float(self.min_corridor_length_m) < float(self.sample_interval_m):
            raise PairingConfigError("min_corridor_length_m must be >= sample_interval_m")
        for name in ("max_bearing_diff_deg", "max_offset_angle_dev_deg"):
            if float(getattr(self, name)) > 90.0:
                raise PairingConfigError(f"{name} must be <= 90 degrees")


@dataclass
class Station:
    lon: float
    lat: float
    s: float            # cumulative along-line distance (m)
    bearing: float      # local tangent bearing (deg, 0..360)


@dataclass
class _Line:
    feature_id: str
    coords: list          # [[lon, lat], ...]
    props: dict
    stations: list = field(default_factory=list)   # list[Station]


# ---------------------------------------------------------------------------
# geometry helpers (equirectangular metres; mirrors the rest of the offline stack)
# ---------------------------------------------------------------------------


def _cos_lat(lat: float) -> float:
    c = math.cos(math.radians(lat))
    return c if abs(c) > 1e-9 else 1e-9


def meters_between(a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> float:
    mid = (a_lat + b_lat) / 2.0
    dn = (b_lat - a_lat) * M_PER_DEG_LAT
    de = (b_lon - a_lon) * M_PER_DEG_LAT * _cos_lat(mid)
    return math.hypot(dn, de)


def bearing_deg(a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> float:
    """North-referenced bearing a -> b (0..360)."""
    mid = (a_lat + b_lat) / 2.0
    dn = (b_lat - a_lat) * M_PER_DEG_LAT
    de = (b_lon - a_lon) * M_PER_DEG_LAT * _cos_lat(mid)
    return math.degrees(math.atan2(de, dn)) % 360.0


def axial_bearing_diff(b1: float, b2: float) -> float:
    """Bearing difference modulo 180: antiparallel carriageways read as 0.

    Makes pairing invariant to coordinate order / digitisation direction.
    """
    m = abs(b1 - b2) % 180.0
    return min(m, 180.0 - m)


def angle_between_deg(b1: float, b2: float) -> float:
    """Smallest absolute angle (0..180) between two bearings."""
    d = abs(b1 - b2) % 360.0
    return min(d, 360.0 - d)


def line_length_m(coords: list) -> float:
    total = 0.0
    for i in range(len(coords) - 1):
        total += meters_between(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    return total


ID_PRECISION = 6          # ~0.1 m at these latitudes
_ID_HASH_LEN = 12


def _h(blob: str) -> str:
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:_ID_HASH_LEN]


def _canon_json(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def canonical_coords(coords: list, precision: int = ID_PRECISION) -> list:
    """Orientation-canonical rounded coordinates.

    IDENTITY MUST NOT DEPEND ON PROVIDER DIGITISATION DIRECTION: the same physical line
    digitised end-to-start must hash identically. We therefore round, then take the
    lexicographically smaller of the forward and reversed sequences. (Rendering may still
    emit whatever direction it likes — only identity is canonicalised.)
    """
    fwd = [[round(float(c[0]), precision), round(float(c[1]), precision)] for c in coords]
    rev = list(reversed(fwd))
    return fwd if fwd <= rev else rev


def canonical_orientation(coords: list, precision: int = ID_PRECISION) -> list:
    """The SAME line in a deterministic orientation, with full precision preserved.

    Chooses the direction by the same rule `canonical_coords` hashes with, but returns the
    original unrounded coordinates. Applied BEFORE resampling so that stations, runs,
    derived midpoints, emitted part geometry and every id are invariant to provider
    digitisation direction — a reversed source line must not shift the resampling phase.
    Rendering direction is therefore deterministic too.
    """
    fwd = [[round(float(c[0]), precision), round(float(c[1]), precision)] for c in coords]
    if fwd <= list(reversed(fwd)):
        return list(coords)
    return list(reversed(coords))


def _source_layer_context(props: dict) -> str:
    """Stable source-layer context, so two identical geometries from DIFFERENT provider
    layers can never collide onto one source identity."""
    p = props if isinstance(props, dict) else {}
    return _canon_json({
        "layer": p.get("source_layer_id"),
        "kind": p.get("kind"),
        "road_class": p.get("road_class"),
    })


def source_feature_id(coords: list, props: dict | None = None) -> str:
    """Identity of the COMPLETE original source road ("r" prefix).

    Prefers an authoritative provider feature id when one is actually present; otherwise
    hashes the orientation-canonical geometry plus source-layer context. Invariant to
    forward/reversed coordinate order.
    """
    p = props if isinstance(props, dict) else {}
    for key in PROVIDER_ID_KEYS:
        v = p.get(key)
        if isinstance(v, str) and v.strip():
            return "r" + _h("pid|" + _source_layer_context(p) + "|" + v.strip())
    return "r" + _h("geom|" + _source_layer_context(p) + "|" + _canon_json(canonical_coords(coords)))


def part_feature_id(source_id: str, role: str, part_coords: list) -> str:
    """Identity of ONE emitted geographic part of a source road ("p" prefix).

    Derived from the source identity, the emitted role (selection_kind or diagnostic_kind)
    and the orientation-canonical part geometry. Two parts of one source always differ
    (their geometry differs), so no extra discriminator is needed; and the part id inherits
    the source's coordinate-order invariance.
    """
    return "p" + _h("part|" + _canon_json({
        "s": source_id, "role": role, "c": canonical_coords(part_coords),
    }))


def corridor_feature_id(member_source_ids: list, midpoint: list) -> str:
    """Identity of a derived divided-highway corridor ("c" prefix).

    Derived from the pairing method/version, the ORDERED member source ids, and the
    orientation-canonical midpoint geometry — never from a run's along-range, so reversing
    either carriageway leaves the corridor identity unchanged.
    """
    return "c" + _h("corr|" + _canon_json({
        "m": PAIRING_METHOD, "v": PAIRING_VERSION,
        "ids": sorted(member_source_ids), "c": canonical_coords(midpoint),
    }))


def resample_line(coords: list, interval_m: float) -> list:
    """Resample a polyline at a fixed interval -> [Station]. Deterministic.

    Always emits the first and last vertex; interior stations land every `interval_m` of
    along-line distance. Bearing is the local tangent of the segment the station sits on.
    """
    pts = [c for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2]
    if len(pts) < 2 or interval_m <= 0:
        return []
    out: list = []
    s_acc = 0.0
    next_s = 0.0
    for i in range(len(pts) - 1):
        a_lon, a_lat = float(pts[i][0]), float(pts[i][1])
        b_lon, b_lat = float(pts[i + 1][0]), float(pts[i + 1][1])
        seg = meters_between(a_lon, a_lat, b_lon, b_lat)
        if seg <= 0:
            continue
        brg = bearing_deg(a_lon, a_lat, b_lon, b_lat)
        while next_s <= s_acc + seg + 1e-9:
            t = (next_s - s_acc) / seg
            t = min(max(t, 0.0), 1.0)
            out.append(Station(
                lon=a_lon + (b_lon - a_lon) * t,
                lat=a_lat + (b_lat - a_lat) * t,
                s=next_s,
                bearing=brg,
            ))
            next_s += interval_m
        s_acc += seg
    # Always keep the final vertex so the run can reach the end of the line.
    last = pts[-1]
    if not out or meters_between(out[-1].lon, out[-1].lat, float(last[0]), float(last[1])) > 1e-6:
        prev = pts[-2]
        out.append(Station(
            lon=float(last[0]), lat=float(last[1]), s=s_acc,
            bearing=bearing_deg(float(prev[0]), float(prev[1]), float(last[0]), float(last[1])),
        ))
    return out


def project_point_to_polyline(lon: float, lat: float, coords: list) -> tuple:
    """Nearest point on a polyline -> (snap_lon, snap_lat, dist_m, tangent_deg, along_s_m).

    Equirectangular metres about the query latitude. Returns (None, ...) when degenerate.
    """
    pts = [c for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2]
    if len(pts) < 2:
        return (None, None, math.inf, 0.0, 0.0)
    cl = _cos_lat(lat)
    px, py = lon * M_PER_DEG_LAT * cl, lat * M_PER_DEG_LAT
    best = (None, None, math.inf, 0.0, 0.0)
    s_acc = 0.0
    for i in range(len(pts) - 1):
        a_lon, a_lat = float(pts[i][0]), float(pts[i][1])
        b_lon, b_lat = float(pts[i + 1][0]), float(pts[i + 1][1])
        ax, ay = a_lon * M_PER_DEG_LAT * cl, a_lat * M_PER_DEG_LAT
        bx, by = b_lon * M_PER_DEG_LAT * cl, b_lat * M_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 <= 0 else ((px - ax) * dx + (py - ay) * dy) / seg2
        t = min(max(t, 0.0), 1.0)
        sx, sy = ax + t * dx, ay + t * dy
        d = math.hypot(px - sx, py - sy)
        if d < best[2]:
            seg_len = math.sqrt(seg2)
            best = (
                sx / (M_PER_DEG_LAT * cl),
                sy / M_PER_DEG_LAT,
                d,
                bearing_deg(a_lon, a_lat, b_lon, b_lat),
                s_acc + t * seg_len,
            )
        s_acc += math.sqrt(seg2)
    return best


def _stdev(values: list) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    return math.sqrt(sum((v - mean) ** 2 for v in values) / n)


def _median(values: list) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


# ---------------------------------------------------------------------------
# classification helpers
# ---------------------------------------------------------------------------


def is_ramp(props: dict) -> bool:
    """Ramp per the provider MTFCC (the only available signal). ERIS-derived, and never a
    substitute for the trusted road_class."""
    mtfcc = props.get("MTFCC") if isinstance(props, dict) else None
    return isinstance(mtfcc, str) and mtfcc.strip().upper() == RAMP_MTFCC


def _route_key(props: dict) -> str:
    """Route identity used for compatibility: prefer BASENAME, else NAME. '' when absent."""
    for key in ("BASENAME", "NAME"):
        v = props.get(key) if isinstance(props, dict) else None
        if isinstance(v, str) and v.strip():
            return v.strip().upper()
    return ""


def routes_compatible(a_props: dict, b_props: dict) -> bool:
    """Route/name metadata must be compatible WHEN PRESENT on both; absent -> permitted."""
    ra, rb = _route_key(a_props), _route_key(b_props)
    if not ra or not rb:
        return True          # missing metadata never blocks a geometric pairing
    return ra == rb


# ---------------------------------------------------------------------------
# pairing pass
# ---------------------------------------------------------------------------


def _candidate_lines(features: list, params: PairingParams) -> list:
    """Primary, non-ramp LineStrings eligible for pairing, in deterministic id order."""
    out: list = []
    for f in features or []:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        if props.get("kind") != ROAD_CENTERLINE_KIND:
            continue                       # only a real centerline can be a carriageway
        if props.get("road_class") != "primary":
            continue                       # ERIS-trusted class only
        if road_role.is_non_carriageway(props):
            continue                       # a ramp OR connector never forms a carriageway pair
        geom = f.get("geometry") if isinstance(f.get("geometry"), dict) else {}
        if geom.get("type") != "LineString":
            continue
        coords = [c for c in (geom.get("coordinates") or []) if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(coords) < 2:
            continue
        # Canonicalise the ORIENTATION before resampling: a reversed source line must not
        # shift the station phase, or the derived midpoints (and their ids) would depend on
        # provider digitisation direction.
        clean = canonical_orientation([[float(c[0]), float(c[1])] for c in coords])
        # Order-invariant SOURCE identity: also the deterministic ordered-pair key that
        # keeps a corridor from being emitted twice as its own A<->B mirror.
        line = _Line(feature_id=source_feature_id(clean, props), coords=clean, props=props)
        line.stations = resample_line(clean, params.sample_interval_m)
        if line.stations:
            out.append(line)
    out.sort(key=lambda ln: ln.feature_id)   # deterministic
    return out


def _station_partner(line: _Line, st: Station, lines: list, params: PairingParams):
    """Best per-station partner, or None. Applies the class/route/separation/axial/offset
    and mutual-nearest gates. Returns (partner_line, dist_m, plon, plat, ptangent, palong)."""
    best = None
    for other in lines:
        if other.feature_id == line.feature_id:
            continue
        if not routes_compatible(line.props, other.props):
            continue
        plon, plat, d, ptang, palong = project_point_to_polyline(st.lon, st.lat, other.coords)
        if plon is None:
            continue
        if d < params.min_separation_m or d > params.max_separation_m:
            continue
        if axial_bearing_diff(st.bearing, ptang) > params.max_bearing_diff_deg:
            continue                       # not axially aligned (mod 180)
        # The offset to the partner must be ~PERPENDICULAR to the local tangent; this is
        # what a median looks like, and it rejects end-to-end / merge proximity.
        off = bearing_deg(st.lon, st.lat, plon, plat)
        if abs(angle_between_deg(off, st.bearing) - 90.0) > params.max_offset_angle_dev_deg:
            continue
        if best is None or d < best[1]:
            best = (other, d, plon, plat, ptang, palong)
    if best is None:
        return None
    if not _mutual_nearest(line, st, best, lines, params):
        return None
    return best


def _mutual_nearest(line: _Line, st: Station, best: tuple, lines: list, params: PairingParams) -> bool:
    """The partner point must project back onto `line` at ~this station, and no third line
    may be closer to it — i.e. the two carriageways are each other's nearest."""
    partner, _d, plon, plat, _t, _a = best
    blon, blat, dback, _bt, _bs = project_point_to_polyline(plon, plat, line.coords)
    if blon is None:
        return False
    if meters_between(blon, blat, st.lon, st.lat) > params.sample_interval_m * 1.5:
        return False
    for other in lines:
        if other.feature_id in (line.feature_id, partner.feature_id):
            continue
        o = project_point_to_polyline(plon, plat, other.coords)
        if o[0] is not None and o[2] < dback - 1e-6:
            return False                   # a third line is closer -> not mutual
    return True


def _window_ok(idx: int, stations: list, partners: list, partner_fid: str, params: PairingParams) -> bool:
    """Moving-window stability around station `idx`: same partner, real longitudinal
    overlap, stable separation (stdev + slope). STABILITY, not proximity."""
    s0 = stations[idx].s
    half = params.window_m / 2.0
    idxs = [j for j in range(len(stations)) if abs(stations[j].s - s0) <= half]
    if len(idxs) < 3:
        return False
    agree = [j for j in idxs if partners[j] is not None and partners[j][0].feature_id == partner_fid]
    if len(agree) / float(len(idxs)) < params.min_window_coverage:
        return False                       # mutual pairing is not stable across the window
    seps = [partners[j][1] for j in agree]
    if _stdev(seps) > params.sep_stdev_max_m:
        return False                       # separation wanders -> not one corridor
    # Rate of change of separation along the route: rejects sharp divergence even when
    # every sample is still inside the distance band.
    for k in range(1, len(agree)):
        ds = abs(stations[agree[k]].s - stations[agree[k - 1]].s)
        if ds <= 1e-6:
            continue
        if abs(seps[k] - seps[k - 1]) / ds > params.sep_slope_max:
            return False
    # Longitudinal overlap: the partner must actually SPAN the window. If it ends mid-window
    # the projections clamp to its endpoint and the along-distance stops advancing.
    alongs = [partners[j][5] for j in agree]
    if (max(alongs) - min(alongs)) < (params.window_m * 0.5):
        return False
    return True


def _midpoint_between(a_lon, a_lat, p_lon, p_lat, line: _Line, partner: _Line, params: PairingParams):
    """Midpoint of the station and its partner projection, validated to sit BETWEEN the two
    carriageways. Returns (lon, lat) or None (which splits the run)."""
    m_lon, m_lat = (a_lon + p_lon) / 2.0, (a_lat + p_lat) / 2.0
    da = project_point_to_polyline(m_lon, m_lat, line.coords)[2]
    db = project_point_to_polyline(m_lon, m_lat, partner.coords)[2]
    if not (math.isfinite(da) and math.isfinite(db)):
        return None
    if abs(da - db) > params.midpoint_tolerance_m:
        return None                        # not centred between them
    return (m_lon, m_lat)


@dataclass
class Corridor:
    """One paired run: the derived midpoint centerline + provenance."""

    a_id: str
    b_id: str
    midpoint: list                # [[lon, lat], ...]
    a_range: tuple                # (s_start, s_end) along A
    b_range: tuple                # (along_min, along_max) along B
    separations: list             # per-station measured centerline separation (m)
    a_coords: list                # observed source geometry over the run
    b_coords: list
    route: dict
    orientation_deg: float
    length_m: float


def _run_to_corridor(line, partner, stations, partners, i0, i1, params):
    """Materialise a paired run [i0, i1] into a Corridor, or None if the midpoint fails."""
    mids, seps, alongs = [], [], []
    for j in range(i0, i1 + 1):
        p = partners[j]
        if p is None or p[0].feature_id != partner.feature_id:
            return None
        st = stations[j]
        m = _midpoint_between(st.lon, st.lat, p[2], p[3], line, partner, params)
        if m is None:
            return None                    # midpoint escaped the interval -> split
        mids.append([m[0], m[1]])
        seps.append(p[1])
        alongs.append(p[5])
    if len(mids) < 2:
        return None
    length = line_length_m(mids)
    if length < params.min_corridor_length_m:
        return None                        # brief interchange-only proximity
    a_range = (stations[i0].s, stations[i1].s)
    b_range = (min(alongs), max(alongs))
    return Corridor(
        a_id=line.feature_id,
        b_id=partner.feature_id,
        midpoint=mids,
        a_range=a_range,
        b_range=b_range,
        separations=seps,
        a_coords=_slice_by_along(line.coords, a_range[0], a_range[1]),
        b_coords=_slice_by_along(partner.coords, b_range[0], b_range[1]),
        route={k: line.props.get(k) for k in ("NAME", "BASENAME", "MTFCC", "RTTYP") if line.props.get(k)},
        orientation_deg=bearing_deg(mids[0][0], mids[0][1], mids[-1][0], mids[-1][1]),
        length_m=length,
    )


def _slice_by_along(coords: list, s0: float, s1: float) -> list:
    """The portion of a polyline between two along-distances (inclusive), with exact cut
    points at the ends. Used for both the observed source geometry and carriageway splits."""
    if s1 <= s0:
        return []
    out: list = []
    acc = 0.0
    for i in range(len(coords) - 1):
        a_lon, a_lat = coords[i][0], coords[i][1]
        b_lon, b_lat = coords[i + 1][0], coords[i + 1][1]
        seg = meters_between(a_lon, a_lat, b_lon, b_lat)
        if seg <= 0:
            continue
        seg_start, seg_end = acc, acc + seg
        if seg_end >= s0 and seg_start <= s1:
            t0 = min(max((s0 - seg_start) / seg, 0.0), 1.0)
            t1 = min(max((s1 - seg_start) / seg, 0.0), 1.0)
            p0 = [a_lon + (b_lon - a_lon) * t0, a_lat + (b_lat - a_lat) * t0]
            p1 = [a_lon + (b_lon - a_lon) * t1, a_lat + (b_lat - a_lat) * t1]
            if not out or meters_between(out[-1][0], out[-1][1], p0[0], p0[1]) > 1e-9:
                out.append(p0)
            if meters_between(p0[0], p0[1], p1[0], p1[1]) > 1e-9:
                out.append(p1)
        acc = seg_end
    return out if len(out) >= 2 else []


def pair_corridors(features: list, params: PairingParams | None = None) -> list:
    """Find every station-local divided-highway corridor among the packaged road features.

    Deterministic and side-effect free. Emits ONE Corridor per paired run, only for the
    ordered pair id(A) < id(B), so the A<->B mirror is never materialised twice.

    Runs the shared uniqueness preflight, so EVERY public pairing entry point (including a
    direct pair_corridors() caller) fails closed on a repeated candidate source identity.
    Raises ``DuplicateSourceIdentityError``.
    """
    p = params or PairingParams()
    assert_unique_candidate_identities(features)
    lines = _candidate_lines(features, p)
    if len(lines) < 2:
        return []
    corridors: list = []
    for line in lines:
        stations = line.stations
        partners = [_station_partner(line, st, lines, p) for st in stations]
        # Confirm each station over the moving window.
        paired_fid: list = []
        for i, st in enumerate(stations):
            cand = partners[i]
            fid = None
            if cand is not None and _window_ok(i, stations, partners, cand[0].feature_id, p):
                fid = cand[0].feature_id
            paired_fid.append(fid)
        # Group consecutive stations sharing one partner into runs.
        i = 0
        while i < len(paired_fid):
            fid = paired_fid[i]
            if fid is None:
                i += 1
                continue
            j = i
            while j + 1 < len(paired_fid) and paired_fid[j + 1] == fid:
                j += 1
            # Only the ordered pair emits (deterministic mirror de-duplication).
            if line.feature_id < fid:
                partner = next((ln for ln in lines if ln.feature_id == fid), None)
                if partner is not None:
                    c = _run_to_corridor(line, partner, stations, partners, i, j, p)
                    if c is not None:
                        corridors.append(c)
            i = j + 1
    corridors.sort(key=lambda c: (c.a_id, c.b_id, c.a_range[0]))   # deterministic output order
    return corridors


# ---------------------------------------------------------------------------
# additive selection features
# ---------------------------------------------------------------------------


def _merge_ranges(ranges: list, gap_tol_m: float = 1.0) -> list:
    """Merge overlapping/adjacent along-ranges."""
    if not ranges:
        return []
    ordered = sorted((min(a, b), max(a, b)) for a, b in ranges)
    out = [list(ordered[0])]
    for s0, s1 in ordered[1:]:
        if s0 <= out[-1][1] + gap_tol_m:
            out[-1][1] = max(out[-1][1], s1)
        else:
            out.append([s0, s1])
    return [(a, b) for a, b in out]


def _complement_ranges(total_len: float, ranges: list, min_len_m: float) -> list:
    """The portions of [0, total_len] NOT covered by `ranges` (the unpaired stretches)."""
    out: list = []
    cursor = 0.0
    for s0, s1 in _merge_ranges(ranges):
        if s0 - cursor >= min_len_m:
            out.append((cursor, s0))
        cursor = max(cursor, s1)
    if total_len - cursor >= min_len_m:
        out.append((cursor, total_len))
    return out


def _feature(coords: list, props: dict) -> dict:
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props}


ROAD_CLASS_LABEL_PRIMARY = "Primary road / highway"


def _selectable(kind: str) -> dict:
    """Trusted role block for a SELECTION CANDIDATE (one of the four selectable kinds)."""
    return {"selection_kind": kind, "selectable": True, "diagnostic": False}


def _diagnostic(kind: str) -> dict:
    """Trusted role block for a DIAGNOSTICS-ONLY feature. `selection_kind` is explicitly
    null so a native switch on the selectable enum can never match it."""
    return {"selection_kind": None, "diagnostic_kind": kind, "selectable": False, "diagnostic": True}


def _context() -> dict:
    """Trusted role block for a retained NON-CENTERLINE context feature (road_bearing,
    road_inventory, submitted_road_geometry, ...). Packaged and consumable for its existing
    contextual purpose, but never a selection candidate and never a diagnostics role."""
    return {"selection_kind": None, "selectable": False, "diagnostic": False}


def _inline_provider(props: dict) -> dict:
    """The provider metadata contract carried INLINE on every selection candidate."""
    return {k: props[k] for k in PROVIDER_INLINE_PROPS if props.get(k) not in (None, "")}


def _norm(v) -> str:
    return str(v).strip().upper() if isinstance(v, str) else ("" if v is None else str(v))


def _shared_provider(a_props: dict, b_props: dict) -> dict:
    """Provider metadata for a DERIVED corridor: only the compatible value SHARED by both
    members. Never fabricates — when the members disagree, or either lacks the field, the
    field is omitted entirely (per-member values stay in member_provider_metadata)."""
    out: dict = {}
    for k in PROVIDER_INLINE_PROPS:
        av, bv = a_props.get(k), b_props.get(k)
        if av in (None, "") or bv in (None, ""):
            continue                       # a member lacks it -> do not fabricate
        if _norm(av) != _norm(bv):
            continue                       # members disagree -> do not fabricate
        out[k] = av
    return out


def _sort_key(f: dict) -> tuple:
    """DETERMINISTIC emission order: (role rank, feature_id) — selectable kinds 0-3, then
    diagnostics (4), then retained context features (5). Provider response order must never
    influence roads.geojson bytes or the package hash."""
    p = f.get("properties") or {}
    kind = p.get("selection_kind")
    if isinstance(kind, str) and kind in _ROLE_RANK:
        rank = _ROLE_RANK[kind]
    elif p.get("diagnostic_kind"):
        rank = _DIAGNOSTIC_RANK
    else:
        rank = _CONTEXT_RANK
    return (rank, str(p.get("feature_id") or ""))


def corridor_feature(c: Corridor, params: PairingParams, member_part_ids: list,
                     a_props: dict, b_props: dict) -> dict:
    """The derived divided_highway_corridor selection candidate (ERIS-generated)."""
    seps = c.separations
    member_source_ids = [c.a_id, c.b_id]                 # already the ordered pair a<b
    props = {
        "kind": "road_centerline",
        "road_class": "primary",
        "road_class_label": ROAD_CLASS_LABEL_PRIMARY,
        **_selectable(SELECTION_DIVIDED_CORRIDOR),
        "feature_id": corridor_feature_id(member_source_ids, c.midpoint),
        # The two COMPLETE original source roads, deterministically ordered.
        "member_source_feature_ids": member_source_ids,
        # The exact diagnostics member segments for THIS run (1:1 with the ids above).
        "member_part_feature_ids": list(member_part_ids),
        # Observed source centrelines CLIPPED TO THIS RUN — not the complete source road,
        # and not resampled. Retained so native consumption is self-contained.
        "member_geometry": {"a": c.a_coords, "b": c.b_coords},
        "member_geometry_kind": "observed_source_centerlines_clipped_to_run",
        "member_provider_metadata": [_inline_provider(a_props), _inline_provider(b_props)],
        "separation_m": {
            "min": round(min(seps), 2), "max": round(max(seps), 2),
            "mean": round(sum(seps) / len(seps), 2), "median": round(_median(seps), 2),
            "stdev": round(_stdev(seps), 2), "samples": len(seps),
        },
        "corridor_length_m": round(c.length_m, 1),
        # Geometry-derived only: NEVER an authoritative direction claim. Road Inventory is
        # the only source that may upgrade orientation_source.
        "orientation_deg": round(c.orientation_deg, 1),
        "orientation_source": "geometry_derived",
        "pairing": {
            "method": PAIRING_METHOD, "version": PAIRING_VERSION,
            "sample_interval_m": params.sample_interval_m, "window_m": params.window_m,
        },
    }
    # ONE provider-metadata contract: the corridor exposes the SAME inline fields as every
    # other candidate, using only values both members agree on.
    props.update(_shared_provider(a_props, b_props))
    return _feature(c.midpoint, props)


def assert_unique_candidate_identities(features: list) -> None:
    """FAIL-CLOSED preflight: EVERY candidate road centerline must have a DISTINCT pairing
    source identity — including two candidates whose geometry is identical.

    A repeated identity is never safe. ``build_selection_features`` derives each emitted
    feature_id from (source id, role, canonical part geometry), so two candidates sharing an
    identity AND geometry produce the SAME final feature_id and both get appended — breaking
    the global feature_id-uniqueness contract and the 1:1 resolution of a corridor's
    ``member_part_feature_ids``. Two candidates sharing an identity with DIFFERENT geometry is
    the disconnected-part collision (one component's paired range applied to another).

    Both fail closed here; the message distinguishes them. Exact redundant packaged parts are
    the packaging boundary's job to remove (see ``roads_geojson_from_context``), not
    something pairing may silently absorb."""
    seen: dict = {}   # source id -> canonical geometry key
    for f in features or []:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        if props.get("kind") != ROAD_CENTERLINE_KIND:
            continue
        geom = f.get("geometry") if isinstance(f.get("geometry"), dict) else {}
        if geom.get("type") != "LineString":
            continue
        coords = [[float(c[0]), float(c[1])] for c in (geom.get("coordinates") or [])
                  if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(coords) < 2:
            continue
        clean = canonical_orientation(coords)
        sid = source_feature_id(clean, props)
        key = tuple((round(x, 7), round(y, 7)) for x, y in clean)
        prev = seen.get(sid)
        if prev is not None:
            same = "identical" if prev == key else "different"
            raise DuplicateSourceIdentityError(
                f"pairing source identity {sid!r} is repeated across candidates with {same} geometry; "
                "every packaged road centerline must carry a unique provider_feature_id "
                "(exact redundant parts must be removed at the packaging boundary)"
            )
        seen[sid] = key


class ProviderRampMislabeledError(ValueError):
    """A feature the PROVIDER explicitly names a ramp was emitted as something else.

    A provider-identified ramp emitted as `individual_carriageway` competes at mainline
    priority in native selection and can displace the real divided corridor near on/off
    ramps — the demonstrated Rocklin/I-80 defect. It is also never a valid diagnostics
    member. Fail closed rather than publish a package whose selection_kind contradicts the
    provider's own route identity."""


def assert_provider_ramps_are_labeled_ramps(features: list) -> None:
    """FAIL-CLOSED invariant: every emitted part whose PROVIDER route identity names a ramp
    must carry selection_kind 'ramp', must stay selectable, and must never be a diagnostics
    member. Checked on the ACTUAL emitted collection, so an adapter that forgot to set
    road_role cannot silently ship mislabeled ramps."""
    for f in features or []:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        if not road_role.provider_declares_ramp(props):
            continue
        kind = props.get("selection_kind")
        if kind != SELECTION_RAMP:
            # Name the field that actually matched — the identity may have come from NAME,
            # in which case reporting only route_id=None leaves the operator with no way to
            # find the offending feature.
            ident = next((f"{k}={props.get(k)!r}" for k in road_role.RAMP_IDENTITY_FIELDS
                          if road_role.is_ramp_route_identity(props.get(k))), "identity=?")
            raise ProviderRampMislabeledError(
                f"provider-identified ramp emitted as selection_kind {kind!r} "
                f"({ident}, feature_id={props.get('feature_id')!r}); it must be {SELECTION_RAMP!r}"
            )
        if props.get("diagnostic_kind") is not None:
            raise ProviderRampMislabeledError(
                f"provider-identified ramp emitted as diagnostic_kind "
                f"{props.get('diagnostic_kind')!r}; a ramp is never a carriageway member"
            )


def assert_unique_emitted_feature_ids(features: list) -> None:
    """FINAL invariant backstop: every non-empty emitted ``feature_id`` is globally unique.

    Covers selectable, diagnostic member, derived corridor and retained context features.
    Source-id uniqueness alone does not prove it, so this is asserted on the ACTUAL output
    before it is returned — a collection with duplicate ids is never handed to the caller."""
    seen: set = set()
    for f in features or []:
        if not isinstance(f, dict):
            continue
        fid = (f.get("properties") or {}).get("feature_id")
        if not isinstance(fid, str) or not fid:
            continue
        if fid in seen:
            raise DuplicateSourceIdentityError(
                f"emitted feature_id {fid!r} is not unique; the packaged road collection would "
                "break member_part_feature_ids 1:1 resolution"
            )
        seen.add(fid)


def build_selection_features(features: list, params: PairingParams | None = None) -> tuple:
    """Rewrite the packaged road features with ADDITIVE selection metadata.

    Returns (features, stats).

    Identity: every emitted feature carries a globally unique `feature_id`; every
    source-derived feature also carries `source_feature_id` (the complete original road).
    Several emitted parts may share one source_feature_id; no two share a feature_id.

    Roles: the four SELECTABLE kinds live in `selection_kind`; a raw paired carriageway
    segment is diagnostics-only (`diagnostic_kind: "carriageway_member"`, selection_kind
    null, selectable false) so the selectable enum stays exactly four values.

    A primary carriageway paired somewhere is SPLIT: one diagnostics member part per paired
    RUN (so a corridor's member_part_feature_ids resolve 1:1) plus selectable
    `individual_carriageway` remainders — keeping paired<->unpaired transitions
    geographically continuous. Corridors are appended as derived features.

    Output is sorted deterministically; provider input order never affects the result.

    Raises ``DuplicateSourceIdentityError`` (fail closed) when any packaged road centerline
    repeats a pairing source identity — whether the geometry is identical (which would emit
    the same feature_id twice) or different (which would apply one component's paired range
    to another) — and again if the FINAL emitted collection somehow contains a duplicate
    feature_id. The caller must not swallow either into unpaired output.
    """
    p = params or PairingParams()
    # The uniqueness preflight runs inside pair_corridors(), so every entry point is covered
    # without validating the same input twice.
    corridors = pair_corridors(features, p)

    # source_feature_id -> [(corridor_index, side, along_range)]
    runs: dict = {}
    for i, c in enumerate(corridors):
        runs.setdefault(c.a_id, []).append((i, "a", c.a_range))
        runs.setdefault(c.b_id, []).append((i, "b", c.b_range))

    out: list = []
    corridor_parts: dict = {}     # corridor_index -> {"a": part_id, "b": part_id}
    corridor_props: dict = {}     # corridor_index -> {"a": props, "b": props}

    for f in features or []:
        if not isinstance(f, dict):
            continue
        props = dict(f.get("properties") or {})
        geom = f.get("geometry") if isinstance(f.get("geometry"), dict) else {}
        raw = geom.get("coordinates") if geom.get("type") == "LineString" else None
        coords = [[float(c[0]), float(c[1])] for c in (raw or [])
                  if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(coords) < 2:
            out.append(f)                  # non-line (or degenerate): pass through untouched
            continue
        # Same canonical orientation the pairing pass used, so emitted part geometry and
        # part ids are invariant to provider digitisation direction.
        coords = canonical_orientation(coords)
        sid = source_feature_id(coords, props)
        base = dict(props)
        base["source_feature_id"] = sid
        base.pop("feature_id", None)       # recomputed per emitted part below

        # CANDIDATE ELIGIBILITY: only a real road centerline may receive a selection_kind.
        # ERIS context geometry (road_bearing / road_inventory / submitted_road_geometry)
        # stays packaged and consumable, but is never promoted into a selectable road.
        if props.get("kind") != ROAD_CENTERLINE_KIND:
            role = context_role(props.get("kind"))
            cp = dict(base, **_context())
            cp["feature_id"] = part_feature_id(sid, role, coords)
            out.append(_feature(coords, cp))
            continue

        my_runs = runs.get(sid)
        if road_role.role_of(props) == road_role.ROLE_RAMP:
            # A RAMP (role supported) NEVER participates in pairing, so it is always whole
            # + selectable. A CONNECTOR is likewise excluded from pairing (via the candidate
            # gate) but stays an individually-selectable road below — it is not asserted to
            # be a ramp when the source could not tell us that.
            rp = dict(base, **_selectable(SELECTION_RAMP))
            rp["feature_id"] = part_feature_id(sid, SELECTION_RAMP, coords)
            out.append(_feature(coords, rp))
            continue
        if not my_runs:
            # An unpaired PRIMARY centerline stays individually selectable (a geographically
            # separated directional roadway) — it is NOT an ordinary road. Everything else
            # (secondary / local / unclassified) is an ordinary road.
            kind = (SELECTION_INDIVIDUAL_CARRIAGEWAY if props.get("road_class") == "primary"
                    else SELECTION_ORDINARY_ROAD)
            op = dict(base, **_selectable(kind))
            op["feature_id"] = part_feature_id(sid, kind, coords)
            out.append(_feature(coords, op))
            continue

        # One diagnostics member part per paired RUN (never merged), so each corridor's
        # member_part_feature_ids resolve to exactly one emitted feature.
        for ci, side, (s0, s1) in my_runs:
            part = _slice_by_along(coords, s0, s1)
            if len(part) < 2:
                continue
            mp = dict(base, **_diagnostic(DIAGNOSTIC_CARRIAGEWAY_MEMBER))
            pid = part_feature_id(sid, DIAGNOSTIC_CARRIAGEWAY_MEMBER, part)
            mp["feature_id"] = pid
            out.append(_feature(part, mp))
            corridor_parts.setdefault(ci, {})[side] = pid
            corridor_props.setdefault(ci, {})[side] = props
        # The unpaired remainder stays individually selectable.
        for s0, s1 in _complement_ranges(line_length_m(coords), [r[2] for r in my_runs],
                                         p.sample_interval_m * 2.0):
            part = _slice_by_along(coords, s0, s1)
            if len(part) < 2:
                continue
            ip = dict(base, **_selectable(SELECTION_INDIVIDUAL_CARRIAGEWAY))
            ip["feature_id"] = part_feature_id(sid, SELECTION_INDIVIDUAL_CARRIAGEWAY, part)
            out.append(_feature(part, ip))

    for i, c in enumerate(corridors):
        parts = corridor_parts.get(i, {})
        cprops = corridor_props.get(i, {})
        if "a" not in parts or "b" not in parts:
            continue                       # a member part failed to materialise -> no corridor
        out.append(corridor_feature(
            c, p, [parts["a"], parts["b"]], cprops.get("a", {}), cprops.get("b", {}),
        ))

    out.sort(key=_sort_key)                # deterministic, provider-order independent

    # TRUTHFUL, EXPLICIT counts. The emitted collection mixes derived corridors, selectable
    # source parts, duplicate diagnostics members and non-selectable context features, so a
    # single "feature_count" is ambiguous. Partition it exactly.
    sel_counts: dict = {}
    diag_counts: dict = {}
    sel_class_counts: dict = {}
    selectable_n = diagnostic_n = context_n = emitted_corridors = 0
    for f in out:
        pr = f.get("properties") or {}
        k = pr.get("selection_kind")
        dk = pr.get("diagnostic_kind")
        if isinstance(k, str) and k in SELECTABLE_KINDS and pr.get("selectable") is True:
            selectable_n += 1
            sel_counts[k] = sel_counts.get(k, 0) + 1
            rc = pr.get("road_class")
            if isinstance(rc, str) and rc:
                sel_class_counts[rc] = sel_class_counts.get(rc, 0) + 1
            if k == SELECTION_DIVIDED_CORRIDOR:
                emitted_corridors += 1
        elif isinstance(dk, str) and dk:
            diagnostic_n += 1
            diag_counts[dk] = diag_counts.get(dk, 0) + 1
        else:
            context_n += 1                 # retained, packaged, never a candidate

    stats = {
        "feature_count": len(out),                 # features actually serialized
        "source_feature_count": len([f for f in (features or []) if isinstance(f, dict)]),
        "selectable_feature_count": selectable_n,
        "diagnostic_feature_count": diagnostic_n,
        "context_feature_count": context_n,
        # SELECTABLE candidates only — the diagnostics role never enters this enum.
        "selection_kinds": sorted(sel_counts),
        "selection_kind_counts": {k: sel_counts[k] for k in sorted(sel_counts)},
        "selectable_road_class_counts": {k: sel_class_counts[k] for k in sorted(sel_class_counts)},
        "diagnostic_kinds": sorted(diag_counts),
        "diagnostic_kind_counts": {k: diag_counts[k] for k in sorted(diag_counts)},
        # Only corridors whose member parts actually materialised are emitted + counted.
        "divided_corridor_count": emitted_corridors,
        "pairing": {
            "method": PAIRING_METHOD, "version": PAIRING_VERSION,
            "sample_interval_m": p.sample_interval_m, "window_m": p.window_m,
            "min_separation_m": p.min_separation_m, "max_separation_m": p.max_separation_m,
            "max_bearing_diff_deg": p.max_bearing_diff_deg,
            "max_offset_angle_dev_deg": p.max_offset_angle_dev_deg,
            "sep_stdev_max_m": p.sep_stdev_max_m, "sep_slope_max": p.sep_slope_max,
            "min_window_coverage": p.min_window_coverage,
            "min_corridor_length_m": p.min_corridor_length_m,
            "midpoint_tolerance_m": p.midpoint_tolerance_m,
        },
    }
    # FINAL invariants: never hand back a collection whose emitted feature_ids collide, nor
    # one that contradicts the provider about which features are ramps.
    assert_unique_emitted_feature_ids(out)
    assert_provider_ramps_are_labeled_ramps(out)
    return out, stats
