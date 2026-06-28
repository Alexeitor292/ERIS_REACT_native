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
        assert osvc.clamp_radius_m(10) == osvc.MIN_RADIUS_M
        assert osvc.clamp_radius_m(999999) == osvc.MAX_RADIUS_M  # never statewide
        assert osvc.clamp_radius_m(1500) == 1500.0

    def test_bounding_box_centered(self):
        b = osvc.bounding_box(38.5, -121.5, 1500.0)
        assert b["min_lat"] < 38.5 < b["max_lat"]
        assert b["min_lon"] < -121.5 < b["max_lon"]

    def test_validate_bounds(self):
        assert osvc.validate_bounds(38.4, -121.6, 38.6, -121.4) is True
        assert osvc.validate_bounds(38.6, -121.6, 38.4, -121.4) is False  # min>=max lat
        assert osvc.validate_bounds(38.4, -121.4, 38.6, -121.6) is False  # min>=max lon
        assert osvc.validate_bounds(200, 0, 201, 1) is False  # out of range
        assert osvc.validate_bounds("x", 0, 1, 1) is False


class TestObjectKey:
    def test_immutable_versioned_key(self):
        # Default format is the auto-generated ERIS terrain bundle.
        assert osvc.make_scene_object_key(42, "v2026-06-27a") == "submissions/42/v2026-06-27a/scene.eristerrain"
        assert osvc.make_scene_object_key(42, "v1", "mspk") == "submissions/42/v1/scene.mspk"
        # sanitizes unsafe chars
        assert osvc.make_scene_object_key(7, "a/b c", "eristerrain") == "submissions/7/abc/scene.eristerrain"


class TestContentSignature:
    def test_signature_stable_and_sensitive(self):
        base = dict(gisa_updated_at="2026-06-26T00:00:00", geometry_json={"type": "Point", "coordinates": [1, 2]}, road_bearing_deg=90.0, radius_m=1500.0)
        assert osvc.content_signature(**base) == osvc.content_signature(**base)
        changed = dict(base); changed["road_bearing_deg"] = 91.0
        assert osvc.content_signature(**changed) != osvc.content_signature(**base)


def _catalog(**overrides) -> dict:
    base = {
        "package_version": "v1",
        "size_bytes": 123456,
        "sha256": "a" * 64,
        "min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48,
        "center_lat": 38.5, "center_lon": -121.5, "radius_m": 1500.0,
        "elevation_source": "USGS_3DEP",
        "elevation_dataset": "3DEP 1m DEM", "elevation_version": "2024", "elevation_resolution": "1m",
        "basemap_or_imagery_source": "Caltrans enterprise imagery",
        "content_signature": "sig123",
        "created_at": "2026-06-27T00:00:00", "uploaded_at": "2026-06-27T01:00:00",
    }
    base.update(overrides)
    return base


class TestDescriptorFromCatalog:
    def test_no_catalog_record_unavailable(self):
        d = osvc.descriptor_from_catalog(submission_id=5, catalog=None, object_present=False, download_path=None)
        assert d["available"] is False
        assert "prepared" in d["reason"].lower()
        assert d["area"] is None and d["package"] is None

    def test_catalog_but_missing_object_unavailable(self):
        d = osvc.descriptor_from_catalog(submission_id=5, catalog=_catalog(), object_present=False, download_path=None)
        assert d["available"] is False
        assert "missing" in d["reason"].lower()

    def test_valid_record_and_object_available_with_real_metadata(self):
        d = osvc.descriptor_from_catalog(
            submission_id=5, catalog=_catalog(), object_present=True,
            download_path="/submissions/5/gisa/offline-scene-package/download",
        )
        assert d["available"] is True and d["reason"] is None
        # Real catalog values, not estimates / base URL.
        assert d["package"]["version"] == "v1"
        assert d["package"]["size_bytes"] == 123456
        assert d["package"]["sha256"] == "a" * 64
        assert d["package"]["elevation_source"] == "USGS_3DEP"
        assert d["package"]["elevation"]["resolution"] == "1m"
        assert d["package"]["basemap_or_imagery_source"] == "Caltrans enterprise imagery"
        assert d["package"]["download_path"] == "/submissions/5/gisa/offline-scene-package/download"
        assert d["area"]["radius_m"] == 1500.0
        assert d["area"]["bounds"]["min_lat"] == 38.48
        assert d["content_signature"] == "sig123"
        # No raw MinIO URL is exposed in the descriptor.
        assert "http" not in str(d["package"].get("download_path"))
