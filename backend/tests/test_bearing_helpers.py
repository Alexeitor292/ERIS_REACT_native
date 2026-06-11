"""
Unit tests for road bearing helper functions in app.main.
No database required — marked with no pytestmark so they run in both the
smoke (-m "not db") and DB (-m db) suites.
"""

from __future__ import annotations

import math

from app.main import _initial_bearing_deg, _derive_road_bearing_from_postmile_layer


class TestInitialBearingDeg:
    def test_bearing_east(self):
        # (0,0) → (0,1): due East, ~90°
        b = _initial_bearing_deg(0.0, 0.0, 0.0, 1.0)
        assert abs(b - 90.0) < 0.5

    def test_bearing_north(self):
        # (0,0) → (1,0): due North, ~0°
        b = _initial_bearing_deg(0.0, 0.0, 1.0, 0.0)
        assert abs(b - 0.0) < 0.5 or abs(b - 360.0) < 0.5

    def test_bearing_west(self):
        # (0,0) → (0,-1): due West, ~270°
        b = _initial_bearing_deg(0.0, 0.0, 0.0, -1.0)
        assert abs(b - 270.0) < 0.5

    def test_bearing_south(self):
        # (0,0) → (-1,0): due South, ~180°
        b = _initial_bearing_deg(0.0, 0.0, -1.0, 0.0)
        assert abs(b - 180.0) < 0.5

    def test_bearing_northeast(self):
        # Should be between 0° and 90°
        b = _initial_bearing_deg(0.0, 0.0, 1.0, 1.0)
        assert 0.0 < b < 90.0

    def test_result_in_range(self):
        # All results must be in [0, 360)
        test_pairs = [
            (0.0, 0.0, 1.0, 1.0),
            (37.7, -122.4, 37.8, -122.3),
            (37.8, -122.3, 37.7, -122.4),
            (-33.9, 151.2, -34.0, 151.3),
        ]
        for lat1, lon1, lat2, lon2 in test_pairs:
            b = _initial_bearing_deg(lat1, lon1, lat2, lon2)
            assert 0.0 <= b < 360.0, f"Out of range for ({lat1},{lon1})→({lat2},{lon2}): {b}"


class TestDeriveRoadBearingFromPostmileLayer:
    def test_returns_none_when_url_not_configured(self, monkeypatch):
        from app import main
        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", None)
        result = _derive_road_bearing_from_postmile_layer(37.7, -122.4, "80", "Alameda", 5.0)
        assert result is None

    def test_returns_none_when_route_missing(self, monkeypatch):
        from app import main
        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        result = _derive_road_bearing_from_postmile_layer(37.7, -122.4, None, "Alameda", 5.0)
        assert result is None

    def test_returns_none_when_county_missing(self, monkeypatch):
        from app import main
        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        result = _derive_road_bearing_from_postmile_layer(37.7, -122.4, "80", None, 5.0)
        assert result is None

    def test_returns_none_when_postmile_missing(self, monkeypatch):
        from app import main
        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        result = _derive_road_bearing_from_postmile_layer(37.7, -122.4, "80", "Alameda", None)
        assert result is None

    def test_east_bearing_from_lower_west_higher_east(self, monkeypatch):
        """Lower PM is west, higher PM is east → bearing should be ~90° (East)."""
        import unittest.mock as mock
        from app import main

        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        monkeypatch.setattr(main.settings, "POSTMILE_ROUTE_FIELD", "ROUTE")
        monkeypatch.setattr(main.settings, "POSTMILE_PM_FIELD", "PM")
        monkeypatch.setattr(main.settings, "POSTMILE_COUNTY_FIELD", "COUNTY")
        monkeypatch.setattr(main.settings, "POSTMILE_DISTRICT_FIELD", "DISTRICT")
        monkeypatch.setattr(main.settings, "POSTMILE_WHERE", "1=1")
        monkeypatch.setattr(main.settings, "POSTMILE_SEARCH_DISTANCE_METERS", 120)

        # Lower PM at same lat, 0.01° west; higher PM at same lat, 0.01° east
        fake_response = {
            "features": [
                {
                    "attributes": {"ROUTE": "80", "PM": 4.5, "COUNTY": "Alameda", "DISTRICT": "04"},
                    "geometry": {"x": -122.41, "y": 37.7},  # west (lower PM)
                },
                {
                    "attributes": {"ROUTE": "80", "PM": 5.5, "COUNTY": "Alameda", "DISTRICT": "04"},
                    "geometry": {"x": -122.39, "y": 37.7},  # east (higher PM)
                },
            ]
        }

        with mock.patch("app.main._safe_json_get", return_value=fake_response):
            result = _derive_road_bearing_from_postmile_layer(
                37.7, -122.4, "80", "Alameda", 5.0, district="04"
            )

        assert result is not None
        assert abs(result - 90.0) < 5.0, f"Expected ~90°, got {result}"

    def test_north_bearing_from_lower_south_higher_north(self, monkeypatch):
        """Lower PM is south, higher PM is north → bearing should be ~0° (North)."""
        import unittest.mock as mock
        from app import main

        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        monkeypatch.setattr(main.settings, "POSTMILE_ROUTE_FIELD", "ROUTE")
        monkeypatch.setattr(main.settings, "POSTMILE_PM_FIELD", "PM")
        monkeypatch.setattr(main.settings, "POSTMILE_COUNTY_FIELD", "COUNTY")
        monkeypatch.setattr(main.settings, "POSTMILE_DISTRICT_FIELD", "DISTRICT")
        monkeypatch.setattr(main.settings, "POSTMILE_WHERE", "1=1")
        monkeypatch.setattr(main.settings, "POSTMILE_SEARCH_DISTANCE_METERS", 120)

        fake_response = {
            "features": [
                {
                    "attributes": {"ROUTE": "101", "PM": 4.5, "COUNTY": "Marin", "DISTRICT": "04"},
                    "geometry": {"x": -122.4, "y": 37.69},  # south (lower PM)
                },
                {
                    "attributes": {"ROUTE": "101", "PM": 5.5, "COUNTY": "Marin", "DISTRICT": "04"},
                    "geometry": {"x": -122.4, "y": 37.71},  # north (higher PM)
                },
            ]
        }

        with mock.patch("app.main._safe_json_get", return_value=fake_response):
            result = _derive_road_bearing_from_postmile_layer(
                37.7, -122.4, "101", "Marin", 5.0, district="04"
            )

        assert result is not None
        b = result if result <= 180 else result - 360
        assert abs(b) < 5.0, f"Expected ~0° (or ~360°), got {result}"

    def test_returns_none_with_only_one_candidate(self, monkeypatch):
        """Fewer than two valid geometry points → None."""
        import unittest.mock as mock
        from app import main

        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        monkeypatch.setattr(main.settings, "POSTMILE_ROUTE_FIELD", "ROUTE")
        monkeypatch.setattr(main.settings, "POSTMILE_PM_FIELD", "PM")
        monkeypatch.setattr(main.settings, "POSTMILE_COUNTY_FIELD", "COUNTY")
        monkeypatch.setattr(main.settings, "POSTMILE_DISTRICT_FIELD", "DISTRICT")
        monkeypatch.setattr(main.settings, "POSTMILE_WHERE", "1=1")
        monkeypatch.setattr(main.settings, "POSTMILE_SEARCH_DISTANCE_METERS", 120)

        fake_response = {
            "features": [
                {
                    "attributes": {"ROUTE": "80", "PM": 5.0, "COUNTY": "Alameda", "DISTRICT": "04"},
                    "geometry": {"x": -122.4, "y": 37.7},
                },
            ]
        }

        with mock.patch("app.main._safe_json_get", return_value=fake_response):
            result = _derive_road_bearing_from_postmile_layer(
                37.7, -122.4, "80", "Alameda", 5.0
            )

        assert result is None

    def test_returns_none_when_arcgis_unavailable(self, monkeypatch):
        """Network failure (_safe_json_get returns None) → None, no exception raised."""
        import unittest.mock as mock
        from app import main

        monkeypatch.setattr(main.settings, "POSTMILE_FEATURE_LAYER_URL", "https://example.com/layer")
        monkeypatch.setattr(main.settings, "POSTMILE_ROUTE_FIELD", "ROUTE")
        monkeypatch.setattr(main.settings, "POSTMILE_PM_FIELD", "PM")
        monkeypatch.setattr(main.settings, "POSTMILE_COUNTY_FIELD", "COUNTY")
        monkeypatch.setattr(main.settings, "POSTMILE_DISTRICT_FIELD", "DISTRICT")
        monkeypatch.setattr(main.settings, "POSTMILE_WHERE", "1=1")
        monkeypatch.setattr(main.settings, "POSTMILE_SEARCH_DISTANCE_METERS", 120)

        with mock.patch("app.main._safe_json_get", return_value=None):
            result = _derive_road_bearing_from_postmile_layer(
                37.7, -122.4, "80", "Alameda", 5.0
            )

        assert result is None
