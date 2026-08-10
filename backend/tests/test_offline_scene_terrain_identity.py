from app.services import offline_scene as scene
from app.services import offline_scene_terrain as terrain
from app.worker import offline_scene_worker as worker


def test_hillshade_contract_change_changes_package_content_signature(monkeypatch):
    base = {
        "gisa_updated_at": "2026-08-10T00:00:00",
        "geometry_json": None,
        "road_bearing_deg": 90.0,
        "radius_m": 1500.0,
        "road_provider": "caltrans_crs",
        "road_filter_version": "classes:1,2,3",
        "imagery_export_contract": "imagery-v3",
    }

    original_identity = worker._terrain_content_identity()
    original_signature = scene.content_signature(
        **base,
        terrain_export_contract=original_identity,
    )

    monkeypatch.setattr(
        terrain,
        "HILLSHADE_ALGORITHM",
        "local_verified_dem_gradient_v2",
    )

    changed_identity = worker._terrain_content_identity()
    changed_signature = scene.content_signature(
        **base,
        terrain_export_contract=changed_identity,
    )

    assert changed_identity != original_identity
    assert changed_signature != original_signature
