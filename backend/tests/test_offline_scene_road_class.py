"""Highway coverage: TIGERweb road CLASS, deterministic dedupe priority, manifest counts.

Proves layer 2/6/8 -> primary/secondary/local, that a provider attribute can never spoof
the ERIS-trusted class, that a duplicate geometry keeps its HIGHEST class regardless of
query order, that the class survives clipping, and that existing behaviors are unchanged.
No network (FakeSession drives the real adapter).
"""

from __future__ import annotations

import json

from app.config import settings
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder
from app.services.road_cross_section_build import build_road_cross_section

BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer"
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}

LINE_A = [[-121.50, 38.500], [-121.49, 38.505]]
LINE_B = [[-121.51, 38.490], [-121.50, 38.495]]
LINE_C = [[-121.515, 38.485], [-121.505, 38.487]]


def _gj(coords, props=None):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props or {}}


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
        v = self.per_layer.get(lid)
        if isinstance(v, Exception):
            raise v
        return FakeResp(v if v is not None else {"features": []})


def _fetch(session, layers="2,6,8"):
    return ctxmod.fetch_tigerweb_road_features(BOUNDS, base_url=BASE, layers=layers, timeout_s=30, session=session)


def _ctx(bearing=None, external=None):
    return {
        "submission_id": 41, "package_version": "gclass-1", "center": INCIDENT,
        "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
        "road_inventory_geometry": None,
        "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
        "external_road_features": external or [],
        "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": None, "sampleExtent": None},
    }


def _roads_settings(monkeypatch, source):
    monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", source)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", BASE)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")


class TestLayerToClass:
    def test_layer_2_primary_6_secondary_8_local(self):
        s = FakeSession({
            2: {"features": [_gj(LINE_A, {"NAME": "US-50"})]},
            6: {"features": [_gj(LINE_B, {"NAME": "Elm Ave"})]},
            8: {"features": [_gj(LINE_C, {"NAME": "Oak St"})]},
        })
        by_name = {f["properties"]["NAME"]: f["properties"] for f in _fetch(s)}
        assert by_name["US-50"]["source_layer_id"] == 2
        assert by_name["US-50"]["road_class"] == "primary"
        assert by_name["US-50"]["road_class_label"] == "Primary road / highway"
        assert by_name["Elm Ave"]["source_layer_id"] == 6
        assert by_name["Elm Ave"]["road_class"] == "secondary"
        assert by_name["Elm Ave"]["road_class_label"] == "Secondary road"
        assert by_name["Oak St"]["source_layer_id"] == 8
        assert by_name["Oak St"]["road_class"] == "local"
        assert by_name["Oak St"]["road_class_label"] == "Local road"
        assert all(p["kind"] == "road_centerline" for p in by_name.values())

    def test_provider_attributes_cannot_spoof_trusted_props(self):
        evil = {"NAME": "Fake Fwy", "road_class": "primary", "road_class_label": "Primary road / highway",
                "source_layer_id": 2, "kind": "evil"}
        s = FakeSession({2: {"features": []}, 6: {"features": []}, 8: {"features": [_gj(LINE_A, evil)]}})
        p = _fetch(s)[0]["properties"]
        # It came from layer 8 -> ERIS says local, whatever the provider claimed.
        assert p["source_layer_id"] == 8 and p["road_class"] == "local"
        assert p["road_class_label"] == "Local road" and p["kind"] == "road_centerline"

    def test_priority_table_is_explicit(self):
        assert ctxmod.road_class_priority("primary") > ctxmod.road_class_priority("secondary")
        assert ctxmod.road_class_priority("secondary") > ctxmod.road_class_priority("local")
        assert ctxmod.road_class_priority("local") > ctxmod.road_class_priority("unclassified")
        assert ctxmod.road_class_for_layer(2) == "primary"
        assert ctxmod.road_class_for_layer(6) == "secondary"
        assert ctxmod.road_class_for_layer(8) == "local"
        # a misconfigured layer id is honestly 'unclassified' — never silently a highway
        assert ctxmod.road_class_for_layer(99) == "unclassified"
        assert ctxmod.road_class_for_layer("x") == "unclassified"


class TestDedupePriority:
    def test_duplicate_primary_local_retains_primary_regardless_of_query_order(self):
        # local layer queried FIRST
        s1 = FakeSession({8: {"features": [_gj(LINE_A, {"NAME": "Local St"})]},
                          6: {"features": []},
                          2: {"features": [_gj(list(reversed(LINE_A)), {"NAME": "US-50"})]}})
        out1 = ctxmod.fetch_tigerweb_road_features(BOUNDS, base_url=BASE, layers="8,6,2", timeout_s=30, session=s1)
        assert len(out1) == 1
        assert out1[0]["properties"]["road_class"] == "primary"
        assert out1[0]["properties"]["source_layer_id"] == 2
        assert out1[0]["properties"]["NAME"] == "US-50"      # winner keeps its OWN metadata

        # primary layer queried FIRST -> identical result (order-independent)
        s2 = FakeSession({2: {"features": [_gj(LINE_A, {"NAME": "US-50"})]},
                          6: {"features": []},
                          8: {"features": [_gj(list(reversed(LINE_A)), {"NAME": "Local St"})]}})
        out2 = _fetch(s2)
        assert len(out2) == 1
        assert out2[0]["properties"]["road_class"] == "primary"
        assert out2[0]["properties"]["NAME"] == "US-50"

    def test_no_arbitrary_attribute_merging_between_duplicates(self):
        s = FakeSession({2: {"features": [_gj(LINE_A, {"NAME": "US-50", "RTTYP": "U"})]},
                         6: {"features": []},
                         8: {"features": [_gj(LINE_A, {"NAME": "Local St", "MTFCC": "S1400", "BASENAME": "Local"})]}})
        p = _fetch(s)[0]["properties"]
        assert p["NAME"] == "US-50" and p["RTTYP"] == "U"
        # the LOSER's attributes are NOT merged in
        assert "MTFCC" not in p and "BASENAME" not in p


class TestManifestRoadClassMetadata:
    def test_manifest_carries_classes_and_counts_including_primary(self, monkeypatch):
        _roads_settings(monkeypatch, "census_tigerweb")
        s = FakeSession({
            2: {"features": [_gj(LINE_A, {"NAME": "US-50"})]},
            6: {"features": []},
            8: {"features": [_gj(LINE_B, {"NAME": "Oak St"}), _gj(LINE_C, {"NAME": "Elm St"})]},
        })
        b = HillshadeReliefBuilder()
        b._session = s
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert roads["road_classes"] == ["local", "primary"]      # only classes actually packaged
        assert roads["road_class_counts"] == {"primary": 1, "local": 2}
        # provider/dataset/attribution untouched by the new class metadata
        assert roads["source"]["provider"] == "us_census_tigerweb"
        assert roads["source"]["dataset"] == "U.S. Census Bureau TIGERweb Transportation Roads"
        assert roads["source"]["attribution"] == "U.S. Census Bureau"
        gj = json.loads(assets[ctxmod.ROADS_FILE])
        assert {f["properties"]["road_class"] for f in gj["features"]} == {"primary", "local"}

    def test_class_metadata_omitted_when_no_classed_roads(self, monkeypatch):
        _roads_settings(monkeypatch, "eris_internal")
        b = HillshadeReliefBuilder()
        b._session = FakeSession({})
        layers, _ = b._build_context_layers(_ctx(bearing=90.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and roads["road_kinds"] == ["road_bearing"]
        assert "road_classes" not in roads and "road_class_counts" not in roads


class TestExistingBehaviorUnchanged:
    def test_class_survives_clipping_into_multiple_parts(self):
        line = [[-121.60, 38.50], [-121.49, 38.50], [-121.40, 38.50],
                [-121.30, 38.51], [-121.51, 38.51], [-121.60, 38.51]]
        ext = ctxmod.normalize_road_features(
            [{"geometry": {"type": "LineString", "coordinates": line}, "properties": {"NAME": "US-50"}}],
            keep_props=ctxmod.TIGER_ROAD_PROPS,
            trusted={"source_layer_id": 2, "road_class": "primary", "road_class_label": "Primary road / highway"},
        )
        gj, count, _ = ctxmod.roads_geojson_from_context(_ctx(external=ext), 250.0, external_configured=True)
        assert count == 2  # clipping still splits into disconnected parts
        buf = ctxmod.bounds_with_buffer(BOUNDS, 250.0)
        for f in gj["features"]:
            p = f["properties"]
            assert p["road_class"] == "primary" and p["source_layer_id"] == 2
            assert p["kind"] == "road_centerline" and p["NAME"] == "US-50"
            for lon, lat in f["geometry"]["coordinates"]:   # clipping unchanged
                assert buf["min_lon"] - 1e-9 <= lon <= buf["max_lon"] + 1e-9
                assert buf["min_lat"] - 1e-9 <= lat <= buf["max_lat"] + 1e-9

    def test_partial_layer_failure_still_tolerated(self):
        s = FakeSession({2: {"features": [_gj(LINE_A, {"NAME": "US-50"})]},
                         6: RuntimeError("layer 6 down"),
                         8: {"features": [_gj(LINE_B, {"NAME": "Oak St"})]}})
        out = _fetch(s)
        assert len(out) == 2
        assert {f["properties"]["road_class"] for f in out} == {"primary", "local"}

    def test_census_provenance_still_truthful(self):
        m = ctxmod.tigerweb_source_meta(BASE)
        assert m["provider"] == "us_census_tigerweb" and m["attribution"] == "U.S. Census Bureau"
        assert "caltrans" not in json.dumps(m).lower()

    def test_arcgis_feature_service_unchanged_no_class_props(self):
        s = FakeSession({0: {"features": [_gj(LINE_A, {"NAME": "X", "TOKEN": "SECRET"})]}})
        out = ctxmod.fetch_arcgis_road_features(
            BOUNDS, source_url="https://gis.example.gov/arcgis/rest/services/Roads/FeatureServer/0",
            timeout_s=30, session=s,
        )
        # unchanged: no attributes, no road_class (that is TIGERweb-layer-derived only)
        assert out[0]["properties"] == {"kind": "road_centerline"}
        assert "SECRET" not in json.dumps(out)

    def test_eris_internal_unchanged(self, monkeypatch):
        _roads_settings(monkeypatch, "eris_internal")
        b = HillshadeReliefBuilder()
        b._session = FakeSession({})
        layers, _ = b._build_context_layers(_ctx(bearing=90.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and roads["road_kinds"] == ["road_bearing"]
        assert roads["source"]["provider"] == "eris_internal"
        assert "service" not in roads["source"]
