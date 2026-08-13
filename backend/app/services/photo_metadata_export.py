from __future__ import annotations

from fractions import Fraction
from io import BytesIO

from PIL import ExifTags, Image, UnidentifiedImageError


class PhotoMetadataExportUnsupported(RuntimeError):
    """Raised when an attachment cannot produce a standards-based JPEG EXIF export."""


def _rational(value: float) -> Fraction:
    return Fraction(str(round(float(value), 7))).limit_denominator(1_000_000)


def _dms(value: float) -> tuple[Fraction, Fraction, Fraction]:
    absolute = abs(float(value))
    degrees = int(absolute)
    minutes_full = (absolute - degrees) * 60.0
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60.0
    return Fraction(degrees, 1), Fraction(minutes, 1), _rational(seconds)


def render_corrected_jpeg(
    original_bytes: bytes,
    *,
    latitude: float | None,
    longitude: float | None,
    camera_heading_deg: float | None,
    location_is_manual: bool,
) -> bytes:
    """Return a derived JPEG with ERIS's effective map metadata embedded in EXIF.

    The input bytes are never changed. Existing EXIF/ICC metadata is preserved where
    possible, while the standard GPS latitude/longitude and GPSImgDirection fields
    are replaced with ERIS's current effective values.
    """
    if not original_bytes:
        raise PhotoMetadataExportUnsupported("Photo object is empty")

    try:
        image = Image.open(BytesIO(original_bytes))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise PhotoMetadataExportUnsupported("Photo cannot be decoded as an image") from exc

    if image.format != "JPEG":
        raise PhotoMetadataExportUnsupported(
            f"Corrected EXIF export currently supports JPEG sources only (got {image.format or 'unknown'})"
        )

    exif = image.getexif()
    try:
        gps = dict(exif.get_ifd(ExifTags.IFD.GPSInfo))
    except Exception:
        gps = {}

    # Exif GPS IFD version 2.3.0.0. Pillow requires the four-byte representation.
    gps[int(ExifTags.GPS.GPSVersionID)] = b"\x02\x03\x00\x00"

    if latitude is not None and longitude is not None:
        gps[int(ExifTags.GPS.GPSLatitudeRef)] = "N" if latitude >= 0 else "S"
        gps[int(ExifTags.GPS.GPSLatitude)] = _dms(latitude)
        gps[int(ExifTags.GPS.GPSLongitudeRef)] = "E" if longitude >= 0 else "W"
        gps[int(ExifTags.GPS.GPSLongitude)] = _dms(longitude)
        gps[int(ExifTags.GPS.GPSMapDatum)] = "WGS-84"
    else:
        # Do not let stale original GPS coordinates survive when ERIS considers the
        # photo unmapped (for example after resetting a low-quality captured fix).
        for tag in (
            ExifTags.GPS.GPSLatitudeRef,
            ExifTags.GPS.GPSLatitude,
            ExifTags.GPS.GPSLongitudeRef,
            ExifTags.GPS.GPSLongitude,
            ExifTags.GPS.GPSMapDatum,
        ):
            gps.pop(int(tag), None)

    if location_is_manual:
        # A manually moved point has no trustworthy sensor altitude/accuracy. Remove
        # those GPS tags instead of attaching stale telemetry to the corrected point.
        for tag in (
            ExifTags.GPS.GPSAltitudeRef,
            ExifTags.GPS.GPSAltitude,
            ExifTags.GPS.GPSHPositioningError,
        ):
            gps.pop(int(tag), None)

    if camera_heading_deg is not None:
        heading = float(camera_heading_deg) % 360.0
        gps[int(ExifTags.GPS.GPSImgDirectionRef)] = "T"
        gps[int(ExifTags.GPS.GPSImgDirection)] = _rational(heading)
    else:
        # Likewise, remove a stale EXIF direction if ERIS has no trustworthy current
        # direction after a reset.
        gps.pop(int(ExifTags.GPS.GPSImgDirectionRef), None)
        gps.pop(int(ExifTags.GPS.GPSImgDirection), None)

    exif[int(ExifTags.IFD.GPSInfo)] = gps

    output = BytesIO()
    save_args = {
        "format": "JPEG",
        "quality": "keep",
        "exif": exif,
    }
    icc_profile = image.info.get("icc_profile")
    if icc_profile:
        save_args["icc_profile"] = icc_profile
    image.save(output, **save_args)
    return output.getvalue()
