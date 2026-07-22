"""Deterministic station-local divided-highway corridor pairing.

Proves the pairing DECISION (not just that code runs): a wide-but-stable open median stays
ONE corridor while a diverging pair splits — stability, not proximity, is what distinguishes
a median from a divergence. Also pins ramp/route/mutual-nearest rejection, mod-180 axial
invariance, paired->unpaired->paired transitions, the midpoint-between invariant, the
additive selection-feature emission, and the manifest contract.

Pure geometry: no network, no DB.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from app.config import settings
from app.services import offline_scene_context as ctxmod
from app.services import road_corridor_pairing as pairing
from app.services.offline_scene_builder import HillshadeReliefBuilder
from app.services.road_cross_section_build import build_road_cross_section

M_PER_DEG_LAT = 111320.0
LAT0, LON0 = 38.5, -121.5

BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer"
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}


def _line(points, name="US-50", mtfcc="S1100", road_class="primary", lat0=LAT0, lon0=LON0):
    """Build a LineString from (along_m, offset_m) pairs: +along = east, +offset = north.

    Properties mirror the REAL packaged TIGERweb shape (the full provider allowlist plus the
    ERIS-trusted class fields), so the provider-metadata contract is genuinely exercised.
    """
    cos_lat = math.cos(math.radians(lat0))
    coords = [[lon0 + d / (M_PER_DEG_LAT * cos_lat), lat0 + off / M_PER_DEG_LAT] for d, off in points]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "road_class": road_class,
            "road_class_label": "Primary road / highway" if road_class == "primary" else "Local road",
            "NAME": name, "BASENAME": name, "MTFCC": mtfcc, "RTTYP": "U",
            "source_layer_id": 2 if road_class == "primary" else 8,
            "kind": "road_centerline",
        },
    }


def _straight(length_m, offset_m=0.0, step=25, **kw):
    return _line([(d, offset_m) for d in range(0, int(length_m) + 1, step)], **kw)


def _kinds(features):
    """Counts by SELECTABLE kind (diagnostics-only features have selection_kind None)."""
    out = {}
    for f in features:
        k = (f.get("properties") or {}).get("selection_kind")
        out[k] = out.get(k, 0) + 1
    return out


def _diag_kinds(features):
    out = {}
    for f in features:
        k = (f.get("properties") or {}).get("diagnostic_kind")
        if k:
            out[k] = out.get(k, 0) + 1
    return out


def _rev(f):
    import copy
    g = copy.deepcopy(f)
    g["geometry"]["coordinates"] = list(reversed(g["geometry"]["coordinates"]))
    return g


def _paired_unpaired_paired_pair():
    """A straight 1800 m carriageway + a partner that hugs, swings away, and returns."""
    pts = []
    for d in range(0, 1801, 25):
        if d <= 600:
            off = 20.0
        elif d <= 800:
            off = 20 + 300 * (d - 600) / 200.0
        elif d <= 1000:
            off = 320.0
        elif d <= 1200:
            off = 320 - 300 * (d - 1000) / 200.0
        else:
            off = 20.0
        pts.append((d, off))
    return _straight(1800), _line(pts)


# ---- pairing decisions -----------------------------------------------------


class TestPairingDecisions:
    def test_narrow_concrete_median_pairs_into_one_corridor(self):
        cs = pairing.pair_corridors([_straight(600), _straight(600, offset_m=18)])
        assert len(cs) == 1
        c = cs[0]
        assert 17.0 < min(c.separations) and max(c.separations) < 19.0
        assert c.length_m > 500

    def test_wide_but_STABLE_open_median_remains_one_corridor(self):
        # 45 m grass median: far too wide for a naive max-distance rule, but rock stable.
        cs = pairing.pair_corridors([_straight(800), _straight(800, offset_m=45)])
        assert len(cs) == 1, "a wide but stable median must NOT be split by distance alone"
        assert 44.0 < sum(cs[0].separations) / len(cs[0].separations) < 46.0

    def test_geographically_diverging_carriageways_stay_separate(self):
        # 20 m -> 300 m over 600 m: every sample is inside the distance band, but the
        # separation SLOPE (~0.47) is far past the gate -> not one corridor.
        diverge = _line([(d, 20 + (300 - 20) * d / 600.0) for d in range(0, 601, 25)])
        assert pairing.pair_corridors([_straight(600), diverge]) == []

    def test_unstable_oscillating_separation_is_rejected(self):
        osc = _line([(d, 42 + 27 * math.sin(d / 60.0)) for d in range(0, 901, 15)])
        assert pairing.pair_corridors([_straight(900), osc]) == []

    def test_paired_unpaired_paired_transition_yields_two_corridors(self):
        pts = []
        for d in range(0, 1801, 25):
            if d <= 600:
                off = 20.0
            elif d <= 800:
                off = 20 + 300 * (d - 600) / 200.0     # swings away
            elif d <= 1000:
                off = 320.0                            # genuinely separate alignment
            elif d <= 1200:
                off = 320 - 300 * (d - 1000) / 200.0   # comes back
            else:
                off = 20.0
            pts.append((d, off))
        cs = pairing.pair_corridors([_straight(1800), _line(pts)])
        assert len(cs) == 2, "the same route may transition paired -> separate -> paired"
        assert cs[0].a_range[1] < cs[1].a_range[0], "runs are disjoint and ordered"
        for c in cs:
            assert c.length_m >= settings.OFFLINE_SCENE_PAIR_MIN_CORRIDOR_LENGTH_M

    def test_reversed_coordinate_order_still_pairs(self):
        b = _straight(600, offset_m=20)
        b["geometry"]["coordinates"] = list(reversed(b["geometry"]["coordinates"]))
        assert len(pairing.pair_corridors([_straight(600), b])) == 1

    def test_axial_bearing_is_modulo_180(self):
        assert pairing.axial_bearing_diff(90.0, 270.0) == 0.0    # antiparallel carriageways
        assert pairing.axial_bearing_diff(10.0, 190.0) == 0.0
        assert pairing.axial_bearing_diff(0.0, 90.0) == 90.0     # perpendicular
        assert pairing.axial_bearing_diff(5.0, 355.0) == 10.0

    def test_parallel_ramp_is_never_paired(self):
        ramp = _straight(600, offset_m=20, name="Ramp", mtfcc=pairing.RAMP_MTFCC)
        assert pairing.pair_corridors([_straight(600), ramp]) == []
        assert pairing.is_ramp({"MTFCC": "S1630"}) is True
        assert pairing.is_ramp({"MTFCC": "S1100"}) is False

    def test_route_mismatch_is_rejected_but_missing_metadata_is_permitted(self):
        assert pairing.pair_corridors([_straight(600), _straight(600, offset_m=20, name="SR-16")]) == []
        # Absent route metadata must never BLOCK a geometric pairing.
        a = _straight(600)
        b = _straight(600, offset_m=20)
        for f in (a, b):
            f["properties"].pop("NAME"); f["properties"].pop("BASENAME")
        assert len(pairing.pair_corridors([a, b])) == 1
        assert pairing.routes_compatible({"NAME": "US-50"}, {}) is True
        assert pairing.routes_compatible({"NAME": "US-50"}, {"NAME": "SR-16"}) is False

    def test_non_primary_roads_never_pair(self):
        a = _straight(600, road_class="secondary", mtfcc="S1200")
        b = _straight(600, offset_m=20, road_class="secondary", mtfcc="S1200")
        assert pairing.pair_corridors([a, b]) == []

    def test_brief_interchange_only_proximity_is_rejected(self):
        # Only ~80 m of parallel hugging: below min_corridor_length_m (150 m).
        brief = _line([(d, 20) for d in range(0, 81, 10)] + [(d, 20 + (d - 80) * 0.9) for d in range(90, 401, 10)])
        assert pairing.pair_corridors([_straight(400), brief]) == []

    def test_mutual_nearest_is_required(self):
        # A third line sits between A and B, so B is not A's mutual-nearest partner.
        a, mid, b = _straight(600), _straight(600, offset_m=20), _straight(600, offset_m=40)
        cs = pairing.pair_corridors([a, mid, b])
        # A pairs with the middle line (its true nearest), never across it to B.
        for c in cs:
            seps = c.separations
            assert max(seps) < 25.0, "must not pair across an intervening carriageway"

    def test_derived_midpoint_stays_between_the_source_lines(self):
        a, b = _straight(600), _straight(600, offset_m=30)
        c = pairing.pair_corridors([a, b])[0]
        ac, bc = a["geometry"]["coordinates"], b["geometry"]["coordinates"]
        for m in c.midpoint:
            da = pairing.project_point_to_polyline(m[0], m[1], ac)[2]
            db = pairing.project_point_to_polyline(m[0], m[1], bc)[2]
            assert abs(da - db) < 1.0, "midpoint must remain centred between the carriageways"
            assert 14.0 < da < 16.0, "and about half the separation from each"

    def test_output_is_deterministic_and_mirror_deduplicated(self):
        a, b = _straight(600), _straight(600, offset_m=20)
        first = pairing.pair_corridors([a, b])
        second = pairing.pair_corridors([b, a])   # input order must not matter
        assert len(first) == len(second) == 1, "A<->B must emit ONE corridor, never a mirror pair"
        assert first[0].a_id == second[0].a_id and first[0].b_id == second[0].b_id
        assert first[0].a_id < first[0].b_id      # deterministic ordered pair


# ---- additive selection features -------------------------------------------


class TestSelectionFeatures:
    def test_carriageway_is_split_into_diagnostic_member_and_selectable_unpaired(self):
        pts = []
        for d in range(0, 1801, 25):
            off = 20.0 if d <= 600 else (20 + 300 * (d - 600) / 200.0 if d <= 800 else 320.0)
            pts.append((d, off))
        out, stats = pairing.build_selection_features([_straight(1800), _line(pts)])
        assert _kinds(out).get("divided_highway_corridor") == 1
        assert _kinds(out).get("individual_carriageway", 0) >= 2   # unpaired remainder of both
        assert _diag_kinds(out).get("carriageway_member", 0) >= 2  # paired portion of both
        for f in out:
            p = f["properties"]
            if p.get("diagnostic_kind") == "carriageway_member":
                assert p["selectable"] is False and p["diagnostic"] is True
                assert p["selection_kind"] is None, "a diagnostics role must not enter the selectable enum"
            if p.get("selection_kind") in pairing.SELECTABLE_KINDS:
                assert p["selectable"] is True and p["diagnostic"] is False

    def test_corridor_feature_carries_full_provenance(self):
        out, _ = pairing.build_selection_features([_straight(600), _straight(600, offset_m=22)])
        c = next(f for f in out if f["properties"]["selection_kind"] == "divided_highway_corridor")
        p = c["properties"]
        assert p["road_class"] == "primary"
        ids = p["member_source_feature_ids"]
        assert len(ids) == 2 and ids[0] != ids[1]
        assert len(p["member_part_feature_ids"]) == 2
        assert len(p["member_geometry"]["a"]) >= 2 and len(p["member_geometry"]["b"]) >= 2
        assert p["member_geometry_kind"] == "observed_source_centerlines_clipped_to_run", "unambiguous semantics"
        assert p["separation_m"]["samples"] > 0 and 21.0 < p["separation_m"]["mean"] < 23.0
        assert p["orientation_source"] == "geometry_derived", "never an authoritative direction claim"
        assert p["pairing"]["method"] == pairing.PAIRING_METHOD and p["pairing"]["version"] == pairing.PAIRING_VERSION
        assert c["geometry"]["type"] == "LineString" and len(c["geometry"]["coordinates"]) >= 2

    def test_every_feature_gains_a_stable_feature_id(self):
        out, _ = pairing.build_selection_features([_straight(600), _straight(600, offset_m=20)])
        again, _ = pairing.build_selection_features([_straight(600), _straight(600, offset_m=20)])
        ids = [f["properties"]["feature_id"] for f in out]
        assert all(isinstance(i, str) and i for i in ids)
        assert ids == [f["properties"]["feature_id"] for f in again], "content-derived ids are stable"


# ---- identity: source vs emitted-part (review blockers 1 + 3) ---------------


def _all_features():
    """A scene with all four selectable kinds + diagnostics members."""
    a, b = _paired_unpaired_paired_pair()
    local = _straight(400, offset_m=-300, name="Oak St", mtfcc="S1400", road_class="local")
    local["properties"]["source_layer_id"] = 8
    ramp = _straight(300, offset_m=-250, name="Ramp 12A", mtfcc=pairing.RAMP_MTFCC)
    return [a, b, local, ramp]


class TestIdentity:
    def test_every_emitted_feature_id_is_globally_unique(self):
        out, _ = pairing.build_selection_features(_all_features())
        ids = [f["properties"]["feature_id"] for f in out]
        assert len(ids) == len(set(ids)), f"duplicate feature_id: {[i for i in ids if ids.count(i) > 1]}"
        assert all(isinstance(i, str) and i for i in ids)

    def test_parts_share_source_feature_id_but_differ_by_feature_id(self):
        out, _ = pairing.build_selection_features(_all_features())
        by_source: dict = {}
        for f in out:
            p = f["properties"]
            if p.get("source_feature_id"):
                by_source.setdefault(p["source_feature_id"], []).append(p["feature_id"])
        multi = {s: ids for s, ids in by_source.items() if len(ids) > 1}
        assert multi, "the paired->unpaired->paired carriageways must emit several parts"
        for sid, ids in multi.items():
            assert len(set(ids)) == len(ids), f"parts of {sid} must have distinct feature_ids"

    def test_paired_unpaired_paired_part_identities_and_stable_source_id(self):
        a, b = _paired_unpaired_paired_pair()
        out, _ = pairing.build_selection_features([a, b])
        a_sid = pairing.source_feature_id(a["geometry"]["coordinates"], a["properties"])
        parts = [f["properties"] for f in out if f["properties"].get("source_feature_id") == a_sid]
        members = [p for p in parts if p.get("diagnostic_kind") == "carriageway_member"]
        singles = [p for p in parts if p.get("selection_kind") == "individual_carriageway"]
        assert len(members) == 2, "two paired runs -> two diagnostics member parts"
        assert len(set(p["feature_id"] for p in members)) == 2, "member part ids are unique"
        assert len(singles) >= 1 and len(set(p["feature_id"] for p in singles)) == len(singles)
        assert all(p["source_feature_id"] == a_sid for p in parts), "source id stable across every part"

    def test_source_feature_id_is_coordinate_order_invariant(self):
        a = _straight(600)
        fwd = pairing.source_feature_id(a["geometry"]["coordinates"], a["properties"])
        rev = pairing.source_feature_id(list(reversed(a["geometry"]["coordinates"])), a["properties"])
        assert fwd == rev, "reversing a source line must not change its source identity"

    def test_source_identity_includes_layer_context(self):
        """Identical geometry from a different provider layer must not collide."""
        coords = _straight(600)["geometry"]["coordinates"]
        p2 = {"road_class": "primary", "source_layer_id": 2, "kind": "road_centerline"}
        p8 = {"road_class": "local", "source_layer_id": 8, "kind": "road_centerline"}
        assert pairing.source_feature_id(coords, p2) != pairing.source_feature_id(coords, p8)

    def test_authoritative_provider_id_is_preferred_when_present(self):
        coords = _straight(600)["geometry"]["coordinates"]
        base = {"road_class": "primary", "source_layer_id": 2}
        with_id = dict(base, provider_feature_id="TLID-12345")
        assert pairing.source_feature_id(coords, with_id) != pairing.source_feature_id(coords, base)
        # Stable, and independent of the geometry it came with.
        other = pairing.source_feature_id(_straight(900)["geometry"]["coordinates"], with_id)
        assert other == pairing.source_feature_id(coords, with_id)

    def test_id_prefixes_are_documented_and_distinct(self):
        out, _ = pairing.build_selection_features(_all_features())
        corr = next(f for f in out if f["properties"].get("selection_kind") == "divided_highway_corridor")
        part = next(f for f in out if f["properties"].get("selection_kind") == "ordinary_road")
        assert corr["properties"]["feature_id"].startswith("c")
        assert part["properties"]["feature_id"].startswith("p")
        assert part["properties"]["source_feature_id"].startswith("r")


class TestCorridorRelationships:
    def test_member_source_ids_resolve_and_are_deterministically_ordered(self):
        out, _ = pairing.build_selection_features(_all_features())
        sources = {f["properties"]["source_feature_id"] for f in out if f["properties"].get("source_feature_id")}
        for f in out:
            p = f["properties"]
            if p.get("selection_kind") != "divided_highway_corridor":
                continue
            ids = p["member_source_feature_ids"]
            assert len(ids) == 2 and all(i in sources for i in ids), "member sources must resolve"
            assert ids == sorted(ids), "member source ids are deterministically ordered"

    def test_member_part_ids_resolve_to_exactly_one_diagnostics_feature_each(self):
        out, _ = pairing.build_selection_features(_all_features())
        diag_by_id = {}
        for f in out:
            p = f["properties"]
            if p.get("diagnostic_kind") == "carriageway_member":
                diag_by_id.setdefault(p["feature_id"], []).append(f)
        for f in out:
            p = f["properties"]
            if p.get("selection_kind") != "divided_highway_corridor":
                continue
            parts = p["member_part_feature_ids"]
            assert len(parts) == 2
            for pid in parts:
                assert len(diag_by_id.get(pid, [])) == 1, f"{pid} must resolve to exactly one diagnostics feature"

    def test_member_part_ids_belong_to_the_declared_member_sources(self):
        out, _ = pairing.build_selection_features(_all_features())
        by_id = {f["properties"]["feature_id"]: f["properties"] for f in out}
        for f in out:
            p = f["properties"]
            if p.get("selection_kind") != "divided_highway_corridor":
                continue
            for pid, sid in zip(p["member_part_feature_ids"], p["member_source_feature_ids"]):
                assert by_id[pid]["source_feature_id"] == sid, "part id aligns with its source id"


class TestEnumSeparation:
    def test_selection_kinds_contains_exactly_the_four_selectable_values(self):
        _, stats = pairing.build_selection_features(_all_features())
        assert stats["selection_kinds"] == sorted(pairing.SELECTABLE_KINDS)
        assert set(stats["selection_kind_counts"]) == set(pairing.SELECTABLE_KINDS)

    def test_carriageway_member_appears_only_under_diagnostic_metadata(self):
        out, stats = pairing.build_selection_features(_all_features())
        assert "carriageway_member" not in stats["selection_kinds"]
        assert "carriageway_member" not in stats["selection_kind_counts"]
        assert stats["diagnostic_kinds"] == ["carriageway_member"]
        assert stats["diagnostic_kind_counts"]["carriageway_member"] > 0
        for f in out:
            assert f["properties"].get("selection_kind") != "carriageway_member"

    def test_provider_metadata_is_inline_and_consistent_across_kinds(self):
        out, _ = pairing.build_selection_features(_all_features())
        corr = next(f for f in out if f["properties"].get("selection_kind") == "divided_highway_corridor")
        indiv = next(f for f in out if f["properties"].get("selection_kind") == "individual_carriageway")
        # ONE contract: native reads the same inline fields for every candidate.
        for key in ("NAME", "BASENAME", "MTFCC", "RTTYP", "source_layer_id"):
            assert corr["properties"][key] == indiv["properties"][key]
        assert "route" not in corr["properties"], "corridor must not nest route metadata separately"
        assert len(corr["properties"]["member_provider_metadata"]) == 2

    def test_corridor_never_fabricates_disagreeing_provider_metadata(self):
        a = _straight(600)
        b = _straight(600, offset_m=20)
        b["properties"]["RTTYP"] = "S"          # members disagree
        b["properties"].pop("BASENAME")          # and one member lacks a field
        out, _ = pairing.build_selection_features([a, b])
        p = next(f for f in out if f["properties"].get("selection_kind") == "divided_highway_corridor")["properties"]
        assert "RTTYP" not in p, "must not fabricate a value the members disagree on"
        assert "BASENAME" not in p, "must not fabricate a value a member lacks"
        assert p["NAME"] == "US-50", "shared values are still exposed inline"


class TestDeterminism:
    def test_reversing_either_or_both_sources_preserves_identity(self):
        a, b = _straight(600), _straight(600, offset_m=20)

        def snap(feats):
            out, _ = pairing.build_selection_features(feats)
            c = next(f for f in out if f["properties"].get("selection_kind") == "divided_highway_corridor")["properties"]
            return (c["feature_id"], tuple(c["member_source_feature_ids"]), tuple(c["member_part_feature_ids"]))

        base = snap([a, b])
        assert snap([_rev(a), b]) == base, "reversing one carriageway must not change identity"
        assert snap([a, _rev(b)]) == base, "reversing the other carriageway must not change identity"
        assert snap([_rev(a), _rev(b)]) == base, "reversing both must not change identity"

    def test_reordering_input_yields_a_deeply_equal_feature_collection(self):
        feats = _all_features()
        o1, _ = pairing.build_selection_features(feats)
        o2, _ = pairing.build_selection_features(list(reversed(feats)))
        assert {"type": "FeatureCollection", "features": o1} == {"type": "FeatureCollection", "features": o2}

    def test_production_json_serialization_is_byte_identical_under_reorder(self):
        feats = _all_features()
        o1, s1 = pairing.build_selection_features(feats)
        o2, s2 = pairing.build_selection_features(list(reversed(feats)))
        # The exact serialization the builder uses for roads.geojson.
        b1 = json.dumps({"type": "FeatureCollection", "features": o1}, separators=(",", ":")).encode("utf-8")
        b2 = json.dumps({"type": "FeatureCollection", "features": o2}, separators=(",", ":")).encode("utf-8")
        assert b1 == b2, "provider response order must never change roads.geojson bytes"
        assert json.dumps(s1, separators=(",", ":")) == json.dumps(s2, separators=(",", ":"))

    def test_manifest_arrays_and_counts_serialize_deterministically(self):
        _, stats = pairing.build_selection_features(_all_features())
        assert stats["selection_kinds"] == sorted(stats["selection_kinds"])
        assert list(stats["selection_kind_counts"]) == sorted(stats["selection_kind_counts"])
        assert stats["diagnostic_kinds"] == sorted(stats["diagnostic_kinds"])
        assert list(stats["diagnostic_kind_counts"]) == sorted(stats["diagnostic_kind_counts"])

    def test_emission_order_is_role_rank_then_feature_id(self):
        out, _ = pairing.build_selection_features(_all_features())
        rank = {"divided_highway_corridor": 0, "individual_carriageway": 1, "ordinary_road": 2, "ramp": 3}
        keys = [(rank.get(f["properties"].get("selection_kind"), 4), f["properties"]["feature_id"]) for f in out]
        assert keys == sorted(keys), "features must be emitted in (role rank, feature_id) order"


class TestThresholdValidation:
    def test_midpoint_tolerance_is_a_configured_threshold_end_to_end(self, monkeypatch):
        # config -> params
        assert hasattr(settings, "OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M")
        b = HillshadeReliefBuilder()
        monkeypatch.setattr(settings, "OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M", 2.5)
        assert b._pairing_params().midpoint_tolerance_m == 2.5
        # params -> manifest pairing block
        _, stats = pairing.build_selection_features(
            [_straight(600), _straight(600, offset_m=20)],
            pairing.PairingParams(midpoint_tolerance_m=2.5),
        )
        assert stats["pairing"]["midpoint_tolerance_m"] == 2.5
        # documented in the ADR
        adr = (Path(__file__).resolve().parents[2] / "docs" / "adr-divided-highway-corridor-pairing.md").read_text(encoding="utf-8")
        assert "midpoint_tolerance_m" in adr and "OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M" in adr

    def test_all_eleven_thresholds_are_reported_in_the_manifest_pairing_block(self):
        _, stats = pairing.build_selection_features([_straight(600), _straight(600, offset_m=20)])
        for key in ("sample_interval_m", "window_m", "min_separation_m", "max_separation_m",
                    "max_bearing_diff_deg", "max_offset_angle_dev_deg", "sep_stdev_max_m",
                    "sep_slope_max", "min_window_coverage", "min_corridor_length_m",
                    "midpoint_tolerance_m"):
            assert key in stats["pairing"], f"{key} must be packaged"

    def test_invalid_thresholds_are_rejected(self):
        import pytest as _pytest
        bad = [
            {"sample_interval_m": 0}, {"sample_interval_m": float("nan")},
            {"min_separation_m": 200.0},                      # >= max_separation_m
            {"min_window_coverage": 0.0}, {"min_window_coverage": 1.5},
            {"window_m": 10.0},                               # < 3 sample intervals
            {"midpoint_tolerance_m": -1.0}, {"sep_slope_max": 0},
            {"max_bearing_diff_deg": 120.0},
        ]
        for kw in bad:
            with _pytest.raises(pairing.PairingConfigError):
                pairing.PairingParams(**kw)
        pairing.PairingParams()  # defaults are valid

    def test_unpaired_primary_is_individual_carriageway_not_ordinary_road(self):
        """An unpaired PRIMARY centerline is a geographically separated directional roadway
        (individually selectable); only secondary/local/unclassified are ordinary roads."""
        local = _straight(400, offset_m=-300, name="Oak St", mtfcc="S1400", road_class="local")
        ramp = _straight(300, offset_m=-250, name="Ramp", mtfcc=pairing.RAMP_MTFCC)
        out, stats = pairing.build_selection_features([_straight(600), local, ramp])
        k = _kinds(out)
        assert k.get("individual_carriageway") == 1, "the unpaired primary stays individually selectable"
        assert k.get("ordinary_road") == 1, "only the local street is an ordinary road"
        assert k.get("ramp") == 1
        assert stats["divided_corridor_count"] == 0
        assert "divided_highway_corridor" not in stats["selection_kinds"]

    def test_geometry_is_preserved_for_non_line_and_degenerate_input(self):
        pt = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [LON0, LAT0]}, "properties": {}}
        out, _ = pairing.build_selection_features([pt])
        assert out == [pt], "non-line input is passed through untouched"

    def test_empty_and_single_feature_input_is_safe(self):
        assert pairing.pair_corridors([]) == []
        assert pairing.pair_corridors([_straight(600)]) == []
        out, stats = pairing.build_selection_features([])
        assert out == [] and stats["divided_corridor_count"] == 0


# ---- candidate eligibility: ONLY real road centerlines ---------------------


def _context_line(kind, offset_m, extra=None, length=400):
    """A non-centerline ERIS context line (road_bearing / road_inventory / submitted)."""
    f = _line([(d, offset_m) for d in range(0, length + 1, 25)])
    f["properties"] = {"kind": kind, **(extra or {})}   # context lines carry no road_class
    return f


def _integration_scene():
    """Two paired primaries + a geographically separate primary + a ramp + a local road +
    a road_bearing line + an inventory context line."""
    return [
        _straight(600),                                                            # paired A
        _straight(600, offset_m=20),                                               # paired B
        _straight(500, offset_m=-800, name="US-50 sep"),                           # separate primary
        _straight(300, offset_m=-250, name="Ramp 12A", mtfcc=pairing.RAMP_MTFCC),  # ramp
        _straight(400, offset_m=-400, name="Oak St", mtfcc="S1400", road_class="local"),
        _context_line("road_bearing", -600, {"bearing_deg": 90.0}, length=900),
        _context_line("road_inventory", -700, {"route_name": "50"}, length=350),
    ]


class TestCandidateEligibility:
    def test_only_road_centerline_features_may_be_selection_candidates(self):
        out, _ = pairing.build_selection_features(_integration_scene())
        for f in out:
            p = f["properties"]
            if p.get("selection_kind") is not None:
                assert p["kind"] == "road_centerline", (
                    f"{p.get('kind')} must never receive a selection_kind"
                )

    def test_road_bearing_is_packaged_but_never_selectable(self):
        out, stats = pairing.build_selection_features(_integration_scene())
        bearing = [f for f in out if f["properties"].get("kind") == "road_bearing"]
        assert len(bearing) == 1, "the synthetic bearing line must still be packaged"
        p = bearing[0]["properties"]
        assert p["selection_kind"] is None and p["selectable"] is False
        assert p.get("diagnostic") is False and "diagnostic_kind" not in p
        assert p["bearing_deg"] == 90.0, "its existing contextual payload is preserved"
        assert len(bearing[0]["geometry"]["coordinates"]) >= 2, "geometry preserved"
        # never promoted, never counted as a candidate or a diagnostic
        assert "road_bearing" not in stats["selection_kinds"] + stats["diagnostic_kinds"]

    def test_inventory_and_submitted_context_lines_remain_nonselectable(self):
        scene = _integration_scene() + [_context_line("submitted_road_geometry", -900)]
        out, _ = pairing.build_selection_features(scene)
        for kind in ("road_inventory", "submitted_road_geometry"):
            fs = [f for f in out if f["properties"].get("kind") == kind]
            assert len(fs) == 1, f"{kind} must still be packaged"
            p = fs[0]["properties"]
            assert p["selection_kind"] is None and p["selectable"] is False and p["diagnostic"] is False
            assert p["feature_id"] and p["source_feature_id"], "context features still get ids"

    def test_context_features_never_get_ordinary_road(self):
        out, _ = pairing.build_selection_features(_integration_scene())
        for f in out:
            p = f["properties"]
            if p.get("kind") != "road_centerline":
                assert p.get("selection_kind") != "ordinary_road"

    def test_a_synthetic_bearing_line_cannot_displace_or_duplicate_a_real_candidate(self):
        """Adding a bearing line must not change the real road candidates at all."""
        without = _integration_scene()[:5]
        with_bearing = without + [_context_line("road_bearing", -600, {"bearing_deg": 90.0}, length=900)]
        o1, s1 = pairing.build_selection_features(without)
        o2, s2 = pairing.build_selection_features(with_bearing)
        sel1 = [f for f in o1 if f["properties"].get("selectable")]
        sel2 = [f for f in o2 if f["properties"].get("selectable")]
        assert [f["properties"]["feature_id"] for f in sel1] == [f["properties"]["feature_id"] for f in sel2]
        assert s1["selection_kind_counts"] == s2["selection_kind_counts"]
        assert s2["context_feature_count"] == s1["context_feature_count"] + 1

    def test_context_feature_ids_are_unique_deterministic_and_never_collide(self):
        scene = _integration_scene()
        out, _ = pairing.build_selection_features(scene)
        again, _ = pairing.build_selection_features(list(reversed(scene)))
        ids = [f["properties"]["feature_id"] for f in out]
        assert len(ids) == len(set(ids))
        assert ids == [f["properties"]["feature_id"] for f in again], "deterministic under reorder"
        # A context role can never collide with a selectable/diagnostic part of one source.
        assert pairing.context_role("road_bearing") == "context:road_bearing"
        coords = _straight(400)["geometry"]["coordinates"]
        sid = "rTEST"
        ctx_id = pairing.part_feature_id(sid, pairing.context_role("road_bearing"), coords)
        sel_id = pairing.part_feature_id(sid, pairing.SELECTION_ORDINARY_ROAD, coords)
        dia_id = pairing.part_feature_id(sid, pairing.DIAGNOSTIC_CARRIAGEWAY_MEMBER, coords)
        assert len({ctx_id, sel_id, dia_id}) == 3, "role discriminator prevents collisions"


class TestClassification:
    def test_standalone_unpaired_primary_becomes_individual_carriageway(self):
        out, _ = pairing.build_selection_features([_straight(600)])
        assert _kinds(out) == {"individual_carriageway": 1}

    def test_geographically_separated_primary_remains_individually_selectable(self):
        out, _ = pairing.build_selection_features(_integration_scene())
        sep = next(f for f in out if f["properties"].get("NAME") == "US-50 sep")
        assert sep["properties"]["selection_kind"] == "individual_carriageway"
        assert sep["properties"]["selectable"] is True

    def test_standalone_local_and_secondary_become_ordinary_road(self):
        local = _straight(400, name="Oak St", mtfcc="S1400", road_class="local")
        secondary = _straight(400, offset_m=-500, name="Elm Ave", mtfcc="S1200", road_class="secondary")
        out, _ = pairing.build_selection_features([local, secondary])
        assert _kinds(out) == {"ordinary_road": 2}, "a local/secondary road is never a carriageway"

    def test_partially_paired_primary_remainder_is_individual_carriageway(self):
        a, b = _paired_unpaired_paired_pair()
        out, _ = pairing.build_selection_features([a, b])
        k = _kinds(out)
        assert k.get("divided_highway_corridor") == 2
        assert k.get("individual_carriageway", 0) >= 2, "the unpaired middle stays selectable"
        assert _diag_kinds(out).get("carriageway_member", 0) == 4


class TestCountSemantics:
    def test_feature_count_partition_arithmetic_is_exact(self):
        _, s = pairing.build_selection_features(_integration_scene())
        assert s["feature_count"] == (
            s["selectable_feature_count"] + s["diagnostic_feature_count"] + s["context_feature_count"]
        )
        assert sum(s["selection_kind_counts"].values()) == s["selectable_feature_count"]
        assert sum(s["diagnostic_kind_counts"].values()) == s["diagnostic_feature_count"]

    def test_source_feature_count_is_unchanged_by_pairing(self):
        scene = _integration_scene()
        _, s = pairing.build_selection_features(scene)
        assert s["source_feature_count"] == len(scene)
        assert s["feature_count"] != s["source_feature_count"], "the rewrite does change the emitted total"

    def test_divided_corridor_count_counts_only_emitted_corridors(self):
        out, s = pairing.build_selection_features(_integration_scene())
        emitted = len([f for f in out if f["properties"].get("selection_kind") == "divided_highway_corridor"])
        assert s["divided_corridor_count"] == emitted == 1

    def test_exact_integration_selection_and_count_contract(self):
        out, s = pairing.build_selection_features(_integration_scene())
        assert s["selection_kind_counts"] == {
            "divided_highway_corridor": 1,   # the paired pair
            "individual_carriageway": 1,     # the geographically separate primary
            "ordinary_road": 1,              # the local road
            "ramp": 1,                       # the ramp
        }
        assert s["diagnostic_kind_counts"] == {"carriageway_member": 2}
        assert s["context_feature_count"] == 2                      # bearing + inventory
        assert s["selectable_feature_count"] == 4
        assert s["diagnostic_feature_count"] == 2
        assert s["feature_count"] == 8 and s["source_feature_count"] == 7
        assert s["selectable_road_class_counts"] == {"local": 1, "primary": 3}


# ---- manifest contract ------------------------------------------------------


class FakeResp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._p


class FakeSession:
    def __init__(self, per_layer):
        self.per_layer = per_layer

    def get(self, url, params=None, timeout=None):
        lid = int(url.rstrip("/").split("/")[-2])
        return FakeResp(self.per_layer.get(lid) or {"features": []})


def _ctx():
    return {
        "submission_id": 77, "package_version": "dhc-1", "center": INCIDENT,
        "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
        "road_inventory_geometry": None,
        "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
        "external_road_features": [],
        "overlays": {"incident": INCIDENT, "roadBearingDeg": None, "geometry": None, "sampleExtent": None},
    }


def _settings(monkeypatch, *, pairing_enabled=True):
    monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "census_tigerweb")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", BASE)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_DIVIDED_PAIRING_ENABLED", pairing_enabled)


class TestManifestContract:
    def _build(self, monkeypatch, **kw):
        _settings(monkeypatch, **kw)
        # Two 600 m primary carriageways, 20 m apart, inside the package bounds.
        s = FakeSession({
            2: {"features": [_straight(600), _straight(600, offset_m=20)]},
            6: {"features": []}, 8: {"features": []},
        })
        b = HillshadeReliefBuilder()
        b._session = s
        return b._build_context_layers(_ctx(), base_bytes=0)

    def test_manifest_reports_selection_kinds_counts_and_pairing_method(self, monkeypatch):
        layers, assets = self._build(monkeypatch)
        roads = layers["roads"]
        assert roads["available"] is True
        assert "divided_highway_corridor" in roads["selection_kinds"]
        assert roads["divided_corridor_count"] == 1
        assert roads["selection_kind_counts"]["divided_highway_corridor"] == 1
        assert roads["pairing"]["method"] == pairing.PAIRING_METHOD
        assert roads["pairing"]["version"] == pairing.PAIRING_VERSION
        # The packaged block reports the thresholds ACTUALLY applied.
        assert roads["pairing"]["sample_interval_m"] == settings.OFFLINE_SCENE_PAIR_SAMPLE_INTERVAL_M
        assert roads["pairing"]["window_m"] == settings.OFFLINE_SCENE_PAIR_WINDOW_M
        # Existing road-class provenance is untouched.
        assert roads["source"]["provider"] == "us_census_tigerweb"
        assert roads["road_classes"] == ["primary"]
        gj = json.loads(assets[ctxmod.ROADS_FILE])
        corr = [f for f in gj["features"] if f["properties"].get("selection_kind") == "divided_highway_corridor"]
        assert len(corr) == 1

    def test_pairing_can_be_disabled_and_the_package_is_unchanged(self, monkeypatch):
        layers, assets = self._build(monkeypatch, pairing_enabled=False)
        roads = layers["roads"]
        assert roads["available"] is True
        assert "selection_kinds" not in roads and "divided_corridor_count" not in roads
        gj = json.loads(assets[ctxmod.ROADS_FILE])
        assert all("selection_kind" not in (f["properties"] or {}) for f in gj["features"])
        assert roads["road_classes"] == ["primary"], "legacy road-class metadata still present"

    def test_pairing_exception_preserves_original_roads_and_cannot_fail_the_build(self, monkeypatch):
        """A pairing failure must degrade to the legacy road package, never break packaging."""
        _settings(monkeypatch)

        def boom(*_a, **_kw):
            raise RuntimeError("pairing exploded")

        # The builder imports this module as `corridor_pairing`; it is the SAME module
        # object, so patching the attribute here patches the builder's call site.
        monkeypatch.setattr(pairing, "build_selection_features", boom)
        s = FakeSession({
            2: {"features": [_straight(600), _straight(600, offset_m=20)]},
            6: {"features": []}, 8: {"features": []},
        })
        b = HillshadeReliefBuilder()
        b._session = s
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)   # must NOT raise
        roads = layers["roads"]
        assert roads["available"] is True, "the roads layer survives a pairing failure"
        assert "selection_kinds" not in roads and "divided_corridor_count" not in roads
        gj = json.loads(assets[ctxmod.ROADS_FILE])
        assert len(gj["features"]) == 2, "the ORIGINAL road features are still packaged"
        assert all("selection_kind" not in (f["properties"] or {}) for f in gj["features"])
        assert roads["road_classes"] == ["primary"], "existing road-class metadata intact"

    def test_manifest_counts_are_truthful_and_partition_exactly(self, monkeypatch):
        """road_class_counts must describe the ORIGINAL sources (2 primary carriageways),
        never the rewritten collection (which would inflate them via splits + the corridor)."""
        _settings(monkeypatch)
        s = FakeSession({
            2: {"features": [_straight(600), _straight(600, offset_m=20)]},
            6: {"features": []}, 8: {"features": []},
        })
        b = HillshadeReliefBuilder()
        b._session = s
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        gj = json.loads(assets[ctxmod.ROADS_FILE])

        assert roads["source_feature_count"] == 2, "two original source carriageways"
        assert roads["road_class_counts"] == {"primary": 2}, "counted from the ORIGINAL sources"
        assert roads["feature_count"] == len(gj["features"]), "feature_count == features serialized"
        assert roads["feature_count"] == (
            roads["selectable_feature_count"] + roads["diagnostic_feature_count"] + roads["context_feature_count"]
        )
        assert sum(roads["selection_kind_counts"].values()) == roads["selectable_feature_count"]
        assert sum(roads["diagnostic_kind_counts"].values()) == roads["diagnostic_feature_count"]
        emitted = len([f for f in gj["features"]
                       if (f["properties"] or {}).get("selection_kind") == "divided_highway_corridor"])
        assert roads["divided_corridor_count"] == emitted

    def test_manifest_road_class_counts_are_not_inflated_by_derived_features(self, monkeypatch):
        """A partially paired pair emits many parts + 2 corridors, but there are still only
        TWO source primaries."""
        _settings(monkeypatch)
        a, b_line = _paired_unpaired_paired_pair()
        s = FakeSession({2: {"features": [a, b_line]}, 6: {"features": []}, 8: {"features": []}})
        b = HillshadeReliefBuilder()
        b._session = s
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["road_class_counts"] == {"primary": 2}, "not inflated by splits/corridors"
        assert roads["source_feature_count"] == 2
        assert roads["feature_count"] > 2, "the rewrite genuinely emits more features"
        assert roads["divided_corridor_count"] == 2

    def test_manifest_reports_diagnostic_enums_separately_from_selectable(self, monkeypatch):
        layers, _ = self._build(monkeypatch)
        roads = layers["roads"]
        assert "carriageway_member" not in roads["selection_kinds"]
        assert roads["diagnostic_kinds"] == ["carriageway_member"]
        assert roads["diagnostic_kind_counts"]["carriageway_member"] == 2
        assert roads["pairing"]["midpoint_tolerance_m"] == settings.OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M

    def test_legacy_package_without_corridor_features_still_describes_roads(self, monkeypatch):
        """A bearing-only (eris_internal) package packages no primaries -> no corridors, and
        the roads layer keeps its existing shape."""
        _settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "eris_internal")
        ctx = _ctx()
        ctx["overlays"]["roadBearingDeg"] = 90.0
        b = HillshadeReliefBuilder()
        b._session = FakeSession({})
        layers, _ = b._build_context_layers(ctx, base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and roads["road_kinds"] == ["road_bearing"]
        assert roads.get("divided_corridor_count", 0) == 0
        assert "divided_highway_corridor" not in (roads.get("selection_kinds") or [])
