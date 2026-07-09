"""Tests for truthful road-context packaging (fix: offline-cross-section-road-context).

Covers: precise roads-unavailable reasons; road-cross-section usability flags; DEFAULT
provenance never reading as Road Inventory; AOI-spanning bearing line; submitted line-
like geometry; and the ArcGIS FeatureServer centerline adapter (Esri paths + GeoJSON +
sanitized service URL, no secret leaks).
"""

from __future__ import annotations

import json

from app.config import settings
from app.services import offline_scene_context as ctxmod
from app.services.offline_scene_builder import HillshadeReliefBuilder
from app.services.road_cross_section_build import build_road_cross_section

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
INCIDENT = {"lat": 38.5, "lon": -121.5}


def _ctx(*, bearing=None, snapshot=None, geometry=None, road_inv_geom=None):
    return {
        "submission_id": 15,
        "package_version": "gtest-1",
        "center": INCIDENT,
        "radius_m": 1500.0,
        "bounds": BOUNDS,
        "content_signature": "sig",
        "road_inventory_geometry": road_inv_geom,
        "road_cross_section": {"attributes": build_road_cross_section(snapshot, None), "snapshot": snapshot},
        "overlays": {"incident": INCIDENT, "roadBearingDeg": bearing, "geometry": geometry, "sampleExtent": None},
    }


class TestRoadsPreciseReasons:
    def test_no_inventory_no_bearing_gives_precise_reason_not_no_data(self):
        gj, count, reason = ctxmod.roads_geojson_from_context(_ctx(bearing=None), 250.0)
        assert count == 0
        assert reason == ctxmod.ROADS_REASON_NO_BEARING  # incident present, no bearing/inventory
        assert reason != "no_data"

    def test_external_configured_but_empty_reason(self):
        gj, count, reason = ctxmod.roads_geojson_from_context(_ctx(bearing=None), 250.0, external_configured=True)
        assert count == 0 and reason == ctxmod.ROADS_REASON_NO_FEATURES

    def test_incident_bearing_packages_aoi_spanning_road_bearing(self):
        gj, count, reason = ctxmod.roads_geojson_from_context(_ctx(bearing=45.0), 250.0)
        assert count == 1 and reason is None
        f = gj["features"][0]
        assert f["properties"]["kind"] == "road_bearing"

    def test_submitted_line_geometry_packaged_but_not_polygons(self):
        line = {"type": "LineString", "coordinates": [[-121.5, 38.5], [-121.49, 38.49]]}
        poly = {"type": "Polygon", "coordinates": [[[-121.5, 38.5], [-121.49, 38.5], [-121.49, 38.49], [-121.5, 38.5]]]}
        gj, count, _ = ctxmod.roads_geojson_from_context(_ctx(bearing=None, geometry=line), 250.0)
        kinds = {f["properties"]["kind"] for f in gj["features"]}
        assert "submitted_road_geometry" in kinds
        # A polygon submission must NOT be turned into a road.
        gj2, count2, _ = ctxmod.roads_geojson_from_context(_ctx(bearing=None, geometry=poly), 250.0)
        assert count2 == 0

    def test_road_inventory_geometry_carries_metadata(self):
        snap = {"left_lanes": 2, "right_lanes": 2, "median_type": "R", "median_width": 22, "route_name": "SR-17", "begin_pm": 5, "end_pm": 6}
        inv = {"type": "LineString", "coordinates": [[-121.5, 38.5], [-121.49, 38.505]]}
        gj, count, _ = ctxmod.roads_geojson_from_context(_ctx(bearing=None, snapshot=snap, road_inv_geom=inv), 250.0)
        f = next(f for f in gj["features"] if f["properties"]["kind"] == "road_inventory")
        assert f["properties"]["route_name"] == "SR-17" and f["properties"]["begin_pm"] == 5


class TestRoadCrossSectionUsability:
    def test_layout_but_no_snap_no_bearing_not_fully_usable(self):
        u = ctxmod.road_cross_section_usability(
            layout_available=True, layout_source="DEFAULT", snap_available=False, orientation_available=False
        )
        assert u["layout_available"] is True and u["snap_available"] is False
        assert u["orientation_available"] is False and u["fully_usable"] is False
        assert u["reason"] == "no_road_snap_geometry"

    def test_snap_available_is_usable(self):
        u = ctxmod.road_cross_section_usability(
            layout_available=True, layout_source="ROAD_INVENTORY", snap_available=True, orientation_available=True
        )
        assert u["fully_usable"] is True and u["reason"] is None

    def test_default_layout_only_flag_when_usable_but_default(self):
        u = ctxmod.road_cross_section_usability(
            layout_available=True, layout_source="DEFAULT", snap_available=True, orientation_available=True
        )
        assert u["fully_usable"] is True and u["reason"] == "default_layout_only"

    def test_default_provenance_is_not_road_inventory(self):
        assert ctxmod.layout_source_label("DEFAULT") == "Default roadway assumptions"
        assert ctxmod.layout_source_label("ROAD_INVENTORY") == "ERIS Road Inventory"
        assert ctxmod.layout_source_label("FORM_FIELDS") == "Submission/form fields"
        block = ctxmod.road_cross_section_block(_ctx(bearing=None, snapshot=None))  # DEFAULT layout
        assert block["source"] == "DEFAULT"
        assert block["provenance"]["layoutSourceLabel"] == "Default roadway assumptions"
        assert "Road Inventory" not in block["provenance"]["note"] or "not measured" in block["provenance"]["note"]


class TestBuilderRoadContext:
    def _b(self):
        return HillshadeReliefBuilder()

    def _no_road_settings(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "eris_internal")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)

    def test_confirmed_blocker_roads_unavailable_precise_reason_and_not_fully_usable(self, monkeypatch):
        # The exact Proxmox case: DEFAULT layout, no bearing, no geometry.
        self._no_road_settings(monkeypatch)
        layers, assets = self._b()._build_context_layers(_ctx(bearing=None, snapshot=None), base_bytes=0)
        assert layers["roads"]["available"] is False
        assert layers["roads"]["reason"] in (ctxmod.ROADS_REASON_NO_BEARING, ctxmod.ROADS_REASON_NO_INVENTORY)
        rxs = layers["road_cross_section"]
        assert rxs["available"] is True
        assert rxs["layout_available"] is True and rxs["snap_available"] is False
        assert rxs["orientation_available"] is False and rxs["fully_usable"] is False
        assert rxs["reason"] == "no_road_snap_geometry"
        assert rxs["layout_source"] == "DEFAULT"
        # provenance/attribution must NOT claim Road Inventory for a DEFAULT layout
        assert "SECRET" not in json.dumps(rxs)
        assert rxs["source"]["attribution"] == "Default roadway assumptions"

    def test_bearing_present_makes_cross_section_fully_usable(self, monkeypatch):
        self._no_road_settings(monkeypatch)
        layers, assets = self._b()._build_context_layers(_ctx(bearing=42.0, snapshot=None), base_bytes=0)
        assert layers["roads"]["available"] is True  # AOI-spanning bearing line packaged
        rxs = layers["road_cross_section"]
        assert rxs["snap_available"] is True and rxs["orientation_available"] is True
        assert rxs["fully_usable"] is True


class TestArcgisCenterlineAdapter:
    def test_normalizes_geojson_and_esri_paths(self):
        feats = [
            {"geometry": {"type": "LineString", "coordinates": [[-121.5, 38.5], [-121.49, 38.5]]}},
            {"geometry": {"paths": [[[-121.5, 38.51], [-121.49, 38.51]]]}},  # Esri polyline
            {"geometry": {"type": "Point", "coordinates": [-121.5, 38.5]}},  # dropped (not a line)
        ]
        out = ctxmod.normalize_road_features(feats)
        assert len(out) == 2
        assert all(f["properties"]["kind"] == "road_centerline" for f in out)
        assert out[1]["geometry"]["type"] == "LineString"  # paths -> GeoJSON

    def test_external_centerlines_clipped_and_packaged_via_context(self):
        ext = ctxmod.normalize_road_features([{"geometry": {"type": "LineString", "coordinates": [[-121.5, 38.5], [-121.49, 38.505]]}}])
        ctx = {**_ctx(bearing=None), "external_road_features": ext}
        gj, count, reason = ctxmod.roads_geojson_from_context(ctx, 250.0, external_configured=True)
        assert count >= 1 and reason is None
        assert any(f["properties"]["kind"] == "road_centerline" for f in gj["features"])

    def test_service_url_sanitized_no_token_leak(self):
        src = {"provider": "arcgis_feature_service", "service": "https://gis.example.gov/FeatureServer/3?token=SECRET&f=json"}
        meta = ctxmod.available_layer(ctxmod.ROADS_FILE, b"{}", src, feature_count=2, road_kinds=["road_centerline"])
        assert "SECRET" not in json.dumps(meta)
        assert meta["source"]["service"] == "https://gis.example.gov/FeatureServer/3"

    def test_service_url_strips_embedded_basic_auth_credentials(self):
        # Review finding: userinfo (user:password@host) must be dropped from the manifest.
        src = {"provider": "arcgis_feature_service", "service": "https://svc_user:S3CRET@gis.example.gov:8443/arcgis/rest/services/Roads/FeatureServer/0?token=ABC"}
        out = ctxmod.sanitize_source(src)
        assert "S3CRET" not in json.dumps(out) and "svc_user" not in json.dumps(out) and "ABC" not in json.dumps(out)
        assert out["service"] == "https://gis.example.gov:8443/arcgis/rest/services/Roads/FeatureServer/0"


class TestRoadsProvenanceReflectsActualKind:
    """Review finding: provenance must reflect the ACTUAL packaged kind, never claim
    ArcGIS centerlines (or attach the service URL) for a synthetic bearing fallback."""

    def _b(self):
        return HillshadeReliefBuilder()

    def test_external_configured_but_only_bearing_packaged_is_not_labeled_arcgis(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "arcgis_feature_service")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE_URL", "https://gis.example.gov/FeatureServer/0")
        # Adapter returns NOTHING for this AOI; the incident still has a bearing.
        monkeypatch.setattr(ctxmod, "fetch_arcgis_road_features", lambda *a, **k: [])
        layers, assets = self._b()._build_context_layers(_ctx(bearing=42.0), base_bytes=0)
        roads = layers["roads"]
        assert roads["available"] is True and roads["road_kinds"] == ["road_bearing"]
        # provenance must NOT claim ArcGIS centerlines and must NOT include the service URL
        assert roads["source"]["provider"] == "eris_internal"
        assert roads["source"]["dataset"] != "ArcGIS road centerlines"
        assert "service" not in roads["source"]

    def test_external_centerline_present_is_labeled_arcgis_with_sanitized_service(self, monkeypatch):
        monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE", "arcgis_feature_service")
        monkeypatch.setattr(settings, "OFFLINE_SCENE_ROAD_SOURCE_URL", "https://gis.example.gov/FeatureServer/0?token=SECRET")
        monkeypatch.setattr(
            ctxmod, "fetch_arcgis_road_features",
            lambda *a, **k: ctxmod.normalize_road_features([{"geometry": {"type": "LineString", "coordinates": [[-121.5, 38.5], [-121.49, 38.505]]}}]),
        )
        layers, assets = self._b()._build_context_layers(_ctx(bearing=None), base_bytes=0)
        roads = layers["roads"]
        assert "road_centerline" in roads["road_kinds"]
        assert roads["source"]["provider"] == "arcgis_feature_service"
        assert roads["source"]["service"] == "https://gis.example.gov/FeatureServer/0"  # token stripped
        assert "SECRET" not in json.dumps(roads)
