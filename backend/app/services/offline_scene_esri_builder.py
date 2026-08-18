"""High-fidelity ERIS mobile package builder.

Wraps the existing USGS/ERIS builder rather than replacing its analytical data.
The resulting package remains `eristerrain`, so MinIO/catalog/download/integrity
and all existing context layers keep their contract.  One additional immutable
asset, `esri-terrain.tpkx`, is embedded and declared as the preferred rendering
surface for native ArcGIS Runtime.
"""

from __future__ import annotations

import io
import json
import zipfile

from sqlalchemy.orm import Session

from ..config import settings
from .offline_scene_builder import OfflineSceneBuildError, get_builder
from .offline_scene_esri_elevation import (
    ESRI_TERRAIN_EXPORT_CONTRACT,
    ESRI_TERRAIN_FILE,
    EsriTerrainExportError,
    export_terrain_tpkx,
)

RENDER_SURFACE_ESRI = "esri_tiled_elevation"
ERIS_ESRI_FORMAT_VERSION = 3


class EsriOfflineTerrainBuilder:
    """Decorator around the current production builder.

    USGS remains mandatory and is built first. Esri Terrain3D is then exported for
    the exact same AOI and embedded as the preferred visualization surface. We
    intentionally fail closed if the Esri export cannot be created: publishing a
    new package that silently falls back to the coarse legacy renderer would defeat
    this migration's fidelity requirement.
    """

    package_format = "eristerrain"

    def __init__(self, base=None):
        self.base = base or get_builder()

    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        source = self.base.prepare_source_data(ctx, progress=progress)
        if progress:
            progress("BUILDING_TERRAIN", "Exporting high-fidelity Esri Terrain 3D tiles")

        token = str(settings.ARCGIS_API_KEY or "").strip()
        if not settings.ARCGIS_RUNTIME_ENABLED:
            raise OfflineSceneBuildError(
                "ArcGIS Runtime is disabled. Enable ArcGIS Runtime before generating "
                "high-fidelity mobile terrain packages."
            )
        try:
            terrain_bytes, terrain_meta = export_terrain_tpkx(
                ctx["bounds"],
                token=token,
                timeout_s=max(15, int(settings.OFFLINE_SCENE_FETCH_TIMEOUT_S)),
                max_wait_s=max(120, int(settings.OFFLINE_SCENE_FETCH_TIMEOUT_S) * 5),
            )
        except EsriTerrainExportError as exc:
            raise OfflineSceneBuildError(str(exc)) from exc

        result = dict(source)
        result["esri_terrain_bytes"] = terrain_bytes
        result["esri_terrain_meta"] = terrain_meta
        return result

    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        base_bytes = self.base.build_package(ctx, source, progress=progress)
        terrain_bytes = source.get("esri_terrain_bytes")
        terrain_meta = source.get("esri_terrain_meta")
        if not isinstance(terrain_bytes, (bytes, bytearray)) or not isinstance(terrain_meta, dict):
            raise OfflineSceneBuildError("High-fidelity Esri terrain payload is missing")

        src = io.BytesIO(base_bytes)
        out = io.BytesIO()
        with zipfile.ZipFile(src, "r") as zin:
            try:
                manifest = json.loads(zin.read("manifest.json"))
            except Exception as exc:
                raise OfflineSceneBuildError("Base ERIS package manifest could not be read") from exc

            manifest["format_version"] = max(
                ERIS_ESRI_FORMAT_VERSION,
                int(manifest.get("format_version", 0) or 0),
            )
            manifest["render_surface"] = {
                "type": RENDER_SURFACE_ESRI,
                "file": ESRI_TERRAIN_FILE,
                "fallback": "usgs_height_grid",
                "export_contract": ESRI_TERRAIN_EXPORT_CONTRACT,
            }
            context = manifest.setdefault("context_layers", {})
            context["esri_elevation"] = terrain_meta
            files = manifest.setdefault("files", {})
            files["esri_elevation"] = ESRI_TERRAIN_FILE

            # Keep every legacy asset byte-for-byte and replace only manifest.json.
            # STORED is intentional: the mobile extractor is deterministic and does
            # not require a general-purpose ZIP decompressor.
            with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as zout:
                zout.writestr(
                    "manifest.json",
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")),
                )
                for info in zin.infolist():
                    if info.filename == "manifest.json" or info.filename == ESRI_TERRAIN_FILE:
                        continue
                    zout.writestr(info.filename, zin.read(info.filename))
                zout.writestr(ESRI_TERRAIN_FILE, bytes(terrain_bytes))
        return out.getvalue()

    def validate_package(self, package_bytes: bytes) -> tuple[bool, str | None]:
        ok, reason = self.base.validate_package(package_bytes)
        if not ok:
            return ok, reason
        try:
            with zipfile.ZipFile(io.BytesIO(package_bytes), "r") as zf:
                manifest = json.loads(zf.read("manifest.json"))
                render = manifest.get("render_surface") or {}
                layer = (manifest.get("context_layers") or {}).get("esri_elevation") or {}
                if render.get("type") != RENDER_SURFACE_ESRI:
                    return False, "package does not select Esri tiled elevation as render surface"
                if render.get("file") != ESRI_TERRAIN_FILE:
                    return False, "Esri render-surface file does not match contract"
                if layer.get("available") is not True or layer.get("file") != ESRI_TERRAIN_FILE:
                    return False, "Esri elevation layer is not declared available"
                if layer.get("format") != "tpkx" or layer.get("encoding") != "LERC":
                    return False, "Esri elevation layer is not a CompactV2/LERC tile package"
                if ESRI_TERRAIN_FILE not in zf.namelist():
                    return False, "missing Esri Terrain3D tile package"
        except Exception as exc:
            return False, f"Esri terrain package validation error: {exc}"
        return True, None

    def upload_and_register(
        self,
        db: Session,
        ctx: dict,
        package_bytes: bytes,
        source: dict,
        job_id: int | None = None,
    ) -> dict:
        # Reuse the mature immutable MinIO + catalog + cancellation transaction.
        return self.base.upload_and_register(
            db, ctx, package_bytes, source, job_id=job_id
        )


def get_esri_builder() -> EsriOfflineTerrainBuilder:
    return EsriOfflineTerrainBuilder()
