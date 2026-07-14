"""Tests for the census_tigerweb offline road-centerline source.

Implements docs/adr-offline-road-context-source.md. No network: a FakeSession stands in
for requests, so the REAL adapter code (URL building, GeoJSON/Esri parsing, per-layer
failure tolerance, clipping, dedupe, allowlist, provenance) is exercised end-to-end.
"""

from __future__ import annotations

import json

import pytest

from app.config import settings
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder
from app.services.road_cross_section_build import build_road_cross_section

BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer"
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}

IN_LINE = [[-121.50, 38.500], [-121.49, 38.505]]      # inside bounds
IN_LINE_2 = [[-121.51, 38.490], [-121.50, 38.495]]    # inside bounds
FAR_LINE = [[-100.0, 20.0], [-99.0, 21.0]]            # far outside bounds


def _gj(coords, props=None, multi=False):
    geom = {"type": "MultiLineString", "coordinates": [coords]} if multi else {"type": "LineString", "coordinates": coords}
    return {"type": "Feature", "geometry": geom, "properties": props or {}}


def _esri(coords, attrs=None):
    return {"geometry": {"paths": [coords]}, "attributes": attrs or {}}


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status = payload, status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    def json(self):
        return self._p


class FakeSession:
    """per_layer: {layer_id: payload | Exception | callable(params)->FakeResp}"""

    def __init__(self, per_layer):
        self.per_layer = per_layer
        self.calls: list = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        lid = int(url.rstrip("/").split("/")[-2])  # .../MapServer/<id>/query
        v = self.per_layer.get(lid)
        if isinstance(v, Exception):
            raise v
        if callable(v):
            return v(dict(params or {}))
        return FakeResp(v)

    @property
    def urls(self):
        return [u for u, _ in self.calls]


def _fetch(session, layers="2,6,8", bounds=None):
    return ctxmod.fetch_tigerweb_road_features(
        bounds or BOUNDS, base_url=BASE, layers=layers, timeout_s=30, session=session
    )


class TestTigerwebQuery:
    def test_queries_configured_mapserver_layers_2_6_8_in_wgs84(self):
        s = FakeSession({2: {"features": [_gj(IN_LINE)]}, 6: {"features": []}, 8: {"features": []}})
        _fetch(s)
        assert s.urls == [f"{BASE}/2/query", f"{BASE}/6/query", f"{BASE}/8/query"]
        p = s.calls[0][1]
        assert p["f"] == "geojson" and p["outSR"] == "4326" and p["inSR"] == "4326"
        assert p["geometryType"] == "esriGeometryEnvelope" and p["returnGeometry"] == "true"
        assert p["geometry"] == f"{BOUNDS['min_lon']},{BOUNDS['min_lat']},{BOUNDS['max_lon']},{BOUNDS['max_lat']}"

    def test_combines_results_from_all_layers(self):
        s = FakeSession({2: {"features": [_gj(IN_LINE)]}, 6: {"features": [_gj(IN_LINE_2)]}, 8: {"features": []}})
        out = _fetch(s)
        assert len(out) == 2
        assert all(f["properties"]["kind"] == "road_centerline" for f in out)

    def test_partial_layer_failure_keeps_other_layers(self):
        s = FakeSession({2: {"features": [_gj(IN_LINE)]}, 6: RuntimeError("layer 6 down"), 8: {"features": [_gj(IN_LINE_2)]}})
        out = _fetch(s)
        assert len(out) == 2  # layer 6 failing did NOT discard 2 and 8

    def test_all_layers_failing_raises(self):
        s = FakeSession({2: RuntimeError("down"), 6: RuntimeError("down"), 8: RuntimeError("down")})
        with pytest.raises(RuntimeError, match="all 3 TIGERweb road layers failed"):
            _fetch(s)

    def test_no_features_returns_empty(self):
        s = FakeSession({2: {"features": []}, 6: {"features": []}, 8: {"features": []}})
        assert _fetch(s) == []

    def test_linestring_and_multilinestring_accepted(self):
        s = FakeSession({2: {"features": [_gj(IN_LINE)]}, 6: {"features": [_gj(IN_LINE_2, multi=True)]}, 8: {"features": []}})
        out = _fetch(s)
        types = sorted(f["geometry"]["type"] for f in out)
        assert types == ["LineString", "MultiLineString"]

    def test_esri_paths_fallback_when_geojson_unsupported(self):
        # Layer returns an ArcGIS error payload for f=geojson (HTTP 200), Esri JSON for f=json.
        def layer(params):
            if params.get("f") == "geojson":
                return FakeResp({"error": {"code": 400, "message": "Unsupported format"}})
            return FakeResp({"features": [_esri(IN_LINE, {"NAME": "Esri Rd"})]})

        s = FakeSession({2: layer, 6: {"features": []}, 8: {"features": []}})
        out = _fetch(s)
        assert len(out) == 1
        assert out[0]["geometry"]["type"] == "LineString"   # paths -> GeoJSON
        assert out[0]["properties"]["NAME"] == "Esri Rd"
        assert [p["f"] for _, p in s.calls[:2]] == ["geojson", "json"]  # tried geojson first

    def test_error_payload_on_both_formats_fails_that_layer(self):
        err = lambda params: FakeResp({"error": {"code": 500, "message": "boom"}})  # noqa: E731
        s = FakeSession({2: err, 6: {"features": [_gj(IN_LINE)]}, 8: err})
        out = _fetch(s)
        assert len(out) == 1  # layer 2/8 failed; 6 survived


class TestSafetyAndHygiene:
    def test_only_allowlisted_properties_are_preserved(self):
        props = {"NAME": "Main St", "BASENAME": "Main", "MTFCC": "S1400", "RTTYP": "M",
                 "OID": 12345, "TOKEN": "SECRET", "GEOID": "x", "kind": "spoofed"}
        s = FakeSession({2: {"features": [_gj(IN_LINE, props)]}, 6: {"features": []}, 8: {"features": []}})
        out = _fetch(s)
        got = out[0]["properties"]
        assert set(got) == {"NAME", "BASENAME", "MTFCC", "RTTYP", "kind"}
        assert got["kind"] == "road_centerline"       # provider attr cannot spoof `kind`
        assert "SECRET" not in json.dumps(out) and "OID" not in got

    def test_deduplicates_identical_and_reversed_lines(self):
        rev = list(reversed(IN_LINE))
        s = FakeSession({
            2: {"features": [_gj(IN_LINE)]},
            6: {"features": [_gj(rev)]},          # same road, reversed -> duplicate
            8: {"features": [_gj(IN_LINE), _gj(IN_LINE_2)]},  # exact dup + a new one
        })
        out = _fetch(s)
        assert len(out) == 2  # IN_LINE (once) + IN_LINE_2

    def test_census_provenance_is_truthful_and_never_caltrans(self):
        m = ctxmod.tigerweb_source_meta(BASE)
        assert m["provider"] == "us_census_tigerweb"
        assert m["dataset"] == "U.S. Census Bureau TIGERweb Transportation Roads"
        assert m["attribution"] == "U.S. Census Bureau"
        blob = json.dumps(m).lower()
        for forbidden in ("caltrans", "road inventory", "arcgis enterprise", "survey", "engineering"):
            assert forbidden not in blob

    def test_service_url_sanitized_no_token_or_credentials(self):
        meta = ctxmod.available_layer(
            ctxmod.ROADS_FILE, b"{}", ctxmod.tigerweb_source_meta(f"https://u:P@ss@tigerweb.geo.census.gov/x?token=SECRET"),
            feature_count=1, road_kinds=["road_centerline"],
        )
        blob = json.dumps(meta)
        assert "SECRET" not in blob and "P@ss" not in blob and "token" not in blob


class TestBuilderTigerweb:
    def _b(self, session):
        b = HillshadeReliefBuilder()
        b._session = session
        return b

    def _ctx(self, bearing=None):
        return {
            "submission_id": 21, "package_version": "gtiger-1", "center": INCIDENT,
            "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
            "road_inventory_geometry": None,
            "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
            "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": None, "sampleExtent": None},
        }

    def _settings(self, monkeypatch, source="census_tigerweb"):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", source)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", BASE)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")

    def test_packages_roads_and_makes_cross_section_usable(self, monkeypatch):
        self._settings(monkeypatch)
        s = FakeSession({2: {"features": [_gj(IN_LINE, {"NAME": "SR-17"})]}, 6: {"features": []}, 8: {"features": [_gj(IN_LINE_2)]}})
        layers, assets = self._b(s)._build_context_layers(self._ctx(bearing=None), base_bytes=0)

        roads = layers["roads"]
        assert roads["available"] is True
        assert ctxmod.ROADS_FILE in assets
        assert "road_centerline" in roads["road_kinds"]
        # truthful Census provenance — never Caltrans
        assert roads["source"]["provider"] == "us_census_tigerweb"
        assert roads["source"]["attribution"] == "U.S. Census Bureau"
        assert roads["source"]["service"] == BASE
        assert "caltrans" not in json.dumps(roads["source"]).lower()

        rxs = layers["road_cross_section"]
        assert rxs["snap_available"] is True and rxs["fully_usable"] is True
        # No authoritative bearing -> orientation stays FALSE (no verified upstation claim).
        assert rxs["orientation_available"] is False

    def test_clips_features_outside_package_bounds(self, monkeypatch):
        self._settings(monkeypatch)
        s = FakeSession({2: {"features": [_gj(FAR_LINE)]}, 6: {"features": []}, 8: {"features": []}})
        layers, assets = self._b(s)._build_context_layers(self._ctx(bearing=None), base_bytes=0)
        # The far line is dropped by clipping -> no usable geometry in area.
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == ctxmod.ROADS_REASON_NO_FEATURES

    def test_no_features_in_area_reason(self, monkeypatch):
        self._settings(monkeypatch)
        s = FakeSession({2: {"features": []}, 6: {"features": []}, 8: {"features": []}})
        layers, _ = self._b(s)._build_context_layers(self._ctx(bearing=None), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == "no_centerline_features_in_area"
        assert layers["road_cross_section"]["fully_usable"] is False  # honest

    def test_all_layers_failing_degrades_to_source_error_without_failing_package(self, monkeypatch):
        self._settings(monkeypatch)
        s = FakeSession({2: RuntimeError("down"), 6: RuntimeError("down"), 8: RuntimeError("down")})
        layers, assets = self._b(s)._build_context_layers(self._ctx(bearing=None), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == "source_error"
        # The terrain package still builds (cross-section layout still packaged).
        assert layers["road_cross_section"]["available"] is True


class TestExistingSourcesUnchanged:
    def _ctx(self, bearing=90.0):
        return {
            "submission_id": 22, "package_version": "g-1", "center": INCIDENT,
            "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
            "road_inventory_geometry": None,
            "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
            "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": None, "sampleExtent": None},
        }

    def test_eris_internal_unchanged(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "eris_internal")
        b = HillshadeReliefBuilder()
        b._session = FakeSession({})  # must NOT be used
        layers, _ = b._build_context_layers(self._ctx(bearing=90.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and roads["road_kinds"] == ["road_bearing"]
        assert roads["source"]["provider"] == "eris_internal"
        assert "service" not in roads["source"]

    def test_arcgis_feature_service_unchanged_single_layer_no_attributes(self):
        s = FakeSession({0: {"features": [_gj(IN_LINE, {"NAME": "X", "TOKEN": "SECRET"})]}})
        out = ctxmod.fetch_arcgis_road_features(
            BOUNDS, source_url="https://gis.example.gov/arcgis/rest/services/Roads/FeatureServer/0",
            timeout_s=30, session=s,
        )
        assert s.urls == ["https://gis.example.gov/arcgis/rest/services/Roads/FeatureServer/0/query"]
        assert s.calls[0][1]["outFields"] == ""            # no attributes requested
        assert out[0]["properties"] == {"kind": "road_centerline"}  # and none packaged
        assert "SECRET" not in json.dumps(out)
