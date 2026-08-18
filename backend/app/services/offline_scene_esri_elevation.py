"""Esri Terrain 3D offline elevation export for ERIS mobile packages.

The connected Web UI uses ArcGIS World Elevation. For mobile, ERIS exports the
corresponding export-enabled Terrain3D service into a CompactV2/LERC tile package
(`.tpkx`) and embeds that immutable file inside the normal ERIS offline bundle.

This module deliberately does NOT replace USGS 3DEP as ERIS's analytical source.
The USGS grid remains in the package for provenance/cross-section calculations;
the Esri tile cache is the high-fidelity visualization surface consumed by
ArcGIS Runtime's AGSArcGISTiledElevationSource.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests

logger = logging.getLogger("eris.offline_scene_esri_elevation")

ESRI_TERRAIN_EXPORT_URL = (
    "https://tiledbasemaps.arcgis.com/arcgis/rest/services/"
    "WorldElevation3D/Terrain3D/ImageServer"
)
ESRI_TERRAIN_ITEM_ID = "09ae40dd6766478bb7de3c557c1421cb"
ESRI_TERRAIN_FILE = "esri-terrain.tpkx"
ESRI_TERRAIN_EXPORT_CONTRACT = "esri_terrain3d_compactv2_lerc_v1"


class EsriTerrainExportError(RuntimeError):
    pass


def _error_message(payload: object, default: str) -> str:
    if not isinstance(payload, dict):
        return default
    err = payload.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        details = err.get("details")
        if isinstance(details, list) and details:
            return f"{msg or default}: {'; '.join(str(x) for x in details[:3])}"
        if msg:
            return str(msg)
    return default


def _request_json(session: requests.Session, url: str, *, params: dict, timeout_s: int) -> dict:
    try:
        r = session.get(url, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except requests.RequestException as exc:
        raise EsriTerrainExportError(f"Esri Terrain3D request failed: {exc}") from exc
    except ValueError as exc:
        raise EsriTerrainExportError("Esri Terrain3D returned a non-JSON response") from exc
    if not isinstance(data, dict):
        raise EsriTerrainExportError("Esri Terrain3D returned an unexpected response")
    if "error" in data:
        raise EsriTerrainExportError(_error_message(data, "Esri Terrain3D rejected the request"))
    return data


def _try_request_json(
    session: requests.Session,
    urls: list[str],
    *,
    params: dict,
    timeout_s: int,
) -> tuple[dict, str]:
    """Try the documented ArcGIS Online/Enterprise job URL variants.

    Esri deployments expose exportTiles async jobs either directly under
    `<service>/jobs/<id>` or under `<service>/exportTiles/jobs/<id>`. The first
    successful JSON resource wins; errors are retained only for the final message.
    """
    errors: list[str] = []
    for url in urls:
        try:
            return _request_json(session, url, params=params, timeout_s=timeout_s), url
        except EsriTerrainExportError as exc:
            errors.append(str(exc))
    raise EsriTerrainExportError(
        "Could not resolve the Terrain3D export job resource: " + " | ".join(errors[-2:])
    )


def _available_levels(service_info: dict) -> list[int]:
    tile_info = service_info.get("tileInfo")
    lods = tile_info.get("lods") if isinstance(tile_info, dict) else None
    out: list[int] = []
    if isinstance(lods, list):
        for lod in lods:
            if not isinstance(lod, dict):
                continue
            level = lod.get("level")
            if isinstance(level, int) and level >= 0:
                out.append(level)
    return sorted(set(out))


def _aoi(bounds: dict) -> str:
    min_lon = float(bounds["min_lon"])
    min_lat = float(bounds["min_lat"])
    max_lon = float(bounds["max_lon"])
    max_lat = float(bounds["max_lat"])
    return json.dumps(
        {
            "features": [
                {
                    "geometry": {
                        "rings": [
                            [
                                [min_lon, min_lat],
                                [min_lon, max_lat],
                                [max_lon, max_lat],
                                [max_lon, min_lat],
                                [min_lon, min_lat],
                            ]
                        ],
                        "spatialReference": {"wkid": 4326},
                    }
                }
            ],
            "spatialReference": {"wkid": 4326},
        },
        separators=(",", ":"),
    )


def _job_urls(service_url: str, job_id: str) -> list[str]:
    root = service_url.rstrip("/")
    return [
        f"{root}/jobs/{job_id}",
        f"{root}/exportTiles/jobs/{job_id}",
    ]


def _extract_inline_output_url(job: dict) -> str | None:
    for key in ("outputUrl", "outputURL", "url", "URL", "href"):
        value = job.get(key)
        if isinstance(value, str) and value:
            return value
    results = job.get("results")
    if isinstance(results, dict):
        for value in results.values():
            if isinstance(value, dict):
                for key in ("value", "outputUrl", "url", "URL", "href"):
                    candidate = value.get(key)
                    if isinstance(candidate, str) and candidate:
                        return candidate
    return None


def _result_url(
    session: requests.Session,
    service_url: str,
    job_id: str,
    job: dict,
    *,
    token: str,
    timeout_s: int,
    resolved_job_url: str | None,
) -> str:
    inline = _extract_inline_output_url(job)
    if inline:
        return inline

    results = job.get("results") if isinstance(job, dict) else None
    out = results.get("out_service_url") if isinstance(results, dict) else None
    param_url = out.get("paramUrl") if isinstance(out, dict) else None
    if not isinstance(param_url, str) or not param_url:
        param_url = "results/out_service_url"

    bases: list[str] = []
    if resolved_job_url:
        bases.append(resolved_job_url.rstrip("/"))
    bases.extend(u.rstrip("/") for u in _job_urls(service_url, job_id))
    # Preserve order while de-duplicating.
    seen: set[str] = set()
    urls: list[str] = []
    for base in bases:
        candidate = f"{base}/{param_url.lstrip('/')}"
        if candidate not in seen:
            seen.add(candidate)
            urls.append(candidate)

    result, _ = _try_request_json(
        session,
        urls,
        params={"f": "json", "token": token},
        timeout_s=timeout_s,
    )
    value = result.get("value")
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        for key in ("url", "URL", "outputUrl", "href"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
    inline = _extract_inline_output_url(result)
    if inline:
        return inline
    raise EsriTerrainExportError("Esri Terrain3D export completed without a downloadable tile package URL")


def export_terrain_tpkx(
    bounds: dict,
    *,
    token: str,
    service_url: str = ESRI_TERRAIN_EXPORT_URL,
    timeout_s: int = 60,
    poll_interval_s: float = 2.0,
    max_wait_s: int = 300,
) -> tuple[bytes, dict]:
    """Export all advertised Terrain3D LODs for the bounded AOI as CompactV2.

    Authentication is intentionally supplied by the worker/operator; it is never
    persisted in the package or returned in metadata.
    """
    if not token or not str(token).strip():
        raise EsriTerrainExportError(
            "ArcGIS authentication is required for Terrain 3D offline export. "
            "Configure the backend ArcGIS credential before generating a mobile area."
        )

    service_url = service_url.rstrip("/")
    session = requests.Session()
    session.headers.update({"User-Agent": "ERIS-offline-terrain/1"})

    service_info = _request_json(
        session,
        service_url,
        params={"f": "json", "token": token},
        timeout_s=timeout_s,
    )
    if service_info.get("exportTilesAllowed") is False:
        raise EsriTerrainExportError("Configured ArcGIS Terrain3D service does not allow tile export")

    levels = _available_levels(service_info)
    if not levels:
        raise EsriTerrainExportError("ArcGIS Terrain3D service did not advertise any tile levels")

    submit = _request_json(
        session,
        f"{service_url}/exportTiles",
        params={
            "f": "json",
            "token": token,
            "tilePackage": "true",
            "storageFormatType": "esriMapCacheStorageModeCompactV2",
            "exportBy": "LevelID",
            "levels": ",".join(str(x) for x in levels),
            "areaOfInterest": _aoi(bounds),
            # LERC elevation is already compact; do not recompress/resample it.
            "optimizeTilesForSize": "false",
        },
        timeout_s=timeout_s,
    )
    job_id = submit.get("jobId")
    if not isinstance(job_id, str) or not job_id:
        raise EsriTerrainExportError(_error_message(submit, "Esri Terrain3D export did not return a job id"))

    deadline = time.monotonic() + max(30, int(max_wait_s))
    job: dict = submit
    resolved_job_url: str | None = None
    while time.monotonic() < deadline:
        job, resolved_job_url = _try_request_json(
            session,
            _job_urls(service_url, job_id),
            params={"f": "json", "token": token},
            timeout_s=timeout_s,
        )
        status = str(job.get("jobStatus") or "")
        if status == "esriJobSucceeded":
            break
        if status in {"esriJobFailed", "esriJobCancelled", "esriJobTimedOut"}:
            msgs = job.get("messages")
            detail = ""
            if isinstance(msgs, list):
                descriptions = [str(m.get("description")) for m in msgs if isinstance(m, dict) and m.get("description")]
                if descriptions:
                    detail = f": {descriptions[-1]}"
            raise EsriTerrainExportError(f"Esri Terrain3D export {status}{detail}")
        time.sleep(max(0.25, float(poll_interval_s)))
    else:
        raise EsriTerrainExportError("Timed out waiting for Esri Terrain3D offline tile export")

    download_url = _result_url(
        session,
        service_url,
        job_id,
        job,
        token=token,
        timeout_s=timeout_s,
        resolved_job_url=resolved_job_url,
    )
    # Result URLs can be relative on Enterprise deployments. Resolve against the
    # service root without ever persisting a credential-bearing URL.
    if not download_url.lower().startswith(("http://", "https://")):
        download_url = urljoin(service_url + "/", download_url)

    try:
        r = session.get(download_url, params={"token": token}, timeout=max(timeout_s, 120))
        r.raise_for_status()
        data = bytes(r.content)
    except requests.RequestException as exc:
        raise EsriTerrainExportError(f"Failed to download exported Terrain3D tile package: {exc}") from exc

    if len(data) < 1024:
        raise EsriTerrainExportError("Exported Terrain3D tile package is unexpectedly small")

    sha = hashlib.sha256(data).hexdigest()
    meta = {
        "available": True,
        "file": ESRI_TERRAIN_FILE,
        "format": "tpkx",
        "encoding": "LERC",
        "bytes": len(data),
        "sha256": sha,
        "export_contract": ESRI_TERRAIN_EXPORT_CONTRACT,
        "levels": levels,
        "source": {
            "provider": "esri",
            "dataset": "Terrain 3D (for Export)",
            "item_id": ESRI_TERRAIN_ITEM_ID,
            "service": ESRI_TERRAIN_EXPORT_URL,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "attribution": "Esri Terrain 3D",
        },
    }
    return data, meta
