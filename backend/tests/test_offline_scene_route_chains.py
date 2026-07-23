"""DEFECT C — provider-neutral road role + route-chain stitching around an I-80-style
interchange. Pure, no DB, no network.

Run: pytest -m "not db" tests/test_offline_scene_route_chains.py
"""

from __future__ import annotations

import json

import pytest

from app.services import road_corridor_pairing as pairing
from app.services import road_role
from app.services import road_route_chains as chains

# Local metric frame near lat 38.5 (I-80 through Sacramento is ~E-W here).
BASE_LON, BASE_LAT = -121.50, 38.50
_M_LAT = 111_320.0
import math  # noqa: E402

_M_LON = _M_LAT * math.cos(math.radians(BASE_LAT))


def P(east_m: float, north_m: float) -> list:
    """A [lon, lat] from local east/north metre offsets."""
    return [round(BASE_LON + east_m / _M_LON, 7), round(BASE_LAT + north_m / _M_LAT, 7)]


def _feat(coords, *, route_id=None, fsys=1, road_class="primary", role=None,
          role_source=None, provider="caltrans_crs", extra=None):
    props = {
        "kind": "road_centerline", "road_class": road_class, "provider": provider,
        "functional_class": fsys,
    }
    if route_id:
        props["route_id"] = route_id
        fam, des = road_role.caltrans_route_identity(route_id)
        if fam:
            props["route_family"] = fam
        if des:
            props["carriageway_designator"] = des
    if role is not None:
        props["road_role"] = role
    if role_source is not None:
        props["role_source"] = role_source
    if extra:
        props.update(extra)
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props}


# ---- an I-80-style interchange fixture --------------------------------------------------
# Two sustained divided carriageways (20 m apart), each segmented by the provider at the
# interchange boundary (east=600), plus a diverging on-ramp, a diverging off-ramp, and a
# short parallel connector hugging the mainline.

def _interchange_features():
    north = 10.0
    south = -10.0
    # North carriageway (designator P), segmented at east=600
    n1 = _feat([P(0, north), P(300, north), P(600, north)], route_id="SHS_080._P")
    n2 = _feat([P(600, north), P(900, north), P(1200, north)], route_id="SHS_080._P")
    # South carriageway (designator S), segmented at east=600
    s1 = _feat([P(0, south), P(300, south), P(600, south)], route_id="SHS_080._S")
    s2 = _feat([P(600, south), P(900, south), P(1200, south)], route_id="SHS_080._S")
    # On-ramp: diverges sharply from the south carriageway near the interchange.
    on_ramp = _feat([P(560, south), P(590, -70), P(650, -120), P(750, -140)], route_id="SHS_080._R1")
    # Off-ramp: diverges sharply from the north carriageway.
    off_ramp = _feat([P(640, north), P(670, 70), P(730, 120), P(830, 140)], route_id="SHS_080._R2")
    # Short parallel collector-distributor hugging the north carriageway (25 m off, parallel).
    cd = _feat([P(600, 35), P(680, 35), P(750, 35)], route_id="SHS_080._C1")
    return [n1, n2, s1, s2, on_ramp, off_ramp, cd]


def _default_chain_params():
    return chains.ChainParams()


def _default_pair_params():
    return pairing.PairingParams()


# =========================================================================================
# road_role unit tests
# =========================================================================================

class TestRoadRole:
    @pytest.mark.parametrize("rid,fam,des", [
        ("SHS_050._P", "50", "P"),
        ("SHS_099._S", "99", "S"),
        ("SHS_5._P", "5", "P"),
        ("SHS_080._R1", "80", "R1"),
        ("050", "50", None),
        ("garbage", None, None),
        ("", None, None),
        (None, None, None),
    ])
    def test_caltrans_route_identity(self, rid, fam, des):
        assert road_role.caltrans_route_identity(rid) == (fam, des)

    def test_leading_zero_families_are_equal(self):
        assert road_role.caltrans_route_identity("SHS_050._P")[0] == road_role.caltrans_route_identity("SHS_50._P")[0]

    def test_role_from_mtfcc(self):
        assert road_role.role_from_mtfcc("S1630") == road_role.ROLE_RAMP
        assert road_role.role_from_mtfcc("S1640") == road_role.ROLE_CONNECTOR
        assert road_role.role_from_mtfcc("S1100") == road_role.ROLE_MAINLINE
        assert road_role.role_from_mtfcc(None) == road_role.ROLE_UNKNOWN
        assert road_role.role_from_mtfcc("") == road_role.ROLE_UNKNOWN

    def test_role_of_prefers_explicit_then_mtfcc(self):
        assert road_role.role_of({"road_role": "connector"}) == "connector"
        assert road_role.role_of({"MTFCC": "S1630"}) == "ramp"           # legacy TIGER fallback
        assert road_role.role_of({}) == "unknown"
        # An explicit role wins over MTFCC.
        assert road_role.role_of({"road_role": "mainline", "MTFCC": "S1630"}) == "mainline"

    def test_is_non_carriageway(self):
        assert road_role.is_non_carriageway({"road_role": "ramp"})
        assert road_role.is_non_carriageway({"road_role": "connector"})
        assert road_role.is_non_carriageway({"MTFCC": "S1630"})
        assert not road_role.is_non_carriageway({"road_role": "mainline"})
        assert not road_role.is_non_carriageway({"road_role": "unknown"})   # unknown may still pair

    def test_continuity_key_never_falls_back_to_name(self):
        assert road_role.carriageway_continuity_key({"route_family": "80", "carriageway_designator": "P"}) == "crs:80:P"
        assert road_role.carriageway_continuity_key({"NAME": "Route 80"}) is None   # NAME is not continuity
        assert road_role.carriageway_continuity_key({"TLID": "12345"}) == "lin:TLID:12345"


# =========================================================================================
# stitching + connector classification
# =========================================================================================

class TestStitching:
    def test_contiguous_same_carriageway_segments_are_stitched(self):
        out, stats = chains.stitch_route_chains(_interchange_features(), _default_chain_params())
        # The two P segments and the two S segments each stitch into ONE chain spanning ~1200 m.
        stitched = [f for f in out if f["properties"].get("chain_member_count") == 2]
        assert len(stitched) == 2
        for m in stitched:
            assert m["properties"]["role_source"] == "geometry_route_chain"
            coords = m["geometry"]["coordinates"]
            assert chains.line_length_m([[c[0], c[1]] for c in coords]) > 1100
        assert stats["chains_stitched_from_multiple"] == 2

    def test_geometry_never_fabricates_a_mainline_role(self):
        """A sustained chain is NOT proof of a through carriageway (it could be a long
        parallel collector-distributor), and Caltrans carries no mainline attribute — so the
        pass may only DEMOTE to connector, never assert `mainline`."""
        out, _ = chains.stitch_route_chains(_interchange_features(), _default_chain_params())
        roles = {f["properties"].get("road_role") for f in out}
        assert "mainline" not in roles, "geometry must not fabricate a mainline claim"
        assert roles <= {"unknown", "connector"}

    def test_ramps_are_demoted_to_connector_and_excluded(self):
        out, _ = chains.stitch_route_chains(_interchange_features(), _default_chain_params())
        connectors = [f for f in out if f["properties"].get("road_role") == "connector"]
        # Both diverging ramps become connectors (branch geometry off the mainline).
        assert len(connectors) >= 2
        for c in connectors:
            assert road_role.is_non_carriageway(c["properties"])   # excluded from pairing

    def test_no_false_chord_across_a_gap(self):
        # Two P segments with a 500 m gap between them must NOT be stitched.
        a = _feat([P(0, 10), P(300, 10)], route_id="SHS_080._P")
        b = _feat([P(800, 10), P(1100, 10)], route_id="SHS_080._P")
        out, _ = chains.stitch_route_chains([a, b], _default_chain_params())
        for f in out:
            coords = f["geometry"]["coordinates"]
            # No single emitted chain jumps the 500 m gap (max segment step stays small).
            for i in range(len(coords) - 1):
                step = chains.meters_between(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
                assert step < 400, "a false chord bridged the gap"

    def test_never_stitches_across_different_route_family(self):
        a = _feat([P(0, 10), P(300, 10), P(600, 10)], route_id="SHS_080._P")
        b = _feat([P(600, 10), P(900, 10)], route_id="SHS_099._P")  # touching but DIFFERENT family
        out, _ = chains.stitch_route_chains([a, b], _default_chain_params())
        # Two separate chains (one per family), never merged.
        fams = sorted(f["properties"].get("route_family") for f in out)
        assert fams == ["80", "99"]

    def test_deterministic_under_input_reorder_and_reversed_coords(self):
        feats = _interchange_features()
        out1, _ = chains.stitch_route_chains(feats, _default_chain_params())

        def rev(f):
            g = json.loads(json.dumps(f))
            g["geometry"]["coordinates"] = list(reversed(g["geometry"]["coordinates"]))
            return g

        feats2 = [rev(f) for f in reversed(feats)]
        out2, _ = chains.stitch_route_chains(feats2, _default_chain_params())

        def canon(out):
            return sorted(
                json.dumps({"role": f["properties"].get("road_role"),
                            "coords": pairing.canonical_coords(f["geometry"]["coordinates"])},
                           sort_keys=True)
                for f in out
            )

        assert canon(out1) == canon(out2)

    # ---- adversarial-review regressions --------------------------------------------------

    def test_a_crossing_freeway_is_NOT_demoted_to_connector(self):
        """REGRESSION: a DIFFERENT freeway meeting this one at a grade-separated crossing is
        not a branch of it. Demoting it destroyed that freeway's own divided corridor."""
        # I-80 runs E-W; Route 50 (a divided pair) is clipped just north of it, ~perpendicular.
        r80 = _feat([P(0, 0), P(700, 0), P(1400, 0)], route_id="SHS_080._P")
        r50p = _feat([P(695, 15), P(697, 140), P(699, 250)], route_id="SHS_050._P")
        r50s = _feat([P(715, 15), P(717, 140), P(719, 250)], route_id="SHS_050._S")
        out, _ = chains.stitch_route_chains([r80, r50p, r50s], _default_chain_params())
        for f in out:
            fam = f["properties"].get("route_family")
            if fam == "50":
                assert f["properties"].get("road_role") != "connector", \
                    "a crossing freeway must not be demoted to connector"
        # ...and Route 50's divided corridor still forms.
        paired, stats = pairing.build_selection_features(out, _default_pair_params())
        assert stats["divided_corridor_count"] >= 1

    def test_only_same_route_family_geometry_may_be_demoted(self):
        # A short branch of the SAME family IS demoted; the crossing case above proves a
        # different family is not.
        out, _ = chains.stitch_route_chains(_interchange_features(), _default_chain_params())
        connectors = [f for f in out if f["properties"].get("road_role") == "connector"]
        assert connectors, "the same-family ramps must still be demoted"
        for c in connectors:
            assert c["properties"].get("route_family") == "80"

    def test_a_near_perpendicular_meeting_is_never_a_branch(self):
        # Same family, but meeting at ~90 deg: a crossing, not a merge/diverge.
        main = _feat([P(0, 0), P(700, 0), P(1400, 0)], route_id="SHS_080._P")
        perp = _feat([P(700, 12), P(702, 120), P(704, 220)], route_id="SHS_080._X1")
        out, _ = chains.stitch_route_chains([main, perp], _default_chain_params())
        x = next(f for f in out if f["properties"].get("carriageway_designator") == "X1")
        assert x["properties"].get("road_role") != "connector"

    def test_joining_within_the_gap_never_drops_a_real_vertex(self):
        """REGRESSION: the appended segment's near vertex was deleted (up to join_gap = 25 m
        away), inventing a chord the source never had."""
        a = _feat([P(0, 0), P(300, 0)], route_id="SHS_080._P")
        b = _feat([P(320, 0), P(620, 0)], route_id="SHS_080._P")   # 20 m gap: a REAL vertex
        out, _ = chains.stitch_route_chains([a, b], _default_chain_params())
        chain = next(f for f in out if f["properties"].get("chain_member_count") == 2)
        easts = sorted(round((c[0] - BASE_LON) * _M_LON) for c in chain["geometry"]["coordinates"])
        assert 320 in easts, f"the real vertex at east=320 was dropped: {easts}"
        assert easts == [0, 300, 320, 620]

    def test_coincident_endpoints_still_collapse_to_one_vertex(self):
        a = _feat([P(0, 0), P(300, 0)], route_id="SHS_080._P")
        b = _feat([P(300, 0), P(600, 0)], route_id="SHS_080._P")   # exactly coincident
        out, _ = chains.stitch_route_chains([a, b], _default_chain_params())
        chain = next(f for f in out if f["properties"].get("chain_member_count") == 2)
        easts = sorted(round((c[0] - BASE_LON) * _M_LON) for c in chain["geometry"]["coordinates"])
        assert easts == [0, 300, 600], f"duplicate vertex not collapsed: {easts}"

    def test_disabled_is_passthrough(self):
        feats = _interchange_features()
        out, stats = chains.stitch_route_chains(feats, chains.ChainParams(enabled=False))
        assert out == feats and stats["stitching"] == "disabled"

    def test_features_without_continuity_key_pass_through_unchanged(self):
        # A TIGER-style feature (no route_family) is untouched.
        tiger = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [P(0, 0), P(300, 0)]},
                 "properties": {"kind": "road_centerline", "road_class": "primary", "MTFCC": "S1100"}}
        out, stats = chains.stitch_route_chains([tiger], _default_chain_params())
        assert out == [tiger]
        assert stats["stitching"] in ("no_continuity_keys", "applied")


# =========================================================================================
# end-to-end: stitch -> pair -> corridor around the interchange
# =========================================================================================

class TestInterchangeCorridor:
    def _prepare_and_pair(self, feats):
        prepared, chain_stats = chains.stitch_route_chains(feats, _default_chain_params())
        out, stats = pairing.build_selection_features(prepared, _default_pair_params())
        return prepared, out, stats, chain_stats

    def test_one_stable_mainline_corridor_through_the_interchange(self):
        _prepared, out, stats, _ = self._prepare_and_pair(_interchange_features())
        corridors = [f for f in out if (f["properties"] or {}).get("selection_kind") == "divided_highway_corridor"]
        assert stats["divided_corridor_count"] == 1
        assert len(corridors) == 1
        # The corridor spans (a large fraction of) the ~1200 m mainline, not a stub.
        mid = corridors[0]["geometry"]["coordinates"]
        assert chains.line_length_m([[c[0], c[1]] for c in mid]) > 900

    def test_midpoint_never_jumps_onto_a_ramp(self):
        _prepared, out, _, _ = self._prepare_and_pair(_interchange_features())
        corridor = next(f for f in out if (f["properties"] or {}).get("selection_kind") == "divided_highway_corridor")
        # The midpoint must sit between the two carriageways (|north| < 10 m), never out at a
        # ramp (|north| >> 10 m). Convert each midpoint lat back to a north offset.
        for lon, lat in corridor["geometry"]["coordinates"]:
            north_m = (lat - BASE_LAT) * _M_LAT
            assert abs(north_m) < 8.0, f"midpoint escaped to north={north_m:.1f} m (a ramp/branch)"

    def test_ramps_and_connectors_are_not_paired_as_the_opposing_carriageway(self):
        _prepared, out, _, _ = self._prepare_and_pair(_interchange_features())
        corridor = next(f for f in out if (f["properties"] or {}).get("selection_kind") == "divided_highway_corridor")
        members = corridor["properties"]["member_source_feature_ids"]
        # Exactly two members; neither is a connector/ramp chain.
        assert len(members) == 2
        # The corridor's separation reflects the ~20 m divided highway, not a ramp splay.
        assert corridor["properties"]["separation_m"]["max"] < 40.0

    def test_no_fabricated_lane_or_pavement_claims(self):
        _prepared, out, _, _ = self._prepare_and_pair(_interchange_features())
        blob = json.dumps(out).lower()
        for forbidden in ("lane_count", "lanes", "pavement", "median_width", "shoulder", "traffic_direction"):
            assert forbidden not in blob, f"fabricated roadway fact: {forbidden}"

    def test_deterministic_under_reversed_feature_and_coordinate_order(self):
        feats = _interchange_features()
        _p1, out1, _s1, _c1 = self._prepare_and_pair(feats)

        def rev(f):
            g = json.loads(json.dumps(f))
            g["geometry"]["coordinates"] = list(reversed(g["geometry"]["coordinates"]))
            return g

        _p2, out2, _s2, _c2 = self._prepare_and_pair([rev(f) for f in reversed(feats)])
        assert json.dumps(out1, sort_keys=True) == json.dumps(out2, sort_keys=True)

    def test_a_real_divergence_still_splits_a_corridor(self):
        # If the two carriageways DIVERGE (separation ramps from 20 m to 120 m), the corridor
        # must SPLIT rather than draw a chord through the divergence.
        north, south0 = 10.0, -10.0
        n = _feat([P(0, north), P(400, north), P(800, north), P(1200, north)], route_id="SHS_080._P")
        # South carriageway peels away after east=600.
        s = _feat([P(0, south0), P(400, south0), P(600, -20), P(800, -70), P(1200, -160)], route_id="SHS_080._S")
        _prepared, out, stats, _ = self._prepare_and_pair([n, s])
        corridor = next((f for f in out if (f["properties"] or {}).get("selection_kind") == "divided_highway_corridor"), None)
        if corridor is not None:
            # Any corridor formed covers only the stable (pre-divergence) stretch.
            for lon, lat in corridor["geometry"]["coordinates"]:
                east_m = (lon - BASE_LON) * _M_LON
                assert east_m < 720.0, "corridor extended through the divergence"
