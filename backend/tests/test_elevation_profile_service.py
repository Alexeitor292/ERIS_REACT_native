"""
Pure unit tests for app.services.elevation_profile.

No database, no MinIO, no network — `_fetch_elevation_ft` is mocked so these run
in the no-DB CI job. The companion tests in test_elevation_profile.py cover the
DB-backed endpoint and are marked `db`.
"""

from __future__ import annotations

from unittest.mock import patch

from app.services import elevation_profile as ep


# ---------------------------------------------------------------------------
# _classify
# ---------------------------------------------------------------------------

def _pts(pairs: list[tuple[float, float | None]]) -> list[dict]:
    return [{"offset_m": o, "elevation_ft": e} for o, e in pairs]


class TestClassify:
    def test_flat(self):
        cls, conf, reason = ep._classify(_pts([(-20, 100.0), (0, 100.0), (20, 100.0)]))
        assert cls == "FLAT"
        assert conf is not None and 0.0 <= conf <= 1.0
        assert reason == "CLASSIFIED"

    def test_left_high(self):
        # left well above center, right well below center
        cls, _, reason = ep._classify(_pts([(-20, 130.0), (0, 100.0), (20, 70.0)]))
        assert cls == "LEFT_HIGH"
        assert reason == "CLASSIFIED"

    def test_right_high(self):
        cls, _, _ = ep._classify(_pts([(-20, 70.0), (0, 100.0), (20, 130.0)]))
        assert cls == "RIGHT_HIGH"

    def test_bowl_both_sides_high(self):
        cls, _, _ = ep._classify(_pts([(-20, 130.0), (0, 100.0), (20, 130.0)]))
        assert cls == "BOWL"

    def test_crown_both_sides_low(self):
        cls, _, _ = ep._classify(_pts([(-20, 70.0), (0, 100.0), (20, 70.0)]))
        assert cls == "CROWN"

    def test_insufficient_when_a_side_missing(self):
        # no right-side points -> not enough valid samples, not a real failure
        cls, conf, reason = ep._classify(_pts([(-20, 130.0), (0, 100.0)]))
        assert cls == "UNKNOWN"
        assert conf is None
        assert reason == "INSUFFICIENT_VALID_SAMPLES"

    def test_insufficient_when_elevations_none(self):
        cls, conf, reason = ep._classify(_pts([(-20, None), (0, None), (20, None)]))
        assert cls == "UNKNOWN"
        assert conf is None
        assert reason == "INSUFFICIENT_VALID_SAMPLES"

    def test_ambiguous_when_one_side_high_other_flat(self):
        # Left clearly high, right ~level with center: a real but mixed shape that
        # does not fit a single canonical class -> honestly AMBIGUOUS_TERRAIN.
        cls, conf, reason = ep._classify(_pts([(-20, 130.0), (0, 100.0), (20, 101.0)]))
        assert cls == "UNKNOWN"
        assert conf is None
        assert reason == "AMBIGUOUS_TERRAIN"


# ---------------------------------------------------------------------------
# _offset_point
# ---------------------------------------------------------------------------

class TestOffsetPoint:
    def test_east_increases_lon(self):
        lat0, lon0 = 37.0, -122.0
        lat1, lon1 = ep._offset_point(lat0, lon0, bearing_deg=90.0, distance_m=100.0)
        assert lon1 > lon0
        assert abs(lat1 - lat0) < 1e-3  # due east keeps latitude ~constant

    def test_north_increases_lat(self):
        lat0, lon0 = 37.0, -122.0
        lat1, lon1 = ep._offset_point(lat0, lon0, bearing_deg=0.0, distance_m=100.0)
        assert lat1 > lat0
        assert abs(lon1 - lon0) < 1e-6

    def test_distance_is_reasonable(self):
        # 100 m north ≈ 0.0009 deg latitude
        lat1, _ = ep._offset_point(37.0, -122.0, bearing_deg=0.0, distance_m=100.0)
        assert abs((lat1 - 37.0) - 0.0009) < 0.0002


# ---------------------------------------------------------------------------
# fetch_elevation_profile
# ---------------------------------------------------------------------------

class TestFetchElevationProfile:
    def test_with_bearing_samples_full_cross_section(self):
        with patch.object(ep, "_fetch_elevation_ft", return_value=100.0):
            result = ep.fetch_elevation_profile(
                37.0, -122.0, road_bearing_deg=90.0, half_width_m=60.0, spacing_m=10.0,
            )
        pts = result["profile"]["points"]
        # offsets -60..+60 step 10 => 13 points
        assert len(pts) == 13
        offsets = [p["offset_m"] for p in pts]
        assert offsets[0] == -60.0 and offsets[-1] == 60.0
        # every point carries the data the renderer needs
        for p in pts:
            assert "offset_m" in p and "elevation_ft" in p and p["source"] == ep.EPQS_SOURCE
        assert result["source"] == ep.EPQS_SOURCE
        # flat terrain → FLAT
        assert result["classification"] == "FLAT"

    def test_point_count_respects_half_width_and_spacing(self):
        with patch.object(ep, "_fetch_elevation_ft", return_value=50.0):
            result = ep.fetch_elevation_profile(
                37.0, -122.0, road_bearing_deg=0.0, half_width_m=20.0, spacing_m=5.0,
            )
        # n_steps = 20/5 = 4 => 9 points (-20..+20 step 5)
        assert len(result["profile"]["points"]) == 9
        meta = result["profile"]["metadata"]
        assert meta["half_width_m"] == 20.0
        assert meta["spacing_m"] == 5.0
        assert meta["road_bearing_deg_used"] == 0.0
        assert meta["classification_requires_bearing"] is True

    def test_without_bearing_center_only_and_unknown(self):
        with patch.object(ep, "_fetch_elevation_ft", return_value=42.0):
            result = ep.fetch_elevation_profile(37.0, -122.0, road_bearing_deg=None)
        pts = result["profile"]["points"]
        assert len(pts) == 1
        assert pts[0]["offset_m"] == 0.0
        assert pts[0]["elevation_ft"] == 42.0
        assert result["classification"] == "UNKNOWN"
        # The avoidable "no bearing" case is explicitly diagnosed, not a failure.
        assert result["classification_reason"] == "ROAD_BEARING_UNAVAILABLE"
        meta = result["profile"]["metadata"]
        assert meta["road_bearing_deg_used"] is None
        assert meta["classification_reason"] == "ROAD_BEARING_UNAVAILABLE"
        assert "classification_note" in meta
        assert "Road bearing could not be resolved" in meta["classification_note"]

    def test_real_relief_classifies_from_points(self):
        # Left high, right low — classification is derived from the sampled points,
        # not from any external hint.
        # Road bearing 90 (east) => perpendicular-left bearing is 0 (north) and
        # perpendicular-right is 180 (south), so left samples have HIGHER latitude.
        # Make elevation rise with latitude so the left (north) side reads higher.
        def fake_elev(lat: float, lon: float) -> float:
            return 100.0 + (lat - 37.0) * 50000.0

        with patch.object(ep, "_fetch_elevation_ft", side_effect=fake_elev):
            result = ep.fetch_elevation_profile(
                37.0, -122.0, road_bearing_deg=90.0, half_width_m=60.0, spacing_m=20.0,
            )
        assert result["classification"] == "LEFT_HIGH"
        assert result["confidence"] is not None

    def test_none_elevations_do_not_crash(self):
        with patch.object(ep, "_fetch_elevation_ft", return_value=None):
            result = ep.fetch_elevation_profile(
                37.0, -122.0, road_bearing_deg=45.0, half_width_m=30.0, spacing_m=10.0,
            )
        pts = result["profile"]["points"]
        assert all(p["elevation_ft"] is None for p in pts)
        assert result["classification"] == "UNKNOWN"
        # Bearing present but USGS returned no valid samples -> insufficient samples.
        assert result["classification_reason"] == "INSUFFICIENT_VALID_SAMPLES"
        assert result["error"] is None
