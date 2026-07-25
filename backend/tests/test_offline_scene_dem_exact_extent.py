"""
Pure and rasterio-backed tests for the exact USGS 3DEP DEM export contract.

No network, database, MinIO or ArcGIS credentials are used.
"""

from __future__ import annotations

import numpy as np
import pytest
from affine import Affine
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

from app.services import offline_scene_dem as dem


# Representative mountain/highway AOI proportions. The live submission-21
# acceptance probe will later provide the authoritative field bounds.
BOUNDS = {
    "min_lat": 40.680000,
    "min_lon": -123.100000,
    "max_lat": 40.707000,
    "max_lon": -123.064000,
}

WIDTH = 256
HEIGHT = 256


def metadata(
    *,
    bounds: dict | None = None,
    width: int = WIDTH,
    height: int = HEIGHT,
    wkid: int = 4326,
):
    b = dict(bounds or BOUNDS)

    return {
        "href": (
            "https://elevation.nationalmap.gov/"
            "arcgisoutput/example.tif"
        ),
        "width": width,
        "height": height,
        "extent": {
            "xmin": b["min_lon"],
            "ymin": b["min_lat"],
            "xmax": b["max_lon"],
            "ymax": b["max_lat"],
            "spatialReference": {"wkid": wkid},
        },
    }


def geotiff_bytes(
    *,
    bounds: dict | None = None,
    width: int = WIDTH,
    height: int = HEIGHT,
    crs: str = "EPSG:4326",
    dtype: str = "float32",
    count: int = 1,
    transform=None,
):
    b = dict(bounds or BOUNDS)

    if transform is None:
        transform = from_bounds(
            b["min_lon"],
            b["min_lat"],
            b["max_lon"],
            b["max_lat"],
            width,
            height,
        )

    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": count,
        "dtype": dtype,
        "crs": crs,
        "transform": transform,
    }

    values = np.arange(
        width * height,
        dtype=np.float32,
    ).reshape(height, width)

    if dtype != "float32":
        values = values.astype(dtype)

    with MemoryFile() as memory_file:
        with memory_file.open(**profile) as dataset:
            for band in range(1, count + 1):
                dataset.write(values, band)

        return memory_file.read()


class TestRequestContract:
    def test_contract_identity_is_versioned(self):
        assert (
            dem.DEM_EXPORT_CONTRACT
            == "exact_extent_arcgis_3dep_v1"
        )

    def test_request_forbids_aspect_adjustment_and_requires_json(self):
        params = dem.export_params(BOUNDS, WIDTH, HEIGHT)

        assert params == {
            "bbox": (
                "-123.1,40.68,-123.064,40.707"
            ),
            "bboxSR": "4326",
            "imageSR": "4326",
            "size": "256,256",
            "format": "tiff",
            "pixelType": "F32",
            "interpolation": "RSP_BilinearInterpolation",
            "adjustAspectRatio": "false",
            "f": "json",
        }

    @pytest.mark.parametrize(
        "width,height",
        [
            (0, 256),
            (256, 0),
            (-1, 256),
            (256.5, 256),
            (True, 256),
        ],
    )
    def test_request_rejects_invalid_dimensions(self, width, height):
        with pytest.raises(
            dem.DemContractError,
            match="dimensions",
        ):
            dem.export_params(BOUNDS, width, height)


class TestArcGisMetadataVerification:
    def test_exact_metadata_passes(self):
        result = dem.verify_export_metadata(
            metadata(),
            bounds=BOUNDS,
            width_px=WIDTH,
            height_px=HEIGHT,
        )

        assert result["extent_verified"] is True
        assert result["extent_max_delta_deg"] == 0.0
        assert result["returned_bounds"] == BOUNDS
        assert (
            result["export_contract"]
            == dem.DEM_EXPORT_CONTRACT
        )
        assert result["adjust_aspect_ratio"] is False

    def test_adjusted_extent_fails_closed(self):
        changed = dict(BOUNDS)
        changed["max_lat"] += 0.001

        with pytest.raises(
            dem.DemContractError,
            match="service adjusted the export",
        ):
            dem.verify_export_metadata(
                metadata(bounds=changed),
                bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_wrong_dimensions_fail_closed(self):
        with pytest.raises(
            dem.DemContractError,
            match="returned size",
        ):
            dem.verify_export_metadata(
                metadata(width=512),
                bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_wrong_spatial_reference_fails_closed(self):
        with pytest.raises(
            dem.DemContractError,
            match="wkid 3857",
        ):
            dem.verify_export_metadata(
                metadata(wkid=3857),
                bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_service_error_object_fails_without_echoing_text(self):
        value = {
            "error": {
                "message": (
                    "secret token and complete request URL"
                )
            }
        }

        with pytest.raises(
            dem.DemContractError,
            match="error object",
        ) as captured:
            dem.verify_export_metadata(
                value,
                bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

        assert "secret token" not in str(captured.value)


class TestGeneratedHrefPolicy:
    def test_same_origin_https_href_passes(self):
        href = (
            "https://elevation.nationalmap.gov/"
            "arcgisoutput/example.tif"
        )

        assert (
            dem.safe_export_href(
                href,
                service_url=(
                    "https://elevation.nationalmap.gov/"
                    "arcgis/rest/services/3DEPElevation/"
                    "ImageServer"
                ),
            )
            == href
        )

    @pytest.mark.parametrize(
        "href",
        [
            "http://elevation.nationalmap.gov/output/a.tif",
            "https://example.com/output/a.tif",
            "https://user:pass@elevation.nationalmap.gov/a.tif",
        ],
    )
    def test_unsafe_href_fails_closed(self, href):
        with pytest.raises(dem.DemContractError):
            dem.safe_export_href(
                href,
                service_url=(
                    "https://elevation.nationalmap.gov/"
                    "arcgis/rest/services/3DEPElevation/"
                    "ImageServer"
                ),
            )


class TestGeoTiffVerification:
    def test_exact_float32_wgs84_geotiff_passes(self):
        result = dem.inspect_dem_tiff(
            geotiff_bytes(),
            expected_bounds=BOUNDS,
            width_px=WIDTH,
            height_px=HEIGHT,
        )

        assert result["raster_verified"] is True
        assert result["raster_transform_verified"] is True
        assert result["raster_driver"] == "GTiff"
        assert result["raster_dtype"] == "float32"
        assert result["raster_crs_wkid"] == 4326
        assert result["raster_bounds"] == pytest.approx(BOUNDS)

    def test_wrong_raster_bounds_fail_closed(self):
        changed = dict(BOUNDS)
        changed["max_lat"] += 0.001

        with pytest.raises(
            dem.DemContractError,
            match="TIFF bounds differ",
        ):
            dem.inspect_dem_tiff(
                geotiff_bytes(bounds=changed),
                expected_bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_wrong_raster_dimensions_fail_closed(self):
        with pytest.raises(
            dem.DemContractError,
            match="128x256",
        ):
            dem.inspect_dem_tiff(
                geotiff_bytes(width=128),
                expected_bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_wrong_crs_fails_closed(self):
        with pytest.raises(
            dem.DemContractError,
            match="not EPSG:4326",
        ):
            dem.inspect_dem_tiff(
                geotiff_bytes(crs="EPSG:3857"),
                expected_bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_non_float32_fails_closed(self):
        with pytest.raises(
            dem.DemContractError,
            match="not float32",
        ):
            dem.inspect_dem_tiff(
                geotiff_bytes(dtype="int16"),
                expected_bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )

    def test_rotated_transform_fails_closed(self):
        normal = from_bounds(
            BOUNDS["min_lon"],
            BOUNDS["min_lat"],
            BOUNDS["max_lon"],
            BOUNDS["max_lat"],
            WIDTH,
            HEIGHT,
        )

        rotated = Affine(
            normal.a,
            1e-5,
            normal.c,
            0.0,
            normal.e,
            normal.f,
        )

        with pytest.raises(
            dem.DemContractError,
            match="rotated",
        ):
            dem.inspect_dem_tiff(
                geotiff_bytes(transform=rotated),
                expected_bounds=BOUNDS,
                width_px=WIDTH,
                height_px=HEIGHT,
            )


class TestCompleteVerificationRecord:
    def test_complete_record_passes(self):
        metadata_result = dem.verify_export_metadata(
            metadata(),
            bounds=BOUNDS,
            width_px=WIDTH,
            height_px=HEIGHT,
        )

        raster_result = dem.inspect_dem_tiff(
            geotiff_bytes(),
            expected_bounds=metadata_result["returned_bounds"],
            width_px=metadata_result["returned_width_px"],
            height_px=metadata_result["returned_height_px"],
        )

        result = dem.complete_verification(
            metadata_result,
            raster_result,
        )

        assert dem.verification_ok(result) is True

    def test_missing_raster_proof_fails(self):
        metadata_result = dem.verify_export_metadata(
            metadata(),
            bounds=BOUNDS,
            width_px=WIDTH,
            height_px=HEIGHT,
        )

        assert dem.verification_ok(metadata_result) is False

        with pytest.raises(
            dem.DemContractError,
            match="incomplete",
        ):
            dem.complete_verification(
                metadata_result,
                {},
            )


def test_geotiff_verification_records_true_pixel_center_bounds():
    result = dem.inspect_dem_tiff(
        geotiff_bytes(),
        expected_bounds=BOUNDS,
        width_px=WIDTH,
        height_px=HEIGHT,
    )

    pixel_width = (
        BOUNDS["max_lon"] - BOUNDS["min_lon"]
    ) / WIDTH
    pixel_height = (
        BOUNDS["max_lat"] - BOUNDS["min_lat"]
    ) / HEIGHT

    expected = {
        "min_lat": BOUNDS["min_lat"] + pixel_height / 2.0,
        "min_lon": BOUNDS["min_lon"] + pixel_width / 2.0,
        "max_lat": BOUNDS["max_lat"] - pixel_height / 2.0,
        "max_lon": BOUNDS["max_lon"] - pixel_width / 2.0,
    }

    assert result["raster_pixel_width_deg"] == pytest.approx(
        pixel_width
    )
    assert result["raster_pixel_height_deg"] == pytest.approx(
        pixel_height
    )
    assert result["raster_sample_bounds"] == pytest.approx(
        expected
    )
    assert result["raster_sample_bounds"] != result["raster_bounds"]

    assert (
        (
            result["raster_sample_bounds"]["max_lon"]
            - result["raster_sample_bounds"]["min_lon"]
        )
        / (WIDTH - 1)
        == pytest.approx(pixel_width)
    )
    assert (
        (
            result["raster_sample_bounds"]["max_lat"]
            - result["raster_sample_bounds"]["min_lat"]
        )
        / (HEIGHT - 1)
        == pytest.approx(pixel_height)
    )


def test_complete_verification_rejects_forged_sample_centers():
    metadata_result = dem.verify_export_metadata(
        metadata(),
        bounds=BOUNDS,
        width_px=WIDTH,
        height_px=HEIGHT,
    )
    raster_result = dem.inspect_dem_tiff(
        geotiff_bytes(),
        expected_bounds=metadata_result["returned_bounds"],
        width_px=WIDTH,
        height_px=HEIGHT,
    )
    result = dem.complete_verification(
        metadata_result,
        raster_result,
    )

    forged = dict(result)
    forged["raster_sample_bounds"] = dict(
        result["raster_sample_bounds"]
    )
    forged["raster_sample_bounds"]["min_lon"] += 0.0001

    assert dem.verification_ok(forged) is False
