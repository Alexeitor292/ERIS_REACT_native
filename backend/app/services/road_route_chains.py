"""Route-chain stitching + conservative connector classification (pure, deterministic).

WHY. A provider that segments a highway at interchange boundaries (Caltrans CRS is an LRS
event layer; ERIS clipping fragments further) hands the corridor pairer a stream of short
disconnected mainline pieces. Each short piece fails the pairing pass's minimum-corridor and
window-stability gates on its own, so a continuous divided mainline fragments and — worse —
a geometrically-nearby ramp can become a carriageway's "partner" and drag the derived
midpoint onto the ramp.

This pass runs BEFORE pairing and does two things, using ONLY geometry + the trusted role /
carriageway-continuity identity the adapter supplied (never a fabricated lane/ownership fact):

  1. STITCH contiguous same-carriageway segments (same continuity key) into one longer
     feature, so the pairer sees a continuous carriageway. The stitched chain keeps the role
     the provider gave it (Caltrans: ``unknown``) — geometry never asserts ``mainline``. It
     NEVER stitches across different route families / carriageway designators, and NEVER
     stitches through a fork (an ambiguous junction) — those stay separate.
  2. Conservatively demote short BRANCH geometry (a segment that merges/diverges from a
     longer mainline at an acute angle) to role ``connector`` so pairing excludes it. Real
     divergences therefore split a corridor, while a stable pair of carriageways continues
     through an interchange.

Everything a provider could not tell us stays ``unknown``. The stitched mainline records its
raw member source ids for diagnostics; the raw members are not separately packaged.

Deterministic: features are processed in a canonical id order and geometry is
orientation-canonicalised, so output is invariant to input order and per-segment coordinate
direction. No I/O, no config import (thresholds passed in): unit-testable in the non-DB job.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field

from . import road_role
from .road_corridor_pairing import (
    ROAD_CENTERLINE_KIND,
    axial_bearing_diff,
    bearing_deg,
    canonical_orientation,
    line_length_m,
    meters_between,
    project_point_to_polyline,
    source_feature_id,
)


# Two joined endpoints closer than this are the SAME vertex (sub-metre); only then is the
# duplicate dropped when merging. Anything further apart keeps both real vertices.
_COINCIDENT_M = 0.5


@dataclass(frozen=True)
class ChainParams:
    """Thresholds for stitching + connector detection. Conservative by default; named,
    validated, packaged in the manifest, and tested."""

    enabled: bool = True
    join_gap_m: float = 25.0            # endpoints within this distance may connect
    join_bearing_deg: float = 35.0      # axial tangent continuity across a join (mod 180)
    min_mainline_len_m: float = 200.0   # a stitched chain this long is a SUSTAINED through-route
    connector_max_len_m: float = 400.0  # only a SHORT branch may be demoted to connector
    branch_angle_deg: float = 35.0      # MIN acute deviation from the through-route = a branch
    # MAX deviation still considered a branch. A merge/diverge leaves the through-route at an
    # ACUTE angle; a near-perpendicular meeting is a grade-separated CROSSING, not a branch,
    # and demoting it would destroy a real intersecting freeway's corridor.
    branch_angle_max_deg: float = 80.0
    junction_tol_m: float = 30.0        # endpoint-to-through-route attachment distance

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        for name in ("join_gap_m", "join_bearing_deg", "min_mainline_len_m",
                     "connector_max_len_m", "branch_angle_deg", "branch_angle_max_deg",
                     "junction_tol_m"):
            v = getattr(self, name)
            if not isinstance(v, (int, float)) or not math.isfinite(float(v)) or float(v) <= 0:
                raise ValueError(f"ChainParams.{name} must be a finite number > 0 (got {v!r})")
        for name in ("join_bearing_deg", "branch_angle_deg", "branch_angle_max_deg"):
            if float(getattr(self, name)) > 90.0:
                raise ValueError("angle thresholds must be <= 90 degrees")
        if float(self.branch_angle_deg) >= float(self.branch_angle_max_deg):
            raise ValueError("branch_angle_deg must be < branch_angle_max_deg")


@dataclass
class _Seg:
    fid: str                 # source_feature_id of this segment
    coords: list             # orientation-canonical [[lon,lat], ...]
    props: dict
    key: str | None          # carriageway-continuity key (None -> never stitched)
    length_m: float
    used: bool = False


@dataclass
class _Chain:
    key: str | None
    coords: list
    members: list = field(default_factory=list)   # ordered member fids
    member_props: list = field(default_factory=list)


def _endpoint_bearing(coords: list, *, at_start: bool) -> float:
    """Tangent bearing pointing OUTWARD at an endpoint (start points back, end points fwd)."""
    if len(coords) < 2:
        return 0.0
    if at_start:
        a, b = coords[1], coords[0]     # outward from the start
    else:
        a, b = coords[-2], coords[-1]   # outward from the end
    return bearing_deg(a[0], a[1], b[0], b[1])


def _seg_for(feature: dict) -> _Seg | None:
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    geom = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else {}
    if geom.get("type") != "LineString":
        return None
    raw = [c for c in (geom.get("coordinates") or []) if isinstance(c, (list, tuple)) and len(c) >= 2]
    if len(raw) < 2:
        return None
    coords = canonical_orientation([[float(c[0]), float(c[1])] for c in raw])
    return _Seg(
        fid=source_feature_id(coords, props),
        coords=coords,
        props=dict(props),
        key=road_role.carriageway_continuity_key(props),
        length_m=line_length_m(coords),
    )


def _try_connect(chain_coords: list, seg: _Seg, params: ChainParams):
    """If ``seg`` extends ``chain_coords`` at either end within gap + bearing continuity,
    return the merged coordinates (seg possibly reversed); else None. Endpoint-continuous
    only — never a mid-line T-junction."""
    c_start, c_end = chain_coords[0], chain_coords[-1]
    s_start, s_end = seg.coords[0], seg.coords[-1]
    gap = params.join_gap_m
    # tangent of the chain pointing outward at each end
    chain_end_brg = _endpoint_bearing(chain_coords, at_start=False)
    chain_start_brg = _endpoint_bearing(chain_coords, at_start=True)

    def continuous(join_brg_out: float, seg_in_brg: float) -> bool:
        # The chain's outward bearing must continue roughly straight into the segment.
        return axial_bearing_diff(join_brg_out, seg_in_brg) <= params.join_bearing_deg

    # NEVER DROP A REAL VERTEX. The joined endpoints are only guaranteed within `gap`
    # (25 m), so the appended segment's near vertex is dropped ONLY when it is effectively
    # the same point; otherwise it is kept and the two genuine vertices stay in the chain.
    # (Silently deleting a vertex up to 25 m away would invent a chord the source never had.)
    def _join(head: list, tail: list) -> list:
        if meters_between(head[-1][0], head[-1][1], tail[0][0], tail[0][1]) <= _COINCIDENT_M:
            return head + tail[1:]
        return head + tail

    # append seg (forward) to chain end
    if meters_between(c_end[0], c_end[1], s_start[0], s_start[1]) <= gap:
        if continuous(chain_end_brg, _endpoint_bearing(seg.coords, at_start=True) + 180.0):
            return _join(chain_coords, seg.coords)
    # append seg (reversed) to chain end
    if meters_between(c_end[0], c_end[1], s_end[0], s_end[1]) <= gap:
        if continuous(chain_end_brg, _endpoint_bearing(seg.coords, at_start=False) + 180.0):
            return _join(chain_coords, list(reversed(seg.coords)))
    # prepend seg (forward) to chain start
    if meters_between(c_start[0], c_start[1], s_end[0], s_end[1]) <= gap:
        if continuous(chain_start_brg, _endpoint_bearing(seg.coords, at_start=False) + 180.0):
            return _join(seg.coords, chain_coords)
    # prepend seg (reversed) to chain start
    if meters_between(c_start[0], c_start[1], s_start[0], s_start[1]) <= gap:
        if continuous(chain_start_brg, _endpoint_bearing(seg.coords, at_start=True) + 180.0):
            return _join(list(reversed(seg.coords)), chain_coords)
    return None


def _count_endpoint_touchers(seg: _Seg, at_end: bool, group: list, params: ChainParams) -> int:
    """How many OTHER same-key segments touch this endpoint within join_gap. >1 = a fork:
    stitching there would be ambiguous, so we refuse to stitch through it."""
    pt = seg.coords[-1] if at_end else seg.coords[0]
    n = 0
    for other in group:
        if other.fid == seg.fid:
            continue
        for op in (other.coords[0], other.coords[-1]):
            if meters_between(pt[0], pt[1], op[0], op[1]) <= params.join_gap_m:
                n += 1
                break
    return n


def _stitch_group(group: list, params: ChainParams) -> list:
    """Greedy, deterministic stitching within one continuity group. Refuses to stitch
    through a fork (ambiguous junction). Returns a list of _Chain."""
    group = sorted(group, key=lambda s: s.fid)
    chains: list = []
    for seed in group:
        if seed.used:
            continue
        seed.used = True
        chain = _Chain(key=seed.key, coords=list(seed.coords),
                       members=[seed.fid], member_props=[seed.props])
        extended = True
        while extended:
            extended = False
            for seg in group:
                if seg.used:
                    continue
                # Refuse to grow through a fork on EITHER side being joined.
                merged = _try_connect(chain.coords, seg, params)
                if merged is None:
                    continue
                # Ambiguity guard: if either of the segment's endpoints touches more than one
                # OTHER member of this group, it is a junction — do not stitch through it.
                # (Deliberately counts all group members, consumed or not: over-refusing is
                # the safe direction.)
                if (_count_endpoint_touchers(seg, at_end=False, group=group, params=params) > 1 or
                        _count_endpoint_touchers(seg, at_end=True, group=group, params=params) > 1):
                    continue
                chain.coords = merged
                chain.members.append(seg.fid)
                chain.member_props.append(seg.props)
                seg.used = True
                extended = True
                break
        chains.append(chain)
    return chains


def _chain_feature_id(member_ids: list) -> str:
    raw = json.dumps({"v": 1, "m": sorted(member_ids)}, sort_keys=True, separators=(",", ":"))
    return "chain:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _min_dist_point_to_polyline(pt, coords) -> tuple[float, float]:
    """(true perpendicular distance metres, mainline tangent bearing at the nearest point).

    Uses the exact point-to-segment projection so a ramp attaching MID-SEGMENT is detected,
    not just near a vertex."""
    snap_lon, snap_lat, dist_m, tangent, _along = project_point_to_polyline(pt[0], pt[1], coords)
    if snap_lon is None:
        return (math.inf, 0.0)
    return (dist_m, tangent)


def stitch_route_chains(features: list, params: ChainParams | None = None) -> tuple[list, dict]:
    """Return (prepared_features, stats).

    Primary road_centerline features carrying a carriageway-continuity key are grouped and
    stitched into longer mainline features (role ``mainline``, role_source
    ``geometry_route_chain``); short branch geometry that merges/diverges from a mainline is
    demoted to ``connector`` (excluded from pairing downstream). Everything else — features
    with no continuity key (e.g. TIGER), non-primary roads, ramps already flagged, ERIS
    context geometry — passes through UNCHANGED, so provider behaviour that already works is
    untouched. Deterministic and side-effect free.
    """
    p = params or ChainParams()
    feats = [f for f in (features or []) if isinstance(f, dict)]
    if not p.enabled:
        return list(feats), {"stitching": "disabled"}

    # Partition: stitchable primary centerlines (with a key) vs pass-through.
    segs: list = []
    passthrough: list = []
    for f in feats:
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        eligible = (
            props.get("kind") == ROAD_CENTERLINE_KIND
            and props.get("road_class") == "primary"
            and not road_role.is_non_carriageway(props)   # keep already-known ramps/connectors out
        )
        seg = _seg_for(f) if eligible else None
        if seg is not None and seg.key is not None:
            segs.append(seg)
        else:
            passthrough.append(f)

    if not segs:
        return list(feats), {"stitching": "no_continuity_keys", "chains": 0}

    # Group by continuity key and stitch within each group.
    groups: dict = {}
    for s in segs:
        groups.setdefault(s.key, []).append(s)
    chains: list = []
    for key in sorted(groups):
        chains.extend(_stitch_group(groups[key], p))

    # SUSTAINED through-routes (long chains) are the reference geometry for branch detection.
    # This is an internal geometric notion only — it is NOT written out as a `mainline` role.
    sustained_chains = [c for c in chains if line_length_m(c.coords) >= p.min_mainline_len_m]

    out: list = list(passthrough)
    stitched_count = 0
    connector_count = 0
    for c in chains:
        length = line_length_m(c.coords)
        base = dict(c.member_props[0])   # representative provider metadata (lowest-id member)
        # Clear per-part identity fields. The packaging boundary already ran (it clipped and
        # id'd the parts BEFORE this pass), so a stitched chain deliberately carries no
        # provider id and pairing keys it off the canonical geometry hash instead.
        for k in ("feature_id", "provider_feature_id", "source_feature_id"):
            base.pop(k, None)
        base["kind"] = ROAD_CENTERLINE_KIND
        base["chain_member_source_feature_ids"] = list(c.members)
        base["chain_member_count"] = len(c.members)

        is_branch = False
        if length < p.connector_max_len_m:
            # Is this SHORT chain a merge/diverge branch off a sustained through-route?
            #
            # TWO conservative conditions, both required — either alone produces false
            # demotions that destroy real corridors:
            #   * SAME ROUTE FAMILY. We only claim "connector" when the provider's own route
            #     identity says this geometry belongs to the same highway as the through-route
            #     it meets. A DIFFERENT freeway meeting this one is a crossing/interchange
            #     neighbour, not a branch of it — demoting it would delete that freeway's own
            #     divided corridor.
            #   * ACUTE, NOT PERPENDICULAR. A ramp leaves its parent at an acute angle
            #     (branch_angle_deg..branch_angle_max_deg). A near-perpendicular meeting is a
            #     grade-separated CROSSING and is never a branch.
            my_family = base.get("route_family")
            for endpoint in (c.coords[0], c.coords[-1]):
                brg_here = _endpoint_bearing(c.coords, at_start=(endpoint is c.coords[0]))
                for m in sustained_chains:
                    if m.members == c.members:
                        continue
                    m_family = (m.member_props[0] or {}).get("route_family")
                    if not (my_family and m_family and my_family == m_family):
                        continue                       # different highway -> not our branch
                    d, mbrg = _min_dist_point_to_polyline(endpoint, m.coords)
                    if d > p.junction_tol_m:
                        continue
                    dev = axial_bearing_diff(brg_here, mbrg)
                    if p.branch_angle_deg <= dev <= p.branch_angle_max_deg:
                        is_branch = True
                        break
                if is_branch:
                    break

        if is_branch:
            base["road_role"] = road_role.ROLE_CONNECTOR
            base["role_source"] = road_role.ROLE_SOURCE_ROUTE_CHAIN
            connector_count += 1
        else:
            # NEVER fabricate a `mainline` claim from geometry. Route continuity + length do
            # not prove a chain is a through carriageway rather than, say, a long parallel
            # collector-distributor road — and the provider (Caltrans CRS) carries no
            # mainline/ramp attribute. The role therefore stays UNKNOWN, which pairing
            # already accepts as a candidate; only the CONNECTOR demotion above (an
            # exclusion, i.e. the safe direction) is derived from geometry. A provider that
            # genuinely knows the role (e.g. TIGER MTFCC) still sets it in its adapter.
            base["road_role"] = road_role.normalized_role(base.get("road_role"))
            base["role_source"] = (road_role.ROLE_SOURCE_ROUTE_CHAIN
                                   if len(c.members) > 1 else base.get("role_source")
                                   or road_role.ROLE_SOURCE_UNSPECIFIED)
        if len(c.members) > 1:
            stitched_count += 1
        out.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [list(pt) for pt in c.coords]},
            "properties": base,
        })

    stats = {
        "stitching": "applied",
        "input_segments": len(segs),
        "chains": len(chains),
        "chains_stitched_from_multiple": stitched_count,
        # Sustained through-routes are a GEOMETRIC reference count, not a role claim.
        "sustained_chains": len(sustained_chains),
        "connector_chains": connector_count,
        "params": {
            "join_gap_m": p.join_gap_m, "join_bearing_deg": p.join_bearing_deg,
            "min_mainline_len_m": p.min_mainline_len_m,
            "connector_max_len_m": p.connector_max_len_m,
            "branch_angle_deg": p.branch_angle_deg,
            "branch_angle_max_deg": p.branch_angle_max_deg,
            "junction_tol_m": p.junction_tol_m,
        },
    }
    return out, stats
