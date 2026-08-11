import json
import pytest
from fastapi import HTTPException
from app.photos import _normalize_capture_metadata


def test_capture_metadata_valid():
    out = _normalize_capture_metadata(json.dumps({
        "captured_at":"2026-08-10T18:05:02Z", "latitude":38.58, "longitude":-121.49,
        "horizontal_accuracy_m":4.8, "camera_heading_deg":238.25,
        "camera_heading_accuracy_code":3, "heading_reference":"TRUE_NORTH",
        "location_source":"DEVICE_AT_CAPTURE", "heading_source":"DEVICE_TRUE_HEADING"
    }))
    assert out["latitude"] == pytest.approx(38.58)
    assert out["camera_heading_deg"] == pytest.approx(238.25)


def test_coordinate_pair_required():
    with pytest.raises(HTTPException):
        _normalize_capture_metadata(json.dumps({"latitude":38.5}))


@pytest.mark.parametrize("heading", [-1, 360, 999])
def test_bad_heading_rejected(heading):
    with pytest.raises(HTTPException):
        _normalize_capture_metadata(json.dumps({"camera_heading_deg": heading}))


def test_empty_is_none():
    assert _normalize_capture_metadata(None) is None
    assert _normalize_capture_metadata("{}") is None
