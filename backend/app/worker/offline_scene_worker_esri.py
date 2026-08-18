"""Production worker entrypoint for high-fidelity mobile terrain packages.

Keeps the proven queue/state/cancellation implementation in offline_scene_worker
unchanged, while replacing its builder factory and visual content identity with
the Esri-enabled ERIS builder. This preserves the existing worker recovery model.
"""

from __future__ import annotations

from . import offline_scene_worker as worker
from ..services.offline_scene_esri_builder import get_esri_builder
from ..services.offline_scene_esri_elevation import (
    ESRI_IMAGERY_EXPORT_CONTRACT,
    ESRI_TERRAIN_EXPORT_CONTRACT,
)


# process_job() resolves get_builder from its module globals at call time.
worker.get_builder = get_esri_builder

_legacy_terrain_identity = worker._terrain_content_identity


def _esri_terrain_identity() -> str:
    # Forces a content-signature change whenever either native Esri visual cache
    # contract changes, so devices never treat a legacy/coarser package as current.
    return (
        f"{_legacy_terrain_identity()}:"
        f"{ESRI_TERRAIN_EXPORT_CONTRACT}:{ESRI_IMAGERY_EXPORT_CONTRACT}"
    )


worker._terrain_content_identity = _esri_terrain_identity


def run_worker() -> None:
    worker.run_worker()


if __name__ == "__main__":  # pragma: no cover
    run_worker()
