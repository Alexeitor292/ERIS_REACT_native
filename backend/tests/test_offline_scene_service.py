"""
Pure unit tests for app.services.offline_scene (no DB / no network).
Run in the no-DB job: pytest -m "not db" tests/test_offline_scene_service.py
"""

from __future__ import annotations

import pytest

from app.services import offline_scene as osvc


class TestRadiusAndBounds:
    def test_radius_clamped_and_default(self):
        assert osvc.clamp_radius_m(None) == osvc.DEFAULT_RADIUS_M
        assert osvc.clamp_radius_m(10) == osvc.MIN_RADIUS_M  # below min
        assert osvc.clamp_radius_m(999999) == osvc.MAX_RADIUS_M  # above max -> not statewide
        assert osvc.clamp_radius_m(1500) == 1500.0
        assert osvc.clamp_radius_m(float("nan")) == osvc.DEFAULT_RADIUS_M

    def test_bounding_box_centered_and_ordered(self):
        b = osvc.bounding_box(38.5, -121.5, 1500.0)
        assert b["min_lat"] < 38.5 < b["max_lat"]
        assert b["min_lon"] < -121.5 < b["max_lon"]
        # roughly symmetric in latitude (~0.0135 deg for 1500 m)
        assert abs((38.5 - b["min_lat"]) - (b["max_lat"] - 38.5)) < 1e-6

    def test_size_estimate_grows_with_radius(self):
        small = osvc.estimate_package_size_mb(500.0)
        big = osvc.estimate_package_size_mb(4000.0)
        assert big > small > 0


class TestContentSignature:
    def test_signature_stable_and_sensitive(self):
        base = dict(gisa_updated_at="2026-06-26T00:00:00", geometry_json={"type": "Point", "coordinates": [1, 2]}, road_bearing_deg=90.0, radius_m=1500.0)
        a = osvc.content_signature(**base)
        b = osvc.content_signature(**base)
        assert a == b  # stable for equal inputs
        # geometry change -> different signature (drives refresh)
        changed = dict(base)
        changed["geometry_json"] = {"type": "Point", "coordinates": [9, 9]}
        assert osvc.content_signature(**changed) != a
        # bearing change -> different signature
        changed2 = dict(base)
        changed2["road_bearing_deg"] = 91.0
        assert osvc.content_signature(**changed2) != a


class TestDescriptor:
    def test_no_coordinates_unavailable(self):
        d = osvc.build_scene_area_descriptor(
            submission_id=5, lat=None, lon=None, radius_m=None,
            gisa_updated_at=None, geometry_json=None, road_bearing_deg=None,
            package_base_url="https://pkg.example.gov",
        )
        assert d["available"] is False
        assert "coordinates" in d["reason"].lower()
        assert d["area"] is None and d["package"] is None

    def test_no_host_configured_unavailable_with_reason(self):
        d = osvc.build_scene_area_descriptor(
            submission_id=5, lat=38.5, lon=-121.5, radius_m=1500.0,
            gisa_updated_at="2026-06-26T00:00:00", geometry_json=None, road_bearing_deg=90.0,
            package_base_url=None,
        )
        assert d["available"] is False
        assert "host" in d["reason"].lower() or "ARCGIS_SCENE_PACKAGE_BASE_URL" in d["reason"]
        # Still returns bounds + size estimate so the UI can show the scope.
        assert d["area"]["radius_m"] == 1500.0
        assert d["package"]["estimated_size_mb"] > 0
        assert d["package"]["download_url"] is None

    def test_host_configured_builds_download_url_with_signature(self):
        d = osvc.build_scene_area_descriptor(
            submission_id=42, lat=38.5, lon=-121.5, radius_m=1500.0,
            gisa_updated_at="2026-06-26T00:00:00", geometry_json=None, road_bearing_deg=90.0,
            package_base_url="https://pkg.example.gov/",
        )
        assert d["available"] is True
        assert d["reason"] is None
        assert d["package"]["format"] == "mspk"
        assert d["package"]["download_url"].startswith("https://pkg.example.gov/submissions/42/scene.mspk?sig=")
        assert d["content_signature"] in d["package"]["download_url"]
        assert d["package"]["version"] == d["content_signature"]

    def test_radius_is_bounded_not_statewide(self):
        d = osvc.build_scene_area_descriptor(
            submission_id=1, lat=38.5, lon=-121.5, radius_m=10_000_000,  # absurd
            gisa_updated_at=None, geometry_json=None, road_bearing_deg=None,
            package_base_url="https://pkg.example.gov",
        )
        assert d["area"]["radius_m"] == osvc.MAX_RADIUS_M
