from io import BytesIO

import pytest
from PIL import ExifTags, Image

from app.services.photo_metadata_export import PhotoMetadataExportUnsupported, render_corrected_jpeg


def make_jpeg() -> bytes:
    image = Image.new("RGB", (32, 24), "white")
    exif = Image.Exif()
    exif[int(ExifTags.Base.Make)] = "Apple"
    out = BytesIO()
    image.save(out, "JPEG", quality=90, exif=exif)
    return out.getvalue()


def decimal_from_dms(values, ref: str) -> float:
    deg, minutes, seconds = (float(v) for v in values)
    out = deg + minutes / 60.0 + seconds / 3600.0
    return -out if ref in {"S", "W"} else out


def test_export_embeds_effective_location_and_direction():
    exported = render_corrected_jpeg(
        make_jpeg(),
        latitude=39.509072,
        longitude=-121.017635,
        camera_heading_deg=271.5,
        location_is_manual=True,
    )
    exif = Image.open(BytesIO(exported)).getexif()
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    assert exif[int(ExifTags.Base.Make)] == "Apple"
    assert decimal_from_dms(gps[int(ExifTags.GPS.GPSLatitude)], gps[int(ExifTags.GPS.GPSLatitudeRef)]) == pytest.approx(39.509072, abs=1e-6)
    assert decimal_from_dms(gps[int(ExifTags.GPS.GPSLongitude)], gps[int(ExifTags.GPS.GPSLongitudeRef)]) == pytest.approx(-121.017635, abs=1e-6)
    assert gps[int(ExifTags.GPS.GPSImgDirectionRef)] == "T"
    assert float(gps[int(ExifTags.GPS.GPSImgDirection)]) == pytest.approx(271.5, abs=1e-3)


def test_export_clears_untrusted_location_and_direction():
    exported = render_corrected_jpeg(
        make_jpeg(),
        latitude=None,
        longitude=None,
        camera_heading_deg=None,
        location_is_manual=False,
    )
    gps = Image.open(BytesIO(exported)).getexif().get_ifd(ExifTags.IFD.GPSInfo)
    assert int(ExifTags.GPS.GPSLatitude) not in gps
    assert int(ExifTags.GPS.GPSLongitude) not in gps
    assert int(ExifTags.GPS.GPSImgDirection) not in gps


def test_non_jpeg_is_not_silently_converted():
    image = Image.new("RGB", (8, 8), "white")
    data = BytesIO()
    image.save(data, "PNG")
    with pytest.raises(PhotoMetadataExportUnsupported):
        render_corrected_jpeg(data.getvalue(), latitude=39.0, longitude=-121.0, camera_heading_deg=90.0, location_is_manual=True)
