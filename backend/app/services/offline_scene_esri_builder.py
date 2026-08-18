"""High-fidelity ERIS mobile package builder.

Wraps the existing USGS/ERIS builder rather than replacing its analytical data.
The resulting package remains an ERIS terrain bundle, so MinIO/catalog/download/
integrity and all existing context layers keep their contract. Two immutable Esri
sidecars are embedded for native ArcGIS Runtime visualization:
`esri-terrain.tpkx` (Terrain 3D LERC elevation) and `esri-imagery.tpkx`
(World Imagery raster tiles).
"""

from __future__ import annotations

import io
import json
import zipfile

from sqlalchemy.orm import Session

from ..config import settings
from .offline_scene_builder import OfflineSceneBuildError, get_builder
from .offline_scene_esri_elevation import (
    ESRI_IMAGERY_EXPORT_CONTRACT,
    ESRI_IMAGERY_FILE,
    ESRI_TERRAIN_EXPORT_CONTRACT,
    ESRI_TERRAIN_FILE,
    EsriTerrainExportError,
    export_imagery_tpkx,
    export_terrain_tpkx,
)

RENDER_SURFACE_ESRI = "esri_tiled_elevation"
ERIS_ESRI_FORMAT_VERSION = 3
PACKAGE_FORMAT_ESRI = "eristerrain_esri"


class EsriOfflineTerrainBuilder:
    """Decorator around the current production builder.

    USGS remains mandatory and is built first. Esri Terrain3D + World Imagery are
    then exported for the exact same AOI and embedded as the preferred visual
    surface/basemap. We intentionally fail closed if either Esri export cannot be
    created: a package carrying the new format must never silently fall back to
    the coarse legacy visualization.
    """

    package_format = PACKAGE_FORMAT_ESRI

    def __init__(self, base=None):
        # get_builder() returns a fresh builder instance for every job. This wrapper
        # therefore owns the instance and may safely set its package_format only
        # during registration without cross-job shared-state leakage.
        self.base = base or get_builder()

    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        source = self.base.prepare_source_data(ctx, progress=progress)
        token = str(settings.ARCGIS_API_KEY or "").strip()
        if not settings.ARCGIS_RUNTIME_ENABLED:
            raise OfflineSceneBuildError(
                "ArcGIS Runtime is disabled. Enable ArcGIS Runtime before generating "
                "high-fidelity mobile terrain packages."
            )
        timeout_s = max(15, int(settings.OFFLINE_SCENE_FETCH_TIMEOUT_S))
        max_wait_s = max(120, timeout_s * 5)
        try:
            if progress:
                progress("BUILDING_TERRAIN", "Exporting high-fidelity Esri Terrain 3D tiles")
            terrain_bytes, terrain_meta = export_terrain_tpkx(
                ctx["bounds"], token=token,
                timeout_s=timeout_s, max_wait_s=max_wait_s,
            )
            if progress:
                progress("BUILDING_BASEMAP", "Exporting Esri World Imagery for offline 3D")
            imagery_bytes, imagery_meta = export_imagery_tpkx(
                ctx["bounds"], token=token,
                timeout_s=timeout_s, max_wait_s=max_wait_s,
            )
        except EsriTerrainExportError as exc:
            raise OfflineSceneBuildError(str(exc)) from exc

        result = dict(source)
        result["esri_terrain_bytes"] = terrain_bytes
        result["esri_terrain_meta"] = terrain_meta
        result["esri_imagery_bytes"] = imagery_bytes
        result["esri_imagery_meta"] = imagery_meta
        return result

    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        base_bytes = self.base.build_package(ctx, source, progress=progress)
        terrain_bytes = source.get("esri_terrain_bytes")
        terrain_meta = source.get("esri_terrain_meta")
        imagery_bytes = source.get("esri_imagery_bytes")
        imagery_meta = source.get("esri_imagery_meta")
        if not isinstance(terrain_bytes, (bytes, bytearray)) or not isinstance(terrain_meta, dict):
            raise OfflineSceneBuildError("High-fidelity Esri terrain payload is missing")
        if not isinstance(imagery_bytes, (bytes, bytearray)) or not isinstance(imagery_meta, dict):
            raise OfflineSceneBuildError("Esri World Imagery offline payload is missing")

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
            manifest["package_format"] = PACKAGE_FORMAT_ESRI
            manifest["render_surface"] = {
                "type": RENDER_SURFACE_ESRI,
                "file": ESRI_TERRAIN_FILE,
                "fallback": "usgs_height_grid",
                "export_contract": ESRI_TERRAIN_EXPORT_CONTRACT,
            }
            manifest["render_basemap"] = {
                "type": "esri_world_imagery",
                "file": ESRI_IMAGERY_FILE,
                "export_contract": ESRI_IMAGERY_EXPORT_CONTRACT,
            }
            context = manifest.setdefault("context_layers", {})
            context["esri_elevation"] = terrain_meta
            context["esri_imagery"] = imagery_meta
            files = manifest.setdefault("files", {})
            files["esri_elevation"] = ESRI_TERRAIN_FILE
            files["esri_imagery"] = ESRI_IMAGERY_FILE

            with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as zout:
                zout.writestr(
                    "manifest.json",
                    json.dumps(manifest, sort_keys=True, separators=(",", ":")),
                )
                for info in zin.infolist():
                    if info.filename in {"manifest.json", ESRI_TERRAIN_FILE, ESRI_IMAGERY_FILE}:
                        continue
                    zout.writestr(info.filename, zin.read(info.filename))
                zout.writestr(ESRI_TERRAIN_FILE, bytes(terrain_bytes))
                zout.writestr(ESRI_IMAGERY_FILE, bytes(imagery_bytes))
        return out.getvalue()

    def validate_package(self, package_bytes: bytes) -> tuple[bool, str | None]:
        ok, reason = self.base.validate_package(package_bytes)
        if not ok:
            return ok, reason
        try:
            with zipfile.ZipFile(io.BytesIO(package_bytes), "r") as zf:
                manifest = json.loads(zf.read("manifest.json"))
                context = manifest.get("context_layers") or {}
                render = manifest.get("render_surface") or {}
                basemap = manifest.get("render_basemap") or {}
                elevation = context.get("esri_elevation") or {}
                imagery = context.get("esri_imagery") or {}
                if manifest.get("package_format") != PACKAGE_FORMAT_ESRI:
                    return False, "package format does not identify Esri tiled terrain"
                if render.get("type") != RENDER_SURFACE_ESRI or render.get("file") != ESRI_TERRAIN_FILE:
                    return False, "package does not select the Esri tiled elevation render surface"
                if basemap.get("type") != "esri_world_imagery" or basemap.get("file") != ESRI_IMAGERY_FILE:
                    return False, "package does not select the Esri World Imagery offline basemap"
                if elevation.get("available") is not True or elevation.get("file") != ESRI_TERRAIN_FILE:
                    return False, "Esri elevation layer is not declared available"
                if elevation.get("format") != "tpkx" or elevation.get("encoding") != "LERC":
                    return False, "Esri elevation layer is not a CompactV2/LERC tile package"
                if imagery.get("available") is not True or imagery.get("file") != ESRI_IMAGERY_FILE:
                    return False, "Esri imagery layer is not declared available"
                if imagery.get("format") != "tpkx":
                    return False, "Esri imagery layer is not a CompactV2 tile package"
                names = set(zf.namelist())
                if ESRI_TERRAIN_FILE not in names:
                    return False, "missing Esri Terrain3D tile package"
                if ESRI_IMAGERY_FILE not in names:
                    return False, "missing Esri World Imagery tile package"
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
        previous_format = self.base.package_format
        self.base.package_format = self.package_format
        try:
            return self.base.upload_and_register(
                db, ctx, package_bytes, source, job_id=job_id
            )
        finally:
            self.base.package_format = previous_format


def get_esri_builder() -> EsriOfflineTerrainBuilder:
    return EsriOfflineTerrainBuilder()
