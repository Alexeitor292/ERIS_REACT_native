import json

import pytest

from app.services.offline_scene_esri_elevation import (
    ESRI_IMAGERY_EXPORT_CONTRACT,
    ESRI_IMAGERY_FILE,
    ESRI_TERRAIN_EXPORT_CONTRACT,
    ESRI_TERRAIN_FILE,
    EsriTerrainExportError,
    _aoi,
    _available_levels,
    _job_urls,
    export_imagery_tpkx,
    export_terrain_tpkx,
)


def test_esri_visual_contracts_are_versioned_tpkx_assets():
    assert ESRI_TERRAIN_FILE.endswith(".tpkx")
    assert ESRI_IMAGERY_FILE.endswith(".tpkx")
    assert ESRI_TERRAIN_FILE != ESRI_IMAGERY_FILE
    assert "compactv2" in ESRI_TERRAIN_EXPORT_CONTRACT
    assert "lerc" in ESRI_TERRAIN_EXPORT_CONTRACT
    assert "compactv2" in ESRI_IMAGERY_EXPORT_CONTRACT


def test_available_levels_uses_every_advertised_lod_without_duplicates():
    info = {
        "tileInfo": {
            "lods": [
                {"level": 0, "resolution": 1},
                {"level": 1, "resolution": 0.5},
                {"level": 1, "resolution": 0.5},
                {"level": 3, "resolution": 0.125},
                {"level": "4"},
            ]
        }
    }
    assert _available_levels(info) == [0, 1, 3]


def test_aoi_is_closed_wgs84_polygon_matching_package_bounds():
    bounds = {"min_lon": -121.25, "min_lat": 38.5, "max_lon": -121.1, "max_lat": 38.65}
    obj = json.loads(_aoi(bounds))
    feature = obj["features"][0]
    ring = feature["geometry"]["rings"][0]
    assert ring[0] == [-121.25, 38.5]
    assert ring[-1] == ring[0]
    assert feature["geometry"]["spatialReference"]["wkid"] == 4326


def test_job_urls_support_both_arcgis_async_shapes():
    urls = _job_urls("https://example.test/arcgis/rest/services/Terrain/ImageServer", "j123")
    assert urls == [
        "https://example.test/arcgis/rest/services/Terrain/ImageServer/jobs/j123",
        "https://example.test/arcgis/rest/services/Terrain/ImageServer/exportTiles/jobs/j123",
    ]


@pytest.mark.parametrize("exporter", [export_terrain_tpkx, export_imagery_tpkx])
def test_exports_require_worker_side_arcgis_authentication_before_network(exporter):
    with pytest.raises(EsriTerrainExportError, match="authentication is required"):
        exporter(
            {"min_lon": -121.25, "min_lat": 38.5, "max_lon": -121.1, "max_lat": 38.65},
            token="",
        )
