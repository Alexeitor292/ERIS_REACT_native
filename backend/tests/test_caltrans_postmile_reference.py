from __future__ import annotations

from app.services import caltrans_postmile_reference as ref


def _feature(object_id: int, *, pm: float, x: float, y: float) -> dict:
    return {
        "attributes": {
            "OBJECTID": object_id,
            "Route": 80,
            "RteSuffix": None,
            "PMRouteID": "PLA080",
            "County": "PLA",
            "District": 3,
            "PMPrefix": None,
            "PM": pm,
            "PMSuffix": None,
            "PMc": f"{pm:.1f}",
            "Odometer": pm,
            "PMInterval": 0.1,
            "HwySegment": "A",
            "AlignCode": "C",
            "Direction": "E",
        },
        "geometry": {"x": x, "y": y},
    }


def test_normalize_feature_preserves_engineering_identity_and_wgs84_point():
    point = ref._normalize_feature(
        {
            "attributes": {
                "OBJECTID": 42,
                "Route": 80,
                "RteSuffix": "S",
                "PMRouteID": "PLA080S",
                "County": "pla",
                "District": 3,
                "PMPrefix": "R",
                "PM": 12.3,
                "PMSuffix": "A",
                "PMc": "R12.3A",
                "Odometer": 12.31,
                "PMInterval": 0.1,
                "HwySegment": "A",
                "AlignCode": "R",
                "Direction": "E",
            },
            "geometry": {"x": -121.234567, "y": 38.765432},
        }
    )

    assert point == {
        "object_id": 42,
        "district_code": "03",
        "county_code": "PLA",
        "route_name": "80",
        "route_suffix_code": "S",
        "pm_route_id": "PLA080S",
        "pm_prefix_code": "R",
        "postmile": 12.3,
        "pm_suffix_code": "A",
        "postmile_compound": "R12.3A",
        "odometer": 12.31,
        "pm_interval": 0.1,
        "highway_segment": "A",
        "align_code": "R",
        "direction": "E",
        "latitude": 38.765432,
        "longitude": -121.234567,
    }


def test_normalize_feature_rejects_missing_geometry_or_invalid_wgs84():
    no_geometry = _feature(1, pm=1.0, x=-121.0, y=38.0)
    no_geometry["geometry"] = {}
    assert ref._normalize_feature(no_geometry) is None

    bad_lon = _feature(2, pm=1.1, x=-221.0, y=38.0)
    assert ref._normalize_feature(bad_lon) is None


def test_fetch_reference_pages_until_short_page_and_deduplicates_object_ids(monkeypatch):
    first_page = [_feature(i, pm=i / 10, x=-121.0, y=38.0) for i in range(1, ref._PAGE_SIZE + 1)]
    second_page = [
        _feature(ref._PAGE_SIZE, pm=200.0, x=-121.1, y=38.1),
        _feature(ref._PAGE_SIZE + 1, pm=200.1, x=-121.2, y=38.2),
    ]
    seen_urls: list[str] = []

    def fake_fetch(url: str, timeout_s: int = 45):
        seen_urls.append(url)
        if "resultOffset=0" in url:
            return {"features": first_page}
        assert f"resultOffset={ref._PAGE_SIZE}" in url
        return {"features": second_page}

    monkeypatch.setattr(ref, "_fetch_json", fake_fetch)
    points = ref.fetch_postmile_reference_points()

    assert len(points) == ref._PAGE_SIZE + 1
    assert len(seen_urls) == 2
    assert points[-1]["object_id"] == ref._PAGE_SIZE + 1


def test_fetch_reference_fails_closed_on_empty_usable_dataset(monkeypatch):
    monkeypatch.setattr(ref, "_fetch_json", lambda *_args, **_kwargs: {"features": []})

    try:
        ref.fetch_postmile_reference_points()
    except ref.PostmileReferenceError as exc:
        assert "zero usable points" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected fail-closed PostmileReferenceError")
