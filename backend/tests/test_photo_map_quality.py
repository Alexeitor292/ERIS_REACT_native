from app.routes.photo_map import _quality_gated_capture


def row(**overrides):
    base = {
        "latitude": 38.58,
        "longitude": -121.49,
        "horizontal_accuracy_m": 5.0,
        "altitude_m": 30.0,
        "camera_heading_deg": 90.0,
        "camera_heading_accuracy_code": 3,
        "heading_reference": "TRUE_NORTH",
        "location_source": "DEVICE_AT_CAPTURE",
        "heading_source": "DEVICE_TRUE_HEADING",
    }
    base.update(overrides)
    return base


def test_good_capture_is_mapped_and_headed():
    out = _quality_gated_capture(row())
    assert out["latitude"] == 38.58
    assert out["longitude"] == -121.49
    assert out["camera_heading_deg"] == 90.0


def test_weak_gps_is_not_mapped():
    out = _quality_gated_capture(row(horizontal_accuracy_m=45.0))
    assert out["latitude"] is None
    assert out["longitude"] is None
    assert out["location_source"] is None


def test_missing_gps_accuracy_is_not_mapped():
    out = _quality_gated_capture(row(horizontal_accuracy_m=None))
    assert out["latitude"] is None
    assert out["longitude"] is None


def test_low_confidence_heading_is_suppressed():
    out = _quality_gated_capture(row(camera_heading_accuracy_code=1))
    assert out["camera_heading_deg"] is None
    assert out["heading_reference"] is None


def test_magnetic_heading_is_suppressed_on_true_north_map():
    out = _quality_gated_capture(
        row(
            heading_reference="MAGNETIC_NORTH",
            heading_source="DEVICE_MAGNETIC_HEADING",
        )
    )
    assert out["camera_heading_deg"] is None
    assert out["heading_source"] is None
