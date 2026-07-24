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
import math
import zipfile

import pytest

from app.services import road_corridor_pairing as pairing

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


def _fetch(session, classes=cal.DEFAULT_FUNCTIONAL_CLASSES, *, bounds=None, **kw):
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
        assert p["outFields"] == "OBJECTID,EventID,RouteID,F_System,County_label,Caltrans_District"
        assert p["outFields"] != "*"
        assert p["orderByFields"] == "OBJECTID"  # OBJECTID drives stable PAGINATION only

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

    def test_default_query_uses_the_freeway_expressway_filter(self):
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        _fetch(s)  # no explicit classes -> the product default
        assert s.calls[0]["where"] == "F_System IN (1, 2)"

    def test_exceeded_transfer_limit_drives_next_page(self):
        # Two features, page size 1: page 0 sets exceededTransferLimit -> a 2nd page runs.
        feats = [gj_feat(1, "SHS_050._P", 1, IN_A), gj_feat(2, "SHS_099._P", 2, IN_B)]
        s = PagingSession(feats)
        out = _fetch(s, page_size=1)
        assert len(s.calls) >= 2 and len(out) == 2

    def test_offset_advances_by_records_returned_not_by_requested_page_size(self):
        """REGRESSION: ArcGIS clamps resultRecordCount to the layer's maxRecordCount, so a
        page can return FEWER rows than requested while signalling more remain. Advancing by
        the requested page size would skip the unfetched rows and then exit as if complete —
        silently losing roads."""

        class ClampingSession:
            """Serves at most `clamp` records per page regardless of resultRecordCount."""

            def __init__(self, features, clamp):
                self.features, self.clamp, self.calls = features, clamp, []

            def get(self, url, params=None, timeout=None):
                self.calls.append(dict(params or {}))
                off = int(params["resultOffset"])
                n = min(int(params["resultRecordCount"]), self.clamp)
                page = self.features[off:off + n]
                return FakeResp({"features": page, "exceededTransferLimit": (off + n) < len(self.features)})

        feats = [gj_feat(i, f"SHS_0{i}._P", 1, [[-121.50 + i * 1e-4, 38.50], [-121.49 + i * 1e-4, 38.505]])
                 for i in range(10)]
        s = ClampingSession(feats, clamp=2)
        out = _fetch(s, page_size=5)  # server clamps 5 -> 2
        assert len(out) == 10, "every matching record must be retrieved despite the clamp"
        assert [c["resultOffset"] for c in s.calls][:4] == ["0", "2", "4", "6"]  # advanced by returned count

    def test_empty_page_while_service_reports_more_is_incomplete(self):
        class StallSession:
            def get(self, url, params=None, timeout=None):
                # Claims more records remain but returns none -> no forward progress.
                return FakeResp({"features": [], "exceededTransferLimit": True})

        with pytest.raises(cal.CaltransIncompleteSourceError, match="empty page"):
            _fetch(StallSession(), page_size=5)

    def test_duplicate_provider_object_ids_deduped(self):
        dup = gj_feat(1, "SHS_050._P", 1, IN_A)
        s = PagingSession([dup, gj_feat(2, "SHS_099._P", 2, IN_B), dup])
        out = _fetch(s, page_size=1000)
        assert sorted(f["properties"]["provider_object_id"] for f in out) == [1, 2]

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
# 3a. Pagination caps FAIL CLOSED (a truncated result is never a complete source)
# --------------------------------------------------------------------------- #
class TestPaginationCapFailsClosed:
    def _many(self, n=50):
        return [gj_feat(i, f"SHS_0{i}._P", 1, [[-121.50 + i * 1e-4, 38.50], [-121.49 + i * 1e-4, 38.505]])
                for i in range(n)]

    def test_max_pages_hit_with_exceeded_transfer_limit_raises(self):
        s = PagingSession(self._many())
        with pytest.raises(cal.CaltransIncompleteSourceError, match="page cap"):
            _fetch(s, page_size=1, max_pages=3)
        assert len(s.calls) == 3  # bounded: it did not keep paging

    def test_max_features_hit_before_a_short_final_page_raises(self):
        s = PagingSession(self._many(20))
        with pytest.raises(cal.CaltransIncompleteSourceError, match="feature cap"):
            _fetch(s, page_size=5, max_features=7)

    def test_exact_cap_on_a_complete_result_is_not_truncated(self):
        # 3 features, cap 3, and the page is short with no more-records flag -> COMPLETE.
        s = PagingSession(self._many(3))
        out = _fetch(s, page_size=10, max_features=3)
        assert len(out) == 3  # no exception: nothing was dropped

    def test_duplicates_beyond_the_cap_do_not_falsely_truncate(self):
        """A row that is discarded as a duplicate is not 'dropped work' — it must not trip the
        feature cap and fail a job whose de-duplicated result is actually complete."""
        dup = gj_feat(1, "SHS_050._P", 1, IN_A)
        s = PagingSession([dup, gj_feat(2, "SHS_099._P", 2, IN_B), dup])
        out = _fetch(s, page_size=10, max_features=2)  # 3 rows, 2 unique, cap 2
        assert sorted(f["properties"]["provider_object_id"] for f in out) == [1, 2]

    def test_incomplete_source_is_a_fetch_error_subclass(self):
        assert issubclass(cal.CaltransIncompleteSourceError, cal.CaltransFetchError)


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
                    "properties": {"OBJECTID": 2, "RouteID": "SHS_099._P", "F_System": 2}}
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

    # ---- FAIL-CLOSED: an invalid vertex must never be skipped so its neighbours join ----
    # Dropping a corrupt vertex and keeping the rest of the part would INVENT a straight
    # chord (A -> B) that does not exist in the source. ERIS rejects the whole feature.

    def _ls(self, coords, oid=1, fsys=1):
        return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"OBJECTID": oid, "RouteID": "SHS_050._P", "F_System": fsys}}

    def test_invalid_middle_vertex_never_bridges_the_valid_endpoints(self):
        A, BAD, B = [-121.50, 38.500], [999.0, 999.0], [-121.49, 38.505]
        out = cal.normalize_caltrans_features([self._ls([A, BAD, B])], included_classes=(1, 2))
        assert out == [], "a corrupt middle vertex must reject the feature, not fabricate A->B"

    def test_invalid_first_vertex_rejects_the_feature(self):
        out = cal.normalize_caltrans_features(
            [self._ls([[float("nan"), 38.5], [-121.50, 38.500], [-121.49, 38.505]])], included_classes=(1, 2))
        assert out == []

    def test_invalid_final_vertex_rejects_the_feature(self):
        out = cal.normalize_caltrans_features(
            [self._ls([[-121.50, 38.500], [-121.49, 38.505], [float("inf"), 38.5]])], included_classes=(1, 2))
        assert out == []

    def test_boolean_coordinates_reject_the_feature(self):
        out = cal.normalize_caltrans_features(
            [self._ls([[-121.50, 38.500], [True, False], [-121.49, 38.505]])], included_classes=(1, 2))
        assert out == []

    def test_one_malformed_multipart_member_cannot_create_a_false_bridge(self):
        bad_multi = {"type": "Feature",
                     "geometry": {"type": "MultiLineString", "coordinates": [IN_B, [[-121.5, 38.5], [999.0, 999.0]]]},
                     "properties": {"OBJECTID": 1, "RouteID": "SHS_099._P", "F_System": 2}}
        assert cal.normalize_caltrans_features([bad_multi], included_classes=(1, 2)) == []
        # A non-list member is equally fatal (no silent "use the good parts").
        junk_multi = {"type": "Feature",
                      "geometry": {"type": "MultiLineString", "coordinates": [IN_B, "not-a-part"]},
                      "properties": {"OBJECTID": 2, "RouteID": "SHS_099._P", "F_System": 2}}
        assert cal.normalize_caltrans_features([junk_multi], included_classes=(1, 2)) == []

    def test_valid_geometry_remains_deterministic(self):
        good_ls = self._ls([[-121.50, 38.500], [-121.49, 38.505]])
        good_mls = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [IN_B, IN_C]},
                    "properties": {"OBJECTID": 2, "RouteID": "SHS_099._P", "F_System": 2}}
        a = cal.normalize_caltrans_features([good_ls, good_mls], included_classes=(1, 2))
        b = cal.normalize_caltrans_features([good_ls, good_mls], included_classes=(1, 2))
        assert json.dumps(a, separators=(",", ":")) == json.dumps(b, separators=(",", ":"))
        assert sorted(f["geometry"]["type"] for f in a) == ["LineString", "MultiLineString"]

    def test_excessive_coordinate_count_rejected(self):
        big = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-121.5 + i * 1e-6, 38.5] for i in range(50)]}, "properties": {"OBJECTID": 1, "F_System": 1}}
        assert cal.normalize_caltrans_features([big], included_classes=(1, 2, 3), max_coords_per_feature=10) == []


# --------------------------------------------------------------------------- #
# 5. Filtering by functional class
# --------------------------------------------------------------------------- #
class TestFiltering:
    def test_default_policy_is_freeway_expressway_only(self):
        # Product policy: default = F_System 1 (Interstate) + 2 (Other Freeways and
        # Expressways). Class 3 is a SURFACE arterial and is opt-in, never a default.
        assert cal.DEFAULT_FUNCTIONAL_CLASSES == (1, 2)
        assert cal.build_where_clause(cal.DEFAULT_FUNCTIONAL_CLASSES) == "F_System IN (1, 2)"

    def test_included_freeway_classes_kept(self):
        feats = [gj_feat(1, "SHS_005._P", 1, IN_A), gj_feat(2, "SHS_099._P", 2, IN_B)]
        out = cal.normalize_caltrans_features(feats, included_classes=(1, 2))
        assert {f["properties"]["functional_class"] for f in out} == {1, 2}
        assert {f["properties"]["road_class"] for f in out} == {"primary"}  # freeways/expressways

    def test_class_3_is_opt_in_and_is_not_presented_as_a_freeway(self):
        arterial = gj_feat(3, "SHS_049._P", 3, IN_C)
        # Excluded under the default policy...
        assert cal.normalize_caltrans_features([arterial], included_classes=(1, 2)) == []
        # ...and when opted in, it is a SECONDARY surface arterial, never "primary"/freeway.
        out = cal.normalize_caltrans_features([arterial], included_classes=(1, 2, 3))
        assert out[0]["properties"]["road_class"] == "secondary"
        assert out[0]["properties"]["functional_class_label"] == "Principal Arterial - Other"
        assert "freeway" not in out[0]["properties"]["functional_class_label"].lower()

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
        by_id = {f["properties"]["provider_object_id"]: f["properties"] for f in out}
        assert "route_id" not in by_id[1] and "NAME" not in by_id[1]
        assert by_id[2]["route_id"] == "SHS_020._P" and by_id[2]["NAME"] == "Route 20"
        assert "route_id" not in by_id[3]  # non-string dropped

    def test_non_provider_route_convention_is_not_reshaped_into_a_route_claim(self):
        # Only the provider's own SHS_* route-id convention yields a "Route N" label; any
        # other id is passed through verbatim rather than asserting a route designation.
        assert cal.caltrans_route_label("SHS_050._P") == "Route 50"
        assert cal.caltrans_route_label("CITY-MAIN-ST-12") == "CITY-MAIN-ST-12"
        assert cal.caltrans_route_label("") is None

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
            "provider_object_id", "provider_source_feature_id", "source_feature_id",
            "provider_feature_id", "route_id", "NAME",
            "route_family", "carriageway_designator",   # truthful carriageway-continuity identity
            "road_role", "role_source",                 # provider-neutral role (honestly UNKNOWN)
            "functional_class", "functional_class_label",
            "county", "district", "provider", "road_class", "road_class_label", "kind",
        }
        # The provider carries NO mainline/ramp signal, so the adapter is honest:
        assert out["road_role"] == "unknown" and out["role_source"] == "unspecified"
        assert out["route_family"] == "50" and out["carriageway_designator"] == "P"
        # The complete-source durable identity is exposed for provenance/tracing.
        assert out["provider_source_feature_id"] == out["source_feature_id"]
        assert out["kind"] == "road_centerline" and out["provider"] == "caltrans_crs"
        assert out["road_class"] == "primary"  # trusted, derived from F_System, not spoofed
        assert out["provider_object_id"] == 10                    # OBJECTID kept as provenance
        assert isinstance(out["source_feature_id"], str)          # durable ERIS identity
        assert out["source_feature_id"].startswith("caltrans:")
        assert "SECRET" not in json.dumps(out)

    def test_durable_id_is_supplied_to_the_pairing_provider_id_hook(self):
        """The pairing pass PREFERS `provider_feature_id` over its own geometry-only hash;
        supplying the durable id there keeps its derived ids unique per source feature."""
        from app.services import road_corridor_pairing as pairing

        f = gj_feat(10, "SHS_050._P", 1, IN_A)
        f["properties"]["EventID"] = "evt-abc-123"
        out = cal.normalize_caltrans_features([f], included_classes=(1,))[0]["properties"]
        assert out["provider_event_id"] == "evt-abc-123"          # raw provider field (audit)
        assert out["provider_feature_id"] == out["source_feature_id"]
        assert "provider_feature_id" in pairing.PROVIDER_ID_KEYS  # the contract we rely on

    def test_distinct_route_events_on_one_alignment_keep_distinct_packaged_ids(self):
        """Two concurrent LRS route events can share an alignment. They must not collapse to
        one identity in the packaged output (which would merge two roads for selection)."""
        from app.services import road_corridor_pairing as pairing

        a = gj_feat(1, "SHS_005._P", 1, IN_A)
        b = gj_feat(2, "SHS_099._P", 1, IN_A)  # identical geometry, different route
        feats = cal.normalize_caltrans_features([a, b], included_classes=(1,))
        assert len({f["properties"]["source_feature_id"] for f in feats}) == 2
        paired, _stats = pairing.build_selection_features(feats, pairing.PairingParams())
        assert len({f["properties"]["feature_id"] for f in paired}) == len(paired)  # all unique

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
        f3 = gj_feat(3, "SHS_099._P", 2, IN_B)
        f2 = gj_feat(2, "SHS_020._P", 2, IN_C)
        forward = cal.dedupe_caltrans_features(cal.normalize_caltrans_features([f1, f2, f3], included_classes=(1, 2)))
        shuffled = cal.dedupe_caltrans_features(cal.normalize_caltrans_features([f3, f1, f2], included_classes=(1, 2)))
        ids_fwd = [f["properties"]["source_feature_id"] for f in forward]
        ids_shuf = [f["properties"]["source_feature_id"] for f in shuffled]
        assert len(ids_fwd) == 3
        # Ordering is by the DURABLE identity, so response order cannot change the output.
        assert ids_fwd == ids_shuf
        assert json.dumps(forward, separators=(",", ":")) == json.dumps(shuffled, separators=(",", ":"))


# --------------------------------------------------------------------------- #
# 6b. Durable feature identity (OBJECTID is NOT identity)
# --------------------------------------------------------------------------- #
class TestDurableIdentity:
    def _sfid(self, feature):
        return cal.normalize_caltrans_features([feature], included_classes=(1, 2))[0]["properties"]["source_feature_id"]

    def test_objectid_reassignment_does_not_change_identity(self):
        """A service refresh/republication may reassign OBJECTID. With geometry and stable
        attributes unchanged, the durable ERIS identity must be identical."""
        a = self._sfid(gj_feat(477930, "SHS_050._P", 1, IN_A))
        b = self._sfid(gj_feat(999999, "SHS_050._P", 1, IN_A))  # ONLY OBJECTID changed
        assert a == b

    def test_objectid_reassignment_does_not_change_identity_with_event_id(self):
        f1 = gj_feat(1, "SHS_050._P", 1, IN_A)
        f1["properties"]["EventID"] = "evt-1"
        f2 = gj_feat(42, "SHS_050._P", 1, IN_A)
        f2["properties"]["EventID"] = "evt-1"
        assert self._sfid(f1) == self._sfid(f2)

    def test_identity_is_coordinate_order_invariant(self):
        fwd = gj_feat(1, "SHS_050._P", 1, IN_A)
        rev = gj_feat(1, "SHS_050._P", 1, list(reversed(IN_A)))  # reversed digitization
        assert self._sfid(fwd) == self._sfid(rev)

    def test_identity_is_multipart_order_invariant(self):
        a = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [IN_B, IN_C]},
             "properties": {"OBJECTID": 1, "RouteID": "SHS_099._P", "F_System": 2}}
        b = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [IN_C, IN_B]},
             "properties": {"OBJECTID": 7, "RouteID": "SHS_099._P", "F_System": 2}}
        assert self._sfid(a) == self._sfid(b)

    def test_different_geometry_yields_different_identity(self):
        assert self._sfid(gj_feat(1, "SHS_050._P", 1, IN_A)) != self._sfid(gj_feat(1, "SHS_050._P", 1, IN_B))

    def test_same_event_id_with_different_geometry_yields_different_ids(self):
        """source_feature_id identifies ONE exact original road feature, so a shared EventID
        must not merge two different geometries. (Stability of the provider's event across
        releases is represented by provider_event_id, not by source_feature_id.)"""
        f1 = gj_feat(1, "SHS_050._P", 1, IN_A)
        f1["properties"]["EventID"] = "evt-9"
        f2 = gj_feat(1, "SHS_050._P", 1, IN_B)
        f2["properties"]["EventID"] = "evt-9"
        assert self._sfid(f1) != self._sfid(f2)

    def test_distinct_routes_with_identical_geometry_yield_different_ids(self):
        a = gj_feat(1, "SHS_005._P", 1, IN_A)
        b = gj_feat(1, "SHS_099._P", 1, IN_A)  # same geometry + class, different route event
        assert self._sfid(a) != self._sfid(b)

    def test_provider_event_id_still_carries_the_provider_event(self):
        f = gj_feat(1, "SHS_050._P", 1, IN_A)
        f["properties"]["EventID"] = "evt-9"
        props = cal.normalize_caltrans_features([f], included_classes=(1,))[0]["properties"]
        assert props["provider_event_id"] == "evt-9"  # provenance / cross-version correlation

    def test_malformed_event_id_is_rejected_and_falls_back(self):
        assert cal.validated_event_id("  ") is None
        assert cal.validated_event_id("x" * 200) is None
        assert cal.validated_event_id("bad\x00id") is None
        assert cal.validated_event_id(12345) is None
        assert cal.validated_event_id(" evt-ok ") == "evt-ok"
        # Degenerate placeholders (all-zero GUID / single repeated char) are not identity.
        assert cal.validated_event_id("{00000000-0000-0000-0000-000000000000}") is None
        assert cal.validated_event_id("0000") is None
        # A rejected EventID must not leak into the packaged properties.
        f = gj_feat(1, "SHS_050._P", 1, IN_A)
        f["properties"]["EventID"] = "bad\x00id"
        props = cal.normalize_caltrans_features([f], included_classes=(1,))[0]["properties"]
        assert "provider_event_id" not in props
        assert props["source_feature_id"] == self._sfid(gj_feat(1, "SHS_050._P", 1, IN_A))

    def test_a_shared_event_id_never_collapses_distinct_geometries(self):
        """EventID is validated for SHAPE, not uniqueness. A placeholder/republished event id
        shared by several distinct geometry rows must NEVER silently drop roads."""
        feats = []
        for i in range(5):
            f = gj_feat(i, "SHS_050._P", 1, [[-121.50 + i * 1e-3, 38.50], [-121.49 + i * 1e-3, 38.505]])
            f["properties"]["EventID"] = "same-event-for-all"  # shape-valid but not unique
            feats.append(f)
        out = cal.dedupe_caltrans_features(cal.normalize_caltrans_features(feats, included_classes=(1,)))
        assert len(out) == 5, "distinct geometries must survive a non-unique upstream event id"

    def test_shared_event_id_stays_distinct_through_pairing_end_to_end(self):
        """END-TO-END: several distinct roads republished under ONE shape-valid EventID must
        stay distinct all the way through the divided-corridor pairing pass, and every
        corridor's member references must resolve unambiguously."""
        from app.services import road_corridor_pairing as pairing

        # Two parallel carriageways (pair into a corridor) + a separate road, all sharing
        # one EventID — the exact case the event-only identity formula used to collapse.
        car_a = [[-121.500, 38.5000], [-121.480, 38.5000]]
        car_b = [[-121.500, 38.5004], [-121.480, 38.5004]]   # ~44 m apart, same bearing
        other = [[-121.470, 38.4900], [-121.460, 38.4950]]
        feats_in = []
        for i, coords in enumerate((car_a, car_b, other)):
            f = gj_feat(i + 1, "SHS_050._P", 1, coords)
            f["properties"]["EventID"] = "one-event-for-all"
            feats_in.append(f)

        norm = cal.dedupe_caltrans_features(cal.normalize_caltrans_features(feats_in, included_classes=(1,)))
        assert len(norm) == 3, "a shared EventID must not drop distinct roads"
        assert len({f["properties"]["source_feature_id"] for f in norm}) == 3

        paired, _stats = pairing.build_selection_features(norm, pairing.PairingParams())
        # Pairing-derived SOURCE ids stay distinct (they key off provider_feature_id). A
        # DERIVED corridor is not source-derived, so it legitimately carries no source id.
        src_ids = {
            f["properties"]["source_feature_id"]
            for f in paired
            if isinstance(f["properties"].get("source_feature_id"), str)
        }
        assert len(src_ids) == 3, f"expected 3 distinct source ids, got {sorted(src_ids)}"
        # Every emitted feature id is unique.
        fids = [f["properties"].get("feature_id") for f in paired]
        assert len(set(fids)) == len(fids)
        # Corridor member references resolve unambiguously and never repeat a member.
        corridors = [f for f in paired if f["properties"].get("member_source_feature_ids")]
        assert corridors, "the two parallel carriageways should have paired into a corridor"
        for f in corridors:
            members = f["properties"]["member_source_feature_ids"]
            assert len(set(members)) == len(members), "a corridor must not repeat a member source id"
            assert set(members) <= src_ids, "member source ids must resolve to emitted sources"

    def test_canonical_geometry_key_accepts_the_esri_paths_form(self):
        # Public API: a caller passing raw upstream Esri geometry must not silently get an
        # empty key (which would degrade identity to route+class and collapse segments).
        key = cal.canonical_geometry_key({"paths": [IN_A]})
        assert key and key == cal.canonical_geometry_key({"type": "LineString", "coordinates": IN_A})

    def test_identity_is_scoped_to_the_provider_layer(self):
        f = gj_feat(1, "SHS_050._P", 1, IN_A)
        a = cal.normalize_caltrans_features([f], included_classes=(1,), layer_key=cal.DEFAULT_LAYER_KEY)
        b = cal.normalize_caltrans_features([f], included_classes=(1,), layer_key="caltrans_crs:/other/featureserver/9")
        assert a[0]["properties"]["source_feature_id"] != b[0]["properties"]["source_feature_id"]

    def test_layer_key_ignores_host_query_and_credentials(self):
        base = cal.caltrans_layer_key(URL)
        assert base == cal.caltrans_layer_key(URL + "?token=SECRET")
        assert base == cal.caltrans_layer_key(URL.replace("caltrans-gis.dot.ca.gov", "u:p@mirror.example.gov"))
        assert "SECRET" not in base and "token" not in base


# --------------------------------------------------------------------------- #
# 6c. Strict functional-class configuration
# --------------------------------------------------------------------------- #
class TestFunctionalClassConfig:
    @pytest.mark.parametrize(
        "spec,expected",
        [("1,2", (1, 2)), ("2,1,2", (1, 2)), ("1,3", (1, 3)), (" 1 , 2 ", (1, 2)), ("7", (7,))],
    )
    def test_valid_specs_normalize_deterministically(self, spec, expected):
        assert cal.parse_functional_classes(spec) == expected

    @pytest.mark.parametrize("spec", ["1,x", "1.9", "8", "0", "-1", "", " ", ",", None, "1,,x"])
    def test_invalid_specs_are_rejected_not_defaulted(self, spec):
        # A wholly/partly invalid operator value must NEVER silently become the default.
        with pytest.raises(ValueError):
            cal.parse_functional_classes(spec)

    def test_settings_validator_rejects_malformed_and_normalizes(self):
        from app.config import Settings

        base = {"DB_PASS": "x", "JWT_SECRET": "y"}
        assert Settings(**base, OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES="2,1,2").OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES == "1,2"
        assert Settings(**base, OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES="1,3").OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES == "1,3"
        for bad in ("1,x", "1.9", "8", ""):
            with pytest.raises(Exception):
                Settings(**base, OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES=bad)

    def test_omitted_setting_uses_the_declared_default(self):
        from app.config import Settings

        s = Settings(DB_PASS="x", JWT_SECRET="y")
        assert s.OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES == "1,2"

    # ---- strict COLLECTION normalization (adapter/query API) ----
    @pytest.mark.parametrize("bad", [[1.9], [1.0], [True], [False], ["1"], ["1.9"], [None], [8], [0], [], [2, "3"]])
    def test_build_where_clause_rejects_non_int_collections(self, bad):
        # int(c) would silently turn 1.9/True/1.0/"1" into 1 — a query nobody asked for.
        with pytest.raises(ValueError):
            cal.build_where_clause(bad)

    def test_build_where_clause_normalizes_valid_collections(self):
        assert cal.build_where_clause([2, 1, 2]) == "F_System IN (1, 2)"
        assert cal.normalize_functional_class_collection([3, 1, 3]) == (1, 3)

    @pytest.mark.parametrize("bad", [[1.9], [1.0], [True], ["1"], [], [8]])
    def test_fetch_rejects_invalid_collections_before_any_request(self, bad):
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        with pytest.raises(ValueError):
            cal.fetch_caltrans_road_features(
                BOUNDS, layer_url=URL, functional_classes=bad, timeout_s=30, session=s, sleep=lambda *_: None
            )
        assert s.calls == [], "no network request may be issued for an invalid class collection"

    def test_upstream_non_integral_f_system_is_not_truncated(self):
        # 1.9 must NOT become class 1 — it is rejected, so the feature is dropped.
        for bad in (1.9, "1.9", "1e0", True):
            f = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A},
                 "properties": {"OBJECTID": 1, "F_System": bad}}
            assert cal.normalize_caltrans_features([f], included_classes=(1, 2)) == []
        # An integral float representation IS accepted.
        f_ok = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A},
                "properties": {"OBJECTID": 1, "F_System": 2.0}}
        assert len(cal.normalize_caltrans_features([f_ok], included_classes=(1, 2))) == 1


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
# 7b. content_signature reflects the ACTUAL road result
# --------------------------------------------------------------------------- #
class TestRoadContentSignature:
    def _layer(self, **over):
        base = {
            "available": True, "file": "roads.geojson", "sha256": "a" * 64, "bytes": 10,
            "feature_count": 2, "filter_version": "caltrans_crs.v2:F_System[1,2]",
            "functional_classes": [1, 2],
            "source": {"provider": "caltrans_crs", "retrieved_at": "2026-07-22T00:00:00Z"},
        }
        base.update(over)
        return base

    def test_identical_packaged_roads_produce_the_same_signature(self):
        a = osvc.road_content_fingerprint(self._layer())
        b = osvc.road_content_fingerprint(self._layer())
        assert a == b

    def test_changing_only_retrieved_at_does_not_change_the_signature(self):
        a = osvc.road_content_fingerprint(self._layer())
        b = osvc.road_content_fingerprint(
            self._layer(source={"provider": "caltrans_crs", "retrieved_at": "2027-01-01T00:00:00Z"})
        )
        assert a == b

    def test_changing_roads_geojson_changes_the_signature(self):
        assert osvc.road_content_fingerprint(self._layer()) != osvc.road_content_fingerprint(
            self._layer(sha256="b" * 64)
        )

    def test_caltrans_success_and_tiger_fallback_differ(self):
        caltrans = osvc.road_content_fingerprint(self._layer())
        tiger = osvc.road_content_fingerprint(self._layer(
            source={"provider": "us_census_tigerweb"},
            fallback={"from": "caltrans_crs", "to": "census_tigerweb", "reason": "source_error"},
            filter_version=None, functional_classes=None,
        ))
        assert caltrans != tiger

    def test_available_and_unavailable_differ_and_reason_matters(self):
        available = osvc.road_content_fingerprint(self._layer())
        unavailable = osvc.road_content_fingerprint({"available": False, "reason": "source_error"})
        other_reason = osvc.road_content_fingerprint({"available": False, "reason": "incomplete_source"})
        assert len({available, unavailable, other_reason}) == 3

    def test_fallback_recovery_produces_a_new_download_signature(self):
        """A later run that recovers the primary provider must not look identical to the
        earlier fallback run, or mobile would never re-download the better data."""
        fell_back = osvc.road_content_fingerprint(self._layer(
            source={"provider": "us_census_tigerweb"},
            fallback={"from": "caltrans_crs", "to": "census_tigerweb", "reason": "incomplete_source"},
        ))
        recovered = osvc.road_content_fingerprint(self._layer())
        assert fell_back != recovered

    def test_finalized_signature_folds_the_fingerprint_and_is_deterministic(self):
        base = osvc.content_signature(
            gisa_updated_at="2026-01-01", geometry_json=None, road_bearing_deg=None, radius_m=1500.0
        )
        fp = osvc.road_content_fingerprint(self._layer())
        final = osvc.finalize_content_signature(base, fp)
        assert final == osvc.finalize_content_signature(base, fp)   # deterministic
        assert final != base                                        # actually folded in
        assert len(final) == 16
        other = osvc.finalize_content_signature(base, osvc.road_content_fingerprint(self._layer(sha256="c" * 64)))
        assert final != other

    def test_legacy_content_signature_callers_are_unchanged(self):
        legacy = dict(gisa_updated_at="2026-01-01", geometry_json=None, road_bearing_deg=None, radius_m=1500.0)
        assert osvc.content_signature(**legacy) == osvc.content_signature(**legacy)

    def test_builder_writes_the_finalized_signature_into_ctx_and_manifest(self, monkeypatch):
        """The SAME finalized value must reach the manifest and (via ctx) catalog
        registration — and two runs whose road output differs must differ."""
        import numpy as np

        from app.services import offline_scene_dem as dem_fmt
        from app.services import offline_scene_terrain as terrain_fmt

        _caltrans_settings(monkeypatch)
        heights = np.full((8, 8), 100.0, dtype="float32")
        grid, _stats = terrain_fmt.encode_height_grid(heights)

        # This test exercises road-signature finalization, not DEM acquisition.
        # Supply the complete verification record now required by build_package
        # rather than weakening the production fail-closed boundary.
        dem_verification = {
            "export_contract": dem_fmt.DEM_EXPORT_CONTRACT,
            "adjust_aspect_ratio": False,
            "extent_verified": True,
            "raster_verified": True,
            "raster_transform_verified": True,
            "raster_crs_wkid": 4326,
            "requested_width_px": 8,
            "requested_height_px": 8,
            "returned_width_px": 8,
            "returned_height_px": 8,
            "raster_width_px": 8,
            "raster_height_px": 8,
            "extent_max_delta_deg": 0.0,
            "extent_tolerance_deg": dem_fmt.DEM_EXTENT_TOLERANCE_DEG,
            "raster_bounds_max_delta_deg": 0.0,
            "requested_bounds": dict(BOUNDS),
            "returned_bounds": dict(BOUNDS),
            "raster_bounds": dict(BOUNDS),
        }
        assert dem_fmt.verification_ok(dem_verification)

        def _run(session):
            ctx = _ctx()
            ctx["content_signature"] = "base-sig"
            b = _builder(session)
            monkeypatch.setattr(
                terrain_fmt,
                "decode_dem_tiff",
                lambda *a, **k: heights,
            )
            pkg = b.build_package(
                ctx,
                {
                    "dem_bytes": b"x",
                    "dem_verification": dict(dem_verification),
                    "hillshade_bytes": b"",
                    "usgs_meta": {},
                    "basemap_meta": {},
                },
            )
            m = json.loads(
                zipfile.ZipFile(
                    io.BytesIO(pkg)
                ).read("manifest.json")
            )
            return (
                ctx["content_signature"],
                m["content_signature"],
                m["context_layers"]["roads"],
            )

        ctx_sig, manifest_sig, roads = _run(PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)]))
        assert ctx_sig == manifest_sig != "base-sig"   # finalized, and shared with the catalog
        assert roads["available"] is True

        # A different road outcome (source down -> unavailable) must change the signature.
        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("down")

        ctx_sig2, manifest_sig2, roads2 = _run(Boom())
        assert roads2["available"] is False
        assert ctx_sig2 == manifest_sig2 and manifest_sig2 != manifest_sig


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
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES", "1,2")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1000)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_PAGES", 100)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_FEATURES", 20000)
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
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A, county="SACRAMENTO", district=3), gj_feat(2, "SHS_099._P", 2, IN_B)])
        layers, assets = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and ctxmod.ROADS_FILE in assets
        assert roads["road_kinds"] == ["road_centerline"]
        assert roads["source"]["provider"] == "caltrans_crs"
        assert roads["source"]["dataset"] == "Caltrans CRS Functional Classification"
        assert roads["source"]["service"] == URL
        assert roads["filter_version"] == "caltrans_crs.v2:F_System[1,2]"
        assert roads["functional_classes"] == [1, 2]
        assert roads["road_class_counts"].get("primary", 0) >= 1
        # Truthful scope: nothing in the packaged road metadata claims ownership.
        blob = json.dumps(roads).lower()
        assert "state highway system" not in blob
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

    def test_packaged_identity_survives_objectid_reassignment(self, monkeypatch):
        """END-TO-END: a service refresh may reassign OBJECTIDs. With geometry and stable
        attributes unchanged, the durable identities in the PACKAGED roads.geojson (after
        the divided-corridor pairing rewrite) must be identical, while the provider's
        OBJECTID is still retained distinctly as provenance."""
        _caltrans_settings(monkeypatch)

        def _package(oid_a, oid_b):
            s = PagingSession([gj_feat(oid_a, "SHS_050._P", 1, IN_A), gj_feat(oid_b, "SHS_099._P", 2, IN_B)])
            layers, assets = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
            gj = json.loads(assets[ctxmod.ROADS_FILE])
            return (
                sorted(f["properties"].get("source_feature_id") for f in gj["features"]),
                sorted(f["properties"].get("provider_object_id") for f in gj["features"]),
            )

        ids_a, oids_a = _package(1, 2)
        ids_b, oids_b = _package(987654, 987655)  # ONLY the OBJECTIDs changed
        assert ids_a == ids_b and all(isinstance(i, str) and i for i in ids_a)
        assert oids_a == [1, 2] and oids_b == [987654, 987655]  # provenance still truthful

    def test_incomplete_source_optional_is_truthfully_unavailable_and_never_packaged(self, monkeypatch):
        """A pagination cap hit while more features remain must NEVER be packaged as an
        available road layer — no READY package may contain the truncated subset."""
        _caltrans_settings(monkeypatch, required=False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_PAGES", 2)
        feats = [gj_feat(i, f"SHS_0{i}._P", 1, [[-121.50 + i * 1e-4, 38.50], [-121.49 + i * 1e-4, 38.505]]) for i in range(10)]
        layers, assets = _builder(PagingSession(feats))._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == "incomplete_source"   # distinct from a generic source_error
        assert ctxmod.ROADS_FILE not in assets          # the truncated subset is not packaged

    def test_incomplete_source_required_fails_generation(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_FEATURES", 2)
        feats = [gj_feat(i, f"SHS_0{i}._P", 1, [[-121.50 + i * 1e-4, 38.50], [-121.49 + i * 1e-4, 38.505]]) for i in range(10)]
        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(PagingSession(feats))._build_context_layers(_ctx(), base_bytes=0)

    def test_explicit_fallback_after_incomplete_source_is_audited(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=False, fallback="census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_PAGES", 1)

        class IncompleteThenTiger:
            """Caltrans always reports more records remain (forcing the page cap); TIGERweb
            serves a usable fallback."""

            def get(self, url, params=None, timeout=None):
                if "CRS_Functional_Classification" in url:
                    return FakeResp({"features": [gj_feat(1, "SHS_050._P", 1, IN_A)], "exceededTransferLimit": True})
                lid = int(url.rstrip("/").split("/")[-2])
                return FakeResp({"features": [gj_feat(1, "US-50", 2, IN_A)]} if lid == 2 else {"features": []})

        layers, assets = _builder(IncompleteThenTiger())._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert roads["source"]["provider"] == "us_census_tigerweb"
        assert roads["fallback"] == {"from": "caltrans_crs", "to": "census_tigerweb", "reason": "incomplete_source"}

    def test_cancellation_never_becomes_source_error_or_triggers_fallback(self, monkeypatch):
        """Cancellation is not a road failure: it leaves _build_context_layers immediately,
        contacts no fallback provider, packages nothing, and is never reported as
        source_error / incomplete_source — even with roads REQUIRED."""
        _caltrans_settings(monkeypatch, required=True, fallback="census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)

        state = {"n": 0}

        def cancel():
            state["n"] += 1
            return state["n"] > 1  # allow page 1, then cancel

        class Router:
            def __init__(self):
                self.caltrans_calls, self.tiger_calls = 0, 0

            def get(self, url, params=None, timeout=None):
                if "CRS_Functional_Classification" in url:
                    self.caltrans_calls += 1
                    return FakeResp({"features": [gj_feat(1, "SHS_050._P", 1, IN_A)], "exceededTransferLimit": True})
                self.tiger_calls += 1
                return FakeResp({"features": [gj_feat(9, "US-50", 2, IN_A)]})

        s = Router()
        ctx = dict(_ctx())
        ctx["cancel_check"] = cancel
        with pytest.raises(cal.CaltransFetchCancelled):
            _builder(s)._build_context_layers(ctx, base_bytes=0)
        assert s.caltrans_calls == 1, "exactly one page request before the cancellation"
        assert s.tiger_calls == 0, "no fallback provider may be contacted after cancellation"

    def test_worker_keeps_a_cancelled_job_cancelled_not_failed(self, monkeypatch):
        """The worker maps a between-pages cancellation to its canonical CANCELLED result and
        never uploads or registers a package."""
        from app.worker import offline_scene_worker as worker

        calls = {"upload": 0, "failed": 0}

        class FakeBuilder:
            def prepare_source_data(self, ctx, progress=None):
                return {"usgs_meta": {}, "basemap_meta": {}}

            def build_package(self, ctx, source, progress=None):
                raise cal.CaltransFetchCancelled("cancelled between pages")

            def validate_package(self, data):  # pragma: no cover - never reached
                return True, None

            def upload_and_register(self, *a, **k):  # pragma: no cover - must never run
                calls["upload"] += 1
                raise AssertionError("no upload may occur after cancellation")

        def fake_update(db, job_id, **kw):
            if kw.get("status") == "FAILED":
                calls["failed"] += 1
            return True

        monkeypatch.setattr(worker, "_build_context", lambda db, job: {"submission_id": 1})
        monkeypatch.setattr(worker, "_job_cancelled", lambda db, job_id: False)
        monkeypatch.setattr(worker.jobs, "update_job_if_active", fake_update)
        monkeypatch.setattr(worker.jobs, "progress_for", lambda s: 0)
        monkeypatch.setattr(worker.jobs, "get_job", lambda db, job_id: {"id": job_id, "status": "CANCELLED"})

        final = worker.process_job(object(), {"id": 7, "submission_id": 1}, builder=FakeBuilder())
        assert final["status"] == "CANCELLED"
        assert calls["upload"] == 0 and calls["failed"] == 0

    @pytest.mark.parametrize(
        "source,blank_setting",
        [
            ("caltrans_crs", "OFFLINE_SCENE_CALTRANS_ROADS_URL"),
            ("census_tigerweb", "OFFLINE_SCENE_TIGERWEB_BASE_URL"),
            ("arcgis_feature_service", "OFFLINE_SCENE_ROAD_SOURCE_URL"),
        ],
    )
    def test_unconfigured_external_provider_never_packages_internal_geometry(
        self, monkeypatch, source, blank_setting
    ):
        """An explicitly selected EXTERNAL provider with no endpoint must report
        provider_not_configured — never silently package ERIS-internal bearing/inventory
        geometry and label it as that provider."""
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", source)
        monkeypatch.setattr(settings, blank_setting, "")
        # A build context that DOES have usable internal geometry (bearing) — the tempting
        # substitution. It must not be used for an external provider.
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=90.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == "provider_not_configured"
        assert ctxmod.ROADS_FILE not in assets
        assert "source" not in roads  # nothing claims a provider

    def test_unconfigured_external_provider_fails_when_roads_required(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_ROADS_URL", "")
        with pytest.raises(OfflineSceneBuildError, match="provider_not_configured"):
            _builder(PagingSession([]))._build_context_layers(_ctx(bearing=90.0), base_bytes=0)

    def test_unconfigured_fallback_is_not_reported_as_a_successful_fallback(self, monkeypatch):
        """A fallback configured as arcgis_feature_service WITHOUT its URL must not appear as
        a successful ArcGIS fallback while actually packaging internal context."""
        _caltrans_settings(monkeypatch, required=False, fallback="arcgis_feature_service")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE_URL", "")

        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("caltrans down")

        layers, assets = _builder(Boom())._build_context_layers(_ctx(bearing=90.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert "fallback" not in roads
        assert ctxmod.ROADS_FILE not in assets
        assert "arcgis" not in json.dumps(roads).lower()

    def test_eris_internal_may_still_package_internal_geometry(self, monkeypatch):
        """Only eris_internal is allowed to package internal bearing/inventory geometry."""
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "eris_internal")
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=90.0), base_bytes=0)
        assert layers["roads"]["available"] is True
        assert layers["roads"]["source"]["provider"] == "eris_internal"
        assert ctxmod.ROADS_FILE in assets

    # ---- PROVIDER EXCLUSIVITY: an external layer holds ONLY that provider's features ----

    def test_zero_features_with_bearing_present_is_unavailable(self, monkeypatch):
        """Caltrans configured + reachable + zero usable features, with an internal bearing
        available: the bearing must NOT be borrowed to publish available:true."""
        _caltrans_settings(monkeypatch)
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert ctxmod.ROADS_FILE not in assets
        assert "source" not in roads

    def test_zero_features_with_road_inventory_geometry_present_is_unavailable(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        ctx = _ctx(bearing=None)
        ctx["road_inventory_geometry"] = {"type": "LineString", "coordinates": IN_A}
        layers, assets = _builder(PagingSession([]))._build_context_layers(ctx, base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert ctxmod.ROADS_FILE not in assets

    @pytest.mark.parametrize("bearing,inv", [(42.0, None), (None, {"type": "LineString", "coordinates": IN_A})])
    def test_zero_features_with_internal_geometry_succeeds_when_roads_required(self, monkeypatch, bearing, inv):
        """DEFECT A: a COMPLETE, SUCCESSFUL Caltrans query that finds zero freeway/expressway
        centerlines must NOT fail the job even when roads are required — it ships a READY
        terrain package with roads unavailable, a truthful completed-query reason, and NO
        internal geometry borrowed and NO fallback."""
        _caltrans_settings(monkeypatch, required=True)
        ctx = _ctx(bearing=bearing)
        ctx["road_inventory_geometry"] = inv
        # Does not raise:
        layers, assets = _builder(PagingSession([]))._build_context_layers(ctx, base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert roads["query_completed"] is True                 # provider ran and completed
        assert roads["provider"] == "caltrans_crs"              # truthful provenance
        assert "fallback" not in roads                          # no fallback invented
        assert ctxmod.ROADS_FILE not in assets                  # no borrowed internal geometry
        # Terrain/imagery may still be packaged; only the roads layer is unavailable.

    def test_explicit_eris_internal_fallback_packages_internal_geometry_audited(self, monkeypatch):
        """The ONLY sanctioned route to internal geometry after an external miss."""
        _caltrans_settings(monkeypatch, required=False, fallback="eris_internal")
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert roads["road_kinds"] == ["road_bearing"]
        assert roads["source"]["provider"] == "eris_internal"
        assert roads["fallback"] == {
            "from": "caltrans_crs", "to": "eris_internal", "reason": "no_centerline_features_in_area",
        }
        assert ctxmod.ROADS_FILE in assets

    def test_successful_caltrans_result_contains_no_internal_bearing_feature(self, monkeypatch):
        """A successful external result must not be silently mixed with internal geometry."""
        _caltrans_settings(monkeypatch)
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])
        layers, assets = _builder(s)._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert roads["road_kinds"] == ["road_centerline"]      # no road_bearing mixed in
        gj = json.loads(assets[ctxmod.ROADS_FILE])
        kinds = {f["properties"].get("kind") for f in gj["features"]}
        assert kinds == {"road_centerline"}
        assert all(f["properties"].get("provider") == "caltrans_crs" for f in gj["features"])

    def test_tigerweb_zero_features_does_not_borrow_internal_geometry(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
        monkeypatch.setattr(ctxmod, "fetch_tigerweb_road_features", lambda *a, **k: [])
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert ctxmod.ROADS_FILE not in assets

    def test_arcgis_zero_features_does_not_borrow_internal_geometry(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "arcgis_feature_service")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE_URL", "https://gis.example.gov/FeatureServer/0")
        monkeypatch.setattr(ctxmod, "fetch_arcgis_road_features", lambda *a, **k: [])
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert ctxmod.ROADS_FILE not in assets

    def test_external_fallback_uses_only_the_fallback_providers_results(self, monkeypatch):
        """An external fallback packages ITS OWN external features — never internal context."""
        _caltrans_settings(monkeypatch, required=False, fallback="census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL", "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")
        monkeypatch.setattr(ctxmod, "fetch_tigerweb_road_features", lambda *a, **k: [])
        # Caltrans finds nothing AND the tiger fallback finds nothing: internal bearing must
        # still not be packaged by either provider.
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert ctxmod.ROADS_FILE not in assets

    def test_eris_internal_still_packages_bearing_and_inventory(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "eris_internal")
        ctx = _ctx(bearing=42.0)
        ctx["road_inventory_geometry"] = {"type": "LineString", "coordinates": IN_B}
        layers, assets = _builder(PagingSession([]))._build_context_layers(ctx, base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True
        assert set(roads["road_kinds"]) == {"road_bearing", "road_inventory"}
        assert roads["source"]["provider"] == "eris_internal"
        assert ctxmod.ROADS_FILE in assets

    def test_cancellation_still_never_contacts_or_packages_a_fallback(self, monkeypatch):
        """Exclusivity must not weaken the cancellation path."""
        _caltrans_settings(monkeypatch, required=True, fallback="eris_internal")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)
        state = {"n": 0}

        def cancel():
            state["n"] += 1
            return state["n"] > 1

        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A), gj_feat(2, "SHS_099._P", 2, IN_B)])
        ctx = dict(_ctx(bearing=42.0))
        ctx["cancel_check"] = cancel
        with pytest.raises(cal.CaltransFetchCancelled):
            _builder(s)._build_context_layers(ctx, base_bytes=0)
        assert len(s.calls) == 1

    def test_provider_none_packages_no_roads(self, monkeypatch):
        _caltrans_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "none")
        s = PagingSession([gj_feat(1, "SHS_050._P", 1, IN_A)])  # must NOT be used
        layers, _ = _builder(s)._build_context_layers(_ctx(), base_bytes=0)
        assert layers["roads"]["available"] is False and layers["roads"]["reason"] == "provider_none"
        assert s.calls == []


class TestDefectAEmptyRoadPolicy:
    """DEFECT A — a COMPLETE, SUCCESSFUL external query returning zero qualifying centerlines
    is NOT a failure. It ships a READY package with roads unavailable; only genuine
    failures/incomplete/unsafe outcomes still fail closed when roads are required."""

    def test_valid_empty_result_succeeds_without_roads_when_required(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == ctxmod.ROADS_REASON_NO_FEATURES
        assert roads["query_completed"] is True
        assert roads["provider"] == "caltrans_crs"
        assert roads["filter_version"] == "caltrans_crs.v2:F_System[1,2]"
        assert roads["functional_classes"] == [1, 2]
        assert ctxmod.ROADS_FILE not in assets            # no roads asset
        assert "fallback" not in roads                    # no fallback invented

    def test_configured_provider_transport_failure_still_fails_when_required(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)

        class Boom:
            def get(self, *a, **k):
                raise RuntimeError("caltrans down")

        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(Boom())._build_context_layers(_ctx(), base_bytes=0)

    def test_provider_not_configured_still_fails_when_required(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_ROADS_URL", "")  # missing endpoint
        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(PagingSession([]))._build_context_layers(_ctx(), base_bytes=0)

    def test_incomplete_truncated_pagination_still_fails_when_required(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_PAGE_SIZE", 1)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_CALTRANS_MAX_PAGES", 1)  # cap below the real page count

        class NeverEnds:
            """Always says more remain, so the cap is hit while features remain -> incomplete."""

            def get(self, url, params=None, timeout=None):
                return FakeResp({"features": [gj_feat(1, "SHS_050._P", 1, IN_A)], "exceededTransferLimit": True})

        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(NeverEnds())._build_context_layers(_ctx(), base_bytes=0)

    def test_valid_empty_result_does_not_fall_back_or_borrow_internal(self, monkeypatch):
        # Empty query + bearing available + NO fallback configured: nothing is borrowed.
        _caltrans_settings(monkeypatch, required=True, fallback="")
        layers, assets = _builder(PagingSession([]))._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False and roads["query_completed"] is True
        assert "fallback" not in roads
        assert ctxmod.ROADS_FILE not in assets
        blob = json.dumps(roads).lower()
        assert "census" not in blob and "tiger" not in blob and "eris_internal" not in blob

    def test_layer_carries_no_env_var_or_python_internals(self, monkeypatch):
        # The machine reason is a stable token; the layer must not leak settings names,
        # enum class names, exception text or the service URL.
        _caltrans_settings(monkeypatch, required=True)
        layers, _ = _builder(PagingSession([]))._build_context_layers(_ctx(), base_bytes=0)
        blob = json.dumps(layers["roads"])
        for bad in ("OFFLINE_SCENE_ROADS_REQUIRED", "OfflineSceneBuildError", "Traceback",
                    "CaltransFetch", URL, "http"):
            assert bad not in blob

    def test_tigerweb_partial_layer_failure_with_no_features_still_fails_closed(self, monkeypatch):
        """REGRESSION (adversarial review): TIGERweb tolerates a SUBSET of layers failing.
        An empty result after a partial failure is NOT a verified-empty answer — it may mean
        the layer that held the roads failed — so it must NOT be treated as a completed-empty
        query and must still fail closed when roads are required."""
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL",
                            "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")

        class PartialFailSession:
            """Layer 2 (Primary) fails; layers 6/8 succeed but return nothing."""

            def get(self, url, params=None, timeout=None):
                lid = int(url.rstrip("/").split("/")[-2])
                if lid == 2:
                    raise RuntimeError("tigerweb layer 2 down")
                return FakeResp({"features": []})

        with pytest.raises(OfflineSceneBuildError, match="required"):
            _builder(PartialFailSession())._build_context_layers(_ctx(), base_bytes=0)

    def test_tigerweb_all_layers_ok_and_empty_is_a_genuine_completed_empty(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "census_tigerweb")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_BASE_URL",
                            "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_TIGERWEB_LAYERS", "2,6,8")

        class AllOkEmptySession:
            def get(self, url, params=None, timeout=None):
                return FakeResp({"features": []})

        layers, _ = _builder(AllOkEmptySession())._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["query_completed"] is True
        assert roads["provider"] == "us_census_tigerweb"

    def test_optional_mode_valid_empty_is_also_completed_not_source_error(self, monkeypatch):
        _caltrans_settings(monkeypatch, required=False)
        layers, _ = _builder(PagingSession([]))._build_context_layers(_ctx(), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is False
        assert roads["reason"] == ctxmod.ROADS_REASON_NO_FEATURES     # NOT source_error
        assert roads["query_completed"] is True


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
# Strict roads.geojson validation (pure)
# --------------------------------------------------------------------------- #
class TestStrictRoadsGeojsonValidation:
    def _fc(self, features):
        return json.dumps({"type": "FeatureCollection", "features": features}).encode()

    def _line(self, coords=None):
        return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords or IN_A}, "properties": {}}

    def test_valid_collection_passes(self):
        ok, reason = ctxmod.validate_roads_geojson(self._fc([self._line()]), 1)
        assert ok and reason is None

    def test_wrong_container_type_rejected(self):
        data = json.dumps({"type": "AnythingElse", "features": []}).encode()
        ok, reason = ctxmod.validate_roads_geojson(data)
        assert not ok and "FeatureCollection" in reason

    def test_feature_without_feature_type_rejected(self):
        bad = {"geometry": {"type": "LineString", "coordinates": IN_A}, "properties": {}}
        ok, reason = ctxmod.validate_roads_geojson(self._fc([bad]))
        assert not ok and "Feature" in reason

    def test_non_object_properties_rejected(self):
        bad = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": IN_A}, "properties": "nope"}
        ok, reason = ctxmod.validate_roads_geojson(self._fc([bad]))
        assert not ok and "properties" in reason

    def test_empty_multilinestring_rejected(self):
        bad = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": []}, "properties": {}}
        ok, reason = ctxmod.validate_roads_geojson(self._fc([bad]))
        assert not ok and "no parts" in reason

    def test_empty_multipart_member_rejected(self):
        bad = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [IN_A, []]}, "properties": {}}
        ok, reason = ctxmod.validate_roads_geojson(self._fc([bad]))
        assert not ok and "2 vertices" in reason

    @pytest.mark.parametrize("coord", [[True, False], [float("nan"), 38.5], [float("inf"), 38.5], [200.0, 38.5], [-121.5, 99.0], ["a", "b"], [1]])
    def test_invalid_coordinates_rejected(self, coord):
        ok, reason = ctxmod.validate_roads_geojson(self._fc([self._line([[-121.5, 38.5], coord])]))
        assert not ok and "coordinates" in reason

    def test_features_not_a_list_rejected(self):
        data = json.dumps({"type": "FeatureCollection", "features": {"a": 1}}).encode()
        ok, reason = ctxmod.validate_roads_geojson(data)
        assert not ok and "list" in reason

    @pytest.mark.parametrize("count", [-1, 1.5, "2", True, None if False else "x"])
    def test_invalid_feature_count_values_rejected(self, count):
        ok, reason = ctxmod.validate_roads_geojson(self._fc([self._line()]), count)
        assert not ok and "feature_count" in reason

    def test_zero_features_with_zero_count_is_valid(self):
        ok, reason = ctxmod.validate_roads_geojson(self._fc([]), 0)
        assert ok, reason

    def test_not_json_rejected(self):
        ok, reason = ctxmod.validate_roads_geojson(b"{nope")
        assert not ok and "JSON" in reason


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


# --------------------------------------------------------------------------- #
# Clipped-part identity: one source feature -> many packaged LineStrings, each
# with a UNIQUE pairing identity (so road_corridor_pairing never merges parts).
# --------------------------------------------------------------------------- #
_ID_M_PER_DEG_LAT = 111320.0
_ID_LAT0, _ID_LON0 = 38.50, -121.50
_ID_COS = math.cos(math.radians(_ID_LAT0))
_ID_BOUNDS = {"min_lat": 38.45, "min_lon": -121.60, "max_lat": 38.55, "max_lon": -121.40}


def _id_ll(east_m, north_m):
    return [round(_ID_LON0 + east_m / (_ID_M_PER_DEG_LAT * _ID_COS), 7),
            round(_ID_LAT0 + north_m / _ID_M_PER_DEG_LAT, 7)]


def _id_component(origin_e, off_n, length_m=400, step=25):
    return [_id_ll(origin_e + d, off_n) for d in range(0, length_m + 1, step)]


def _caltrans_mls(oid, route, fsys, parts):
    return {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": parts},
            "properties": {"OBJECTID": oid, "RouteID": route, "F_System": fsys}}


def _emit_caltrans(features, bounds=None):
    """normalize Caltrans -> roads_geojson_from_context clipping (external, exclusive)."""
    norm = cal.normalize_caltrans_features(features, included_classes=(1, 2))
    gj, _count, _reason = ctxmod.roads_geojson_from_context(
        {"bounds": bounds or _ID_BOUNDS, "external_road_features": norm, "overlays": {}},
        250.0, external_configured=True, include_internal_context=False,
    )
    return gj["features"]


def _centerlines(feats):
    return [f for f in feats if f["properties"].get("kind") == "road_centerline"]


def _pfid_set(feats):
    return {f["properties"].get("provider_feature_id") for f in _centerlines(feats)}


class TestClippedPartIdentity:
    def test_multipart_emits_two_lines_shared_source_distinct_part_ids(self):
        """Case 1: a two-part Caltrans MultiLineString -> two LineStrings; one
        provider_source_feature_id; two different provider_feature_id; unique final ids."""
        f = _caltrans_mls(10, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])
        parts = _centerlines(_emit_caltrans([f]))
        assert len(parts) == 2
        assert all(p["geometry"]["type"] == "LineString" for p in parts)
        srcs = {p["properties"]["provider_source_feature_id"] for p in parts}
        assert len(srcs) == 1, "both parts trace to ONE source feature"
        pfids = [p["properties"]["provider_feature_id"] for p in parts]
        assert len(set(pfids)) == 2, "each clipped part has its OWN pairing identity"
        assert all(pid.startswith("part:") for pid in pfids)
        paired, _stats = pairing.build_selection_features(_emit_caltrans([f]), pairing.PairingParams())
        fids = [g["properties"].get("feature_id") for g in paired]
        assert len(set(fids)) == len(fids)

    def test_multipart_reorder_produces_the_same_id_set_and_bytes(self):
        """Case 2: reordering the MultiLineString's parts yields the same part-id set and
        deterministically equivalent sorted output."""
        parts_fwd = _emit_caltrans([_caltrans_mls(10, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])])
        parts_rev = _emit_caltrans([_caltrans_mls(10, "SHS_050._P", 1, [_id_component(4000, 22), _id_component(0, 22)])])
        assert _pfid_set(parts_fwd) == _pfid_set(parts_rev)
        a, _ = pairing.build_selection_features(parts_fwd, pairing.PairingParams())
        b, _ = pairing.build_selection_features(parts_rev, pairing.PairingParams())
        assert json.dumps(a, sort_keys=True, separators=(",", ":")) == json.dumps(b, sort_keys=True, separators=(",", ":"))

    def test_each_part_reversed_keeps_the_same_identity_set(self):
        """Case 3: reversing each part's digitisation direction keeps the same id set."""
        base = _emit_caltrans([_caltrans_mls(10, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])])
        rev = _emit_caltrans([_caltrans_mls(10, "SHS_050._P", 1,
                                            [list(reversed(_id_component(0, 22))), list(reversed(_id_component(4000, 22)))])])
        assert _pfid_set(base) == _pfid_set(rev)

    def test_objectid_only_reassignment_is_invariant(self):
        """Case 4: OBJECTID-only change leaves source-level AND part-level identities."""
        base = _emit_caltrans([_caltrans_mls(10, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])])
        other = _emit_caltrans([_caltrans_mls(987654, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])])
        assert ({p["properties"]["provider_source_feature_id"] for p in _centerlines(base)}
                == {p["properties"]["provider_source_feature_id"] for p in _centerlines(other)})
        assert _pfid_set(base) == _pfid_set(other)

    def test_leave_and_reenter_emits_distinct_parts_with_distinct_ids(self):
        """Case 5: one LineString that enters, exits, and re-enters the clip bounds emits
        >= 2 disconnected parts, each with a distinct pairing identity."""
        # inside -> far east (outside +buffer) -> back inside: two disconnected clipped parts.
        line = [_id_ll(0, 0), _id_ll(0, 30), [-121.20, 38.50], _id_ll(200, -30), _id_ll(200, 0)]
        f = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
             "properties": {"OBJECTID": 5, "RouteID": "SHS_050._P", "F_System": 1}}
        parts = _centerlines(_emit_caltrans([f]))
        assert len(parts) >= 2, "a leave/re-enter line must yield disconnected parts"
        assert len({p["properties"]["provider_feature_id"] for p in parts}) == len(parts)
        assert len({p["properties"]["provider_source_feature_id"] for p in parts}) == 1

    def test_two_carriageways_split_into_two_locations_pair_independently(self):
        """Case 6: two carriageway source features, each a MultiLineString split into two
        geographically separate components -> two INDEPENDENT corridors, no cross-contamination."""
        a = _caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])
        b = _caltrans_mls(2, "SHS_050._S", 1, [_id_component(0, -22), _id_component(4000, -22)])
        feats = _emit_caltrans([a, b])
        cl = _centerlines(feats)
        assert len(cl) == 4 and len(_pfid_set(feats)) == 4
        paired, stats = pairing.build_selection_features(feats, pairing.PairingParams())
        assert stats["divided_corridor_count"] == 2
        fids = [g["properties"].get("feature_id") for g in paired]
        assert len(set(fids)) == len(fids), "every emitted feature_id is unique"
        diag = {g["properties"]["feature_id"] for g in paired
                if g["properties"].get("diagnostic_kind") == "carriageway_member"}
        corridors = [g for g in paired if g["properties"].get("selection_kind") == "divided_highway_corridor"]
        assert len(corridors) == 2
        member_ids_seen = []
        for c in corridors:
            members = c["properties"]["member_part_feature_ids"]
            assert len(members) == 2 and len(set(members)) == 2
            assert set(members) <= diag, "each member id resolves to exactly one emitted diagnostic member"
            member_ids_seen.extend(members)
            # both members of a corridor sit at the SAME locality (no X<->Y mixing).
            mg = c["properties"].get("member_geometry") or {}
            ax = [p[0] for p in mg.get("a", [])]
            bx = [p[0] for p in mg.get("b", [])]
            assert ax and bx and abs(min(ax) - min(bx)) < 0.01 and (max(ax) - min(ax)) < 0.02
        assert len(set(member_ids_seen)) == len(member_ids_seen), "no diagnostic member is shared across corridors"

    def test_single_unsplit_line_is_deterministic(self):
        """Case 7: a single unsplit Caltrans LineString stays deterministic + selectable."""
        f = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": _id_component(0, 0)},
             "properties": {"OBJECTID": 7, "RouteID": "SHS_050._P", "F_System": 1}}
        parts = _centerlines(_emit_caltrans([f]))
        assert len(parts) == 1
        a, _ = pairing.build_selection_features(_emit_caltrans([f]), pairing.PairingParams())
        b, _ = pairing.build_selection_features(_emit_caltrans([f]), pairing.PairingParams())
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

    def test_reused_event_id_across_distinct_features_stays_unique(self):
        """Case 8: reused EventID on two distinct source features -> distinct part ids."""
        fa = _caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22)])
        fb = _caltrans_mls(2, "SHS_099._P", 1, [_id_component(4000, 22)])
        fa["properties"]["EventID"] = fb["properties"]["EventID"] = "shared-event"
        parts = _centerlines(_emit_caltrans([fa, fb]))
        assert len(parts) == 2
        assert len({p["properties"]["provider_source_feature_id"] for p in parts}) == 2
        assert len(_pfid_set(parts)) == 2

    def test_pairing_guard_fires_on_colliding_provider_ids(self):
        """Fail closed: if two distinct lines reach pairing with the same provider_feature_id,
        build_selection_features raises rather than misapply a component's range."""
        parts = _centerlines(_emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])]))
        # Reintroduce the old bug: force both parts to share one provider_feature_id.
        collide = json.loads(json.dumps(parts))
        collide[1]["properties"]["provider_feature_id"] = collide[0]["properties"]["provider_feature_id"]
        with pytest.raises(pairing.DuplicateSourceIdentityError):
            pairing.build_selection_features(collide, pairing.PairingParams())

    def test_identical_geometry_sharing_an_id_now_fails_closed(self):
        """REPLACES the old 'identical duplicates are harmless' assumption. Two candidates
        sharing an identity AND geometry would emit the SAME final feature_id twice, so the
        preflight must reject them."""
        one = _centerlines(_emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22)])]))[0]
        dup = json.loads(json.dumps([one, one]))
        with pytest.raises(pairing.DuplicateSourceIdentityError, match="identical geometry"):
            pairing.assert_unique_candidate_identities(dup)

    def test_builder_fails_closed_on_packaged_identity_collision(self, monkeypatch):
        """A generated part identity mapping to two DIFFERENT geometries fails the package at
        the packaging boundary — never swallowed into an unavailable roads layer."""
        _caltrans_settings(monkeypatch)
        # Force a CONSTANT part id so two distinct clipped parts collide.
        monkeypatch.setattr(ctxmod, "packaged_part_provider_feature_id", lambda *a, **k: "part:COLLIDE")
        s = PagingSession([_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])])
        ctx = _ctx()
        ctx["bounds"] = _ID_BOUNDS
        ctx["center"] = {"lat": _ID_LAT0, "lon": _ID_LON0}
        with pytest.raises(OfflineSceneBuildError, match="Packaged road identities collided"):
            _builder(s)._build_context_layers(ctx, base_bytes=0)


# --------------------------------------------------------------------------- #
# Duplicate-emission invariant: an EXACT redundant packaged part is emitted once,
# any repeated candidate identity fails closed, and every emitted feature_id is
# globally unique.
# --------------------------------------------------------------------------- #
def _assert_globally_unique_ids(emitted):
    """Every non-empty emitted feature_id is unique, and every corridor member id resolves
    to exactly ONE emitted diagnostic member."""
    fids = [f["properties"].get("feature_id") for f in emitted]
    nonempty = [x for x in fids if isinstance(x, str) and x]
    assert len(set(nonempty)) == len(nonempty), f"duplicate emitted feature_id: {nonempty}"
    diag = [f["properties"]["feature_id"] for f in emitted
            if f["properties"].get("diagnostic_kind") == "carriageway_member"]
    assert len(set(diag)) == len(diag)
    for f in emitted:
        members = f["properties"].get("member_part_feature_ids") or []
        for m in members:
            assert diag.count(m) == 1, f"member id {m} must resolve to exactly one diagnostic member"


class TestDuplicatePackagedPartIdentity:
    def test_multipart_with_the_same_part_twice_is_packaged_once(self):
        """Case 1: a valid but REDUNDANT MultiLineString containing the same part twice."""
        part = _id_component(0, 0)
        f = _caltrans_mls(1, "SHS_050._P", 1, [part, list(part)])
        parts = _centerlines(_emit_caltrans([f]))
        assert len(parts) == 1, "the exact redundant part must be packaged once"
        assert len({p["properties"]["provider_feature_id"] for p in parts}) == 1
        assert len({p["properties"]["provider_source_feature_id"] for p in parts}) == 1
        emitted, stats = pairing.build_selection_features(_emit_caltrans([f]), pairing.PairingParams())
        _assert_globally_unique_ids(emitted)
        # Counts reflect what was ACTUALLY packaged, not the redundant input.
        assert stats["feature_count"] == len(emitted) == 1
        assert stats["source_feature_count"] == 1

    def test_reversed_order_and_direction_give_the_same_bytes_and_identities(self):
        """Case 2: duplicate parts reversed in order AND coordinate direction."""
        part = _id_component(0, 0)
        fwd = _emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [part, list(part)])])
        rev = _emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [list(reversed(part)), list(reversed(part))])])
        assert _pfid_set(fwd) == _pfid_set(rev)
        assert ({p["properties"]["provider_source_feature_id"] for p in _centerlines(fwd)}
                == {p["properties"]["provider_source_feature_id"] for p in _centerlines(rev)})
        # The FINAL packaged bytes (pairing applies canonical orientation) are identical.
        a, _ = pairing.build_selection_features(fwd, pairing.PairingParams())
        b, _ = pairing.build_selection_features(rev, pairing.PairingParams())
        assert json.dumps(a, sort_keys=True, separators=(",", ":")) == json.dumps(b, sort_keys=True, separators=(",", ":"))

    def test_clipping_that_yields_the_same_final_part_twice_emits_once(self):
        """Case 3: two multipart members that CLIP to the same final part (one forward, one
        reversed) collapse to a single packaged LineString."""
        part = _id_component(0, 0)
        f = _caltrans_mls(2, "SHS_050._P", 1, [part, list(reversed(part))])
        parts = _centerlines(_emit_caltrans([f]))
        assert len(parts) == 1
        emitted, _ = pairing.build_selection_features(_emit_caltrans([f]), pairing.PairingParams())
        _assert_globally_unique_ids(emitted)

    def test_direct_duplicate_to_build_selection_features_raises(self):
        """Case 4: two identical candidates handed straight to build_selection_features."""
        one = _centerlines(_emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22)])]))[0]
        dup = json.loads(json.dumps([one, one]))
        with pytest.raises(pairing.DuplicateSourceIdentityError):
            pairing.build_selection_features(dup, pairing.PairingParams())

    def test_direct_duplicate_to_pair_corridors_raises(self):
        """Case 5: the same duplicate handed straight to pair_corridors()."""
        one = _centerlines(_emit_caltrans([_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22)])]))[0]
        dup = json.loads(json.dumps([one, one]))
        with pytest.raises(pairing.DuplicateSourceIdentityError):
            pairing.pair_corridors(dup, pairing.PairingParams())

    def test_same_id_different_geometry_still_fails_closed(self):
        """Case 6: one identity mapping to different geometries fails closed at BOTH the
        packaging boundary and the pairing preflight."""
        parts = _centerlines(_emit_caltrans(
            [_caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])]))
        collide = json.loads(json.dumps(parts))
        collide[1]["properties"]["provider_feature_id"] = collide[0]["properties"]["provider_feature_id"]
        with pytest.raises(pairing.DuplicateSourceIdentityError, match="different geometry"):
            pairing.assert_unique_candidate_identities(collide)

    def test_packaging_boundary_raises_on_a_true_identity_collision(self, monkeypatch):
        """A generated part identity seen with two DIFFERENT geometries is a real collision:
        raise rather than silently drop either geometry."""
        monkeypatch.setattr(ctxmod, "packaged_part_provider_feature_id", lambda *a, **k: "part:COLLIDE")
        f = _caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])
        with pytest.raises(ctxmod.RoadIdentityCollisionError, match="two different geometries"):
            _emit_caltrans([f])

    def test_distinct_source_ids_with_identical_geometry_are_kept(self):
        """Case 7: geometry-only dedupe must NOT happen — two different route events sharing
        an alignment remain two distinct candidates."""
        geom = _id_component(0, 0)
        fa = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": geom},
              "properties": {"OBJECTID": 1, "RouteID": "SHS_050._P", "F_System": 1}}
        fb = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": geom},
              "properties": {"OBJECTID": 2, "RouteID": "SHS_099._P", "F_System": 1}}
        parts = _centerlines(_emit_caltrans([fa, fb]))
        assert len(parts) == 2, "different source identities must not be geometry-deduped"
        assert len(_pfid_set(parts)) == 2
        assert len({p["properties"]["provider_source_feature_id"] for p in parts}) == 2

    def test_two_independent_corridors_still_have_globally_unique_ids(self):
        """Case 8: the accepted two-corridor scenario keeps every invariant."""
        a = _caltrans_mls(1, "SHS_050._P", 1, [_id_component(0, 22), _id_component(4000, 22)])
        b = _caltrans_mls(2, "SHS_050._S", 1, [_id_component(0, -22), _id_component(4000, -22)])
        emitted, stats = pairing.build_selection_features(_emit_caltrans([a, b]), pairing.PairingParams())
        assert stats["divided_corridor_count"] == 2
        _assert_globally_unique_ids(emitted)

    def test_output_level_assertion_rejects_duplicate_emitted_ids(self):
        """The final backstop rejects a collection with duplicate emitted feature_ids."""
        f = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": _id_component(0, 0)},
             "properties": {"feature_id": "p-same", "kind": "road_centerline"}}
        with pytest.raises(pairing.DuplicateSourceIdentityError, match="not unique"):
            pairing.assert_unique_emitted_feature_ids([f, json.loads(json.dumps(f))])
        # An empty/absent feature_id is not a duplicate.
        pairing.assert_unique_emitted_feature_ids([{"properties": {}}, {"properties": {"feature_id": ""}}])

    def test_caltrans_response_level_dedupe_still_intact(self):
        """Case 9: the fetch-level dedupe (by durable identity) is unchanged."""
        a = gj_feat(1, "SHS_050._P", 1, IN_A)
        s = PagingSession([a, gj_feat(2, "SHS_099._P", 2, IN_B), json.loads(json.dumps(a))])
        out = _fetch(s, page_size=1000)
        assert sorted(f["properties"]["provider_object_id"] for f in out) == [1, 2]

    def test_eris_internal_context_is_untouched_by_part_dedupe(self):
        """Case 10: internal context carries no provider identity, so the dedupe never
        applies to it and bearing/inventory geometry is packaged as before."""
        ctx = {"bounds": _ID_BOUNDS, "external_road_features": [],
               "road_inventory_geometry": {"type": "LineString", "coordinates": _id_component(0, 0)},
               "overlays": {"incident": {"lat": _ID_LAT0, "lon": _ID_LON0}, "roadBearingDeg": 90.0}}
        gj, count, _reason = ctxmod.roads_geojson_from_context(ctx, 250.0, external_configured=False)
        kinds = {f["properties"].get("kind") for f in gj["features"]}
        assert count >= 2 and {"road_inventory", "road_bearing"} <= kinds
        assert all("provider_feature_id" not in f["properties"] for f in gj["features"])
