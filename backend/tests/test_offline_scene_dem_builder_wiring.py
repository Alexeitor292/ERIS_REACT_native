"""
Production-wiring tests for the exact USGS 3DEP DEM contract.

No live network, database, MinIO, or ArcGIS credential is used.
"""

from __future__ import annotations

import io
import json
import zipfile

import numpy as np
import pytest
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

from app.services import offline_scene_builder as builder_module
from app.services import offline_scene_dem as dem


BOUNDS = {
    "min_lat": 40.680000,
    "min_lon": -123.100000,
    "max_lat": 40.707000,
    "max_lon": -123.064000,
}


def _metadata(bounds: dict, width: int, height: int) -> dict:
    return {
        "href": (
            "https://elevation.nationalmap.gov/"
            "arcgisoutput/verified-dem.tif"
        ),
        "width": width,
        "height": height,
        "extent": {
            "xmin": bounds["min_lon"],
            "ymin": bounds["min_lat"],
            "xmax": bounds["max_lon"],
            "ymax": bounds["max_lat"],
            "spatialReference": {"wkid": 4326},
        },
    }


def _geotiff(
    bounds: dict,
    width: int,
    height: int,
) -> bytes:
    transform = from_bounds(
        bounds["min_lon"],
        bounds["min_lat"],
        bounds["max_lon"],
        bounds["max_lat"],
        width,
        height,
    )
    values = np.linspace(
        100.0,
        350.0,
        width * height,
        dtype=np.float32,
    ).reshape(height, width)

    profile = {
        "driver": "GTiff",
        "width": width,
        "height": height,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": transform,
    }

    with MemoryFile() as memory_file:
        with memory_file.open(**profile) as dataset:
            dataset.write(values, 1)

        return memory_file.read()


def _verification(
    bounds: dict,
    width: int,
    height: int,
    data: bytes,
) -> dict:
    metadata_verification = dem.verify_export_metadata(
        _metadata(bounds, width, height),
        bounds=bounds,
        width_px=width,
        height_px=height,
    )
    raster_verification = dem.inspect_dem_tiff(
        data,
        expected_bounds=metadata_verification[
            "returned_bounds"
        ],
        width_px=width,
        height_px=height,
    )

    return dem.complete_verification(
        metadata_verification,
        raster_verification,
    )


class _Response:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict | None = None,
        json_value=None,
        content: bytes = b"",
    ):
        self.status_code = status_code
        self.headers = dict(headers or {})
        self._json_value = json_value
        self.content = content

    def json(self):
        if isinstance(self._json_value, Exception):
            raise self._json_value

        return self._json_value


class _Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(
        self,
        url,
        *,
        params=None,
        timeout=None,
        allow_redirects=None,
    ):
        self.calls.append(
            {
                "url": url,
                "params": params,
                "timeout": timeout,
                "allow_redirects": allow_redirects,
            }
        )

        if not self.responses:
            raise AssertionError("unexpected extra HTTP request")

        return self.responses.pop(0)


def _ctx() -> dict:
    return {
        "submission_id": 21,
        "package_version": "g-test-58",
        "center": {
            "lat": (
                BOUNDS["min_lat"] + BOUNDS["max_lat"]
            )
            / 2.0,
            "lon": (
                BOUNDS["min_lon"] + BOUNDS["max_lon"]
            )
            / 2.0,
        },
        "radius_m": 1500.0,
        "bounds": dict(BOUNDS),
        "content_signature": "base-signature",
        "overlays": {},
    }


def test_fetch_verified_dem_uses_two_safe_exact_extent_legs():
    width = 32
    height = 24
    tiff = _geotiff(BOUNDS, width, height)
    session = _Session(
        [
            _Response(
                headers={"Content-Type": "application/json"},
                json_value=_metadata(
                    BOUNDS,
                    width,
                    height,
                ),
            ),
            _Response(
                headers={"Content-Type": "image/tiff"},
                content=tiff,
            ),
        ]
    )

    data, verification = dem.fetch_verified_dem(
        BOUNDS,
        service_url=(
            "https://elevation.nationalmap.gov/"
            "arcgis/rest/services/3DEPElevation/"
            "ImageServer"
        ),
        width_px=width,
        height_px=height,
        timeout_s=30,
        session=session,
    )

    assert data == tiff
    assert dem.verification_ok(verification) is True
    assert len(session.calls) == 2

    metadata_call, download_call = session.calls

    assert metadata_call["params"]["f"] == "json"
    assert (
        metadata_call["params"]["adjustAspectRatio"]
        == "false"
    )
    assert metadata_call["params"]["format"] == "tiff"
    assert metadata_call["params"]["pixelType"] == "F32"
    assert metadata_call["allow_redirects"] is False

    assert download_call["params"] is None
    assert download_call["allow_redirects"] is False
    assert download_call["url"].startswith(
        "https://elevation.nationalmap.gov/"
    )


def test_builder_uses_raster_verified_bounds_and_packages_no_old_hillshade(
    monkeypatch,
):
    width = int(
        builder_module.settings.OFFLINE_SCENE_GRID_PX
    )
    height = width
    tiff = _geotiff(BOUNDS, width, height)
    verification = _verification(
        BOUNDS,
        width,
        height,
        tiff,
    )

    def fake_fetch(
        bounds,
        *,
        service_url,
        width_px,
        height_px,
        timeout_s,
        session,
    ):
        assert bounds == BOUNDS
        assert width_px == width
        assert height_px == height

        return tiff, verification

    monkeypatch.setattr(
        dem,
        "fetch_verified_dem",
        fake_fetch,
    )

    builder = builder_module.HillshadeReliefBuilder(
        session=object()
    )
    source = builder.prepare_source_data(_ctx())

    assert source["hillshade_bytes"] == b""
    assert (
        source["basemap_meta"]["has_hillshade"]
        is False
    )
    assert dem.verification_ok(
        source["dem_verification"]
    )

    monkeypatch.setattr(
        builder,
        "_build_context_layers",
        lambda ctx, base_bytes, progress=None: ({}, {}),
    )

    package = builder.build_package(
        _ctx(),
        source,
    )

    ok, reason = builder.validate_package(package)

    assert ok is True, reason

    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        names = set(archive.namelist())
        manifest = json.loads(
            archive.read("manifest.json")
        )

    assert "hillshade.png" not in names
    assert (
        manifest["elevation"]["export_contract"]
        == dem.DEM_EXPORT_CONTRACT
    )
    assert (
        manifest["elevation"]["extent_verified"]
        is True
    )
    assert (
        manifest["terrain"]["bounds"]
        == pytest.approx(
            verification["raster_bounds"]
        )
    )


def test_builder_rejects_missing_verification_record(
    monkeypatch,
):
    builder = builder_module.HillshadeReliefBuilder(
        session=object()
    )

    monkeypatch.setattr(
        builder,
        "_build_context_layers",
        lambda ctx, base_bytes, progress=None: ({}, {}),
    )

    with pytest.raises(
        builder_module.OfflineSceneBuildError,
        match="verification record",
    ):
        builder.build_package(
            _ctx(),
            {
                "dem_bytes": b"not-used",
                "dem_verification": {},
                "usgs_meta": {},
                "basemap_meta": {
                    "has_hillshade": False,
                },
            },
        )


def test_prepare_translates_contract_failure(
    monkeypatch,
):
    def fail_fetch(*args, **kwargs):
        raise dem.DemContractError(
            "service adjusted the export"
        )

    monkeypatch.setattr(
        dem,
        "fetch_verified_dem",
        fail_fetch,
    )

    builder = builder_module.HillshadeReliefBuilder(
        session=object()
    )

    with pytest.raises(
        builder_module.OfflineSceneBuildError,
        match="exact-extent verification failed",
    ):
        builder.prepare_source_data(_ctx())
