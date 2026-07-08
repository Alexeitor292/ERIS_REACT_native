"""
Server-side port of the mobile road cross-section derivation
(mobile/src/measurements/buildRoadSectionFromInventory.ts), so the ERIS worker can
PACKAGE the Road Inventory-derived roadway layout (RoadCrossSection) inside the
.eristerrain bundle for the offline Cross Section tool.

This is a FAITHFUL parity port: same field-alias precedence, same Caltrans defaults,
same median classification, same divided-road shoulder inference, same source-decision
(ROAD_INVENTORY / FORM_FIELDS / DEFAULT), and the same undefined-vs-null key handling
(the optional PM/route/county keys are OMITTED when absent; terrain/design_speed/adt/
landmark are always present, null when absent). Locked to the mobile output by the
shared fixture mobile/src/measurements/__fixtures__/roadCrossSectionParity.json (see
tests/test_road_cross_section_build.py and the mobile parity test).

Widths are in feet. Orientation is canonical UPSTATION (LT left, RT right).
"""

from __future__ import annotations

import math

# ── Caltrans defaults (mirror buildRoadSectionFromInventory.ts) ────────────────
DEFAULT_LANE_W_FT = 12
DEFAULT_FREEWAY_OSHLD_FT = 8
DEFAULT_HWY_OSHLD_FT = 4
DEFAULT_ISHLD_FT = 0
MIN_TOTAL_FT = 20

MedianCategory = str  # NONE | PAINTED | RAISED | BARRIER | DEPRESSED
RoadLayoutSource = str  # ROAD_INVENTORY | FORM_FIELDS | DEFAULT


def _to_num(v) -> float | None:
    """Mirror TS toNum: reject None/''/negative/non-finite -> None."""
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n < 0:
        return None
    return n


def _js_round(n: float) -> int:
    """JS Math.round semantics (round half toward +inf), not Python banker's rounding."""
    return int(math.floor(n + 0.5))


def _to_int(v) -> int | None:
    n = _to_num(v)
    return max(1, _js_round(n)) if n is not None else None


def _pick(*vals) -> float | None:
    for v in vals:
        n = _to_num(v)
        if n is not None:
            return n
    return None


def classify_median(code) -> MedianCategory:
    s = str(code if code is not None else "").strip().upper()
    if not s or s == "0" or s == "N" or s == "NONE":
        return "NONE"
    if s in ("P", "C", "1", "M"):
        return "PAINTED"
    if s in ("R", "K", "2", "RAISED"):
        return "RAISED"
    if s in ("B", "3", "BARRIER"):
        return "BARRIER"
    if s in ("D", "4", "DEPRESSED"):
        return "DEPRESSED"
    return "RAISED"  # unknown non-zero code -> raised


def _is_divided(median_cat: MedianCategory, median_w: float) -> bool:
    return median_cat != "NONE" and median_w > 0


def _num_or_int(x: float) -> float | int:
    """Present whole numbers as ints (matches JS number JSON: 12 not 12.0)."""
    return int(x) if isinstance(x, float) and x.is_integer() else x


def build_road_cross_section(snapshot: dict | None, fallback_roadway_width: float | None = None) -> dict:
    """Build a RoadCrossSection dict from a road-inventory snapshot (a serialized
    road_segments row) + a fallback roadway width. Byte-for-byte parity with the
    mobile derivation."""
    if not snapshot or not isinstance(snapshot, dict) or len(snapshot) == 0:
        return _build_fallback(fallback_roadway_width)

    sn = snapshot

    lt_lanes = _to_int(_first(sn, "left_lanes", "lt_lane_count", "lt_lanes")) or 1
    rt_lanes = _to_int(_first(sn, "right_lanes", "rt_lane_count", "rt_lanes")) or 1

    lt_tww = _pick(sn.get("left_traveled_way_width"), sn.get("lt_traveled_way_width"), sn.get("lt_tww"))
    if lt_tww is not None and lt_lanes > 0:
        lt_lane_w: float = lt_tww / lt_lanes
    else:
        lt_lane_w = _pick(sn.get("lt_lane_width"), sn.get("left_lane_width"))
        lt_lane_w = lt_lane_w if lt_lane_w is not None else DEFAULT_LANE_W_FT

    rt_tww = _pick(sn.get("right_traveled_way_width"), sn.get("rt_traveled_way_width"), sn.get("rt_tww"))
    if rt_tww is not None and rt_lanes > 0:
        rt_lane_w: float = rt_tww / rt_lanes
    else:
        rt_lane_w = _pick(sn.get("rt_lane_width"), sn.get("right_lane_width"))
        rt_lane_w = rt_lane_w if rt_lane_w is not None else DEFAULT_LANE_W_FT

    median_w = _pick(sn.get("median_width"), sn.get("median_width_ft"), sn.get("median_width_amt"))
    median_w = median_w if median_w is not None else 0
    median_cat = classify_median(sn.get("median_type") if sn.get("median_type") is not None else sn.get("median_type_code"))

    divided = _is_divided(median_cat, median_w)
    default_oshld = DEFAULT_FREEWAY_OSHLD_FT if (lt_lanes + rt_lanes >= 4) else DEFAULT_HWY_OSHLD_FT
    default_ishld = 4 if divided else DEFAULT_ISHLD_FT

    lt_oshld = _pick(
        sn.get("left_outside_shoulder_width"), sn.get("lt_outside_shoulder_width"),
        sn.get("lt_o_shd_tot_width"), sn.get("left_outside_shoulder"),
    )
    lt_oshld = lt_oshld if lt_oshld is not None else default_oshld

    if divided:
        lt_ishld = _pick(
            sn.get("left_inside_shoulder_width"), sn.get("lt_inside_shoulder_width"),
            sn.get("lt_i_shd_tot_width"), sn.get("left_inside_shoulder"),
        )
        lt_ishld = lt_ishld if lt_ishld is not None else default_ishld
        rt_ishld = _pick(
            sn.get("right_inside_shoulder_width"), sn.get("rt_inside_shoulder_width"),
            sn.get("rt_i_shd_tot_width"), sn.get("right_inside_shoulder"),
        )
        rt_ishld = rt_ishld if rt_ishld is not None else default_ishld
    else:
        lt_ishld = 0
        rt_ishld = 0

    rt_oshld = _pick(
        sn.get("right_outside_shoulder_width"), sn.get("rt_outside_shoulder_width"),
        sn.get("rt_o_shd_tot_width"), sn.get("right_outside_shoulder"),
    )
    rt_oshld = rt_oshld if rt_oshld is not None else default_oshld

    total = max(
        MIN_TOTAL_FT,
        lt_oshld + lt_ishld + lt_lanes * lt_lane_w + median_w + rt_lanes * rt_lane_w + rt_ishld + rt_oshld,
    )

    out: dict = {
        "lt_lane_count": lt_lanes,
        "rt_lane_count": rt_lanes,
        "lt_lane_width_ft": _num_or_int(float(lt_lane_w)),
        "rt_lane_width_ft": _num_or_int(float(rt_lane_w)),
        "lt_outside_shoulder_ft": _num_or_int(float(lt_oshld)),
        "lt_inside_shoulder_ft": _num_or_int(float(lt_ishld)),
        "rt_inside_shoulder_ft": _num_or_int(float(rt_ishld)),
        "rt_outside_shoulder_ft": _num_or_int(float(rt_oshld)),
        "median_width_ft": _num_or_int(float(median_w)),
        "median_category": median_cat,
        "total_width_ft": _num_or_int(float(total)),
    }
    # Optional PM/route/county: OMIT when absent (TS uses `?? undefined`).
    _add_if(out, "begin_pm", _num_or_int_opt(_to_num(sn.get("begin_pm"))))
    _add_if(out, "end_pm", _num_or_int_opt(_to_num(sn.get("end_pm"))))
    _add_if(out, "length_miles", _num_or_int_opt(_to_num(sn.get("length_miles"))))
    _add_if(out, "route_name", str(sn["route_name"]) if sn.get("route_name") is not None else None)
    _add_if(out, "county_code", str(sn["county_code"]) if sn.get("county_code") is not None else None)
    # Always present (TS uses `?? null`).
    out["terrain_code"] = str(sn["terrain_code"]) if sn.get("terrain_code") is not None else None
    out["design_speed"] = _num_or_int_opt(_to_num(sn.get("design_speed")))
    out["adt"] = _num_or_int_opt(_to_num(sn.get("adt")))
    out["landmark"] = str(sn["landmark_short_desc"]) if sn.get("landmark_short_desc") is not None else None
    out["source"] = "ROAD_INVENTORY"
    return out


def _build_fallback(roadway_width: float | None) -> dict:
    w = _to_num(roadway_width)
    if w is not None and w > 0:
        half_w = w / 2
        lane_count = max(1, _js_round(half_w / DEFAULT_LANE_W_FT))
        lane_w = half_w / lane_count
        total = max(MIN_TOTAL_FT, w)
        return {
            "lt_lane_count": lane_count, "rt_lane_count": lane_count,
            "lt_lane_width_ft": _num_or_int(float(lane_w)), "rt_lane_width_ft": _num_or_int(float(lane_w)),
            "lt_outside_shoulder_ft": 0, "lt_inside_shoulder_ft": 0,
            "rt_inside_shoulder_ft": 0, "rt_outside_shoulder_ft": 0,
            "median_width_ft": 0, "median_category": "NONE",
            "total_width_ft": _num_or_int(float(total)), "source": "FORM_FIELDS",
        }
    # Bare 2-lane undivided highway.
    return {
        "lt_lane_count": 1, "rt_lane_count": 1,
        "lt_lane_width_ft": DEFAULT_LANE_W_FT, "rt_lane_width_ft": DEFAULT_LANE_W_FT,
        "lt_outside_shoulder_ft": DEFAULT_HWY_OSHLD_FT, "lt_inside_shoulder_ft": 0,
        "rt_inside_shoulder_ft": 0, "rt_outside_shoulder_ft": DEFAULT_HWY_OSHLD_FT,
        "median_width_ft": 0, "median_category": "NONE",
        "total_width_ft": 2 * (DEFAULT_LANE_W_FT + DEFAULT_HWY_OSHLD_FT), "source": "DEFAULT",
    }


def _first(sn: dict, *keys):
    for k in keys:
        v = sn.get(k)
        if v is not None:
            return v
    return None


def _add_if(d: dict, key: str, value) -> None:
    if value is not None:
        d[key] = value


def _num_or_int_opt(x: float | None):
    return None if x is None else _num_or_int(float(x))
