import json

from app.services.field_media_ingest import _coordinate, _heading_reference, merge_capture_metadata_json


def test_coordinate_refs():
    assert _coordinate((39, 30, 0), "N") == 39.5
    assert _coordinate((121, 1, 3), "W") < 0
    assert _coordinate((121, 1, 3), b"W\x00") < 0


def test_direction_refs():
    assert _heading_reference("T") == "TRUE_NORTH"
    assert _heading_reference("M") == "MAGNETIC_NORTH"
    assert _heading_reference(b"T\x00") == "TRUE_NORTH"


def test_fallback_fills_null_fields_without_overwriting_existing_values():
    current = json.dumps({
        "captured_at": "2026-08-13T18:00:00Z",
        "latitude": None,
        "longitude": None,
        "camera_heading_deg": 90,
        "heading_reference": "TRUE_NORTH",
        "heading_source": "DEVICE_TRUE_HEADING",
    })
    embedded = {
        "latitude": 39.509072,
        "longitude": -121.017635,
        "horizontal_accuracy_m": None,
        "camera_heading_deg": 275,
        "heading_reference": "TRUE_NORTH",
        "location_source": "EXIF_GPS",
        "heading_source": "EXIF_GPS_IMG_DIRECTION",
    }
    merged = json.loads(merge_capture_metadata_json(current, embedded))
    assert merged["latitude"] == 39.509072
    assert merged["longitude"] == -121.017635
    assert merged["location_source"] == "EXIF_GPS"
    assert merged["camera_heading_deg"] == 90
    assert merged["heading_source"] == "DEVICE_TRUE_HEADING"


def test_fallback_can_create_payload():
    embedded = {
        "latitude": 39.509072,
        "longitude": -121.017635,
        "location_source": "EXIF_GPS",
    }
    merged = json.loads(merge_capture_metadata_json(None, embedded))
    assert merged["latitude"] == 39.509072
    assert merged["longitude"] == -121.017635
