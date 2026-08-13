from app.services.field_media_quality import quality_gated_capture


def _row(**overrides):
    base = {
        "latitude": 39.509072,
        "longitude": -121.017635,
        "horizontal_accuracy_m": 4.0,
        "altitude_m": 100.0,
        "camera_heading_deg": None,
        "camera_heading_accuracy_code": None,
        "heading_reference": None,
        "location_source": "DEVICE_AT_CAPTURE",
        "heading_source": None,
    }
    base.update(overrides)
    return base


def test_measured_location_survives_weak_accuracy():
    out = quality_gated_capture(_row(horizontal_accuracy_m=68.0))
    assert out["latitude"] == 39.509072
    assert out["longitude"] == -121.017635
    assert out["horizontal_accuracy_m"] == 68.0


def test_measured_location_survives_unknown_accuracy():
    out = quality_gated_capture(_row(horizontal_accuracy_m=None, location_source="EXIF_GPS"))
    assert out["latitude"] == 39.509072
    assert out["longitude"] == -121.017635
    assert out["horizontal_accuracy_m"] is None


def test_true_north_exif_direction_does_not_require_device_accuracy_code():
    out = quality_gated_capture(_row(
        camera_heading_deg=278.5,
        camera_heading_accuracy_code=None,
        heading_reference="TRUE_NORTH",
        heading_source="EXIF_GPS_IMG_DIRECTION",
    ))
    assert out["camera_heading_deg"] == 278.5
    assert out["heading_reference"] == "TRUE_NORTH"


def test_device_heading_still_requires_quality_code():
    out = quality_gated_capture(_row(
        camera_heading_deg=278.5,
        camera_heading_accuracy_code=1,
        heading_reference="TRUE_NORTH",
        heading_source="DEVICE_TRUE_HEADING",
    ))
    assert out["camera_heading_deg"] is None
    assert out["heading_reference"] is None
