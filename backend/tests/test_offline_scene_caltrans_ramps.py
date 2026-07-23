"""Caltrans EXPLICIT ramp identity -> selection_kind 'ramp' (Rocklin / I-80 defect).

The validated package for submission 20 / package 19 emitted 43 individual_carriageway and
ZERO ramps, yet 20 of those parts (11 distinct provider sources) were explicit Caltrans
ramps: RAMP_116039_P .. RAMP_133040_P, including RAMP_YIELD_*. Mislabeled ramps compete at
mainline priority and can displace the I-80 corridor near on/off ramps.

Classification uses the PROVIDER's own route identity (route_id / NAME) — never geometry or
imagery. Pure, no DB, no network.

Run: pytest -m "not db" tests/test_offline_scene_caltrans_ramps.py
"""

from __future__ import annotations

import json
import math

import pytest

from app.services import offline_scene_caltrans as cal
from app.services import offline_scene_context as ctxmod
from app.services import road_corridor_pairing as pairing
from app.services import road_role
from app.services import road_route_chains as chains

# Rocklin / I-80 is ~E-W here.
BASE_LON, BASE_LAT = -121.2400, 38.7900
_M_LAT = 111_320.0
_M_LON = _M_LAT * math.cos(math.radians(BASE_LAT))

# The real provider identities from the field evidence.
FIELD_RAMPS = [
    "RAMP_116039_P", "RAMP_116040_P", "RAMP_116041_P", "RAMP_116042_P",
    "RAMP_116043_P", "RAMP_116044_P", "RAMP_116045_P",
    "RAMP_YIELD_116041_P", "RAMP_YIELD_116044_P",
    "RAMP_133039_P", "RAMP_133040_P",
]


def P(east_m: float, north_m: float) -> list:
    return [round(BASE_LON + east_m / _M_LON, 7), round(BASE_LAT + north_m / _M_LAT, 7)]


def _caltrans_props(route_id: str, fsys: int = 1, oid: int = 1, geom=None) -> dict:
    """Normalize ONE Caltrans feature exactly as the adapter does."""
    geom = geom or {"paths": [[[BASE_LON, BASE_LAT], [BASE_LON + 0.001, BASE_LAT + 0.001]]]}
    raw = {"attributes": {"OBJECTID": oid, "RouteID": route_id, "F_System": fsys}, "geometry": geom}
    out = cal.normalize_caltrans_features([raw], included_classes=(1, 2))
    return out[0]["properties"] if out else {}


def _feature(coords, route_id, fsys=1, oid=1):
    props = _caltrans_props(route_id, fsys=fsys, oid=oid,
                            geom={"paths": [[list(c) for c in coords]]})
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(c) for c in coords]},
            "properties": props}


# =========================================================================================
# 1-3. Provider identity -> ramp, normalized + case-insensitive
# =========================================================================================

class TestRampIdentityClassification:
    def test_route_id_ramp_emits_ramp(self):
        """(1) route_id RAMP_116041_P -> selection_kind ramp."""
        props = _caltrans_props("RAMP_116041_P")
        assert props["road_role"] == "ramp"
        assert props["role_source"] == "provider"      # the PROVIDER said so, not geometry
        out, _ = pairing.build_selection_features([
            {"type": "Feature", "geometry": {"type": "LineString",
                                             "coordinates": [P(0, 0), P(60, 40)]}, "properties": props}
        ], pairing.PairingParams())
        assert [f["properties"]["selection_kind"] for f in out] == ["ramp"]

    def test_name_ramp_yield_emits_ramp(self):
        """(2) NAME RAMP_YIELD_116041_P -> selection_kind ramp."""
        # NAME carries the identity even when route_id does not.
        props = dict(_caltrans_props("SHS_080._P"))
        props["NAME"] = "RAMP_YIELD_116041_P"
        assert road_role.caltrans_role_from_identity(props) == "ramp"
        assert road_role.provider_declares_ramp(props) is True
        # ...and the adapter classifies the real RAMP_YIELD route id too.
        assert _caltrans_props("RAMP_YIELD_116041_P")["road_role"] == "ramp"

    @pytest.mark.parametrize("value", [
        "RAMP_116041_P", "ramp_116041_p", "RaMp_116041_P", "  RAMP_116041_P  ",
        "RAMP-116041", "RAMP116041", "RAMP", "RAMP_YIELD_116044_P", "ramp_yield_116044_p",
    ])
    def test_matching_is_normalized_and_case_insensitive(self, value):
        """(3) normalized + case-insensitive."""
        assert road_role.is_ramp_route_identity(value) is True

    @pytest.mark.parametrize("value", [
        "RAMPART_ROAD", "Rampart", "SHS_080._P", "SHS_050._S", "", "   ", None, 42,
    ])
    def test_non_ramp_identities_are_never_claimed(self, value):
        """The rule must not over-claim: a route merely STARTING with the letters RAMP
        followed by more letters (RAMPART) is not a ramp."""
        assert road_role.is_ramp_route_identity(value) is False

    def test_original_provider_values_are_retained_verbatim(self):
        props = _caltrans_props("RAMP_YIELD_116044_P")
        assert props["route_id"] == "RAMP_YIELD_116044_P"      # unchanged for provenance
        assert props["provider"] == "caltrans_crs"

    def test_all_eleven_field_ramp_identities_classify_as_ramp(self):
        for rid in FIELD_RAMPS:
            assert _caltrans_props(rid)["road_role"] == "ramp", rid


# =========================================================================================
# 4-7. Emission behaviour of ramp parts
# =========================================================================================

class TestRampEmission:
    def _clipped_parts(self, route_id: str):
        """A ramp source that leaves and re-enters the AOI -> several clipped parts."""
        bounds = {"min_lon": BASE_LON - 0.004, "max_lon": BASE_LON + 0.004,
                  "min_lat": BASE_LAT - 0.004, "max_lat": BASE_LAT + 0.004}
        props = _caltrans_props(route_id)
        line = [P(-600, 0), P(-100, 0), P(100, 0), P(600, 0), P(900, 0)]
        ctx = {"bounds": bounds, "overlays": {}, "external_road_features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": line}, "properties": props},
        ]}
        gj, count, _reason = ctxmod.roads_geojson_from_context(
            ctx, 0.0, external_configured=True, include_internal_context=False)
        return gj["features"], count

    def test_every_clipped_part_of_a_ramp_source_remains_a_ramp(self):
        """(4) clipped/split parts derived from a ramp source stay ramps."""
        parts, count = self._clipped_parts("RAMP_116042_P")
        assert count >= 1
        out, stats = pairing.build_selection_features(parts, pairing.PairingParams())
        kinds = [f["properties"]["selection_kind"] for f in out]
        assert kinds and set(kinds) == {"ramp"}, kinds
        assert stats["selection_kind_counts"] == {"ramp": len(kinds)}

    def test_ramp_sources_are_excluded_from_divided_pairing(self):
        """(5) a ramp never becomes a member of a divided-highway pair."""
        # Two ramps running parallel 20 m apart: geometrically pairable, but they are ramps.
        a = _feature([P(0, 10), P(400, 10), P(900, 10)], "RAMP_116043_P", oid=1)
        b = _feature([P(0, -10), P(400, -10), P(900, -10)], "RAMP_116044_P", oid=2)
        out, stats = pairing.build_selection_features([a, b], pairing.PairingParams())
        assert stats["divided_corridor_count"] == 0
        assert stats["selection_kind_counts"] == {"ramp": 2}
        assert pairing.pair_corridors([a, b], pairing.PairingParams()) == []

    def test_ramp_parts_never_become_carriageway_member_diagnostics(self):
        """(6) diagnostic_kind must remain null for ramps."""
        parts, _ = self._clipped_parts("RAMP_116045_P")
        out, _ = pairing.build_selection_features(parts, pairing.PairingParams())
        for f in out:
            assert f["properties"].get("diagnostic_kind") is None
            assert f["properties"].get("diagnostic") is False

    def test_a_ramp_remains_selectable(self):
        """(7) ramps stay user-selectable."""
        out, _ = pairing.build_selection_features(
            [_feature([P(0, 0), P(200, 120)], "RAMP_133040_P")], pairing.PairingParams())
        assert out[0]["properties"]["selectable"] is True
        assert out[0]["properties"]["selection_kind"] == "ramp"

    def test_ramps_are_not_stitched_into_route_chains(self):
        prepared, _ = chains.stitch_route_chains(
            [_feature([P(0, 0), P(150, 0)], "RAMP_116039_P", oid=1),
             _feature([P(150, 0), P(300, 0)], "RAMP_116039_P", oid=2)],
            chains.ChainParams())
        for f in prepared:
            assert f["properties"]["road_role"] == "ramp"
            assert "chain_member_count" not in f["properties"]


# =========================================================================================
# 11. Fail-closed validation
# =========================================================================================

class TestMislabeledRampFailsClosed:
    def test_validation_fails_if_a_provider_ramp_is_emitted_as_individual_carriageway(self):
        """(11) the packaging invariant refuses to publish a mislabeled ramp."""
        props = dict(_caltrans_props("RAMP_116041_P"))
        props["selection_kind"] = "individual_carriageway"   # the shipped defect
        props["selectable"] = True
        bad = [{"type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [P(0, 0), P(100, 50)]},
                "properties": props}]
        with pytest.raises(pairing.ProviderRampMislabeledError, match="individual_carriageway"):
            pairing.assert_provider_ramps_are_labeled_ramps(bad)

    def test_validation_fails_if_a_provider_ramp_is_emitted_as_a_diagnostic(self):
        props = dict(_caltrans_props("RAMP_116041_P"))
        props["selection_kind"] = "ramp"
        props["diagnostic_kind"] = "carriageway_member"
        bad = [{"type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [P(0, 0), P(100, 50)]},
                "properties": props}]
        with pytest.raises(pairing.ProviderRampMislabeledError, match="never a carriageway member"):
            pairing.assert_provider_ramps_are_labeled_ramps(bad)

    def test_a_correctly_labeled_ramp_passes_validation(self):
        out, _ = pairing.build_selection_features(
            [_feature([P(0, 0), P(120, 80)], "RAMP_116041_P")], pairing.PairingParams())
        pairing.assert_provider_ramps_are_labeled_ramps(out)   # does not raise

    def test_the_error_names_the_field_that_matched(self):
        """A NAME-only match previously reported route_id=None, leaving no way to find the
        offending feature."""
        props = {"kind": "road_centerline", "road_class": "primary", "provider": "caltrans_crs",
                 "NAME": "RAMP_YIELD_116041_P", "selection_kind": "individual_carriageway"}
        with pytest.raises(pairing.ProviderRampMislabeledError, match="NAME="):
            pairing.assert_provider_ramps_are_labeled_ramps([
                {"type": "Feature", "geometry": {"type": "LineString",
                                                 "coordinates": [P(0, 0), P(50, 20)]},
                 "properties": props}])


class TestRampRuleIsScopedToTheCaltransProvider:
    """REGRESSION (audit, CRITICAL): `RAMP_*` is a CALTRANS LRS convention, not a general
    road-name rule. Real US streets are named "Ramp Creek Rd" / "Ramp Hollow Rd". Applying
    the rule to a TIGER street classified it a freeway ramp and then tripped the packaging
    invariant, destroying the ENTIRE roads layer for that AOI."""

    @pytest.mark.parametrize("name,mtfcc,road_class", [
        ("Ramp Creek Rd", "S1400", "local"),
        ("Ramp Hollow Rd", "S1400", "local"),
        ("Ramp Branch Rd", "S1100", "primary"),
        ("Ramp Rd", "S1100", "primary"),
        ("Ramp St", "S1400", "local"),
    ])
    def test_a_tiger_street_named_ramp_something_is_not_a_provider_ramp(self, name, mtfcc, road_class):
        tiger = {"kind": "road_centerline", "road_class": road_class,
                 "NAME": name, "MTFCC": mtfcc}          # no `provider: caltrans_crs`
        assert road_role.provider_declares_ramp(tiger) is False
        assert road_role.caltrans_role_from_identity(tiger) == "unknown"

    def test_a_tiger_layer_containing_such_a_street_still_packages(self):
        """The whole-layer failure: one 'Ramp Creek Rd' used to raise for the collection."""
        feats = [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [P(0, 0), P(400, 0)]},
             "properties": {"kind": "road_centerline", "road_class": "primary",
                            "NAME": "Ramp Creek Rd", "MTFCC": "S1100"}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [P(0, 200), P(400, 200)]},
             "properties": {"kind": "road_centerline", "road_class": "local",
                            "NAME": "Oak St", "MTFCC": "S1400"}},
        ]
        out, stats = pairing.build_selection_features(feats, pairing.PairingParams())
        assert len(out) == 2
        kinds = {f["properties"]["selection_kind"] for f in out}
        assert kinds == {"individual_carriageway", "ordinary_road"}
        assert stats["selection_kind_counts"].get("ramp", 0) == 0

    def test_a_caltrans_ramp_is_still_classified(self):
        assert road_role.provider_declares_ramp(_caltrans_props("RAMP_116041_P")) is True


class TestPairCorridorsCannotPairTwoProviderRamps:
    """REGRESSION (audit, MEDIUM): pair_corridors() is a public entry point that runs no
    ramp invariant. With `road_role` absent (a package built before this fix) two parallel
    Caltrans ramps used to pair into a divided corridor."""

    def test_two_legacy_ramps_without_road_role_never_pair(self):
        def legacy(coords, oid):
            # Pass the REAL geometry so each source gets its own durable provider id.
            p = dict(_caltrans_props("RAMP_116043_P", oid=oid,
                                     geom={"paths": [[list(c) for c in coords]]}))
            p.pop("road_role", None)          # legacy package: adapter never set the role
            p.pop("role_source", None)
            return {"type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [list(c) for c in coords]},
                    "properties": p}

        a = legacy([P(0, 10), P(600, 10), P(1200, 10)], 1)
        b = legacy([P(0, -10), P(600, -10), P(1200, -10)], 2)
        # role_of now honours the PROVIDER identity, so neither is a pairing candidate.
        assert road_role.role_of(a["properties"]) == "ramp"
        assert pairing.pair_corridors([a, b], pairing.PairingParams()) == []


# =========================================================================================
# Rocklin-style integration fixture — assert the COMPLETE partition
# =========================================================================================

def _rocklin_scene():
    """Paired mainline carriageways + unpaired mainline fragments + normal ramps +
    RAMP_YIELD fragments, in the shape the Rocklin/I-80 package had."""
    feats = []
    oid = 0

    def add(coords, rid):
        nonlocal oid
        oid += 1
        feats.append(_feature(coords, rid, oid=oid))

    # Two sustained divided mainline carriageways (20 m apart) -> one corridor.
    add([P(0, 10), P(400, 10), P(800, 10), P(1200, 10)], "SHS_080._P")
    add([P(0, -10), P(400, -10), P(800, -10), P(1200, -10)], "SHS_080._S")
    # Unpaired mainline fragments (a separate stretch, no opposing carriageway nearby).
    add([P(2000, 300), P(2400, 300), P(2800, 300)], "SHS_080._P")
    add([P(3200, 900), P(3600, 900)], "SHS_065._P")
    # Normal ramps diverging near the interchange.
    add([P(560, -10), P(600, -80), P(700, -140)], "RAMP_116041_P")
    add([P(640, 10), P(690, 80), P(790, 150)], "RAMP_116042_P")
    add([P(900, 10), P(960, 90), P(1050, 160)], "RAMP_133039_P")
    # RAMP_YIELD fragments.
    add([P(700, -140), P(820, -190)], "RAMP_YIELD_116041_P")
    add([P(790, 150), P(910, 205)], "RAMP_YIELD_116044_P")
    return feats


class TestRocklinIntegrationPartition:
    def _partition(self):
        prepared, _ = chains.stitch_route_chains(_rocklin_scene(), chains.ChainParams())
        out, stats = pairing.build_selection_features(prepared, pairing.PairingParams())
        return out, stats

    def test_complete_selection_partition(self):
        """Assert the WHOLE partition, not merely that corridors exist."""
        out, stats = self._partition()
        sel = stats["selection_kind_counts"]
        diag = stats["diagnostic_kind_counts"]
        # A real divided corridor forms from the paired carriageways...
        assert sel.get("divided_highway_corridor", 0) == 1
        assert diag.get("carriageway_member", 0) == 2      # one member part per side
        # ...every explicit ramp is a ramp (5 ramp sources: 3 normal + 2 RAMP_YIELD)...
        assert sel.get("ramp", 0) == 5
        # ...and the mainline fragments remain individually selectable.
        assert sel.get("individual_carriageway", 0) >= 2
        # NOTHING is left unclassified and the totals add up.
        assert stats["selectable_feature_count"] == sum(sel.values())
        assert stats["feature_count"] == stats["selectable_feature_count"] + stats["diagnostic_feature_count"] + stats["context_feature_count"]

    def test_no_provider_ramp_is_labeled_individual_carriageway(self):
        """(the shipped defect, asserted directly)"""
        out, _ = self._partition()
        for f in out:
            props = f["properties"]
            if road_role.provider_declares_ramp(props):
                assert props.get("selection_kind") == "ramp", props.get("route_id")
        pairing.assert_provider_ramps_are_labeled_ramps(out)

    def test_manifest_selection_counts_include_ramp(self):
        """(10) the packaged counts expose `ramp` explicitly."""
        _out, stats = self._partition()
        assert "ramp" in stats["selection_kinds"]
        assert stats["selection_kind_counts"]["ramp"] == 5

    def test_ramps_are_never_corridor_members(self):
        out, _ = self._partition()
        corridor = next(f for f in out
                        if f["properties"].get("selection_kind") == "divided_highway_corridor")
        member_ids = set(corridor["properties"]["member_part_feature_ids"])
        for f in out:
            if f["properties"].get("selection_kind") == "ramp":
                assert f["properties"]["feature_id"] not in member_ids

    def test_partition_is_deterministic_under_reordering_and_reversal(self):
        feats = _rocklin_scene()

        def run(fs):
            prepared, _ = chains.stitch_route_chains(fs, chains.ChainParams())
            out, _ = pairing.build_selection_features(prepared, pairing.PairingParams())
            return json.dumps(out, sort_keys=True)

        rev = [{**f, "geometry": {"type": "LineString",
                                  "coordinates": list(reversed(f["geometry"]["coordinates"]))}}
               for f in reversed(feats)]
        assert run(feats) == run(rev)

    def test_no_fabricated_ramp_attributes(self):
        """Nothing about direction, lane count, shoulder width or ramp type is invented."""
        out, _ = self._partition()
        blob = json.dumps(out).lower()
        for forbidden in ("lane_count", "shoulder_width", "ramp_type", "traffic_direction",
                          "onramp", "offramp", "eastbound", "westbound"):
            assert forbidden not in blob, forbidden
