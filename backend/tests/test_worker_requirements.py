"""Lightweight regression guard for the offline-scene worker image dependencies.

The worker (HillshadeReliefBuilder + offline_scene_terrain) needs a geospatial
stack that the slim API image deliberately does NOT carry: requests (USGS fetch),
numpy, rasterio (DEM decode), Pillow. requirements-worker.txt is the single source
of truth for the worker Docker image, so assert every import the worker performs is
declared there. This runs in the standard (non-Docker) suite so a dropped pin fails
CI immediately instead of only at `docker build` time.

The actual image build + in-image import smoke test is documented in
Dockerfile.worker / the ADR and run as part of release validation.
"""

from __future__ import annotations

import re
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
WORKER_REQS = BACKEND_ROOT / "requirements-worker.txt"

# Top-level packages the worker imports at runtime (import name may differ from the
# distribution name, e.g. PIL <- Pillow). Map distribution -> why it is needed.
REQUIRED_WORKER_DISTS = {
    "requests": "HillshadeReliefBuilder fetches the USGS 3DEP DEM/hillshade",
    "numpy": "offline_scene_terrain encodes the canonical float32 height grid",
    "rasterio": "offline_scene_terrain.decode_dem_tiff decodes the 3DEP GeoTIFF",
    "Pillow": "hillshade PNG handling",
}


def _declared_dist_names(text: str) -> set[str]:
    names: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        # Strip version specifiers / extras / markers; keep the distribution name.
        name = re.split(r"[<>=!~;\[ ]", line, maxsplit=1)[0].strip()
        if name:
            names.add(name.lower())
    return names


def test_worker_requirements_extends_api_requirements():
    text = WORKER_REQS.read_text(encoding="utf-8")
    assert "-r requirements.txt" in text, "worker reqs must extend the API requirements"


def test_worker_requirements_declare_every_worker_import():
    declared = _declared_dist_names(WORKER_REQS.read_text(encoding="utf-8"))
    missing = [dist for dist in REQUIRED_WORKER_DISTS if dist.lower() not in declared]
    assert not missing, (
        "requirements-worker.txt is missing worker imports "
        f"{missing}; needed because: "
        + "; ".join(f"{d} -> {REQUIRED_WORKER_DISTS[d]}" for d in missing)
    )


def test_requests_is_pinned_compatibly():
    # requests must be present with an explicit version floor so the worker image
    # cannot silently regress to an incompatible/absent requests.
    text = WORKER_REQS.read_text(encoding="utf-8")
    match = re.search(r"^\s*requests\b.*$", text, flags=re.MULTILINE)
    assert match, "requests must be declared explicitly in requirements-worker.txt"
    assert re.search(r">=\s*2\.", match.group(0)), "requests should pin a >=2.x floor"
