"""
Automatic offline 3D package builder.

ERIS generates a bounded offline 3D terrain package automatically — no manual
ArcGIS Pro authoring. Chosen format: an ERIS terrain bundle ('eristerrain', a zip)
because automated true-.mspk authoring requires ArcGIS Pro (Windows + license),
which is not available on a Linux worker. The bundle contains a clipped USGS 3DEP
DEM, a server-rendered hillshade, ERIS overlays, and a manifest, and is rendered
natively at runtime (AGSScene from the local DEM + hillshade).

Provider interface (OfflineScenePackageBuilder):
  prepare_source_data() -> fetch + clip USGS 3DEP for the AOI
  build_package()        -> assemble the bundle bytes
  validate_package()     -> structural validation that it opens as a real bundle
  upload_and_register()  -> immutable MinIO upload + catalog registration (verified)

The heavy network/raster work is isolated in HillshadeReliefBuilder; the assembly,
manifest, and validation are pure and unit-tested.
"""

from __future__ import annotations

import io
import json
import math
import zipfile
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..config import settings
from ..storage import put_object_bytes
from . import offline_scene as offline_scene_svc
from .offline_scene_catalog import register_ready_package

BUNDLE_FORMAT = "eristerrain"
_TIFF_MAGICS = (b"II*\x00", b"MM\x00*")
_M_PER_DEG_LAT = 111_320.0


# ---- pure helpers (no network) --------------------------------------------

def export_image_params(bounds: dict, px: int) -> dict:
    """ArcGIS ImageServer exportImage query params for the AOI bbox (WGS84)."""
    bbox = f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
    return {"bbox": bbox, "bboxSR": "4326", "imageSR": "4326", "size": f"{px},{px}", "f": "image"}


def aoi_resolution_m(bounds: dict, center_lat: float, px: int) -> float:
    """Approx ground resolution (metres/pixel) for the exported AOI image."""
    width_m = (bounds["max_lon"] - bounds["min_lon"]) * _M_PER_DEG_LAT * max(1e-6, math.cos(math.radians(center_lat)))
    return round(width_m / max(1, px), 2)


def build_manifest(ctx: dict, usgs_meta: dict, basemap_meta: dict) -> dict:
    return {
        "format": BUNDLE_FORMAT,
        "format_version": 1,
        "submission_id": ctx["submission_id"],
        "package_version": ctx["package_version"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "area": {"center": ctx["center"], "radius_m": ctx["radius_m"], "bounds": ctx["bounds"]},
        "elevation": {
            "source": offline_scene_svc.ELEVATION_SOURCE_3DEP,
            "dataset": usgs_meta.get("dataset"),
            "version": usgs_meta.get("version"),
            "resolution": usgs_meta.get("resolution"),
            "service": usgs_meta.get("service"),
        },
        "basemap": basemap_meta,
        "overlays": ctx.get("overlays") or {},
        "content_signature": ctx["content_signature"],
        "files": {"dem": "dem.tif", "hillshade": "hillshade.png", "overlays": "overlays.json", "manifest": "manifest.json"},
    }


def assemble_bundle(dem_bytes: bytes, hillshade_bytes: bytes, overlays: dict, manifest: dict) -> bytes:
    """Zip the bundle deterministically (manifest + DEM + hillshade + overlays)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, sort_keys=True, separators=(",", ":")))
        zf.writestr("dem.tif", dem_bytes)
        if hillshade_bytes:
            zf.writestr("hillshade.png", hillshade_bytes)
        zf.writestr("overlays.json", json.dumps(overlays or {}, sort_keys=True, separators=(",", ":")))
    return buf.getvalue()


def validate_bundle_bytes(package_bytes: bytes) -> tuple[bool, str | None]:
    """Structural validation that this opens as a real ERIS terrain bundle: a valid
    zip with a manifest, a non-trivial DEM that is a real TIFF (magic bytes), and a
    recognized format. Returns (ok, reason)."""
    try:
        with zipfile.ZipFile(io.BytesIO(package_bytes)) as zf:
            names = set(zf.namelist())
            if "manifest.json" not in names:
                return False, "missing manifest.json"
            if "dem.tif" not in names:
                return False, "missing dem.tif"
            manifest = json.loads(zf.read("manifest.json"))
            if manifest.get("format") != BUNDLE_FORMAT:
                return False, f"unexpected format {manifest.get('format')!r}"
            if manifest.get("elevation", {}).get("source") != offline_scene_svc.ELEVATION_SOURCE_3DEP:
                return False, "elevation source is not USGS_3DEP"
            dem = zf.read("dem.tif")
            if len(dem) < 256:
                return False, "DEM too small to be real 3DEP coverage"
            if not dem.startswith(_TIFF_MAGICS):
                return False, "DEM is not a valid TIFF (3DEP fetch likely failed)"
    except zipfile.BadZipFile:
        return False, "not a valid package archive"
    except Exception as e:  # pragma: no cover - defensive
        return False, f"validation error: {e}"
    return True, None


# ---- provider interface ----------------------------------------------------

class OfflineSceneBuildError(Exception):
    pass


class OfflineScenePackageBuilder(ABC):
    package_format = BUNDLE_FORMAT

    @abstractmethod
    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        """Fetch + clip the authoritative USGS 3DEP terrain for the AOI. Returns
        {dem_bytes, hillshade_bytes, usgs_meta, basemap_meta}."""

    @abstractmethod
    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        ...

    def validate_package(self, package_bytes: bytes) -> tuple[bool, str | None]:
        return validate_bundle_bytes(package_bytes)

    def upload_and_register(self, db: Session, ctx: dict, package_bytes: dict | bytes, source: dict) -> dict:
        """Immutable MinIO upload + verified catalog registration. Only marks READY
        after the catalog re-verifies size + SHA-256 of the uploaded object."""
        import hashlib

        data = package_bytes if isinstance(package_bytes, (bytes, bytearray)) else bytes(package_bytes)
        sha = hashlib.sha256(data).hexdigest()
        size = len(data)
        object_key = offline_scene_svc.make_scene_object_key(
            ctx["submission_id"], ctx["package_version"], self.package_format
        )
        bucket = settings.MINIO_OFFLINE_SCENES_BUCKET
        put_object_bytes(object_key=object_key, data=data, content_type="application/zip", bucket=bucket)

        usgs = source.get("usgs_meta") or {}
        basemap = source.get("basemap_meta") or {}
        return register_ready_package(
            db,
            submission_id=ctx["submission_id"],
            package_version=ctx["package_version"],
            sha256=sha,
            size_bytes=size,
            min_lat=ctx["bounds"]["min_lat"], min_lon=ctx["bounds"]["min_lon"],
            max_lat=ctx["bounds"]["max_lat"], max_lon=ctx["bounds"]["max_lon"],
            center_lat=ctx["center"]["lat"], center_lon=ctx["center"]["lon"],
            radius_m=ctx["radius_m"],
            elevation_source=offline_scene_svc.ELEVATION_SOURCE_3DEP,
            elevation_dataset=usgs.get("dataset") or settings.OFFLINE_SCENE_3DEP_DATASET,
            elevation_version=usgs.get("version") or "dynamic",
            elevation_resolution=str(usgs.get("resolution") or "unknown"),
            basemap_or_imagery_source=basemap.get("source_label") or "USGS 3DEP hillshade (terrain relief)",
            content_signature=ctx["content_signature"],
            package_format=self.package_format,
            object_key=object_key,
            uploaded_by=ctx.get("requested_by"),
            notes="Auto-generated by ERIS offline-scene worker",
            verify_sha=True,
        )


class HillshadeReliefBuilder(OfflineScenePackageBuilder):
    """MVP, licence-clean builder: a clipped USGS 3DEP DEM + a server-rendered
    hillshade (terrain relief). No streamed Esri/Google imagery is cached. A
    licensed offline imagery provider can replace the basemap step later."""

    def __init__(self, session=None):
        # Lazy import so the module loads without `requests` in pure-test contexts.
        import requests  # noqa: F401
        self._requests = requests
        self._session = session or requests.Session()

    def _export(self, params: dict) -> bytes:
        url = settings.OFFLINE_SCENE_3DEP_IMAGESERVER.rstrip("/") + "/exportImage"
        resp = self._session.get(url, params=params, timeout=settings.OFFLINE_SCENE_FETCH_TIMEOUT_S)
        resp.raise_for_status()
        ctype = resp.headers.get("Content-Type", "")
        if "json" in ctype:  # ArcGIS returns an error as JSON with HTTP 200
            raise OfflineSceneBuildError(f"3DEP export error: {resp.text[:200]}")
        return resp.content

    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        px = int(settings.OFFLINE_SCENE_EXPORT_PX)
        base = export_image_params(ctx["bounds"], px)
        # Real 32-bit float elevation (the local terrain surface).
        dem_bytes = self._export({**base, "format": "tiff", "pixelType": "F32"})
        if not dem_bytes or not dem_bytes.startswith(_TIFF_MAGICS):
            raise OfflineSceneBuildError("USGS 3DEP did not return a valid DEM for this area.")
        if progress:
            progress("BUILDING_TERRAIN", "Rendering hillshade from USGS 3DEP")
        # Server-rendered hillshade (licence-clean relief imagery).
        hillshade_bytes = b""
        try:
            rule = json.dumps({"rasterFunction": "Hillshade Gray"})
            hillshade_bytes = self._export({**base, "format": "png", "renderingRule": rule})
        except Exception:
            hillshade_bytes = b""  # terrain still works from the DEM alone
        resolution = aoi_resolution_m(ctx["bounds"], ctx["center"]["lat"], px)
        usgs_meta = {
            "dataset": settings.OFFLINE_SCENE_3DEP_DATASET,
            "version": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "resolution": f"{resolution} m/px",
            "service": settings.OFFLINE_SCENE_3DEP_IMAGESERVER,
        }
        basemap_meta = {
            "provider": settings.OFFLINE_SCENE_IMAGERY_PROVIDER,
            "source_label": "USGS 3DEP hillshade (terrain relief)" if hillshade_bytes else "USGS 3DEP terrain relief",
            "has_imagery": False,
        }
        return {"dem_bytes": dem_bytes, "hillshade_bytes": hillshade_bytes, "usgs_meta": usgs_meta, "basemap_meta": basemap_meta}

    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        manifest = build_manifest(ctx, source["usgs_meta"], source["basemap_meta"])
        return assemble_bundle(source["dem_bytes"], source.get("hillshade_bytes") or b"", ctx.get("overlays") or {}, manifest)


def get_builder() -> OfflineScenePackageBuilder:
    """Provider factory. Only the hillshade (USGS 3DEP) provider exists today; a
    licensed offline-imagery provider can be selected here later."""
    return HillshadeReliefBuilder()
