"""Provider-neutral normalized road ROLE + carriageway-continuity identity.

The packaged road sources carry CENTERLINES and a functional classification — never
observed lanes, pavement edges, traffic direction, ownership or median width. So the role
model here is deliberately coarse and honest:

    mainline   — a through carriageway eligible to pair into a divided corridor.
    ramp       — an interchange ramp; separately selectable, never a carriageway partner.
    connector  — a short merge/diverge / collector-distributor branch; never a partner.
    unknown    — the source does not say, and we will not guess.

A PROVIDER ADAPTER may assign only what its source actually supports:
  * TIGER has MTFCC, which distinguishes ramp (S1630) / service-drive connector (S1640) /
    through road — so the TIGER adapter can assign a real role.
  * Caltrans CRS publishes an EXPLICIT ramp identity in its LRS route id / NAME: values
    like ``RAMP_116041_P`` and ``RAMP_YIELD_116044_P`` name the feature as a ramp. That is
    an authoritative provider statement, so the Caltrans adapter assigns ``ramp`` from it.
    Caltrans states nothing about mainline-vs-connector for its other routes, so those stay
    ``unknown``; a SEPARATE, geometry-based route-chaining pass (road_route_chains) may then
    demote ``unknown`` to ``connector`` from route continuity + geometry — a derivation
    recorded in ``role_source``, never presented as a provider fact.

Pure + deterministic (no I/O, no config): unit-testable in the non-DB backend job.
"""

from __future__ import annotations

import re

ROLE_MAINLINE = "mainline"
ROLE_RAMP = "ramp"
ROLE_CONNECTOR = "connector"
ROLE_UNKNOWN = "unknown"

ROLES = (ROLE_MAINLINE, ROLE_RAMP, ROLE_CONNECTOR, ROLE_UNKNOWN)

# Roles that MUST NOT form a divided-carriageway pair or be treated as an opposing
# carriageway. ``unknown`` is intentionally NOT excluded — an un-refined segment may still
# be a real carriageway; the pairing pass's own stability gates decide.
NON_CARRIAGEWAY_ROLES = frozenset({ROLE_RAMP, ROLE_CONNECTOR})

# How a role was arrived at (provenance; never implies a measured fact).
ROLE_SOURCE_PROVIDER = "provider"            # the provider's own attribute (e.g. TIGER MTFCC)
ROLE_SOURCE_ROUTE_CHAIN = "geometry_route_chain"  # derived by the route-chaining pass
ROLE_SOURCE_UNSPECIFIED = "unspecified"

# TIGER MTFCC signals (the only role signal TIGER carries).
_MTFCC_RAMP = "S1630"
_MTFCC_SERVICE_DRIVE = "S1640"   # collector/distributor / service drive -> connector


def normalized_role(value) -> str:
    """Coerce any value to one of the four roles; anything unrecognized -> unknown."""
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ROLES:
            return v
    return ROLE_UNKNOWN


def role_from_mtfcc(mtfcc) -> str:
    """TIGER role from MTFCC: ramp (S1630) / connector (S1640) / else mainline for a
    through road. Returns ``unknown`` when MTFCC is absent so nothing is fabricated.

    (S1100 primary, S1200 secondary and S1400 local are all THROUGH roads = mainline for
    corridor purposes; the pairing candidate filter still restricts to road_class primary.)
    """
    if not isinstance(mtfcc, str) or not mtfcc.strip():
        return ROLE_UNKNOWN
    code = mtfcc.strip().upper()
    if code == _MTFCC_RAMP:
        return ROLE_RAMP
    if code == _MTFCC_SERVICE_DRIVE:
        return ROLE_CONNECTOR
    if code.startswith("S1"):
        return ROLE_MAINLINE
    return ROLE_UNKNOWN


def role_of(props) -> str:
    """The TRUSTED normalized role of a packaged feature.

    Prefers an explicit ``road_role`` written by the adapter/route-chaining pass; then the
    PROVIDER's own route identity (a Caltrans `RAMP_*` package built before the adapter set
    the role still classifies correctly, so `pair_corridors` cannot pair two ramps); then the
    TIGER MTFCC signal. No other guessing."""
    p = props if isinstance(props, dict) else {}
    r = p.get("road_role")
    if isinstance(r, str) and r.strip().lower() in ROLES:
        return r.strip().lower()
    declared = caltrans_role_from_identity(p)
    if declared != ROLE_UNKNOWN:
        return declared
    return role_from_mtfcc(p.get("MTFCC"))


def is_non_carriageway(props) -> bool:
    """True when a feature's role forbids it from being a divided-carriageway partner."""
    return role_of(props) in NON_CARRIAGEWAY_ROLES


# ---- Caltrans CRS RouteID -> carriageway-continuity identity -----------------
# A CRS RouteID looks like "SHS_050._P" / "SHS_050._S" / "SHS_5._P": an LRS prefix, a route
# number, and a P/S/... directional-carriageway designator. The route FAMILY (the number)
# groups both carriageways of one highway; the full (family, designator) pair identifies a
# single carriageway — the stitching key. We parse conservatively and never invent a family.
_CRS_ROUTE_RE = re.compile(r"^(?:SHS[_\-])?0*(?P<num>\d+)(?:[._\-]+(?P<des>[A-Za-z0-9]+))?", re.IGNORECASE)


def caltrans_route_identity(route_id) -> tuple[str | None, str | None]:
    """(route_family, carriageway_designator) parsed from a CRS RouteID, or (None, None).

    "SHS_050._P" -> ("50", "P");  "SHS_099._S" -> ("99", "S");  "SHS_5._P" -> ("5", "P").
    Leading zeros in the number are stripped so "050" and "50" are the SAME family. The
    designator is upper-cased. A RouteID we cannot parse yields (None, None) — never a
    fabricated identity."""
    if not isinstance(route_id, str) or not route_id.strip():
        return (None, None)
    m = _CRS_ROUTE_RE.match(route_id.strip())
    if not m:
        return (None, None)
    num = m.group("num")
    des = m.group("des")
    family = str(int(num)) if num is not None else None
    designator = des.upper() if isinstance(des, str) and des else None
    return (family, designator)


# EXPLICIT provider ramp identity in the Caltrans CRS LRS route id / NAME, e.g.
# "RAMP_116041_P", "RAMP_YIELD_116044_P", "RAMP_133039_P".
#
# Matching is NORMALIZED (trimmed, case-insensitive) and anchored at the start. The negative
# lookahead rejects a following LETTER so a genuine route named e.g. "RAMPART..." is never
# mistaken for a ramp, while every real form ("RAMP", "RAMP_...", "RAMP-...", "RAMP116041")
# still matches. This is deliberately narrower than a bare "starts with RAMP" so the rule
# cannot over-claim; it recognises the provider's statement and infers nothing else — no
# direction, lane count, shoulder width or ramp type.
_RAMP_IDENTITY_RE = re.compile(r"^RAMP(?![A-Z])", re.IGNORECASE)

# The provider fields that may carry the route identity, in precedence order.
RAMP_IDENTITY_FIELDS = ("route_id", "NAME")

# The RAMP_* convention is a CALTRANS CRS LRS statement — it is NOT a general road-name
# rule. Other providers put a human STREET NAME in `NAME`, and real US streets are called
# "Ramp Creek Rd" / "Ramp Hollow Rd" / "Ramp St". Applying the rule to them would classify
# an ordinary residential street as a freeway ramp, so every lookup is scoped to the
# provider that actually publishes the convention.
CALTRANS_PROVIDER_NAME = "caltrans_crs"


def is_ramp_route_identity(value) -> bool:
    """True when a provider route identity string explicitly names a RAMP.

    Normalized + case-insensitive; ``None``/non-string/blank -> False. Never mutates or
    reinterprets the value — the original is kept verbatim for provenance."""
    if not isinstance(value, str):
        return False
    return bool(_RAMP_IDENTITY_RE.match(value.strip()))


def caltrans_role_from_identity(props) -> str:
    """The role Caltrans CRS itself states for a feature.

    ``ramp`` when the CALTRANS ``route_id`` or ``NAME`` explicitly names a ramp; otherwise
    ``unknown`` (the provider's F_System is a FUNCTION code and says nothing about mainline
    vs ramp). Only what the provider actually states — nothing is guessed from geometry.

    SCOPED TO THE CALTRANS PROVIDER. `RAMP_*` is a Caltrans LRS route-identity convention;
    other providers put a human street name in ``NAME``, and streets genuinely called
    "Ramp Creek Rd" exist. Without this scope an ordinary TIGER street would be classified
    a freeway ramp and would then trip the packaging invariant for the whole layer."""
    p = props if isinstance(props, dict) else {}
    if str(p.get("provider") or "").strip().lower() != CALTRANS_PROVIDER_NAME:
        return ROLE_UNKNOWN
    for key in RAMP_IDENTITY_FIELDS:
        if is_ramp_route_identity(p.get(key)):
            return ROLE_RAMP
    return ROLE_UNKNOWN


def provider_declares_ramp(props) -> bool:
    """Whether the PROVIDER's own route identity names this feature a ramp. Used as a
    fail-closed packaging invariant: such a feature must never be emitted as a mainline
    carriageway. Independent of the derived ``road_role`` so it also catches an adapter
    that failed to set the role."""
    return caltrans_role_from_identity(props) == ROLE_RAMP


def carriageway_continuity_key(props) -> str | None:
    """A stable key identifying ONE physical carriageway for route-chain stitching, or None
    when the source provides no continuity signal (so nothing is stitched).

    Caltrans: route_family + carriageway designator (same RouteID carriageway).
    Others: an explicit provider linear id (TLID/LINEARID) when present. Deliberately does
    NOT fall back to a display NAME — two unrelated roads can share a name."""
    p = props if isinstance(props, dict) else {}
    fam = p.get("route_family")
    des = p.get("carriageway_designator")
    if isinstance(fam, str) and fam:
        return f"crs:{fam}:{des if isinstance(des, str) and des else ''}"
    for key in ("provider_linear_id", "TLID", "LINEARID"):
        v = p.get(key)
        if isinstance(v, (str, int)) and str(v).strip():
            return f"lin:{key}:{str(v).strip()}"
    return None
