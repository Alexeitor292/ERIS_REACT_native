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
import logging
import math
import zipfile
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..config import settings
from ..storage import put_object_bytes
from . import offline_scene as offline_scene_svc
from . import offline_scene_context as context_fmt
from . import offline_scene_terrain as terrain_fmt
from .offline_scene_catalog import JobCancelledError, register_ready_package

logger = logging.getLogger("eris.offline_scene_builder")

BUNDLE_FORMAT = "eristerrain"
FORMAT_VERSION = 2  # canonical height-grid bundle (v1 was a raw-TIFF prototype)
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


def build_manifest(
    ctx: dict, usgs_meta: dict, basemap_meta: dict, terrain_meta: dict, context_layers: dict | None = None
) -> dict:
    has_hillshade = bool(basemap_meta.get("has_hillshade"))
    files = {
        "manifest": "manifest.json",
        "terrain": terrain_meta["file"],
        "overlays": "overlays.json",
    }
    if has_hillshade:
        files["hillshade"] = "hillshade.png"
    # Record each declared-available context asset in the files map.
    for name, layer in (context_layers or {}).items():
        if isinstance(layer, dict) and layer.get("available") and layer.get("file"):
            files[name] = layer["file"]
    return {
        "format": BUNDLE_FORMAT,
        "format_version": FORMAT_VERSION,
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
        "terrain": terrain_meta,
        "basemap": basemap_meta,
        # Backward compatible: legacy readers ignore context_layers; new readers
        # treat an absent block / layer as "unavailable" (never corrupt).
        "context_layers": context_layers or {},
        "overlays": ctx.get("overlays") or {},
        "content_signature": ctx["content_signature"],
        "files": files,
    }


def assemble_bundle(
    grid_bytes: bytes, hillshade_bytes: bytes, overlays: dict, manifest: dict,
    extra_assets: dict[str, bytes] | None = None,
) -> bytes:
    """Zip the bundle deterministically (manifest + height grid + hillshade +
    overlays + any context assets: roads.geojson / imagery.png / overview.png)."""
    grid_name = manifest.get("terrain", {}).get("file", terrain_fmt.HEIGHT_GRID_FILE)
    buf = io.BytesIO()
    # STORED (uncompressed) so the mobile client reads entries without a zlib
    # decompressor; float32 grids + PNG are not meaningfully compressible anyway.
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, sort_keys=True, separators=(",", ":")))
        zf.writestr(grid_name, grid_bytes)
        if hillshade_bytes:
            zf.writestr("hillshade.png", hillshade_bytes)
        zf.writestr("overlays.json", json.dumps(overlays or {}, sort_keys=True, separators=(",", ":")))
        for name, data in (extra_assets or {}).items():
            if data:
                zf.writestr(name, data)
    return buf.getvalue()


def validate_bundle_bytes(package_bytes: bytes) -> tuple[bool, str | None]:
    """Structural validation that this opens as a real ERIS terrain bundle: a valid
    zip, a v2+ manifest, USGS_3DEP provenance, valid terrain metadata, and a height
    grid whose byte length AND checksum match the manifest. Returns (ok, reason)."""
    try:
        with zipfile.ZipFile(io.BytesIO(package_bytes)) as zf:
            names = set(zf.namelist())
            if "manifest.json" not in names:
                return False, "missing manifest.json"
            manifest = json.loads(zf.read("manifest.json"))
            if manifest.get("format") != BUNDLE_FORMAT:
                return False, f"unexpected format {manifest.get('format')!r}"
            if int(manifest.get("format_version", 0)) < FORMAT_VERSION:
                return False, "unsupported manifest format_version"
            if manifest.get("elevation", {}).get("source") != offline_scene_svc.ELEVATION_SOURCE_3DEP:
                return False, "elevation source is not USGS_3DEP"
            terrain = manifest.get("terrain") or {}
            ok, reason = terrain_fmt.validate_terrain_metadata(terrain)
            if not ok:
                return False, reason
            grid_name = terrain.get("file", terrain_fmt.HEIGHT_GRID_FILE)
            if grid_name not in names:
                return False, f"missing terrain grid {grid_name}"
            grid = zf.read(grid_name)
            expected = int(terrain["rows"]) * int(terrain["columns"]) * 4
            if len(grid) != expected:
                return False, "terrain grid byte length does not match dimensions"
            if terrain.get("sha256") and terrain_fmt.grid_sha256(grid) != terrain["sha256"]:
                return False, "terrain grid checksum mismatch"
            # Context layers: metadata structure + every DECLARED-available asset
            # must be present and match its sha256 (and byte count when declared).
            # Absent block / layer = unavailable, not an error (backward compatible).
            context_layers = manifest.get("context_layers") or {}
            ok, reason = context_fmt.validate_context_layers(context_layers)
            if not ok:
                return False, reason
            for name, layer in context_layers.items():
                if not (isinstance(layer, dict) and layer.get("available")):
                    continue
                # Tiled imagery: every declared tile must be present + match sha256 +
                # byte count (no partial/holey imagery ever reaches a READY package).
                if name == "imagery" and layer.get("format") == "tiled":
                    for t in context_fmt.tiled_imagery_tiles(layer):
                        tname = t.get("file")
                        if tname not in names:
                            return False, f"missing imagery tile {tname}"
                        tdata = zf.read(tname)
                        if t.get("sha256") and context_fmt.sha256_hex(tdata) != t["sha256"]:
                            return False, f"imagery tile {tname} checksum mismatch"
                        if t.get("bytes") is not None and len(tdata) != int(t["bytes"]):
                            return False, f"imagery tile {tname} size mismatch"
                    continue
                fname = layer.get("file")
                if fname not in names:
                    return False, f"missing context asset {fname}"
                data = zf.read(fname)
                if layer.get("sha256") and context_fmt.sha256_hex(data) != layer["sha256"]:
                    return False, f"context asset {fname} checksum mismatch"
                if layer.get("bytes") is not None and len(data) != int(layer["bytes"]):
                    return False, f"context asset {fname} size mismatch"
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

    def upload_and_register(
        self, db: Session, ctx: dict, package_bytes: dict | bytes, source: dict, job_id: int | None = None
    ) -> dict:
        """Immutable MinIO upload + verified catalog registration. Only marks READY
        after the catalog re-verifies size + SHA-256 of the uploaded object AND (for
        a generation job) a final atomic cancellation re-check. If the job was
        cancelled, nothing is registered and the uploaded object is recorded as an
        orphan for operator cleanup (never presented as downloadable)."""
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
        try:
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
                job_id=job_id,
            )
        except JobCancelledError:
            # The object was uploaded but the job is cancelled -> orphan it (audit)
            # and re-raise so the worker leaves the job CANCELLED.
            from . import offline_scene_jobs as _jobs
            _jobs.record_orphaned_object(
                db, submission_id=ctx["submission_id"], job_id=job_id, bucket=bucket,
                object_key=object_key, sha256=sha, size_bytes=size,
                reason="cancelled_before_registration",
            )
            raise


class HillshadeReliefBuilder(OfflineScenePackageBuilder):
    """MVP, licence-clean builder: a clipped USGS 3DEP DEM + a server-rendered
    hillshade (terrain relief). No streamed Esri/Google imagery is cached. A
    licensed offline imagery provider can replace the basemap step later."""

    def __init__(self, session=None):
        # Lazy import so the module loads without `requests` in pure-test contexts.
        import random
        import time

        import requests  # noqa: F401
        self._requests = requests
        self._session = session or requests.Session()
        # Injectable clock/jitter so the tiled-imagery bounded-retry policy is testable
        # without real sleeping. Production jitter is small + bounded.
        self._sleep = time.sleep
        self._monotonic = time.monotonic
        self._jitter = lambda attempt: random.uniform(0.0, 0.5)

    def _export(self, params: dict) -> bytes:
        url = settings.OFFLINE_SCENE_3DEP_IMAGESERVER.rstrip("/") + "/exportImage"
        resp = self._session.get(url, params=params, timeout=settings.OFFLINE_SCENE_FETCH_TIMEOUT_S)
        resp.raise_for_status()
        ctype = resp.headers.get("Content-Type", "")
        if "json" in ctype:  # ArcGIS returns an error as JSON with HTTP 200
            raise OfflineSceneBuildError(f"3DEP export error: {resp.text[:200]}")
        return resp.content

    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        grid_px = int(settings.OFFLINE_SCENE_GRID_PX)
        hs_px = int(settings.OFFLINE_SCENE_EXPORT_PX)
        # Real 32-bit float elevation DEM (decoded to a height grid in build_package).
        dem_bytes = self._export({**export_image_params(ctx["bounds"], grid_px), "format": "tiff", "pixelType": "F32"})
        if not dem_bytes or not dem_bytes.startswith(_TIFF_MAGICS):
            raise OfflineSceneBuildError("USGS 3DEP did not return a valid DEM for this area.")
        if progress:
            progress("BUILDING_TERRAIN", "Rendering hillshade from USGS 3DEP")
        # Server-rendered hillshade (licence-clean relief texture).
        hillshade_bytes = b""
        try:
            rule = json.dumps({"rasterFunction": "Hillshade Gray"})
            hillshade_bytes = self._export({**export_image_params(ctx["bounds"], hs_px), "format": "png", "renderingRule": rule})
        except Exception:
            hillshade_bytes = b""  # terrain mesh still renders from the height grid alone
        resolution = aoi_resolution_m(ctx["bounds"], ctx["center"]["lat"], grid_px)
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
            "has_hillshade": bool(hillshade_bytes),
        }
        return {"dem_bytes": dem_bytes, "hillshade_bytes": hillshade_bytes, "usgs_meta": usgs_meta, "basemap_meta": basemap_meta}

    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        # Decode the real USGS 3DEP DEM (handles no-data) into the canonical height grid.
        heights = terrain_fmt.decode_dem_tiff(source["dem_bytes"], max_dim=int(settings.OFFLINE_SCENE_GRID_PX))
        grid_bytes, stats = terrain_fmt.encode_height_grid(heights)
        terrain_meta = terrain_fmt.build_terrain_metadata(stats, ctx["bounds"], terrain_fmt.grid_sha256(grid_bytes))
        hillshade_bytes = source.get("hillshade_bytes") or b""
        base_bytes = len(grid_bytes) + len(hillshade_bytes)
        context_layers, assets = self._build_context_layers(ctx, base_bytes, progress=progress)
        manifest = build_manifest(ctx, source["usgs_meta"], source["basemap_meta"], terrain_meta, context_layers)
        return assemble_bundle(grid_bytes, hillshade_bytes, ctx.get("overlays") or {}, manifest, assets)

    def _build_context_layers(self, ctx: dict, base_bytes: int, progress=None) -> tuple[dict, dict]:
        """Collect roads / optional imagery / overview into (context_layers, assets).
        Every layer degrades gracefully — a source failure marks the layer
        unavailable and NEVER corrupts the terrain package. Assets count toward
        OFFLINE_SCENE_MAX_PACKAGE_MB; the last, skippable asset (imagery) is dropped
        (reason 'too_large') before it could exceed the limit."""
        layers: dict = {}
        assets: dict = {}
        max_bytes = int(settings.OFFLINE_SCENE_MAX_PACKAGE_MB) * 1024 * 1024
        running = int(base_bytes)
        sid = ctx.get("submission_id")

        def _emit(msg: str):
            if progress:
                progress("PACKAGING", msg)

        def _log(layer: str, outcome: str, **kv):
            logger.info("offline-scene context layer submission=%s version=%s layer=%s outcome=%s %s",
                        sid, ctx.get("package_version"), layer, outcome,
                        " ".join(f"{k}={v}" for k, v in kv.items()))

        # --- Roads (default: ERIS-internal; opt-in external ArcGIS centerline adapter) ---
        roads_geojson = None
        roads_available = False
        if settings.OFFLINE_SCENE_ROADS_ENABLED:
            _emit("Collecting road context")
            try:
                external = []
                external_configured = bool(
                    settings.OFFLINE_SCENE_ROAD_SOURCE == "arcgis_feature_service" and settings.OFFLINE_SCENE_ROAD_SOURCE_URL
                )
                if external_configured:
                    bbuf = context_fmt.bounds_with_buffer(ctx["bounds"], settings.OFFLINE_SCENE_ROAD_BUFFER_M)
                    external = context_fmt.fetch_arcgis_road_features(
                        bbuf, source_url=settings.OFFLINE_SCENE_ROAD_SOURCE_URL,
                        timeout_s=int(settings.OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S), session=self._session,
                    )
                geojson, count, roads_reason = context_fmt.roads_geojson_from_context(
                    {**ctx, "external_road_features": external}, settings.OFFLINE_SCENE_ROAD_BUFFER_M,
                    external_configured=external_configured,
                )
                roads_geojson = geojson if count > 0 else None
                if count > 0:
                    data = json.dumps(geojson, separators=(",", ":")).encode("utf-8")
                    if running + len(data) <= max_bytes:
                        # Provenance must reflect the ACTUAL richest kind packaged — never
                        # claim ArcGIS centerlines (or attach the service URL) when the
                        # configured source returned nothing and only a synthetic bearing/
                        # inventory/submitted line was packaged.
                        kinds = context_fmt.road_kinds_from_geojson(geojson)
                        has_centerline = "road_centerline" in kinds
                        src = {
                            "provider": "arcgis_feature_service" if has_centerline else "eris_internal",
                            "dataset": "ArcGIS road centerlines" if has_centerline else "ERIS road context (bearing + inventory + submitted)",
                            "retrieved_at": datetime.now(timezone.utc).isoformat(),
                            "attribution": "Caltrans / ERIS road context",
                        }
                        if has_centerline:
                            src["service"] = settings.OFFLINE_SCENE_ROAD_SOURCE_URL  # sanitized by sanitize_source
                        layers["roads"] = context_fmt.available_layer(
                            context_fmt.ROADS_FILE, data, src, feature_count=count, road_kinds=kinds
                        )
                        assets[context_fmt.ROADS_FILE] = data
                        running += len(data)
                        roads_available = True
                        _log("roads", "packaged", features=count, kinds=",".join(kinds), bytes=len(data))
                    else:
                        layers["roads"] = context_fmt.unavailable_layer("too_large")
                        _log("roads", "skipped_too_large", bytes=len(data))
                else:
                    # PRECISE reason (never generic "no_data").
                    layers["roads"] = context_fmt.unavailable_layer(roads_reason or "no_road_data")
                    _log("roads", "unavailable", reason=roads_reason)
            except Exception as e:  # never corrupt the package on a road-source failure
                layers["roads"] = context_fmt.unavailable_layer("source_error")
                _log("roads", "source_error", error=str(e)[:120])
        else:
            layers["roads"] = context_fmt.unavailable_layer("disabled")

        # --- Road cross-section context (Road Inventory layout; licence-clean, tiny) ---
        if settings.OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED:
            _emit("Packaging road cross-section context")
            try:
                block = context_fmt.road_cross_section_block(ctx)
                if block is None:
                    layers["road_cross_section"] = context_fmt.unavailable_layer("no_data")
                    _log("road_cross_section", "no_data")
                else:
                    data = json.dumps(block, separators=(",", ":")).encode("utf-8")
                    if running + len(data) <= max_bytes:
                        layout_source = block.get("source", "DEFAULT")
                        # Explicit usability: the layout is packaged, but the Cross Section
                        # tool is only FULLY usable when the app can snap (roads.geojson has
                        # geometry) OR orient (upstation bearing). Flags go in the manifest so
                        # the mobile UI never implies usability it does not have.
                        usability = context_fmt.road_cross_section_usability(
                            layout_available=True,
                            layout_source=layout_source,
                            snap_available=roads_available,
                            orientation_available=block.get("upstation_bearing_deg") is not None,
                        )
                        label = context_fmt.layout_source_label(layout_source)
                        src = {
                            "provider": "eris_road_inventory" if str(layout_source).upper() == "ROAD_INVENTORY" else "eris_default_layout",
                            "dataset": f"Roadway cross-section layout ({label})",
                            "attribution": label,   # DEFAULT reads "Default roadway assumptions", NOT Road Inventory
                            "retrieved_at": datetime.now(timezone.utc).isoformat(),
                        }
                        layers["road_cross_section"] = context_fmt.available_layer(
                            context_fmt.ROAD_CROSS_SECTION_FILE, data, src, **usability,
                        )
                        assets[context_fmt.ROAD_CROSS_SECTION_FILE] = data
                        running += len(data)
                        _log("road_cross_section", "packaged", source=layout_source,
                             fully_usable=usability["fully_usable"], reason=usability["reason"], bytes=len(data))
                    else:
                        layers["road_cross_section"] = context_fmt.unavailable_layer("too_large")
                        _log("road_cross_section", "skipped_too_large", bytes=len(data))
            except Exception as e:  # never corrupt the package on a layout failure
                layers["road_cross_section"] = context_fmt.unavailable_layer("build_error")
                _log("road_cross_section", "build_error", error=str(e)[:120])
        else:
            layers["road_cross_section"] = context_fmt.unavailable_layer("disabled")

        # --- Overview inset (server-rendered; licence-clean) ---
        if settings.OFFLINE_SCENE_OVERVIEW_ENABLED:
            _emit("Creating overview map")
            try:
                overlays = ctx.get("overlays") or {}
                px = int(settings.OFFLINE_SCENE_OVERVIEW_PX)
                png = context_fmt.render_overview_png(
                    bounds=ctx["bounds"], incident=overlays.get("incident"), roads_geojson=roads_geojson,
                    geometry=overlays.get("geometry"), sample_extent=overlays.get("sampleExtent"), px=px,
                )
                if running + len(png) <= max_bytes:
                    src = {"provider": "eris_render", "attribution": "ERIS-rendered overview"}
                    layers["overview"] = context_fmt.available_layer(
                        context_fmt.OVERVIEW_FILE, png, src, width=px, height=px
                    )
                    assets[context_fmt.OVERVIEW_FILE] = png
                    running += len(png)
                    _log("overview", "packaged", bytes=len(png))
                else:
                    layers["overview"] = context_fmt.unavailable_layer("too_large")
                    _log("overview", "skipped_too_large", bytes=len(png))
            except Exception as e:
                layers["overview"] = context_fmt.unavailable_layer("render_error")
                _log("overview", "render_error", error=str(e)[:120])

        # --- Aerial imagery (opt-in; skippable last) ---
        if not settings.OFFLINE_SCENE_IMAGERY_ENABLED:
            layers["imagery"] = context_fmt.unavailable_layer("not_configured")
        elif str(settings.OFFLINE_SCENE_IMAGERY_MODE).lower() == "tiled":
            self._build_tiled_imagery(ctx, layers, assets, running, max_bytes, _emit, _log)
        else:
            self._build_single_imagery(ctx, layers, assets, running, max_bytes, _log)

        _emit("Validating offline context layers")
        return layers, assets

    def _build_single_imagery(self, ctx, layers, assets, running, max_bytes, _log):
        """Legacy single imagery.png export (one whole-AOI aerial drape)."""
        try:
            px = min(int(settings.OFFLINE_SCENE_IMAGERY_MAX_PX), 4096)
            data, src = context_fmt.fetch_imagery_png(
                ctx["bounds"], export_url=settings.OFFLINE_SCENE_IMAGERY_EXPORT_URL, px=px,
                timeout_s=int(settings.OFFLINE_SCENE_IMAGERY_FETCH_TIMEOUT_S), session=self._session,
            )
            if running + len(data) <= max_bytes:
                layers["imagery"] = context_fmt.available_layer(
                    context_fmt.IMAGERY_FILE, data, src, format="single", width=px, height=px, bounds=dict(ctx["bounds"])
                )
                assets[context_fmt.IMAGERY_FILE] = data
                _log("imagery", "packaged_single", bytes=len(data))
            else:
                layers["imagery"] = context_fmt.unavailable_layer("too_large")
                _log("imagery", "skipped_too_large", bytes=len(data))
        except Exception as e:
            if settings.OFFLINE_SCENE_IMAGERY_MANDATORY:
                raise OfflineSceneBuildError(f"Mandatory aerial imagery could not be retrieved: {e}") from e
            layers["imagery"] = context_fmt.unavailable_layer("source_error")
            _log("imagery", "source_error", error=str(e)[:120])

    def _build_tiled_imagery(self, ctx, layers, assets, running, max_bytes, _emit, _log):
        """High-definition TILED imagery: plan a gap-free tile grid, fetch each tile
        with bounded retries + backoff, and package all-or-nothing (a partial/holey
        imagery layer is NEVER declared available). Persists per-tile progress. With
        mandatory imagery, an exhausted tile fails the job with exact coordinates +
        a sanitized upstream reason."""
        from . import offline_scene_imagery as imagery

        mandatory = bool(settings.OFFLINE_SCENE_IMAGERY_MANDATORY)
        try:
            target = imagery.resolve_target_mpp(
                settings.OFFLINE_SCENE_IMAGERY_TARGET_MPP, settings.OFFLINE_SCENE_IMAGERY_SOURCE_NATIVE_MPP
            )
            plan = imagery.plan_imagery_tiles(
                ctx["bounds"],
                tile_px=int(settings.OFFLINE_SCENE_IMAGERY_TILE_PX),
                target_mpp=target,
                source_native_mpp=float(settings.OFFLINE_SCENE_IMAGERY_SOURCE_NATIVE_MPP),
                max_export_px=int(settings.OFFLINE_SCENE_IMAGERY_MAX_EXPORT_PX),
                max_tiles=int(settings.OFFLINE_SCENE_IMAGERY_MAX_TILES),
                file_ext=context_fmt.IMAGERY_TILE_EXT,
            )
            imagery.assert_no_gaps_or_overlaps(plan)
        except imagery.ImageryPlanError as e:
            if mandatory:
                raise OfflineSceneBuildError(f"Aerial imagery tile plan failed: {e}") from e
            layers["imagery"] = context_fmt.unavailable_layer(f"plan_error: {str(e)[:60]}")
            _log("imagery", "plan_error", error=str(e)[:120])
            return

        n = len(plan["tiles"])
        imagery_budget = min(int(max_bytes) - int(running), int(settings.OFFLINE_SCENE_IMAGERY_MAX_MB) * 1024 * 1024)
        tile_metas: list = []
        source_meta = None
        imagery_bytes = 0
        current: dict | None = None
        _emit(f"Packaging aerial imagery: 0 of {n} tiles")
        try:
            for i, tile in enumerate(plan["tiles"]):
                current = tile

                def _fetch(_attempt, _tile=tile):
                    return context_fmt.fetch_imagery_tile(
                        _tile["bounds"],
                        export_url=settings.OFFLINE_SCENE_IMAGERY_EXPORT_URL,
                        tile_px=int(plan["tile_size_px"]),
                        timeout_s=int(settings.OFFLINE_SCENE_IMAGERY_TILE_TIMEOUT_S),
                        jpeg_quality=int(settings.OFFLINE_SCENE_IMAGERY_JPEG_QUALITY),
                        session=self._session,
                    )

                data, src = imagery.run_with_retries(
                    _fetch,
                    retries=int(settings.OFFLINE_SCENE_IMAGERY_TILE_RETRIES),
                    deadline_s=float(settings.OFFLINE_SCENE_IMAGERY_OVERALL_DEADLINE_S),
                    sleep=self._sleep, monotonic=self._monotonic, jitter=self._jitter,
                )
                source_meta = source_meta or src
                imagery_bytes += len(data)
                if imagery_bytes > imagery_budget:
                    raise imagery.ImageryPlanError(
                        f"imagery exceeds the {settings.OFFLINE_SCENE_IMAGERY_MAX_MB} MB budget"
                    )
                assets[tile["file"]] = data
                tile_metas.append({
                    "row": tile["row"], "column": tile["column"], "file": tile["file"],
                    "bounds": dict(tile["bounds"]),
                    "sha256": context_fmt.sha256_hex(data), "bytes": len(data),
                })
                _emit(f"Packaging aerial imagery: {i + 1} of {n} tiles")
        except Exception as e:  # roll back ANY partial tiles — never a holey imagery layer
            for t in plan["tiles"]:
                assets.pop(t["file"], None)
            coord = f"({current['row']},{current['column']})" if current else "(?)"
            reason = imagery.sanitize_reason(e)
            if mandatory:
                raise OfflineSceneBuildError(
                    f"Mandatory aerial imagery failed at tile {coord} after retries: {reason}"
                ) from e
            layers["imagery"] = context_fmt.unavailable_layer(f"tile_failed {coord}")
            _log("imagery", "tile_failed", tile=coord, error=reason)
            return

        layers["imagery"] = context_fmt.tiled_imagery_layer(plan, tile_metas, source_meta)
        _log("imagery", "packaged_tiled", tiles=n, bytes=imagery_bytes,
             effective_mpp=plan.get("effective_meters_per_pixel"))


def get_builder() -> OfflineScenePackageBuilder:
    """Provider factory. Only the hillshade (USGS 3DEP) provider exists today; a
    licensed offline-imagery provider can be selected here later."""
    return HillshadeReliefBuilder()
