import json
import pytest
from fastapi import HTTPException
from app.photos import _normalize_capture_metadata
from app.routes.photo_map import _normalize_correction_payload


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


def test_photo_correction_accepts_location_and_heading_overrides():
    out = _normalize_correction_payload({
        "client_correction_uuid": "photo_corr_12345678",
        "location_override": {"latitude": 39.509072, "longitude": -121.017635},
        "heading_override_deg": 271.5,
    })
    assert out["location_is_override"] is True
    assert out["latitude"] == pytest.approx(39.509072)
    assert out["longitude"] == pytest.approx(-121.017635)
    assert out["heading_is_override"] is True
    assert out["camera_heading_deg"] == pytest.approx(271.5)


def test_photo_correction_nulls_mean_reset_to_captured_values():
    out = _normalize_correction_payload({
        "client_correction_uuid": "photo_corr_reset_1234",
        "location_override": None,
        "heading_override_deg": None,
    })
    assert out["location_is_override"] is False
    assert out["latitude"] is None
    assert out["longitude"] is None
    assert out["heading_is_override"] is False
    assert out["camera_heading_deg"] is None


@pytest.mark.parametrize(
    "location",
    [
        {"latitude": 91, "longitude": -121},
        {"latitude": 39, "longitude": -181},
        {"latitude": "not-a-number", "longitude": -121},
    ],
)
def test_photo_correction_rejects_invalid_location(location):
    with pytest.raises(HTTPException):
        _normalize_correction_payload({
            "client_correction_uuid": "photo_corr_invalid_1234",
            "location_override": location,
            "heading_override_deg": None,
        })


@pytest.mark.parametrize("heading", [-0.1, 360, 999, "bad"])
def test_photo_correction_rejects_invalid_heading(heading):
    with pytest.raises(HTTPException):
        _normalize_correction_payload({
            "client_correction_uuid": "photo_corr_heading_1234",
            "location_override": None,
            "heading_override_deg": heading,
        })


def test_photo_correction_requires_stable_client_uuid():
    with pytest.raises(HTTPException):
        _normalize_correction_payload({
            "client_correction_uuid": "short",
            "location_override": None,
            "heading_override_deg": None,
        })
