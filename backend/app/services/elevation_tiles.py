"""USGS 3DEP elevation, tile by tile, for measuring a site on the website and the iPhone.

Both read the same tiles from here, so they get the same heights. A tile fetched once
is kept for everyone, which also carries them through a slow or unavailable USGS
service, since USGS promises neither.

USGS 3DEP products are public domain with no use restrictions, so unlike Esri's
elevation they may be kept here and on phones for use with no signal.

A tile is one square of the Web Mercator grid at level 17 (0.9 to 1 m a cell in California,
USGS's finest DEM being 1 m): 257 x 257 heights in metres, the first and last on the square's
edges, as LERC 1. USGS's mosaic puts the finest source it has at each place on top. ``ios/ERISKit/.../UsgsElevation.swift`` and ``web/.../elevationTile.ts`` read them.
"""
from __future__ import annotations

import logging
import threading
import time
from urllib.parse import urlencode
from urllib.request import urlopen

from ..config import settings
from ..storage import get_object_bytes, put_object_bytes

logger = logging.getLogger("eris.elevation_tiles")

LEVEL = 17
CELLS = 256
_ORIGIN_X = -20037508.342787
_ORIGIN_Y = 20037508.342787
_RESOLUTION_AT_LEVEL_ZERO = 156543.03392800014
RESOLUTION_M = _RESOLUTION_AT_LEVEL_ZERO / 2**LEVEL
TILE_SIZE_M = RESOLUTION_M * CELLS

# California with a margin, in Web Mercator: so this cannot be used to read the world.
_MIN_X, _MAX_X = -13_900_000.0, -12_680_000.0
_MIN_Y, _MAX_Y = 3_700_000.0, 5_190_000.0

# Bump to read every tile from USGS again, for instance after new lidar is flown.
_VERSION = "v1"
# A tile USGS has not been asked for lately can take over 20 seconds.
_TIMEOUT_S = 45
# USGS answers a 502 now and then, and its front end then repeats that error for the same
# address for a while. The same request at a slightly different address gets through.
_ATTEMPTS = 3
_MAGIC = b"CntZImage "
# At most this many requests to USGS at once from one server process.
_usgs_slots = threading.BoundedSemaphore(8)


class TileUnavailable(RuntimeError):
    """USGS could not supply the tile just now."""


def covers(row: int, col: int) -> bool:
    """Whether the tile is one ERIS serves."""
    west = _ORIGIN_X + col * TILE_SIZE_M
    north = _ORIGIN_Y - row * TILE_SIZE_M
    return _MIN_X <= west + TILE_SIZE_M and west <= _MAX_X and _MIN_Y <= north and north - TILE_SIZE_M <= _MAX_Y


def source_url(row: int, col: int) -> str:
    """The request to USGS. The extent reaches half a cell past the square on every side,
    because a cell's value sits at its centre and the outer heights belong on the edges."""
    half = RESOLUTION_M / 2
    west = _ORIGIN_X + col * TILE_SIZE_M - half
    north = _ORIGIN_Y - row * TILE_SIZE_M + half
    params = {
        "bbox": f"{west},{north - TILE_SIZE_M - RESOLUTION_M},{west + TILE_SIZE_M + RESOLUTION_M},{north}",
        "bboxSR": 3857,
        "imageSR": 3857,
        "size": f"{CELLS + 1},{CELLS + 1}",
        "format": "lerc",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    return f"{settings.OFFLINE_SCENE_3DEP_IMAGESERVER.rstrip('/')}/exportImage?{urlencode(params)}"


def _object_key(row: int, col: int) -> str:
    return f"elevation/usgs-3dep/{_VERSION}/{LEVEL}/{row}/{col}.lerc"


def _from_usgs(row: int, col: int) -> bytes:
    if not _usgs_slots.acquire(timeout=30):
        raise TileUnavailable("Too many elevation requests are waiting on USGS")
    try:
        problem: Exception | None = None
        for attempt in range(_ATTEMPTS):
            address = source_url(row, col)
            if attempt:
                time.sleep(attempt)
                address += f"&attempt={attempt}"
            try:
                with urlopen(address, timeout=_TIMEOUT_S) as response:
                    data = response.read()
            except Exception as exc:  # A timeout, a refused connection, an HTTP error.
                problem = exc
                continue
            # USGS answers its own errors with a 200 and JSON.
            if data.startswith(_MAGIC):
                return data
            problem = ValueError(f"USGS sent something other than a tile: {data[:80]!r}")
        raise TileUnavailable(str(problem))
    finally:
        _usgs_slots.release()


def tile(row: int, col: int) -> bytes:
    """The tile's bytes, from what is kept or else from USGS. Storage trouble never stops it."""
    key = _object_key(row, col)
    bucket = settings.S3_OFFLINE_SCENES_BUCKET
    try:
        data, _ = get_object_bytes(object_key=key, bucket=bucket)
        if data.startswith(_MAGIC):
            return data
    except Exception:  # Not kept yet (or storage is down, which keeping below will log).
        pass
    data = _from_usgs(row, col)
    try:
        put_object_bytes(object_key=key, data=data, content_type="application/octet-stream", bucket=bucket)
    except Exception as exc:
        logger.warning("Could not keep elevation tile %s: %s", key, exc)
    return data
