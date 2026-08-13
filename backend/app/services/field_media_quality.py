from __future__ import annotations

import math

_MIN_HEADING_ACCURACY_CODE = 2


def _finite(value):
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int_or_none(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def quality_gated_capture(row) -> dict:
    latitude = _finite(row["latitude"])
    longitude = _finite(row["longitude"])
    horizontal_accuracy = _finite(row["horizontal_accuracy_m"])
    location_ok = (
        latitude is not None
        and longitude is not None
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
        and (horizontal_accuracy is None or horizontal_accuracy >= 0)
    )

    heading = _finite(row["camera_heading_deg"])
    heading_accuracy = _int_or_none(row["camera_heading_accuracy_code"])
    heading_reference = row["heading_reference"]
    heading_source = row["heading_source"]
    heading_in_range = heading is not None and 0 <= heading < 360

    if heading_source == "EXIF_GPS_IMG_DIRECTION":
        heading_ok = heading_in_range and heading_reference == "TRUE_NORTH"
    else:
        heading_ok = (
            heading_in_range
            and heading_accuracy is not None
            and heading_accuracy >= _MIN_HEADING_ACCURACY_CODE
            and heading_reference == "TRUE_NORTH"
        )

    return {
        "latitude": latitude if location_ok else None,
        "longitude": longitude if location_ok else None,
        "horizontal_accuracy_m": horizontal_accuracy,
        "altitude_m": _finite(row["altitude_m"]) if location_ok else None,
        "camera_heading_deg": heading if heading_ok else None,
        "camera_heading_accuracy_code": heading_accuracy,
        "heading_reference": heading_reference if heading_ok else None,
        "location_source": row["location_source"] if location_ok else None,
        "heading_source": heading_source if heading_ok else None,
    }
