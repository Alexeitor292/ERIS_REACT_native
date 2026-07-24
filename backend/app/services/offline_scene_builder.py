"""
Automatic offline 3D package builder.

ERIS generates a bounded offline 3D terrain package automatically — no manual
ArcGIS Pro authoring. Chosen format: an ERIS terrain bundle ('eristerrain', a zip)
because automated true-.mspk authoring requires ArcGIS Pro (Windows + license),
which is not available on a Linux worker. The bundle contains a clipped USGS 3DEP
DEM, a hillshade derived locally from that verified DEM, ERIS overlays, and a
manifest, and is rendered natively at runtime from the local grid and texture.

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
from . import offline_scene_caltrans as caltrans_fmt
from . import offline_scene_context as context_fmt
from . import offline_scene_dem as dem_fmt
from . import offline_scene_terrain as terrain_fmt
from . import road_corridor_pairing as corridor_pairing
from . import road_route_chains as route_chains
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
            "export_contract": usgs_meta.get("export_contract"),
            "extent_verified": usgs_meta.get("extent_verified") is True,
            "verification": usgs_meta.get("verification"),
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
                    # A bundle that CLAIMS the exact-extent export contract must carry the
                    # evidence for it: per-tile verification plus aggregate counts that
                    # agree with the real tile count. A legacy bundle claims nothing and
                    # is validated exactly as before (never relabelled as verified).
                    from . import offline_scene_imagery as _imagery
                    ok, reason = _imagery.validate_packaged_verification(layer)
                    if not ok:
                        return False, reason
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
                # Roads must additionally be valid GeoJSON (line features only) whose
                # declared feature_count matches the actual collection — malformed or
                # partial road data can never reach a READY package.
                if name == "roads":
                    ok, reason = context_fmt.validate_roads_geojson(data, layer.get("feature_count"))
                    if not ok:
                        return False, reason
    except zipfile.BadZipFile:
        return False, "not a valid package archive"
    except Exception as e:  # pragma: no cover - defensive
        return False, f"validation error: {e}"
    return True, None


# Road sources that fetch from an EXTERNAL service. Each needs its own endpoint setting; a
# missing/blank one means the operator's selected provider cannot run at all, which must be
# reported as `provider_not_configured` — never silently satisfied with internal geometry.
_EXTERNAL_ROAD_SOURCES = (
    context_fmt.ROAD_SOURCE_TIGERWEB,
    context_fmt.ROAD_SOURCE_ARCGIS,
    context_fmt.ROAD_SOURCE_CALTRANS,
)


def _external_source_configured(road_source: str) -> bool:
    """Whether an external road source has the configuration it requires to run."""
    if road_source == context_fmt.ROAD_SOURCE_TIGERWEB:
        return bool(str(settings.OFFLINE_SCENE_TIGERWEB_BASE_URL or "").strip()
                    and context_fmt.parse_tigerweb_layers(settings.OFFLINE_SCENE_TIGERWEB_LAYERS))
    if road_source == context_fmt.ROAD_SOURCE_ARCGIS:
        return bool(str(settings.OFFLINE_SCENE_ROAD_SOURCE_URL or "").strip())
    if road_source == context_fmt.ROAD_SOURCE_CALTRANS:
        return bool(str(settings.OFFLINE_SCENE_CALTRANS_ROADS_URL or "").strip())
    return True


def _unavailable_roads_result(reason: str) -> dict:
    """A roads-collection result describing an unavailable roads layer (no asset packaged).
    Mirrors the successful-result shape so the caller handles both uniformly.

    ``provider_query_complete_empty`` defaults False: EVERY failure/incomplete/unsafe road
    outcome (provider_not_configured, source_error, incomplete_source, too_large, ...) must
    keep failing closed when roads are required. Only a verified, COMPLETE external query
    that returned zero qualifying centerlines flips it True (see ``_collect_road_layer``),
    which is the one unavailable outcome that may still ship a READY terrain package."""
    return {
        "layer": context_fmt.unavailable_layer(reason),
        "asset": None,
        "roads_geojson": None,
        "available": False,
        "bytes": 0,
        "reason": reason,
        "provider_query_complete_empty": False,
    }


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
    """Licence-clean builder using an independently verified USGS 3DEP DEM.

    Hillshade is derived locally from the already verified height grid. Terrain
    and relief therefore share one source grid, one geographic extent, and one
    set of pixel dimensions; generating relief performs no additional request.
    """

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

    def prepare_source_data(self, ctx: dict, progress=None) -> dict:
        grid_px = int(settings.OFFLINE_SCENE_GRID_PX)

        try:
            dem_bytes, verification = dem_fmt.fetch_verified_dem(
                ctx["bounds"],
                service_url=settings.OFFLINE_SCENE_3DEP_IMAGESERVER,
                width_px=grid_px,
                height_px=grid_px,
                timeout_s=int(
                    settings.OFFLINE_SCENE_FETCH_TIMEOUT_S
                ),
                session=self._session,
            )
        except dem_fmt.DemContractError as exc:
            raise OfflineSceneBuildError(
                "USGS 3DEP exact-extent verification failed: "
                f"{exc}"
            ) from exc
        except Exception as exc:
            raise OfflineSceneBuildError(
                "USGS 3DEP fetch failed: "
                f"{type(exc).__name__}"
            ) from exc

        if not dem_fmt.verification_ok(verification):
            raise OfflineSceneBuildError(
                "USGS 3DEP verification record is incomplete."
            )

        if progress:
            progress(
                "BUILDING_TERRAIN",
                "Verified exact USGS 3DEP extent; decoding terrain",
            )

        verified_bounds = dict(
            verification["raster_bounds"]
        )
        resolution = aoi_resolution_m(
            verified_bounds,
            ctx["center"]["lat"],
            grid_px,
        )

        usgs_meta = {
            "dataset": settings.OFFLINE_SCENE_3DEP_DATASET,
            "version": datetime.now(timezone.utc).strftime(
                "%Y-%m-%d"
            ),
            "resolution": f"{resolution} m/px",
            "service": settings.OFFLINE_SCENE_3DEP_IMAGESERVER,
            "export_contract": dem_fmt.DEM_EXPORT_CONTRACT,
            "extent_verified": True,
            "verification": dict(verification),
        }
        basemap_meta = {
            "provider": settings.OFFLINE_SCENE_IMAGERY_PROVIDER,
            "source_label": (
                "Local hillshade derived from verified USGS 3DEP DEM"
            ),
            "has_imagery": False,
            # Decoding and local rendering happen in build_package.
            "has_hillshade": False,
        }

        return {
            "dem_bytes": dem_bytes,
            "dem_verification": dict(verification),
            "hillshade_bytes": b"",
            "usgs_meta": usgs_meta,
            "basemap_meta": basemap_meta,
        }

    def build_package(self, ctx: dict, source: dict, progress=None) -> bytes:
        verification = source.get("dem_verification")

        if not dem_fmt.verification_ok(verification):
            raise OfflineSceneBuildError(
                "Cannot package terrain without a complete exact-extent "
                "DEM verification record."
            )

        # Decode only the independently verified USGS 3DEP GeoTIFF.
        heights = terrain_fmt.decode_dem_tiff(
            source["dem_bytes"],
            max_dim=int(settings.OFFLINE_SCENE_GRID_PX),
        )
        grid_bytes, stats = terrain_fmt.encode_height_grid(
            heights
        )

        # Never derive terrain georeferencing from the requested AOI. The raster
        # bounds were independently read from the downloaded GeoTIFF and already
        # proved equal to the ArcGIS-declared and requested extents.
        verified_bounds = dict(
            verification["raster_bounds"]
        )
        terrain_meta = terrain_fmt.build_terrain_metadata(
            stats,
            verified_bounds,
            terrain_fmt.grid_sha256(grid_bytes),
        )

        if progress:
            progress(
                "BUILDING_TERRAIN",
                "Rendering local hillshade from verified DEM",
            )

        try:
            hillshade_bytes, hillshade_meta = (
                terrain_fmt.render_hillshade_png(
                    heights,
                    verified_bounds,
                )
            )
        except Exception as exc:
            raise OfflineSceneBuildError(
                "Local hillshade generation failed: "
                f"{type(exc).__name__}"
            ) from exc

        basemap_meta = dict(
            source.get("basemap_meta") or {}
        )
        basemap_meta.update(
            {
                "provider": settings.OFFLINE_SCENE_IMAGERY_PROVIDER,
                "source_label": (
                    "Local hillshade derived from verified "
                    "USGS 3DEP DEM"
                ),
                "has_imagery": False,
                "has_hillshade": True,
                "hillshade": hillshade_meta,
            }
        )

        # upload_and_register reads source metadata after build_package, so keep
        # the source object synchronized with the exact asset placed in the bundle.
        source["basemap_meta"] = basemap_meta
        source["hillshade_bytes"] = hillshade_bytes

        base_bytes = len(grid_bytes) + len(hillshade_bytes)
        context_layers, assets = self._build_context_layers(
            ctx,
            base_bytes,
            progress=progress,
        )
        # Finalize the content signature from the ACTUAL road result (not merely the
        # configured provider), then write the SAME value into the manifest and — because
        # ctx is what upload_and_register reads — into the catalog row. This is what the
        # mobile newest-package comparison comes down to.
        ctx["content_signature"] = offline_scene_svc.finalize_content_signature(
            ctx["content_signature"],
            offline_scene_svc.road_content_fingerprint((context_layers or {}).get("roads")),
        )
        manifest = build_manifest(
            ctx,
            source["usgs_meta"],
            basemap_meta,
            terrain_meta,
            context_layers,
        )
        return assemble_bundle(
            grid_bytes,
            hillshade_bytes,
            ctx.get("overlays") or {},
            manifest,
            assets,
        )

    # Divided-highway pairing thresholds from config (see the ADR). Kept in one place so
    # the packaged `pairing` block always reports the values that were actually applied.
    def _pairing_params(self) -> corridor_pairing.PairingParams:
        return corridor_pairing.PairingParams(
            sample_interval_m=float(settings.OFFLINE_SCENE_PAIR_SAMPLE_INTERVAL_M),
            window_m=float(settings.OFFLINE_SCENE_PAIR_WINDOW_M),
            min_separation_m=float(settings.OFFLINE_SCENE_PAIR_MIN_SEPARATION_M),
            max_separation_m=float(settings.OFFLINE_SCENE_PAIR_MAX_SEPARATION_M),
            max_bearing_diff_deg=float(settings.OFFLINE_SCENE_PAIR_MAX_BEARING_DIFF_DEG),
            max_offset_angle_dev_deg=float(settings.OFFLINE_SCENE_PAIR_MAX_OFFSET_ANGLE_DEV_DEG),
            sep_stdev_max_m=float(settings.OFFLINE_SCENE_PAIR_SEP_STDEV_MAX_M),
            sep_slope_max=float(settings.OFFLINE_SCENE_PAIR_SEP_SLOPE_MAX),
            min_window_coverage=float(settings.OFFLINE_SCENE_PAIR_MIN_WINDOW_COVERAGE),
            min_corridor_length_m=float(settings.OFFLINE_SCENE_PAIR_MIN_CORRIDOR_LENGTH_M),
            midpoint_tolerance_m=float(settings.OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M),
        )

    # Route-chain stitching thresholds (see road_route_chains). Applied BEFORE pairing to
    # reconstruct a mainline fragmented by provider segmentation and to conservatively demote
    # branch geometry to `connector` so ramps cannot corrupt the derived midpoint.
    def _chain_params(self) -> route_chains.ChainParams:
        return route_chains.ChainParams(
            enabled=bool(settings.OFFLINE_SCENE_ROUTE_CHAIN_ENABLED),
            join_gap_m=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_JOIN_GAP_M),
            join_bearing_deg=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_JOIN_BEARING_DEG),
            min_mainline_len_m=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_MIN_MAINLINE_LEN_M),
            connector_max_len_m=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_CONNECTOR_MAX_LEN_M),
            branch_angle_deg=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_BRANCH_ANGLE_DEG),
            branch_angle_max_deg=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_BRANCH_ANGLE_MAX_DEG),
            junction_tol_m=float(settings.OFFLINE_SCENE_ROUTE_CHAIN_JUNCTION_TOL_M),
        )

    def _collect_road_layer(self, ctx: dict, road_source: str, running: int, max_bytes: int, emit, log) -> dict:
        """Fetch + build the roads context layer for ONE road source. Returns a result
        dict {layer, asset, roads_geojson, available, bytes, reason}. Raises on a
        transport/fetch failure so the caller can degrade, fall back, or (when required)
        fail the job.

        Provider selection is explicit AND honest: when an EXTERNAL provider is selected but
        its required endpoint is missing/blank, this returns `provider_not_configured` rather
        than quietly packaging ERIS-internal bearing/inventory/submitted geometry and
        labelling it as that provider. Only `eris_internal` may package internal context."""
        if road_source in _EXTERNAL_ROAD_SOURCES and not _external_source_configured(road_source):
            log("roads", "provider_not_configured", source=road_source)
            return _unavailable_roads_result("provider_not_configured")

        external: list = []
        tiger_configured = bool(
            road_source == context_fmt.ROAD_SOURCE_TIGERWEB and settings.OFFLINE_SCENE_TIGERWEB_BASE_URL
        )
        arcgis_configured = bool(
            road_source == context_fmt.ROAD_SOURCE_ARCGIS and settings.OFFLINE_SCENE_ROAD_SOURCE_URL
        )
        caltrans_configured = bool(
            road_source == context_fmt.ROAD_SOURCE_CALTRANS and settings.OFFLINE_SCENE_CALTRANS_ROADS_URL
        )
        external_configured = tiger_configured or arcgis_configured or caltrans_configured
        caltrans_classes: tuple[int, ...] | None = None
        if external_configured:
            bbuf = context_fmt.bounds_with_buffer(ctx["bounds"], settings.OFFLINE_SCENE_ROAD_BUFFER_M)
            if tiger_configured:
                # Public U.S. Census TIGERweb (credential-free dev road-snap source). One
                # layer failing does not discard the others; ALL failing raises -> roads
                # degrade to source_error (the terrain package still builds).
                external = context_fmt.fetch_tigerweb_road_features(
                    bbuf, base_url=settings.OFFLINE_SCENE_TIGERWEB_BASE_URL,
                    layers=settings.OFFLINE_SCENE_TIGERWEB_LAYERS,
                    timeout_s=int(settings.OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S), session=self._session,
                )
            elif caltrans_configured:
                # Optional Caltrans CRS Functional Classification — freeway/expressway road
                # CONTEXT by default (F_System 1,2); a functional classification, NOT an
                # ownership record. Bounded, paginated, worker-only fetch; cancellation is
                # re-checked between pages. Raises on an unrecoverable/incomplete result.
                caltrans_classes = caltrans_fmt.parse_functional_classes(
                    settings.OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES
                )
                external = caltrans_fmt.fetch_caltrans_road_features(
                    bbuf,
                    layer_url=settings.OFFLINE_SCENE_CALTRANS_ROADS_URL,
                    functional_classes=caltrans_classes,
                    timeout_s=int(settings.OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S),
                    page_size=int(settings.OFFLINE_SCENE_CALTRANS_PAGE_SIZE),
                    max_features=int(settings.OFFLINE_SCENE_CALTRANS_MAX_FEATURES),
                    max_pages=int(settings.OFFLINE_SCENE_CALTRANS_MAX_PAGES),
                    max_response_bytes=int(settings.OFFLINE_SCENE_CALTRANS_MAX_RESPONSE_MB) * 1024 * 1024,
                    retries=int(settings.OFFLINE_SCENE_CALTRANS_RETRIES),
                    session=self._session, sleep=self._sleep, monotonic=self._monotonic, jitter=self._jitter,
                    cancel_check=ctx.get("cancel_check"),
                )
            else:  # arcgis_feature_service
                external = context_fmt.fetch_arcgis_road_features(
                    bbuf, source_url=settings.OFFLINE_SCENE_ROAD_SOURCE_URL,
                    timeout_s=int(settings.OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S), session=self._session,
                )

        # PROVIDER EXCLUSIVITY: ERIS-internal context (Road Inventory geometry, submitted
        # line geometry, the synthetic road-bearing line) belongs to `eris_internal` ONLY.
        # An externally-sourced roads layer contains that provider's features and nothing
        # else, so a provider that returned nothing cannot publish available:true under
        # borrowed geometry — it degrades to no_centerline_features_in_area, which required
        # mode fails on and an explicit (audited) fallback is the only way to package
        # internal geometry instead.
        include_internal_context = (road_source == context_fmt.ROAD_SOURCE_ERIS_INTERNAL)
        geojson, count, roads_reason = context_fmt.roads_geojson_from_context(
            {**ctx, "external_road_features": external}, settings.OFFLINE_SCENE_ROAD_BUFFER_M,
            external_configured=external_configured,
            include_internal_context=include_internal_context,
        )
        # Deterministic station-local divided-highway pairing (ADDITIVE): adds a stable
        # feature_id + ERIS-derived selection_kind to every road, splits a paired
        # carriageway into its diagnostic member portion + selectable unpaired portions,
        # and appends derived divided_highway_corridor features so the map can show ONE
        # yellow line through a shared corridor. road_class_counts must describe the
        # ORIGINAL source roads, captured BEFORE the pairing rewrite.
        source_features = list(geojson.get("features") or [])
        source_class_counts = context_fmt.road_class_counts({"features": source_features})
        source_count = len(source_features)
        pairing_stats = None
        chain_stats = None
        if count > 0 and settings.OFFLINE_SCENE_DIVIDED_PAIRING_ENABLED:
            try:
                # ROUTE-CHAIN PRE-PASS (provider-neutral): stitch a mainline fragmented by
                # provider segmentation into continuous carriageways and demote branch/ramp
                # geometry to `connector` BEFORE pairing, so a ramp can never become a
                # carriageway partner and drag the midpoint off the mainline. A no-op for
                # providers that carry no carriageway-continuity key (e.g. TIGER).
                prepared_features, chain_stats = route_chains.stitch_route_chains(
                    source_features, self._chain_params()
                )
                paired_features, pairing_stats = corridor_pairing.build_selection_features(
                    prepared_features, self._pairing_params()
                )
                geojson = {"type": "FeatureCollection", "features": paired_features}
                count = len(paired_features)
                log("roads", "paired", corridors=pairing_stats.get("divided_corridor_count", 0),
                    kinds=",".join(pairing_stats.get("selection_kinds") or []))
            except corridor_pairing.DuplicateSourceIdentityError as e:
                # FAIL CLOSED, never swallow: two distinct packaged lines shared a pairing
                # source identity. Publishing misleading unpaired output would hide the
                # collision, so the package fails instead. (The packaging boundary guarantees
                # unique per-part provider_feature_id; this should be unreachable.)
                log("roads", "pairing_identity_collision", error=str(e)[:160])
                raise OfflineSceneBuildError(
                    f"Divided-corridor pairing found colliding road identities: {e}"
                ) from e
            except corridor_pairing.ProviderRampMislabeledError as e:
                # FAIL CLOSED, never swallow: the emitted selection contradicts the PROVIDER
                # about which features are ramps. Falling through to the generic handler would
                # publish the UNPAIRED collection — no selection_kind, no corridors and no
                # ramps at all — which is strictly worse than the mislabeling it detects.
                log("roads", "provider_ramp_mislabeled", error=str(e)[:160])
                raise OfflineSceneBuildError(
                    f"Road selection contradicts the provider about ramps: {e}"
                ) from e
            except Exception as e:  # noqa: BLE001 — other pairing failures must never break packaging
                pairing_stats = None
                log("roads", "pairing_skipped", error=str(e)[:120])

        roads_geojson = geojson if count > 0 else None
        if count == 0:
            # PRECISE reason (never generic "no_data").
            reason = roads_reason or "no_road_data"
            # A COMPLETE, SUCCESSFUL external query that returned zero qualifying centerlines.
            # Reaching here means the provider fetch already returned NORMALLY (a transport /
            # permanent / incomplete-pagination / cancellation failure raises out of the fetch
            # above and is handled by the caller BEFORE this point), and the only feature source
            # for an external provider is that provider (include_internal_context is False), so
            # `no_centerline_features_in_area` here is a verified empty result — not a failure.
            # This is the ONE unavailable outcome allowed to ship a READY terrain/imagery
            # package; every other reason keeps failing closed in required mode.
            complete_empty = bool(
                external_configured and reason == context_fmt.ROADS_REASON_NO_FEATURES
            )
            log("roads", "unavailable", reason=reason,
                query_completed=complete_empty)
            if complete_empty:
                # TRUTHFUL provenance for a completed-but-empty external query: record the
                # provider and (for Caltrans) the exact inclusion policy, and that the query
                # COMPLETED, so the manifest is auditable and mobile can show an accurate,
                # sanitized message without inventing a fallback source.
                provider = None
                filter_meta: dict = {}
                if caltrans_configured:
                    provider = caltrans_fmt.CALTRANS_PROVIDER
                    classes = caltrans_classes or caltrans_fmt.parse_functional_classes(
                        settings.OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES
                    )
                    filter_meta = {
                        "filter_version": caltrans_fmt.caltrans_filter_version(classes),
                        "functional_classes": list(classes),
                    }
                elif tiger_configured:
                    provider = "us_census_tigerweb"
                elif arcgis_configured:
                    provider = "arcgis_feature_service"
                layer = context_fmt.roads_unavailable_complete_layer(
                    reason, provider=provider, **filter_meta
                )
                return {
                    "layer": layer, "asset": None, "roads_geojson": None,
                    "available": False, "bytes": 0, "reason": reason,
                    "provider_query_complete_empty": True,
                }
            return {
                "layer": context_fmt.unavailable_layer(reason),
                "asset": None, "roads_geojson": None, "available": False, "bytes": 0,
                "reason": reason, "provider_query_complete_empty": False,
            }

        data = json.dumps(geojson, separators=(",", ":")).encode("utf-8")
        if running + len(data) > max_bytes:
            # Features EXISTED but were dropped to fit the package budget: an incomplete
            # result, so it must keep failing closed in required mode (NOT a complete-empty).
            log("roads", "skipped_too_large", bytes=len(data))
            return {
                "layer": context_fmt.unavailable_layer("too_large"),
                "asset": None, "roads_geojson": roads_geojson, "available": False, "bytes": 0,
                "reason": "too_large", "provider_query_complete_empty": False,
            }

        # Provenance must reflect the ACTUAL richest kind packaged AND the actual provider —
        # never claim ArcGIS/Caltrans for TIGERweb, never claim a centerline source when only
        # a synthetic bearing/inventory/submitted line was packaged.
        kinds = context_fmt.road_kinds_from_geojson(geojson)
        has_centerline = "road_centerline" in kinds
        if has_centerline and tiger_configured:
            # U.S. Census Bureau — NOT Caltrans / not engineering-grade.
            src = context_fmt.tigerweb_source_meta(settings.OFFLINE_SCENE_TIGERWEB_BASE_URL)
        elif has_centerline and caltrans_configured:
            # Authoritative Caltrans functional-classification linework (road CONTEXT).
            src = caltrans_fmt.caltrans_source_meta(settings.OFFLINE_SCENE_CALTRANS_ROADS_URL)
        elif has_centerline and arcgis_configured:
            src = {
                "provider": "arcgis_feature_service",
                "dataset": "ArcGIS road centerlines",
                "attribution": "Operator-configured ArcGIS road context",
                "retrieved_at": datetime.now(timezone.utc).isoformat(),
                "service": settings.OFFLINE_SCENE_ROAD_SOURCE_URL,  # sanitized by sanitize_source
            }
        else:
            src = {
                "provider": "eris_internal",
                "dataset": "ERIS road context (bearing + inventory + submitted)",
                "attribution": "ERIS road context",
                "retrieved_at": datetime.now(timezone.utc).isoformat(),
            }

        extra: dict = {
            "feature_count": count,                 # total features serialized in roads.geojson
            "source_feature_count": source_count,   # original context features BEFORE pairing
            "road_kinds": kinds,
            # The road CLIPPING CONTRACT, persisted exactly as applied (bounds + buffer).
            "clip_bounds": context_fmt.road_clip_bounds(ctx["bounds"], settings.OFFLINE_SCENE_ROAD_BUFFER_M),
            "buffer_m": float(settings.OFFLINE_SCENE_ROAD_BUFFER_M),
        }
        # Caltrans provenance: the exact inclusion/filter policy so a package is auditable
        # and reproducible, and so the content signature changes when the filter changes.
        if caltrans_configured and has_centerline:
            classes = caltrans_classes or caltrans_fmt.parse_functional_classes(
                settings.OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES
            )
            extra["filter_version"] = caltrans_fmt.caltrans_filter_version(classes)
            extra["functional_classes"] = list(classes)
        if source_class_counts:
            extra["road_classes"] = sorted(source_class_counts)
            extra["road_class_counts"] = source_class_counts
        if pairing_stats:
            extra["selection_kinds"] = pairing_stats["selection_kinds"]
            extra["selection_kind_counts"] = pairing_stats["selection_kind_counts"]
            extra["selectable_road_class_counts"] = pairing_stats["selectable_road_class_counts"]
            if pairing_stats["diagnostic_kinds"]:
                extra["diagnostic_kinds"] = pairing_stats["diagnostic_kinds"]
                extra["diagnostic_kind_counts"] = pairing_stats["diagnostic_kind_counts"]
            extra["selectable_feature_count"] = pairing_stats["selectable_feature_count"]
            extra["diagnostic_feature_count"] = pairing_stats["diagnostic_feature_count"]
            extra["context_feature_count"] = pairing_stats["context_feature_count"]
            extra["divided_corridor_count"] = pairing_stats["divided_corridor_count"]
            extra["pairing"] = pairing_stats["pairing"]
        # Route-chain provenance (auditable): how many source segments were stitched into
        # mainlines and how many branches were demoted to connectors before pairing.
        if chain_stats:
            extra["route_chaining"] = chain_stats

        layer = context_fmt.available_layer(context_fmt.ROADS_FILE, data, src, **extra)
        log("roads", "packaged", features=count, kinds=",".join(kinds), bytes=len(data))
        return {
            "layer": layer, "asset": data, "roads_geojson": roads_geojson,
            "available": True, "bytes": len(data), "reason": None,
            "provider_query_complete_empty": False,
        }

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

        # --- Roads (provider selected by OFFLINE_SCENE_ROAD_SOURCE) ---
        # Failure semantics: a provider failure degrades the roads layer (unavailable +
        # truthful reason) WITHOUT corrupting the terrain package — unless roads are
        # REQUIRED, in which case the job fails and no READY package is published. An
        # explicit (never silent) fallback source can be configured and is AUDITED in the
        # manifest + logs. `none` packages no road context by design.
        roads_geojson = None
        roads_available = False
        if not settings.OFFLINE_SCENE_ROADS_ENABLED:
            layers["roads"] = context_fmt.unavailable_layer("disabled")
        else:
            road_source = context_fmt.normalize_road_source(settings.OFFLINE_SCENE_ROAD_SOURCE)
            roads_required = bool(
                settings.OFFLINE_SCENE_ROADS_REQUIRED and road_source != context_fmt.ROAD_SOURCE_NONE
            )
            if road_source == context_fmt.ROAD_SOURCE_NONE:
                layers["roads"] = context_fmt.unavailable_layer("provider_none")
                _log("roads", "provider_none")
            else:
                _emit("Collecting road context")
                try:
                    result = self._collect_road_layer(ctx, road_source, running, max_bytes, _emit, _log)
                except OfflineSceneBuildError:
                    raise
                except caltrans_fmt.CaltransFetchCancelled:
                    # CANCELLATION IS NOT A ROAD FAILURE. It must leave _build_context_layers
                    # immediately so that no fallback provider is contacted, it never becomes
                    # source_error / incomplete_source, OFFLINE_SCENE_ROADS_REQUIRED cannot
                    # convert it into an availability failure, and nothing is packaged,
                    # uploaded or registered. The worker maps it to its canonical
                    # cancelled-job result.
                    _log("roads", "cancelled")
                    raise
                except context_fmt.RoadIdentityCollisionError as e:
                    # A generated packaged-part identity mapped to two different geometries.
                    # Never swallow into an unavailable layer: fail the package so the
                    # collision is surfaced rather than silently resolved.
                    _log("roads", "packaged_identity_collision", error=str(e)[:160])
                    raise OfflineSceneBuildError(
                        f"Packaged road identities collided: {e}"
                    ) from e
                except caltrans_fmt.CaltransIncompleteSourceError as e:
                    # A pagination cap was hit while MORE features remained. The subset is
                    # known-truncated, so it is never packaged as an available layer — the
                    # layer degrades with a distinct, truthful reason (and, when roads are
                    # required, fails the job below).
                    result = _unavailable_roads_result("incomplete_source")
                    _log("roads", "incomplete_source", error=str(e)[:160])
                except Exception as e:  # never corrupt the package on a road-source failure
                    result = _unavailable_roads_result("source_error")
                    _log("roads", "source_error", error=str(e)[:120])

                # EXPLICIT, AUDITED fallback (never a silent Caltrans->TIGER switch).
                fallback_source = str(settings.OFFLINE_SCENE_ROAD_FALLBACK_SOURCE or "").strip().lower()
                if (not result["available"]) and fallback_source and fallback_source != road_source:
                    try:
                        fb = self._collect_road_layer(ctx, fallback_source, running, max_bytes, _emit, _log)
                        if fb["available"]:
                            fb["layer"]["fallback"] = {
                                "from": road_source, "to": fallback_source,
                                "reason": result.get("reason") or "primary_unavailable",
                            }
                            result = fb
                            _log("roads", "fallback_used", source=road_source, to=fallback_source)
                    except Exception as e:  # noqa: BLE001 - a failing fallback is not fatal by itself
                        _log("roads", "fallback_failed", to=fallback_source, error=str(e)[:120])

                # REQUIRED policy: a required-but-unavailable roads layer FAILS the job so no
                # READY package can carry missing/partial/unverified road data — EXCEPT a
                # verified, complete external query that simply found zero qualifying
                # centerlines in this AOI. "Provider success is required" is enforced (a real
                # failure still fails closed); "at least one feature is required" is NOT — a
                # freeway-free area may still ship a READY terrain/imagery package with roads
                # marked unavailable and a truthful, completed-query reason.
                if (roads_required and not result["available"]
                        and not result.get("provider_query_complete_empty")):
                    raise OfflineSceneBuildError(
                        f"Roads are required (OFFLINE_SCENE_ROADS_REQUIRED=true) for provider "
                        f"'{road_source}' but none could be packaged "
                        f"(reason: {result['layer'].get('reason')})."
                    )
                if result.get("provider_query_complete_empty"):
                    _log("roads", "complete_empty_allowed",
                         reason=result["layer"].get("reason"), required=roads_required)

                layers["roads"] = result["layer"]
                if result["asset"] is not None:
                    assets[context_fmt.ROADS_FILE] = result["asset"]
                    running += result["bytes"]
                roads_geojson = result["roads_geojson"]
                roads_available = result["available"]

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

                data, src, verification = imagery.run_with_retries(
                    _fetch,
                    retries=int(settings.OFFLINE_SCENE_IMAGERY_TILE_RETRIES),
                    deadline_s=float(settings.OFFLINE_SCENE_IMAGERY_OVERALL_DEADLINE_S),
                    sleep=self._sleep, monotonic=self._monotonic, jitter=self._jitter,
                    # An adjusted extent / wrong size / unsafe href is DETERMINISTIC:
                    # retrying re-fetches the identical wrong answer. Fail closed at once
                    # instead of spending the retry budget and the operator's time.
                    is_retryable=lambda e: not isinstance(e, imagery.ImageryContractError),
                )
                source_meta = source_meta or src
                imagery_bytes += len(data)
                if imagery_bytes > imagery_budget:
                    raise imagery.ImageryPlanError(
                        f"imagery exceeds the {settings.OFFLINE_SCENE_IMAGERY_MAX_MB} MB budget"
                    )
                assets[tile["file"]] = data
                meta = {
                    "row": tile["row"], "column": tile["column"], "file": tile["file"],
                    "bounds": dict(tile["bounds"]),
                    "sha256": context_fmt.sha256_hex(data), "bytes": len(data),
                }
                # MEASURED from the decoded header — never the requested size. The export is
                # aspect-matched, so a tile is generally NOT tile_px square, and native needs
                # the real dims for tile-native texture management.
                dims = imagery.image_dimensions(data)
                if dims:
                    meta["width_px"], meta["height_px"] = int(dims[0]), int(dims[1])
                # Truthful, non-sensitive proof for THIS tile that the pixels really cover
                # the bounds recorded above: the requested extent was verified against the
                # service's own returned extent, and the delivered image was measured.
                # fetch_imagery_tile has already failed closed on any mismatch.
                meta.update(verification)
                if not imagery.tile_verification_ok(meta):
                    raise imagery.ImageryContractError("tile verification record is incomplete")
                tile_metas.append(meta)
                _emit(f"Packaging aerial imagery: {i + 1} of {n} tiles")
            # Whole-set backstop: the layer may only CLAIM the exact-extent contract when
            # every packaged tile individually backs the claim. Refusing here (inside the
            # try, so partial tiles roll back) stops a build from silently degrading to a
            # legacy-looking package that the legacy validator would happily accept.
            imagery.assert_extents_verified(tile_metas)
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

        # Record package-time EVIDENCE that the tiling is sound (assert_no_gaps_or_overlaps
        # raises but writes nothing, so a shipped bundle carried no proof the check ran).
        diagnostics = imagery.tile_diagnostics(
            plan, tile_metas, present_files=set(assets.keys()),
            export_contract=imagery.IMAGERY_EXPORT_CONTRACT,
        )
        layers["imagery"] = context_fmt.tiled_imagery_layer(
            plan, tile_metas, source_meta,
            jpeg_quality=int(settings.OFFLINE_SCENE_IMAGERY_JPEG_QUALITY),
            vintage=settings.OFFLINE_SCENE_IMAGERY_SOURCE_VINTAGE,
            diagnostics=diagnostics,
            export_contract=imagery.IMAGERY_EXPORT_CONTRACT,
        )
        _log("imagery", "packaged_tiled", tiles=n, bytes=imagery_bytes,
             effective_mpp=plan.get("effective_meters_per_pixel"))


def get_builder() -> OfflineScenePackageBuilder:
    """Provider factory. Only the hillshade (USGS 3DEP) provider exists today; a
    licensed offline-imagery provider can be selected here later."""
    return HillshadeReliefBuilder()
