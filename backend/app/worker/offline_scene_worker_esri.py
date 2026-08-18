"""Production worker entrypoint for high-fidelity mobile terrain packages.

Keeps the proven queue/state/cancellation implementation in offline_scene_worker
unchanged, while replacing its builder factory and terrain content identity with
the Esri-enabled ERIS builder.  This intentionally makes the migration small and
reversible and preserves all worker recovery semantics.
"""

from __future__ import annotations

from . import offline_scene_worker as worker
from ..services.offline_scene_esri_builder import get_esri_builder
from ..services.offline_scene_esri_elevation import ESRI_TERRAIN_EXPORT_CONTRACT


# process_job() resolves get_builder from its module globals at call time.
worker.get_builder = get_esri_builder

_legacy_terrain_identity = worker._terrain_content_identity


def _esri_terrain_identity() -> str:
    # Forces a content-signature change so devices holding a legacy height-field
    # package are offered the new Esri-tiled package for the same incident/AOI.
    return f"{_legacy_terrain_identity()}:{ESRI_TERRAIN_EXPORT_CONTRACT}"


worker._terrain_content_identity = _esri_terrain_identity


def run_worker() -> None:
    worker.run_worker()


if __name__ == "__main__":  # pragma: no cover
    run_worker()
