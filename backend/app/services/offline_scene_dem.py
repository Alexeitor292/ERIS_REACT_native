"""
Exact-extent contract for USGS 3DEP ArcGIS ImageServer DEM exports.

The terrain package records WGS84 geographic bounds and linearly maps its
float32 height grid onto those bounds. Therefore ERIS may only accept an
export when all three independently agree:

1. the requested WGS84 bounding box and dimensions;
2. the ArcGIS f=json response extent, dimensions and spatial reference;
3. the downloaded GeoTIFF's dimensions, CRS, transform and outer bounds.

No request URL, generated href, token, provider error text or response body is
placed in verification metadata or exception messages.
"""

from __future__ import annotations

import math

from . import offline_scene_imagery as shared_export


DEM_EXPORT_CONTRACT = "exact_extent_arcgis_3dep_v1"
DEM_EXPORT_WKID = 4326
DEM_EXTENT_TOLERANCE_DEG = 1e-9
DEM_UPSTREAM_FORMAT = "tiff"
DEM_PIXEL_TYPE = "F32"
DEM_INTERPOLATION = "RSP_BilinearInterpolation"
ADJUST_ASPECT_RATIO = False

_TIFF_MAGICS = (b"II*\x00", b"MM\x00*")
_BOUNDS_KEYS = ("min_lat", "min_lon", "max_lat", "max_lon")


class DemContractError(Exception):
    """The service response or GeoTIFF violates the exact DEM contract."""


def _finite_number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None

    number = float(value)

    return number if math.isfinite(number) else None


def _positive_whole(value) -> int | None:
    number = _finite_number(value)

    if number is None or number <= 0 or number != int(number):
        return None

    return int(number)


def normalized_bounds(bounds: dict) -> dict:
    if not isinstance(bounds, dict):
        raise DemContractError("DEM bounds are not an object")

    result = {}

    for key in _BOUNDS_KEYS:
        value = _finite_number(bounds.get(key))

        if value is None:
            raise DemContractError(
                f"DEM bounds has a missing or non-finite {key}"
            )

        result[key] = value

    if not (
        result["max_lat"] > result["min_lat"]
        and result["max_lon"] > result["min_lon"]
    ):
        raise DemContractError("DEM bounds are degenerate")

    return result


def export_params(bounds: dict, width_px: int, height_px: int | None = None) -> dict:
    """Build the versioned exact-extent ArcGIS 3DEP export request."""

    clean_bounds = normalized_bounds(bounds)
    width = _positive_whole(width_px)
    height = _positive_whole(height_px if height_px is not None else width_px)

    if width is None or height is None:
        raise DemContractError(
            "DEM export dimensions are not positive integers"
        )

    bbox = (
        f"{clean_bounds['min_lon']},"
        f"{clean_bounds['min_lat']},"
        f"{clean_bounds['max_lon']},"
        f"{clean_bounds['max_lat']}"
    )

    return {
        "bbox": bbox,
        "bboxSR": str(DEM_EXPORT_WKID),
        "imageSR": str(DEM_EXPORT_WKID),
        "size": f"{width},{height}",
        "format": DEM_UPSTREAM_FORMAT,
        "pixelType": DEM_PIXEL_TYPE,
        "interpolation": DEM_INTERPOLATION,
        "adjustAspectRatio": (
            "true" if ADJUST_ASPECT_RATIO else "false"
        ),
        "f": "json",
    }


def verify_export_metadata(
    metadata,
    *,
    bounds: dict,
    width_px: int,
    height_px: int,
    tolerance_deg: float = DEM_EXTENT_TOLERANCE_DEG,
) -> dict:
    """Verify the service-declared extent before downloading the TIFF."""

    clean_bounds = normalized_bounds(bounds)

    try:
        verification = shared_export.verify_export_metadata(
            metadata,
            bounds=clean_bounds,
            width_px=width_px,
            height_px=height_px,
            tolerance_deg=tolerance_deg,
        )
    except shared_export.ImageryContractError as exc:
        raise DemContractError(str(exc)) from exc

    extent = metadata.get("extent")

    returned_bounds = {
        "min_lat": float(extent["ymin"]),
        "min_lon": float(extent["xmin"]),
        "max_lat": float(extent["ymax"]),
        "max_lon": float(extent["xmax"]),
    }

    return {
        "export_contract": DEM_EXPORT_CONTRACT,
        "adjust_aspect_ratio": ADJUST_ASPECT_RATIO,
        **verification,
        "requested_bounds": clean_bounds,
        "returned_bounds": returned_bounds,
    }


def safe_export_href(href, *, service_url: str) -> str:
    """Apply the shared HTTPS/same-origin generated-output policy."""

    try:
        return shared_export.safe_export_href(
            href,
            service_url=service_url,
        )
    except shared_export.ImageryContractError as exc:
        raise DemContractError(str(exc)) from exc


def inspect_dem_tiff(
    data: bytes,
    *,
    expected_bounds: dict,
    width_px: int,
    height_px: int,
    tolerance_deg: float = DEM_EXTENT_TOLERANCE_DEG,
) -> dict:
    """Verify the downloaded GeoTIFF independently of ArcGIS metadata."""

    if not isinstance(data, bytes) or not data.startswith(_TIFF_MAGICS):
        raise DemContractError(
            "DEM download is not a TIFF"
        )

    clean_bounds = normalized_bounds(expected_bounds)
    expected_width = _positive_whole(width_px)
    expected_height = _positive_whole(height_px)

    if expected_width is None or expected_height is None:
        raise DemContractError(
            "expected DEM raster dimensions are invalid"
        )

    tolerance = _finite_number(tolerance_deg)

    if tolerance is None or tolerance < 0:
        raise DemContractError(
            "DEM extent tolerance is invalid"
        )

    try:
        from rasterio.crs import CRS
        from rasterio.io import MemoryFile
    except Exception as exc:  # pragma: no cover - worker dependency gate
        raise RuntimeError(
            "DEM verification requires rasterio/GDAL"
        ) from exc

    try:
        with MemoryFile(data) as memory_file:
            with memory_file.open() as dataset:
                width = int(dataset.width)
                height = int(dataset.height)
                band_count = int(dataset.count)
                driver = str(dataset.driver or "")
                dtype = str(dataset.dtypes[0]) if dataset.dtypes else ""
                transform = dataset.transform
                raster_bounds = dataset.bounds
                raster_crs = dataset.crs
    except Exception as exc:
        raise DemContractError(
            "DEM TIFF could not be opened"
        ) from exc

    if driver.upper() != "GTIFF":
        raise DemContractError(
            "DEM raster driver is not GeoTIFF"
        )

    if (width, height) != (expected_width, expected_height):
        raise DemContractError(
            f"DEM TIFF is {width}x{height} but "
            f"{expected_width}x{expected_height} was declared"
        )

    if band_count != 1:
        raise DemContractError(
            f"DEM TIFF has {band_count} bands instead of one"
        )

    if dtype.lower() != "float32":
        raise DemContractError(
            f"DEM TIFF dtype is {dtype or 'unknown'}, not float32"
        )

    required_crs = CRS.from_epsg(DEM_EXPORT_WKID)

    if raster_crs is None or raster_crs != required_crs:
        epsg = raster_crs.to_epsg() if raster_crs is not None else None

        raise DemContractError(
            f"DEM TIFF CRS is {epsg or 'unknown'}, "
            f"not EPSG:{DEM_EXPORT_WKID}"
        )

    # North-up, unrotated affine:
    #   x = a*column + c, where a > 0
    #   y = e*row + f, where e < 0
    if (
        not math.isfinite(float(transform.a))
        or not math.isfinite(float(transform.e))
        or float(transform.a) <= 0
        or float(transform.e) >= 0
        or abs(float(transform.b)) > 1e-12
        or abs(float(transform.d)) > 1e-12
    ):
        raise DemContractError(
            "DEM TIFF transform is rotated, flipped or non-finite"
        )

    actual_bounds = {
        "min_lat": float(raster_bounds.bottom),
        "min_lon": float(raster_bounds.left),
        "max_lat": float(raster_bounds.top),
        "max_lon": float(raster_bounds.right),
    }

    worst_delta = max(
        abs(actual_bounds[key] - clean_bounds[key])
        for key in _BOUNDS_KEYS
    )

    if worst_delta > tolerance:
        raise DemContractError(
            "DEM TIFF bounds differ from the verified export extent by "
            f"{worst_delta:.3e} deg "
            f"(tolerance {tolerance:.3e} deg)"
        )

    expected_pixel_width = (
        clean_bounds["max_lon"] - clean_bounds["min_lon"]
    ) / expected_width

    expected_pixel_height = -(
        clean_bounds["max_lat"] - clean_bounds["min_lat"]
    ) / expected_height

    pixel_size_delta = max(
        abs(float(transform.a) - expected_pixel_width),
        abs(float(transform.e) - expected_pixel_height),
    )

    if pixel_size_delta > tolerance:
        raise DemContractError(
            "DEM TIFF pixel size does not match its verified extent "
            f"(delta {pixel_size_delta:.3e} deg)"
        )

    return {
        "raster_verified": True,
        "raster_driver": "GTiff",
        "raster_width_px": width,
        "raster_height_px": height,
        "raster_band_count": band_count,
        "raster_dtype": dtype,
        "raster_crs_wkid": DEM_EXPORT_WKID,
        "raster_transform_verified": True,
        "raster_bounds": actual_bounds,
        "raster_bounds_max_delta_deg": worst_delta,
        "raster_pixel_size_max_delta_deg": pixel_size_delta,
    }


def complete_verification(
    metadata_verification: dict,
    raster_verification: dict,
) -> dict:
    """Combine the independent metadata and GeoTIFF proofs."""

    result = {
        **dict(metadata_verification or {}),
        **dict(raster_verification or {}),
    }

    if not verification_ok(result):
        raise DemContractError(
            "DEM verification record is incomplete"
        )

    return result


def verification_ok(record) -> bool:
    """Strictly validate a complete build-time DEM verification record."""

    if not isinstance(record, dict):
        return False

    if record.get("export_contract") != DEM_EXPORT_CONTRACT:
        return False

    if record.get("adjust_aspect_ratio") is not ADJUST_ASPECT_RATIO:
        return False

    if record.get("extent_verified") is not True:
        return False

    if record.get("raster_verified") is not True:
        return False

    if record.get("raster_transform_verified") is not True:
        return False

    if record.get("raster_crs_wkid") != DEM_EXPORT_WKID:
        return False

    requested_width = _positive_whole(
        record.get("requested_width_px")
    )
    requested_height = _positive_whole(
        record.get("requested_height_px")
    )
    returned_width = _positive_whole(
        record.get("returned_width_px")
    )
    returned_height = _positive_whole(
        record.get("returned_height_px")
    )
    raster_width = _positive_whole(
        record.get("raster_width_px")
    )
    raster_height = _positive_whole(
        record.get("raster_height_px")
    )

    if None in (
        requested_width,
        requested_height,
        returned_width,
        returned_height,
        raster_width,
        raster_height,
    ):
        return False

    if not (
        requested_width == returned_width == raster_width
        and requested_height == returned_height == raster_height
    ):
        return False

    extent_delta = _finite_number(
        record.get("extent_max_delta_deg")
    )
    extent_tolerance = _finite_number(
        record.get("extent_tolerance_deg")
    )
    raster_delta = _finite_number(
        record.get("raster_bounds_max_delta_deg")
    )

    if (
        extent_delta is None
        or extent_tolerance is None
        or raster_delta is None
        or extent_delta < 0
        or extent_tolerance < 0
        or raster_delta < 0
        or extent_delta > extent_tolerance
        or raster_delta > extent_tolerance
    ):
        return False

    try:
        requested_bounds = normalized_bounds(
            record.get("requested_bounds")
        )
        returned_bounds = normalized_bounds(
            record.get("returned_bounds")
        )
        raster_bounds = normalized_bounds(
            record.get("raster_bounds")
        )
    except DemContractError:
        return False

    for key in _BOUNDS_KEYS:
        if (
            abs(requested_bounds[key] - returned_bounds[key])
            > extent_tolerance
        ):
            return False

        if (
            abs(returned_bounds[key] - raster_bounds[key])
            > extent_tolerance
        ):
            return False

    return True
