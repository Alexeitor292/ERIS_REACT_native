from __future__ import annotations

from io import BytesIO
import json
import math
import re

from PIL import Image
from sqlalchemy import text

_GPS_INFO_TAG = 34853
_EXIF_IFD_TAG = 34665
_DATETIME_ORIGINAL_TAG = 36867

_GPS_LAT_REF = 1
_GPS_LAT = 2
_GPS_LON_REF = 3
_GPS_LON = 4
_GPS_ALT_REF = 5
_GPS_ALT = 6
_GPS_IMG_DIRECTION_REF = 16
_GPS_IMG_DIRECTION = 17
_GPS_H_POSITIONING_ERROR = 31


def _number(value):
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return out if math.isfinite(out) else None


def _text(value) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("ascii", errors="ignore").strip("\x00 ")
        except Exception:
            return ""
    return str(value or "").strip()


def _coordinate(value, ref):
    if not isinstance(value, (tuple, list)) or len(value) < 3:
        return None
    d = _number(value[0])
    m = _number(value[1])
    s = _number(value[2])
    if d is None or m is None or s is None:
        return None
    magnitude = abs(d) + abs(m) / 60.0 + abs(s) / 3600.0
    normalized_ref = _text(ref).upper()
    if normalized_ref in {"S", "W"}:
        return -magnitude
    if normalized_ref in {"N", "E"}:
        return magnitude
    return -magnitude if d < 0 else magnitude


def _heading_reference(value):
    normalized = _text(value).upper()
    if normalized in {"T", "TRUE", "TRUE_NORTH"}:
        return "TRUE_NORTH"
    if normalized in {"M", "MAGNETIC", "MAGNETIC_NORTH"}:
        return "MAGNETIC_NORTH"
    return "UNKNOWN" if normalized else None


def _date_value(exif):
    value = exif.get(_DATETIME_ORIGINAL_TAG)
    if value:
        return str(value)
    try:
        exif_ifd = exif.get_ifd(_EXIF_IFD_TAG)
    except Exception:
        exif_ifd = None
    if isinstance(exif_ifd, dict) and exif_ifd.get(_DATETIME_ORIGINAL_TAG):
        return str(exif_ifd[_DATETIME_ORIGINAL_TAG])
    return None


def _iso_like_exif_date(value):
    if not value:
        return None
    raw = str(value).strip()
    match = re.match(r"^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})", raw)
    if not match:
        return None
    y, mo, d, h, mi, s = match.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}"


def _altitude_reference_is_below(value) -> bool:
    if isinstance(value, bytes):
        return bool(value) and value[0] == 1
    numeric = _number(value)
    return numeric is not None and int(numeric) == 1


def extract_embedded_photo_metadata(content: bytes) -> dict | None:
    if not content:
        return None
    try:
        with Image.open(BytesIO(content)) as image:
            exif = image.getexif()
            if not exif:
                return None
            try:
                gps = exif.get_ifd(_GPS_INFO_TAG)
            except Exception:
                gps = None
            if not isinstance(gps, dict):
                gps = {}

            latitude = _coordinate(gps.get(_GPS_LAT), gps.get(_GPS_LAT_REF))
            longitude = _coordinate(gps.get(_GPS_LON), gps.get(_GPS_LON_REF))
            valid_location = (
                latitude is not None
                and longitude is not None
                and -90 <= latitude <= 90
                and -180 <= longitude <= 180
            )

            raw_accuracy = _number(gps.get(_GPS_H_POSITIONING_ERROR))
            horizontal_accuracy = raw_accuracy if raw_accuracy is not None and raw_accuracy >= 0 else None

            altitude = _number(gps.get(_GPS_ALT))
            if altitude is not None and _altitude_reference_is_below(gps.get(_GPS_ALT_REF)):
                altitude = -abs(altitude)

            direction = _number(gps.get(_GPS_IMG_DIRECTION))
            if direction is not None:
                direction = direction % 360.0
            direction_ref = _heading_reference(gps.get(_GPS_IMG_DIRECTION_REF))

            date_value = _date_value(exif)
            out = {
                "captured_at": _iso_like_exif_date(date_value),
                "latitude": latitude if valid_location else None,
                "longitude": longitude if valid_location else None,
                "horizontal_accuracy_m": horizontal_accuracy if valid_location else None,
                "altitude_m": altitude if valid_location else None,
                "camera_heading_deg": direction,
                "camera_heading_accuracy_code": None,
                "heading_reference": direction_ref if direction is not None else None,
                "location_source": "EXIF_GPS" if valid_location else None,
                "heading_source": "EXIF_GPS_IMG_DIRECTION" if direction is not None else None,
                "provenance": {
                    "asset_id": None,
                    "exif_tags_present": [
                        name
                        for name, present in (
                            ("GPSLatitude", gps.get(_GPS_LAT) is not None),
                            ("GPSLongitude", gps.get(_GPS_LON) is not None),
                            ("GPSHPositioningError", gps.get(_GPS_H_POSITIONING_ERROR) is not None),
                            ("GPSAltitude", gps.get(_GPS_ALT) is not None),
                            ("GPSImgDirection", gps.get(_GPS_IMG_DIRECTION) is not None),
                            ("GPSImgDirectionRef", gps.get(_GPS_IMG_DIRECTION_REF) is not None),
                            ("DateTimeOriginal", date_value is not None),
                        )
                        if present
                    ],
                },
            }
            return out if any(
                out.get(key) is not None
                for key in ("captured_at", "latitude", "longitude", "camera_heading_deg")
            ) else None
    except Exception:
        return None


def merge_capture_metadata_json(raw_json: str | None, embedded: dict | None) -> str | None:
    if not embedded:
        return raw_json
    if raw_json is None or not raw_json.strip():
        return json.dumps(embedded, separators=(",", ":"))
    try:
        current = json.loads(raw_json)
    except json.JSONDecodeError:
        return raw_json
    if not isinstance(current, dict):
        return raw_json

    merged = dict(current)
    for key, value in embedded.items():
        if key == "provenance":
            if not isinstance(merged.get(key), dict) and isinstance(value, dict):
                merged[key] = value
            continue
        if merged.get(key) is None and value is not None:
            merged[key] = value
    return json.dumps(merged, separators=(",", ":"))


def install_upload_metadata_fallback() -> None:
    from .. import photos

    if getattr(photos, "_field_media_ingest_installed", False):
        return

    original = photos._store_submission_attachment

    async def wrapped_store_submission_attachment(
        *,
        submission_id,
        file,
        section_key,
        kind,
        capture_metadata_json,
        db,
        user,
    ):
        merged_json = capture_metadata_json
        mime = str(getattr(file, "content_type", "") or "").lower()
        if str(kind or "").upper() == "PHOTO" or mime.startswith("image/"):
            try:
                content = await file.read()
                await file.seek(0)
                embedded = extract_embedded_photo_metadata(content)
                merged_json = merge_capture_metadata_json(capture_metadata_json, embedded)
            except Exception:
                try:
                    await file.seek(0)
                except Exception:
                    pass
        return await original(
            submission_id=submission_id,
            file=file,
            section_key=section_key,
            kind=kind,
            capture_metadata_json=merged_json,
            db=db,
            user=user,
        )

    photos._store_submission_attachment = wrapped_store_submission_attachment
    photos._field_media_ingest_installed = True


def _existing_metadata_json(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def backfill_missing_photo_metadata(db) -> dict:
    from .. import photos
    from ..config import settings
    from ..storage import get_object_bytes

    rows = db.execute(text("""
        SELECT a.id, a.storage_bucket, a.storage_key
        FROM attachments a
        LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id=a.id
        WHERE LOWER(COALESCE(a.mime_type,'')) IN ('image/jpeg','image/jpg')
          AND (cm.attachment_id IS NULL OR cm.latitude IS NULL OR cm.longitude IS NULL)
        ORDER BY a.id
    """)).mappings().all()

    scanned = updated = 0
    for row in rows:
        scanned += 1
        try:
            content, _ = get_object_bytes(
                object_key=str(row["storage_key"]),
                bucket=str(row["storage_bucket"] or settings.MINIO_BUCKET),
            )
        except Exception:
            continue
        embedded = extract_embedded_photo_metadata(content)
        if not embedded:
            continue
        normalized = photos._normalize_capture_metadata(
            json.dumps(embedded, separators=(",", ":"))
        )
        if normalized is None:
            continue

        existing = db.execute(
            text("SELECT * FROM attachment_capture_metadata WHERE attachment_id=:aid"),
            {"aid": int(row["id"])},
        ).mappings().first()
        if existing:
            merged = dict(normalized)
            for key in (
                "captured_at",
                "latitude",
                "longitude",
                "horizontal_accuracy_m",
                "altitude_m",
                "camera_heading_deg",
                "camera_heading_accuracy_code",
                "heading_reference",
                "location_source",
                "heading_source",
            ):
                if existing.get(key) is not None:
                    merged[key] = existing[key]
            existing_metadata = _existing_metadata_json(existing.get("metadata_json"))
            if existing_metadata is not None:
                merged["metadata_json"] = existing_metadata
            normalized = merged

        photos._store_capture_metadata(db, int(row["id"]), normalized)
        updated += 1

    db.commit()
    return {"scanned": scanned, "updated": updated}
