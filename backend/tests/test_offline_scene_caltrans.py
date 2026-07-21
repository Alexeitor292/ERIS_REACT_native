"""Tests for the OPTIONAL Caltrans CRS Functional Classification offline road source
(``OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs``).

No network: a FakeSession stands in for ``requests`` so the REAL adapter (https guard,
where-clause construction, pagination, exceededTransferLimit handling, GeoJSON/Esri
normalization, F_System filtering, dedupe, provenance, builder integration, required/
optional failure policy, and package validation) is exercised end-to-end.

Mirrors the conventions in test_offline_scene_tigerweb.py / test_offline_scene_road_class.py.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.config import settings
from app.services import offline_scene as osvc
from app.services import offline_scene_builder as builder
from app.services import offline_scene_caltrans as cal
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder, OfflineSceneBuildError
from app.services.road_cross_section_build import build_road_cross_section

URL = (
    "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/"
    "CHhighway/CRS_Functional_Classification/FeatureServer/0"
)
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}

IN_A = [[-121.50, 38.500], [-121.49, 38.505]]
IN_B = [[-121.51, 38.490], [-121.505, 38.495]]
IN_C = [[-121.505, 38.500], [-121.495, 38.505]]
FAR = [[-100.0, 20.0], [-99.0, 21.0]]  # far outside the AOI


def gj_feat(oid, rid, fsys, coords, *, multi=False, county=None, district=None):
    geom = (
        {"type": "MultiLineString", "coordinates": [coords]}
        if multi
        else {"type": "LineString", "coordinates": coords}
    )
    props = {"OBJECTID": oid, "RouteID": rid, "F_System": fsys}
    if county is not None:
        props["County_label"] = county
    if district is not None:
        props["Caltrans_District"] = district
    return {"type": "Feature", "geometry": geom, "properties": props}


def esri_feat(oid, rid, fsys, coords):
    return {"geometry": {"paths": [coords]}, "attributes": {"OBJECTID": oid, "RouteID": rid, "F_System": fsys}}


class FakeResp:
    def __init__(self, payload, *, ctype="application/json", content=None, status=200):
        self._p = payload
        self.headers = {"Content-Type": ctype}
        self.status = status
        self.content = content if content is not None else json.dumps(payload).encode()

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    def json(self):
        if isinstance(self._p, Exception):
            raise self._p
        return self._p


class PagingSession:
    """Serves ``features`` across pages honoring resultOffset/resultRecordCount and sets
    exceededTransferLimit while more remain. Records every request's params."""

    def __init__(self, features):
        self.features = features
        self.calls: list = []

    def get(self, url, params=None, timeout=None):
        self.calls.append(dict(params or {}))
        off = int(params["resultOffset"])
        n = int(params["resultRecordCount"])
        page = self.features[off:off + n]
        exceeded = (off + n) < len(self.features)
        return FakeResp({"type": "FeatureCollection", "features": page, "exceededTransferLimit": exceeded})

    @property
    def urls(self):
        return None


class RouterSession:
    """Routes by URL substring so one session can serve a failing Caltrans query AND a
    working TIGERweb fallback (used for the explicit-fallback test)."""

    def __init__(self, *, caltrans, tiger):
        self.caltrans = caltrans  # payload | Exception
        self.tiger = tiger        # {layer_id: payload}
        self.calls: list = []

    def get(self, url, params=None, timeout=None):
        self.calls.append(url)
        if "CRS_Functional_Classification" in url:
            if isinstance(self.caltrans, Exception):
                raise self.caltrans
            return FakeResp(self.caltrans)
        lid = int(url.rstrip("/").split("/")[-2])  # .../MapServer/<id>/query
        return FakeResp(self.tiger.get(lid, {"features": []}))


def _fetch(session, classes=(1, 2, 3), *, bounds=None, **kw):
    return cal.fetch_caltrans_road_features(
        bounds or BOUNDS, layer_url=URL, functional_classes=classes, timeout_s=30,
        session=session, sleep=lambda *_: None, **kw,
    )


# --------------------------------------------------------------------------- #
# 1. Provider selection
# --------------------------------------------------------------------------- #
class TestProviderSelection:
    def test_all_valid_sources_accepted(self):
        for s in ("none", "eris_internal", "census_tigerweb", "arcgis_feature_service", "caltrans_crs"):
            assert ctxmod.normalize_road_source(s) == s

    def test_invalid_provider_rejected(self):
        with pytest.raises(ValueError, match="OFFLINE_SCENE_ROAD_SOURCE"):
            ctxmod.normalize_road_source("caltrans")  # not an exact valid value

    def test_config_validator_rejects_invalid_and_accepts_caltrans(self):
        from app.config import Settings

        base = {"DB_PASS": "x", "JWT_SECRET": "y"}
        assert Settings(**base, OFFLINE_SCENE_ROAD_SOURCE="caltrans_crs").OFFLINE_SCENE_ROAD_SOURCE == "caltrans_crs"
        with pytest.raises(Exception):
            Settings(**base, OFFLINE_SCENE_ROAD_SOURCE="not_a_provider")

    def test_fallback_must_be_a_different_real_source(self):
        from app.config import Settings

        base = {"DB_PASS": "x", "JWT_SECRET": "y"}
        assert Settings(**base, OFFLINE_SCENE_ROAD_FALLBACK_SOURCE="").OFFLINE_SCENE_ROAD_FALLBACK_SOURCE == ""
        assert (
            Settings(**base, OFFLINE_SCENE_ROAD_FALLBACK_SOURCE="census_tigerweb").OFFLINE_SCENE_ROAD_FALLBACK_SOURCE
            == "census_tigerweb"
        )
        for bad in ("caltrans_crs", "none", "bogus"):  # cannot fall back to itself/none/unknown
            with pytest.raises(Exception):
                Settings(**base, OFFLINE_SCENE_ROAD_FALLBACK_SOURCE=bad)


# --------------------------------------------------------------------------- #
# 2. ArcGIS query construction (+ safe filter, no injection)
# --------------------------------------------------------------------------- #
class TestQueryConstruction:
    def test_query_params_aoi_wgs84_geometry_and_explicit_fields(self):
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        _fetch(s)
        p = s.calls[0]
        assert p["geometry"] == f"{BOUNDS['min_lon']},{BOUNDS['min_lat']},{BOUNDS['max_lon']},{BOUNDS['max_lat']}"
        assert p["geometryType"] == "esriGeometryEnvelope"
        assert p["inSR"] == "4326" and p["outSR"] == "4326"
        assert p["spatialRel"] == "esriSpatialRelIntersects" and p["returnGeometry"] == "true"
        assert p["f"] == "geojson"
        assert p["outFields"] == "OBJECTID,RouteID,F_System,County_label,Caltrans_District"
        assert p["outFields"] != "*"
        assert p["orderByFields"] == "OBJECTID"

    def test_where_clause_is_the_highway_filter(self):
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        _fetch(s, classes=(1, 2, 3))
        assert s.calls[0]["where"] == "F_System IN (1, 2, 3)"

    def test_where_clause_ints_only_no_injection(self):
        assert cal.build_where_clause([1, 2]) == "F_System IN (1, 2)"
        # Only known integer F_System codes are ever interpolated.
        for bad in (["1; DROP TABLE roads"], ["1 OR 1=1"], ["1)"], [8], [0], ["x"]):
            with pytest.raises(ValueError):
                cal.build_where_clause(bad)

    def test_https_only_endpoint(self):
        # A plaintext http endpoint is rejected before any request is made.
        with pytest.raises(cal.CaltransPermanentError):
            cal.fetch_caltrans_road_features(
                BOUNDS, layer_url="http://caltrans-gis.dot.ca.gov/x/FeatureServer/0",
                functional_classes=(1,), timeout_s=5, session=PagingSession([]),
            )


# --------------------------------------------------------------------------- #
# 3. Pagination
# --------------------------------------------------------------------------- #
class TestPagination:
    def test_single_page(self):
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        out = _fetch(s, page_size=1000)
        assert len(out) == 1 and len(s.calls) == 1

    def test_multiple_pages_until_all_retrieved(self):
        feats = [gj_feat(i, f"SHS_0{i}._P", 1, [[-121.50 + i * 1e-4, 38.50], [-121.49 + i * 1e-4, 38.505]]) for i in range(5)]
        s = PagingSession(feats)
        out = _fetch(s, page_size=2)
        assert [c["resultOffset"] for c in s.calls] == ["0", "2", "4"]  # not just the first page
        assert len(out) == 5

    def test_exceeded_transfer_limit_drives_next_page(self):
        # Two features, page size 1: page 0 sets exceededTransferLimit -> a 2nd page runs.
        feats = [gj_feat(1, "SHS_050._P", 1, IN_A), gj_feat(2, "SHS_099._P", 3, IN_B)]
        s = PagingSession(feats)
        out = _fetch(s, page_size=1)
        assert len(s.calls) >= 2 and len(out) == 2

    def test_duplicate_feature_ids_deduped(self):
        dup = gj_feat(1, "SHS_050._P", 1, IN_A)
        s = PagingSession([dup, gj_feat(2, "SHS_099._P", 3, IN_B), dup])
        out = _fetch(s, page_size=1000)
        assert sorted(f["properties"]["source_feature_id"] for f in out) == [1, 2]

    def test_page_limit_protection_bounds_the_loop(self):
        feats = [gj_feat(i, f"SHS_{i}._P", 1, [[-121.5, 38.5], [-121.49, 38.505]]) for i in range(50)]
        s = PagingSession(feats)
        out = _fetch(s, page_size=1, max_pages=3)  # hard cap -> stops after 3 pages
        assert len(s.calls) == 3 and len(out) == 3

    def test_max_features_cap(self):
        feats = [gj_feat(i, f"SHS_{i}._P", 1, [[-121.5, 38.5], [-121.49, 38.505]]) for i in range(20)]
        s = PagingSession(feats)
        out = _fetch(s, page_size=5, max_features=7)
        assert len(out) == 7

    def test_empty_final_page_stops(self):
        # exceededTransferLimit True on the only page, then an empty page ends it.
        class EdgeSession:
            def __init__(self):
                self.calls = []

            def get(self, url, params=None, timeout=None):
                self.calls.append(dict(params or {}))
                off = int(params["resultOffset"])
                if off == 0:
                    return FakeResp({"features": [gj_feat(1, "SHS_050._P", 1, IN_A)], "exceededTransferLimit": True})
                return FakeResp({"features": [], "exceededTransferLimit": False})

        s = EdgeSession()
        out = _fetch(s, page_size=1)
        assert len(out) == 1 and len(s.calls) == 2  # tried the empty final page, then stopped

    def test_cancellation_between_pages(self):
        state = {"n": 0}

        def cancel():
            state["n"] += 1
            return state["n"] > 1  # False for the 1st page, True before the 2nd

        feats = [gj_feat(1, "SHS_050._P", 1, IN_A), gj_feat(2, "SHS_099._P", 3, IN_B)]
        s = PagingSession(feats)
        with pytest.raises(cal.CaltransFetchCancelled):
            _fetch(s, page_size=1, cancel_check=cancel)
        assert len(s.calls) == 1  # aborted before fetching the 2nd page


# --------------------------------------------------------------------------- #
# 3b. Network safety (untrusted upstream)
# --------------------------------------------------------------------------- #
class TestNetworkSafety:
    def test_html_error_page_with_http_200_is_rejected(self):
        class HtmlSession:
            def get(self, url, params=None, timeout=None):
                return FakeResp("<html>error</html>", ctype="text/html", content=b"<html>error</html>")

        with pytest.raises(cal.CaltransFetchError):
            _fetch(HtmlSession())

    def test_arcgis_error_payload_with_http_200_is_rejected(self):
        class ErrSession:
            def get(self, url, params=None, timeout=None):
                return FakeResp({"error": {"code": 400, "message": "Invalid query"}})

        with pytest.raises(cal.CaltransFetchError):
            _fetch(ErrSession())

    def test_oversized_response_is_rejected(self):
        big = b"x" * 2048

        class BigSession:
            def get(self, url, params=None, timeout=None):
                return FakeResp({"features": []}, content=big)

        with pytest.raises(cal.CaltransFetchError):
            _fetch(BigSession(), max_response_bytes=1024)

    def test_non_json_body_is_rejected(self):
        class JunkSession:
            def get(self, url, params=None, timeout=None):
                return FakeResp(ValueError("no json"), content=b"not json")

        with pytest.raises(cal.CaltransFetchError):
            _fetch(JunkSession())


# --------------------------------------------------------------------------- #
# 4. Geometry handling
# --------------------------------------------------------------------------- #
class TestGeometry:
    def test_linestring_and_multilinestring(self):
        two_part = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [IN_B, IN_C]},
                    "properties": {"OBJECTID": 2, "RouteID": "SHS_099._P", "F_System": 3}}
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A), two_part])
        out = _fetch(s)
        assert sorted(f["geometry"]["type"] for f in out) == ["LineString", "MultiLineString"]

    def test_single_part_multilinestring_collapses_to_linestring(self):
        # A 1-part MultiLineString is deterministically emitted as a LineString.
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A, multi=True)])
        out = _fetch(s)
        assert out[0]["geometry"]["type"] == "LineString"

    def test_esri_paths_accepted(self):
        s = PagingSession([esri_feat(1, "SHS_050._P", 1, IN_A)])
        out = _fetch(s)
        assert out[0]["geometry"]["type"] == "LineString"

    def test_point_and_polygon_dropped(self):
        pt = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-121.5, 38.5]}, "properties": {"OBJECTID": 1, "F_System": 1}}
        poly = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[-121.5, 38.5], [-121.49, 38.5], [-121.49, 38.51], [-121.5, 38.5]]]}, "properties": {"OBJECTID": 2, "F_System": 1}}
        assert cal.normalize_caltrans_features([pt, poly], included_classes=(1, 2, 3)) == []

    def test_malformed_and_empty_geometry_dropped(self):
        bad = [
            {"type": "Feature", "geometry": None, "properties": {"OBJECTID": 1, "F_System": 1}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": []}, "properties": {"OBJECTID": 2, "F_System": 1}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-121.5, 38.5]]}, "properties": {"OBJECTID": 3, "F_System": 1}},
            "not-a-feature",
        ]
        assert cal.normalize_caltrans_features(bad, included_classes=(1, 2, 3)) == []

    def test_invalid_coordinates_dropped(self):
        nan = float("nan")
        bad = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[nan, 38.5], [200.0, 99.0]]}, "properties": {"OBJECTID": 1, "F_System": 1}}
        assert cal.normalize_caltrans_features([bad], included_classes=(1, 2, 3)) == []

    def test_out_of_range_vertices_are_removed(self):
        mixed = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-121.5, 38.5], [999.0, 999.0], [-121.49, 38.505]]}, "properties": {"OBJECTID": 1, "F_System": 1}}
        out = cal.normalize_caltrans_features([mixed], included_classes=(1, 2, 3))
        assert len(out) == 1 and out[0]["geometry"]["coordinates"] == [[-121.5, 38.5], [-121.49, 38.505]]

    def test_excessive_coordinate_count_rejected(self):
        big = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-121.5 + i * 1e-6, 38.5] for i in range(50)]}, "properties": {"OBJECTID": 1, "F_System": 1}}
        assert cal.normalize_caltrans_features([big], included_classes=(1, 2, 3), max_coords_per_feature=10) == []


# --------------------------------------------------------------------------- #
# 5. Filtering by functional class
# --------------------------------------------------------------------------- #
class TestFiltering:
    def test_included_classes_kept(self):
        feats = [gj_feat(1, "SHS_005._P", 1, IN_A), gj_feat(2, "SHS_099._P", 2, IN_B), gj_feat(3, "SHS_049._P", 3, IN_C)]
        out = cal.normalize_caltrans_features(feats, included_classes=(1, 2, 3))
        assert {f["properties"]["functional_class"] for f in out} == {1, 2, 3}
        assert {f["properties"]["road_class"] for f in out} == {"primary"}  # all highways

    def test_excluded_local_and_collector(self):
        feats = [gj_feat(1, "LOCAL", 7, IN_A), gj_feat(2, "COLL", 5, IN_B), gj_feat(3, "SHS_050._P", 1, IN_C)]
        out = cal.normalize_caltrans_features(feats, included_classes=(1, 2, 3))
        assert [f["properties"]["functional_class"] for f in out] == [1]

    def test_unknown_or_missing_classification_dropped(self):
        feats = [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {"OBJECTID": 1}},          # missing F_System
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_B}, "properties": {"OBJECTID": 2, "F_System": 99}},  # unknown code
        ]
        assert cal.normalize_caltrans_features(feats, included_classes=(1, 2, 3)) == []

    def test_route_field_edge_cases(self):
        feats = [
            gj_feat(1, "", 1, IN_A),          # empty route id -> no route_id/NAME
            gj_feat(2, "SHS_020._P", 2, IN_B),
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_C}, "properties": {"OBJECTID": 3, "RouteID": 12345, "F_System": 3}},  # non-string route
        ]
        out = cal.normalize_caltrans_features(feats, included_classes=(1, 2, 3))
        by_id = {f["properties"]["source_feature_id"]: f["properties"] for f in out}
        assert "route_id" not in by_id[1] and "NAME" not in by_id[1]
        assert by_id[2]["route_id"] == "SHS_020._P" and by_id[2]["NAME"] == "Route 20"
        assert "route_id" not in by_id[3]  # non-string dropped

    def test_widened_class_set_maps_hierarchy(self):
        feats = [gj_feat(1, "SHS_050._P", 1, IN_A), gj_feat(2, "ART", 4, IN_B)]
        out = cal.normalize_caltrans_features(feats, included_classes=(1, 2, 3, 4))
        rc = {f["properties"]["functional_class"]: f["properties"]["road_class"] for f in out}
        assert rc == {1: "primary", 4: "secondary"}


# --------------------------------------------------------------------------- #
# 6. Normalization (determinism + minimal allowlist)
# --------------------------------------------------------------------------- #
class TestNormalization:
    def test_minimal_property_allowlist_and_trusted_fields(self):
        f = gj_feat(10, "SHS_050._P", 1, IN_A, county="SACRAMENTO", district=3)
        f["properties"]["SECRET"] = "token"  # provider junk must never survive
        f["properties"]["road_class"] = "local"  # a provider attr must never spoof the trusted class
        out = cal.normalize_caltrans_features([f], included_classes=(1,))[0]["properties"]
        assert set(out) == {
            "source_feature_id", "route_id", "NAME", "functional_class", "functional_class_label",
            "county", "district", "provider", "road_class", "road_class_label", "kind",
        }
        assert out["kind"] == "road_centerline" and out["provider"] == "caltrans_crs"
        assert out["road_class"] == "primary"  # trusted, derived from F_System, not spoofed
        assert "SECRET" not in json.dumps(out)

    def test_deterministic_precision_and_stable_bytes(self):
        noisy = [[-121.5000004, 38.5000006], [-121.4900001, 38.5050009]]
        f = gj_feat(1, "SHS_050._P", 1, noisy)
        a = cal.normalize_caltrans_features([f], included_classes=(1,))
        b = cal.normalize_caltrans_features([json.loads(json.dumps(f))], included_classes=(1,))
        assert json.dumps(a, separators=(",", ":")) == json.dumps(b, separators=(",", ":"))
        exp = [[round(noisy[0][0], 6), round(noisy[0][1], 6)], [round(noisy[1][0], 6), round(noisy[1][1], 6)]]
        assert a[0]["geometry"]["coordinates"] == exp
        # every coordinate is rounded to at most 6 decimal places
        for c in a[0]["geometry"]["coordinates"]:
            assert all(round(v, 6) == v for v in c)

    def test_deterministic_ordering_independent_of_input_order(self):
        f1 = gj_feat(1, "SHS_050._P", 1, IN_A)
        f3 = gj_feat(3, "SHS_099._P", 3, IN_B)
        f2 = gj_feat(2, "SHS_020._P", 2, IN_C)
        forward = cal.dedupe_caltrans_features(cal.normalize_caltrans_features([f1, f2, f3], included_classes=(1, 2, 3)))
        shuffled = cal.dedupe_caltrans_features(cal.normalize_caltrans_features([f3, f1, f2], included_classes=(1, 2, 3)))
        assert [f["properties"]["source_feature_id"] for f in forward] == [1, 2, 3]
        assert [f["properties"]["source_feature_id"] for f in shuffled] == [1, 2, 3]


# --------------------------------------------------------------------------- #
# 7. Provenance + content signature
# --------------------------------------------------------------------------- #
class TestProvenanceAndSignature:
    def test_source_meta_truthful_caltrans(self):
        m = cal.caltrans_source_meta(URL)
        assert m["provider"] == "caltrans_crs"
        assert "Caltrans" in m["dataset"] and "California Department of Transportation" in m["attribution"]
        assert m["service"] == URL

    def test_source_service_url_sanitized(self):
        meta = ctxmod.available_layer(
            ctxmod.ROADS_FILE, b"{}",
            cal.caltrans_source_meta("https://u:P@ss@caltrans-gis.dot.ca.gov/x/FeatureServer/0?token=SECRET"),
            feature_count=0,
        )
        blob = json.dumps(meta)
        assert "SECRET" not in blob and "P@ss" not in blob and "token" not in blob

    def test_content_signature_changes_with_provider_and_filter(self):
        base = dict(gisa_updated_at="2026-01-01", geometry_json=None, road_bearing_deg=None, radius_m=1500.0)
        legacy = osvc.content_signature(**base)
        assert osvc.content_signature(**base) == legacy  # omitting new args -> legacy signature
        cal_123 = osvc.content_signature(**base, road_provider="caltrans_crs", road_filter_version=cal.caltrans_filter_version((1, 2, 3)))
        cal_12 = osvc.content_signature(**base, road_provider="caltrans_crs", road_filter_version=cal.caltrans_filter_version((1, 2)))
        tiger = osvc.content_signature(**base, road_provider="census_tigerweb", road_filter_version="census_tigerweb")
        assert len({legacy, cal_123, cal_12, tiger}) == 4  # all distinct


# --------------------------------------------------------------------------- #
# Builder integration + failure policy
# --------------------------------------------------------------------------- #
def _ctx(bearing=None):
    return {
        "submission_id": 71, "package_version": "gcal-1", "center": INCIDENT,
        "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig",
        "road_inventory_geometry": None,
        "road_cross_section": {"attributes": build_road_cross_section(None, None), "snapshot": None},
        "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": None, "sampleExtent": None},
    }


def _caltrans_settings(monkeypatch, *, required=False, fallback=""):
    monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "caltrans_crs")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_ROADS_URL", URL)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES", "1,2,3")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1000)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_REQUIRED", required)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_FALLBACK_SOURCE", fallback)


def _builder(session):
    b = HillshadeReliefBuilder()
    b._session = session
    b._sleep = lambda *_: None
    return b


class TestBuilderIntegration:
    def test_packages_caltrans_roads_with_provenance_and_filter_version(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A, county="SACRAMENTO", district=3), gj_feat(2, "SHS_099._P", 3, IN_B)])
        layers, assets = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and ctxmod.ROADS_FILE in assets
        assert roads["road_kinds"] == ["road_centerline"]
        assert roads["source"]["provider"] == "caltrans_crs"
        assert roads["source"]["service"] == URL
        assert roads["filter_version"] == "caltrans_crs.v1:F_System[1,2,3]"
        assert roads["functional_classes"] == [1, 2, 3]
        assert roads["road_class_counts"].get("primary", 0) >= 1
        # cross-section is usable because roads.geojson provides snap geometry
        assert layers["road_cross_section"]["snap_available"] is True

    def test_no_features_in_area_degrades_truthfully(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, FAR)])  # clipped away
        layers, _ = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == ctxmod.ROADS_REASON_NO_FEATURES

    def test_optional_outage_is_source_error_without_failing_package(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=False)

        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("caltrans down")

        layers, _ = _builder(Boom())._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"]["available"] is False and layers["roads"]["reason"] == "source_error"
        assert layers["road_cross_section"]["available"] is True  # terrain package still builds

    def test_required_outage_fails_generation(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)

        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("caltrans down")

        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(Boom())._build_context_layers(_ctx(), base_bytes=0)

    def test_no_silent_fallback_to_tiger(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=False, fallback="")

        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("caltrans down")

        layers, _ = _builder(Boom())._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert "fallback" not in layers["roads"]
        assert "census" not in json.dumps(layers["roads"])  # never silently became TIGERweb

    def test_explicit_fallback_is_audited(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=False, fallback="census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
        s = RouterSession(caltrans=RuntimeError("caltrans down"), tiger={2: {"features": [gj_feat(1, "US-50", 2, IN_A)]}})
        layers, assets = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert roads["source"]["provider"] == "us_census_tigerweb"  # the fallback source
        assert roads["fallback"] == {"from": "caltrans_crs", "to": "census_tigerweb", "reason": "source_error"}

    def test_provider_none_packages_no_roads(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "none")
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])  # must NOT be used
        layers, _ = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"]["available"] is False and layers["roads"]["reason"] == "provider_none"
        assert s.calls == []


# --------------------------------------------------------------------------- #
# Package integrity: end-to-end ZIP + fail-closed roads validation
# --------------------------------------------------------------------------- #
class TestPackageIntegrity:
    def _terrain(self):
        import numpy as np

        from app.services import offline_scene_terrain as terrain_fmt

        heights = np.full((8, 8), 100.0, dtype="float32")
        grid, stats = terrain_fmt.encode_height_grid(heights)
        meta = terrain_fmt.build_terrain_metadata(stats, BOUNDS, terrain_fmt.grid_sha256(grid))
        return grid, meta

    def _usgs(self):
        return {"dataset": "USGS 3DEP", "version": "2026-01-01", "resolution": "10 m/px", "service": "https://x"}

    def _basemap(self):
        return {"provider": "usgs_hillshade", "source_label": "USGS 3DEP hillshade", "has_imagery": False, "has_hillshade": True}

    def _package(self, roads_geojson_bytes, feature_count):
        grid, meta = self._terrain()
        ctx = {"submission_id": 1, "package_version": "v1", "center": INCIDENT, "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig", "overlays": {}}
        cl = {
            "roads": ctxmod.available_layer(
                ctxmod.ROADS_FILE, roads_geojson_bytes, cal.caltrans_source_meta(URL),
                feature_count=feature_count, road_kinds=["road_centerline"],
            ),
        }
        manifest = builder.build_manifest(ctx, self._usgs(), self._basemap(), meta, cl)
        pkg = builder.assemble_bundle(grid, b"HS", {}, manifest, {ctxmod.ROADS_FILE: roads_geojson_bytes})
        return pkg, manifest

    def test_valid_package_opens_and_validates(self):
        gj = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {"kind": "road_centerline", "road_class": "primary", "provider": "caltrans_crs", "route_id": "SHS_050._P"}},
        ]}
        data = json.dumps(gj, separators=(",", ":")).encode()
        pkg, manifest = self._package(data, feature_count=1)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
        with zipfile.ZipFile(io.BytesIO(pkg)) as zf:
            m = json.loads(zf.read("manifest.json"))
            roads = m["context_layers"]["roads"]
            assert m["files"]["roads"] == "roads.geojson"
            assert roads["sha256"] == ctxmod.sha256_hex(data) and roads["bytes"] == len(data)
            assert roads["feature_count"] == 1 and roads["source"]["provider"] == "caltrans_crs"
            back = json.loads(zf.read("roads.geojson"))
            assert len(back["features"]) == 1

    def test_missing_roads_asset_rejected(self):
        data = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {}}]}).encode()
        pkg, _ = self._package(data, feature_count=1)
        # Drop the roads asset from the zip -> declared-available but missing.
        buf = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(pkg)) as src, zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as dst:
            for n in src.namelist():
                if n != "roads.geojson":
                    dst.writestr(n, src.read(n))
        ok, reason = builder.validate_bundle_bytes(buf.getvalue())
        assert not ok and "roads.geojson" in reason

    def test_checksum_and_byte_mismatch_rejected(self):
        data = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {}}]}).encode()
        pkg, _ = self._package(data, feature_count=1)
        buf = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(pkg)) as src, zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as dst:
            for n in src.namelist():
                dst.writestr(n, b'{"type":"FeatureCollection","features":[]}' if n == "roads.geojson" else src.read(n))
        ok, reason = builder.validate_bundle_bytes(buf.getvalue())
        assert not ok and ("checksum mismatch" in reason or "size mismatch" in reason)

    def test_invalid_json_rejected(self):
        pkg, _ = self._package(b"{ not valid json", feature_count=1)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "roads.geojson" in reason

    def test_invalid_geojson_geometry_rejected(self):
        data = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-121.5, 38.5]}, "properties": {}}]}).encode()
        pkg, _ = self._package(data, feature_count=1)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "unsupported geometry" in reason

    def test_declared_feature_count_mismatch_rejected(self):
        data = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {}}]}).encode()
        pkg, _ = self._package(data, feature_count=5)  # declares 5, actually 1
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "feature_count mismatch" in reason


# --------------------------------------------------------------------------- #
# Backward compatibility
# --------------------------------------------------------------------------- #
class TestBackwardCompatibility:
    def test_legacy_package_without_roads_metadata_still_opens(self):
        import numpy as np

        from app.services import offline_scene_terrain as terrain_fmt

        heights = np.full((8, 8), 50.0, dtype="float32")
        grid, stats = terrain_fmt.encode_height_grid(heights)
        meta = terrain_fmt.build_terrain_metadata(stats, BOUNDS, terrain_fmt.grid_sha256(grid))
        ctx = {"submission_id": 1, "package_version": "old", "center": INCIDENT, "radius_m": 1500.0, "bounds": BOUNDS, "content_signature": "sig", "overlays": {}}
        # No context_layers block at all (older packages) -> validates + opens.
        manifest = builder.build_manifest(ctx, {"dataset": "USGS 3DEP", "version": "x", "resolution": "10 m/px", "service": "https://x"}, {"has_hillshade": True}, meta, None)
        pkg = builder.assemble_bundle(grid, b"HS", {}, manifest, None)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
