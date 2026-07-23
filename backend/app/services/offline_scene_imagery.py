"""
High-definition TILED offline aerial imagery: pure tile PLANNING, bounded RETRY
scheduling, and image-response validation.

Everything here is pure (no network, no settings import, no DB) so it unit-tests
under the no-DB job. The worker's network fetch lives in offline_scene_context
(fetch_imagery_tile); this module decides WHAT to fetch (the tile grid) and HOW to
retry, and validates that a response is a real image.

Design goals:
  * Split the AOI into a grid of JPEG tiles so each upstream export stays well below
    the source ImageServer max width/height and a conservative request size — total
    packaged detail can far exceed a single 4000px export.
  * Never over-request beyond source-native useful detail (clamp target m/px to the
    operator-declared source-native GSD).
  * Exact, gap-free, overlap-free tile bounds (adjacent tiles share the identical
    edge value, computed from a single edges array).
  * A conservative tile-count budget: fail with a precise operator-visible reason
    BEFORE uncontrolled package growth.
"""

from __future__ import annotations

import math

_M_PER_DEG_LAT = 111_320.0

# JPEG (SOI FF D8 FF) and PNG magic — used to reject JSON/HTML/service-error bodies.
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

IMAGERY_TILE_DIR = "imagery"

# ---- the imagery EXPORT CONTRACT -------------------------------------------
#
# Identity of how a tile is requested, verified and recorded. It is folded into the
# package content signature, so changing WHAT we ask the service for or HOW we prove
# the answer deterministically invalidates every package built under an older
# contract — a stale package can never be treated as equivalent to a current one.
# BUMP THIS STRING whenever the request parameters or the verification rules change.
IMAGERY_EXPORT_CONTRACT = "exact_extent_arcgis_export_v2"

# ArcGIS `exportImage` defaults adjustAspectRatio=TRUE: when the requested pixel
# aspect differs from the bbox aspect *expressed in the OUTPUT spatial reference*, the
# service silently EXPANDS the bbox and returns pixels covering more ground than was
# asked for. With f=image the response is raw bytes, so nothing reveals the swap and
# the package records the requested bounds over adjusted pixels -> every tile edge
# repeats ground. We always send this explicitly; it is never omitted.
ADJUST_ASPECT_RATIO = False

# Absolute tolerance (degrees) when comparing the extent the service SAYS it returned
# against the extent we asked for.
#
# It covers JSON serialization/round-trip noise ONLY — never a geographically
# meaningful offset. At AOI magnitudes (|lon| <= 180) one IEEE-754 double ULP is
# ~2.8e-14 deg, and a decimal round-trip through JSON is exact for shortest-repr
# doubles, so genuine noise is <= ~1e-13 deg. One pixel of a 1024 px tile at the 2 m/px
# target is ~6.8e-06 deg, so 1e-9 deg is ~1/6800 of a pixel (~1e-4 m of ground): four
# orders of magnitude above any serialization artefact and far below anything that
# could shift a mosaic. An adjusted extent is off by a fraction of the tile — many
# thousands of times this bound — so "close enough" can never pass.
EXTENT_TOLERANCE_DEG = 1e-9

# The only spatial reference a packaged tile may be returned in: the manifest/mobile
# placement contract is WGS84 lon/lat, and mobile maps image pixels linearly onto the
# declared bounds.
EXPORT_WKID = 4326

# The bounds key <-> ArcGIS envelope key correspondence, checked in both directions.
_EXTENT_KEYS = (("min_lon", "xmin"), ("min_lat", "ymin"), ("max_lon", "xmax"), ("max_lat", "ymax"))


class ImageryPlanError(Exception):
    """The tile plan is impossible/over-budget — surfaced to the operator verbatim
    (precise, no secrets) so a package never grows uncontrollably."""


class ImageryDeadlineError(Exception):
    """The overall imagery worker deadline was exhausted before a tile succeeded."""


class ImageryContractError(Exception):
    """The service did not honour the exact-extent export contract.

    DETERMINISTIC, and therefore NOT retryable: an adjusted extent, a wrong spatial
    reference, a size we did not ask for, an unusable body or an unsafe download
    target will be identical on the next attempt. The tile fails CLOSED — pixels are
    never packaged under bounds they do not cover — instead of burning the retry
    budget. Messages are built from our OWN request/response numbers only: never the
    href, query string, token or any service-supplied text."""


def _finite_pos(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def resolve_target_mpp(target_cfg, source_native_mpp) -> float:
    """Resolve the configured target metres/pixel.

    A bare number (or numeric string like "0.6") forces that GSD. The sentinel
    "source_native..." uses the operator-declared source-native GSD (or 0.6 when
    that is unknown/<=0). The result is clamped so it is NEVER finer than the
    source-native GSD — we do not over-request beyond useful source detail.
    """
    native = float(source_native_mpp) if _finite_pos(source_native_mpp) else 0.0
    forced: float | None = None
    if isinstance(target_cfg, (int, float)) and not isinstance(target_cfg, bool):
        forced = float(target_cfg)
    elif isinstance(target_cfg, str):
        s = target_cfg.strip().lower()
        if s.startswith("source_native"):
            forced = None  # use native (below)
        else:
            try:
                forced = float(s)
            except ValueError:
                forced = None
    if forced is not None and _finite_pos(forced):
        target = forced
    else:
        target = native if native > 0 else 0.6
    # Never request finer than the source can actually provide.
    if native > 0:
        target = max(target, native)
    return round(target, 4)


def footprint_meters(bounds: dict) -> tuple[float, float]:
    """(widthM, heightM) of geographic bounds (cos-lat adjusted). Raises on bad."""
    for k in ("min_lat", "min_lon", "max_lat", "max_lon"):
        if not (isinstance(bounds.get(k), (int, float)) and math.isfinite(bounds[k])):
            raise ImageryPlanError(f"invalid bounds ({k})")
    min_lat, min_lon = float(bounds["min_lat"]), float(bounds["min_lon"])
    max_lat, max_lon = float(bounds["max_lat"]), float(bounds["max_lon"])
    if not (max_lat > min_lat and max_lon > min_lon):
        raise ImageryPlanError("degenerate bounds (min >= max)")
    mid_lat = (min_lat + max_lat) / 2.0
    cos_lat = math.cos(math.radians(mid_lat)) or 1e-6
    width_m = (max_lon - min_lon) * _M_PER_DEG_LAT * abs(cos_lat)
    height_m = (max_lat - min_lat) * _M_PER_DEG_LAT
    return width_m, height_m


def _edges(lo: float, hi: float, n: int) -> list[float]:
    """n+1 evenly-spaced edge values from lo..hi, endpoints forced EXACT. Adjacent
    cells share the identical interior edge value (no gaps/overlaps, no float drift)."""
    out = [lo + (hi - lo) * (i / n) for i in range(n + 1)]
    out[0] = lo
    out[n] = hi
    return out


def plan_imagery_tiles(
    bounds: dict,
    *,
    tile_px: int,
    target_mpp: float,
    source_native_mpp: float | None = None,
    max_export_px: int = 4096,
    max_tiles: int = 64,
    file_ext: str = "jpg",
) -> dict:
    """Plan the tile grid for `bounds`.

    Returns a plan dict (format "tiled") with columns/rows, the resolved target and
    achieved effective m/px, and a `tiles` list of {row, column, file, bounds}. Each
    tile is exported square at tile_px (<= max_export_px, so an upstream request never
    approaches the service maximum). Raises ImageryPlanError on impossible/over-budget
    plans (precise reason, no secrets).
    """
    tp = int(tile_px)
    if tp < 256 or tp > int(max_export_px):
        raise ImageryPlanError(
            f"tile_px {tp} must be within [256, max_export_px={int(max_export_px)}]"
        )
    if not _finite_pos(target_mpp):
        raise ImageryPlanError("invalid target metres-per-pixel")

    width_m, height_m = footprint_meters(bounds)
    # Never plan finer than source-native useful detail.
    planned_mpp = float(target_mpp)
    if _finite_pos(source_native_mpp):
        planned_mpp = max(planned_mpp, float(source_native_mpp))

    width_px = width_m / planned_mpp
    height_px = height_m / planned_mpp
    columns = max(1, math.ceil(width_px / tp))
    rows = max(1, math.ceil(height_px / tp))
    total = columns * rows
    if total > int(max_tiles):
        raise ImageryPlanError(
            f"imagery tile plan needs {total} tiles ({columns}x{rows}) at "
            f"{planned_mpp:.2f} m/px, exceeding the max of {int(max_tiles)}. "
            f"Reduce the area, raise the target m/px, or raise OFFLINE_SCENE_IMAGERY_MAX_TILES."
        )

    lon_edges = _edges(float(bounds["min_lon"]), float(bounds["max_lon"]), columns)
    lat_edges = _edges(float(bounds["max_lat"]), float(bounds["min_lat"]), rows)  # north -> south

    tiles: list[dict] = []
    for r in range(rows):
        for c in range(columns):
            tiles.append({
                "row": r,
                "column": c,
                "file": f"{IMAGERY_TILE_DIR}/{r}/{c}.{file_ext}",
                "bounds": {
                    "min_lon": lon_edges[c],
                    "max_lon": lon_edges[c + 1],
                    "max_lat": lat_edges[r],
                    "min_lat": lat_edges[r + 1],
                },
            })

    # Effective (achieved) m/px given integer tiling: coarser (larger) of the two axes.
    # Integer ceil tiling slightly over-provisions pixels, so this can come out finer
    # than source-native — but REAL detail can never exceed what the source provides,
    # so we report the honest achievable GSD clamped to source-native (never overstate).
    eff = max(width_m / (columns * tp), height_m / (rows * tp))
    if _finite_pos(source_native_mpp):
        eff = max(eff, float(source_native_mpp))
    return {
        "format": "tiled",
        "tile_size_px": tp,
        "columns": columns,
        "rows": rows,
        "target_meters_per_pixel": round(planned_mpp, 3),
        "effective_meters_per_pixel": round(eff, 3),
        # The source's own useful GSD. Recorded so a reader can tell whether
        # effective_meters_per_pixel was geometry-limited or clamped to the source — we
        # must never claim detail finer than the source actually provides.
        "source_native_meters_per_pixel": (round(float(source_native_mpp), 3)
                                           if _finite_pos(source_native_mpp) else None),
        "bounds": {
            "min_lat": float(bounds["min_lat"]),
            "min_lon": float(bounds["min_lon"]),
            "max_lat": float(bounds["max_lat"]),
            "max_lon": float(bounds["max_lon"]),
        },
        "tiles": tiles,
    }


def assert_no_gaps_or_overlaps(plan: dict, *, eps: float = 1e-9) -> None:
    """Structural self-check: tiles tile the AOI exactly (shared edges, full cover,
    no overlap). Raises ImageryPlanError on any violation. Cheap — run before packaging."""
    cols, rows = int(plan["columns"]), int(plan["rows"])
    by_rc = {(t["row"], t["column"]): t["bounds"] for t in plan["tiles"]}
    if len(by_rc) != cols * rows:
        raise ImageryPlanError("tile plan has missing/duplicate (row,column) cells")
    aoi = plan["bounds"]
    for r in range(rows):
        for c in range(cols):
            b = by_rc[(r, c)]
            if b["min_lon"] >= b["max_lon"] or b["min_lat"] >= b["max_lat"]:
                raise ImageryPlanError(f"degenerate tile ({r},{c})")
            if c + 1 < cols and abs(b["max_lon"] - by_rc[(r, c + 1)]["min_lon"]) > eps:
                raise ImageryPlanError(f"gap/overlap between columns at ({r},{c})")
            if r + 1 < rows and abs(b["min_lat"] - by_rc[(r + 1, c)]["max_lat"]) > eps:
                raise ImageryPlanError(f"gap/overlap between rows at ({r},{c})")
    nw, se = by_rc[(0, 0)], by_rc[(rows - 1, cols - 1)]
    if (abs(nw["min_lon"] - aoi["min_lon"]) > eps or abs(nw["max_lat"] - aoi["max_lat"]) > eps
            or abs(se["max_lon"] - aoi["max_lon"]) > eps or abs(se["min_lat"] - aoi["min_lat"]) > eps):
        raise ImageryPlanError("tile plan does not exactly cover the AOI bounds")


# ---- image-response validation ---------------------------------------------

def image_dimensions(data: bytes | None) -> tuple[int, int] | None:
    """(width, height) read from the ACTUAL encoded image header — never from the requested
    size. The export is aspect-matched, so a tile is generally NOT tile_px x tile_px, and a
    service may legitimately return something other than what was asked for. Reading the
    JPEG SOF / PNG IHDR is what the decoder itself will produce.

    Pure + dependency-free (this module must stay importable in the non-DB test job).
    Returns None when the header cannot be parsed.
    """
    if not data or len(data) < 4:
        return None
    # PNG: 8-byte signature, then IHDR length+type, then width/height (big-endian uint32).
    if is_png(data):
        if len(data) < 24:
            return None
        try:
            w = int.from_bytes(data[16:20], "big")
            h = int.from_bytes(data[20:24], "big")
            return (w, h) if w > 0 and h > 0 else None
        except Exception:  # noqa: BLE001 - malformed header
            return None
    if not is_jpeg(data):
        return None
    # JPEG: walk the marker segments to the first Start-Of-Frame.
    # SOF0..SOF15 carry the true frame size; DHT(C4)/JPG(C8)/DAC(CC) are NOT frame markers.
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    i = 2
    n = len(data)
    try:
        while i + 3 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:   # standalone markers
                i += 2
                continue
            if i + 3 >= n:
                return None
            seg_len = int.from_bytes(data[i + 2:i + 4], "big")
            if seg_len < 2:
                return None
            if marker in sof:
                # FF Cx | len(2) | precision(1) | height(2) | width(2)
                if i + 9 > n:
                    return None
                h = int.from_bytes(data[i + 5:i + 7], "big")
                w = int.from_bytes(data[i + 7:i + 9], "big")
                return (w, h) if w > 0 and h > 0 else None
            i += 2 + seg_len
    except Exception:  # noqa: BLE001 - malformed/truncated stream
        return None
    return None


# ---- exact-extent export verification (pure) -------------------------------

def _num(v) -> float | None:
    """A finite float, or None. `bool` is rejected (a Python bool IS an int)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _whole(v) -> int | None:
    """A finite, integral pixel count > 0, or None."""
    n = _num(v)
    if n is None or n != int(n) or n <= 0:
        return None
    return int(n)


def _wkid(extent: dict, meta: dict) -> int | None:
    """The WKID an ArcGIS envelope declares. `spatialReference` normally rides on the
    envelope; some services put it at the top level, so both are consulted. `wkid` and
    `latestWkid` are equally authoritative (4326 has no separate latest form)."""
    for holder in (extent, meta):
        sr = holder.get("spatialReference") if isinstance(holder, dict) else None
        if not isinstance(sr, dict):
            continue
        for key in ("wkid", "latestWkid"):
            w = _whole(sr.get(key))
            if w is not None:
                return w
    return None


def verify_export_metadata(
    meta,
    *,
    bounds: dict,
    width_px: int,
    height_px: int,
    tolerance_deg: float = EXTENT_TOLERANCE_DEG,
) -> dict:
    """Prove an ArcGIS `exportImage?f=json` response describes EXACTLY what we asked for.

    The service is the only party that knows what it actually rendered. With f=image we
    got bytes and had to assume; with f=json it must state its extent, size and spatial
    reference, and every one of them is checked here before a single pixel is downloaded:

      * a JSON object, carrying no service error;
      * width/height identical to the requested pixel size;
      * an extent with four finite corners in WGS84 (wkid 4326);
      * every corner within `tolerance_deg` of the requested bbox corner.

    Anything else raises ImageryContractError (deterministic -> fail closed, not retried).
    Returns the non-sensitive per-tile verification record. Nothing derived from the href,
    the query string or any service-supplied text ever enters the result or the message.
    """
    if not isinstance(meta, dict):
        raise ImageryContractError("export metadata was not a JSON object")
    if meta.get("error") is not None:
        # The error body can echo the request (token, URL). Report only that it happened.
        raise ImageryContractError("export service returned an error object")

    req_w, req_h = _whole(width_px), _whole(height_px)
    if req_w is None or req_h is None:
        raise ImageryContractError("requested tile size is not a positive integer pair")
    got_w, got_h = _whole(meta.get("width")), _whole(meta.get("height"))
    if got_w is None or got_h is None:
        raise ImageryContractError("export metadata is missing a usable width/height")
    if (got_w, got_h) != (req_w, req_h):
        raise ImageryContractError(
            f"export returned size {got_w}x{got_h} but {req_w}x{req_h} was requested"
        )

    extent = meta.get("extent")
    if not isinstance(extent, dict):
        raise ImageryContractError("export metadata is missing the returned extent")
    wkid = _wkid(extent, meta)
    if wkid is None:
        raise ImageryContractError("returned extent declares no usable spatial reference")
    if wkid != EXPORT_WKID:
        raise ImageryContractError(
            f"returned extent is in wkid {wkid}, not the required {EXPORT_WKID}"
        )

    worst = 0.0
    for bkey, ekey in _EXTENT_KEYS:
        want, got = _num(bounds.get(bkey)), _num(extent.get(ekey))
        if want is None:
            raise ImageryContractError(f"requested bounds has a non-finite {bkey}")
        if got is None:
            raise ImageryContractError(f"returned extent has a missing/non-finite {ekey}")
        worst = max(worst, abs(got - want))
    tol = _num(tolerance_deg)
    if tol is None or tol < 0:
        raise ImageryContractError("extent tolerance is not a finite non-negative number")
    if worst > tol:
        # THE defect this contract exists to catch: the service adjusted the extent, so
        # these pixels do NOT cover the bounds we would have recorded for them.
        raise ImageryContractError(
            f"returned extent differs from the requested extent by {worst:.3e} deg "
            f"(tolerance {tol:.3e} deg) — the service adjusted the export"
        )

    return {
        "extent_verified": True,
        "extent_max_delta_deg": worst,
        "extent_tolerance_deg": tol,
        "requested_width_px": req_w,
        "requested_height_px": req_h,
        "returned_width_px": got_w,
        "returned_height_px": got_h,
    }


def safe_export_href(href, *, service_url: str) -> str:
    """Validate the provider-supplied download URL before ERIS fetches it.

    An `href` in a response body is attacker-influenceable input the moment the service
    (or anything on the path to it) misbehaves, so it is never fetched blindly: HTTPS
    only, no embedded userinfo, and the SAME origin as the configured ArcGIS service
    (host + port). That keeps the worker from being turned into a request proxy for
    internal addresses. Returns the href unchanged when it passes, else raises
    ImageryContractError — whose message NEVER contains the href, its query or its host.
    """
    from urllib.parse import urlsplit

    if not isinstance(href, str) or not href.strip():
        raise ImageryContractError("export metadata is missing the image href")

    def origin(url: str, *, what: str):
        """(scheme, host, port, split) — lower-cased scheme/host for comparison."""
        try:
            parts = urlsplit(url.strip())
            port = parts.port                      # raises on a malformed port
        except ValueError as e:
            raise ImageryContractError(f"{what} is not a parsable URL") from e
        return (parts.scheme or "").lower(), (parts.hostname or "").lower(), port, parts

    scheme, host, port, parts = origin(href, what="image href")
    if scheme != "https":
        raise ImageryContractError("image href is not https")
    if parts.username is not None or parts.password is not None or "@" in (parts.netloc or ""):
        raise ImageryContractError("image href carries embedded userinfo")
    if not host:
        raise ImageryContractError("image href has no host")

    s_scheme, s_host, s_port, _s = origin(str(service_url or ""), what="configured export service")
    if not s_host:
        raise ImageryContractError("configured export service has no host")
    if host != s_host:
        raise ImageryContractError("image href host is not the configured export service host")
    allowed_port = s_port if (s_port is not None and s_scheme == "https") else 443
    if (port if port is not None else 443) != allowed_port:
        raise ImageryContractError("image href port is not the configured export service port")
    return href


def assert_encoded_dimensions(data: bytes | None, *, width_px: int, height_px: int) -> tuple[int, int]:
    """The DOWNLOADED bytes must decode to exactly the size the service declared.

    Verified metadata is a promise; this is the delivery. A body that is not a supported
    image (a JSON/HTML error served with the wrong content type), or whose header cannot
    be parsed, or whose real frame size differs from the declared one, fails closed —
    otherwise pixels of an unknown size would be stretched across the declared bounds.
    """
    if not is_supported_image(data):
        raise ImageryContractError("export download was not a JPEG/PNG image")
    dims = image_dimensions(data)
    if dims is None:
        raise ImageryContractError("export download has no readable image header")
    if (dims[0], dims[1]) != (int(width_px), int(height_px)):
        raise ImageryContractError(
            f"downloaded image is {dims[0]}x{dims[1]} but {int(width_px)}x{int(height_px)} was declared"
        )
    return dims


def tile_verification_ok(tile) -> bool:
    """Whether ONE packaged tile carries a complete, self-consistent verification record.

    Deliberately strict: `extent_verified`/`dimensions_verified` must be exactly True (not
    truthy), the delta must be a finite number within the recorded tolerance, and the
    measured `width_px`/`height_px` must equal the returned size the service declared.
    """
    if not isinstance(tile, dict):
        return False
    if tile.get("extent_verified") is not True or tile.get("dimensions_verified") is not True:
        return False
    delta, tol = _num(tile.get("extent_max_delta_deg")), _num(tile.get("extent_tolerance_deg"))
    if delta is None or tol is None or delta < 0 or tol < 0 or delta > tol:
        return False
    rw, rh = _whole(tile.get("returned_width_px")), _whole(tile.get("returned_height_px"))
    mw, mh = _whole(tile.get("width_px")), _whole(tile.get("height_px"))
    if rw is None or rh is None or mw is None or mh is None:
        return False
    return (rw, rh) == (mw, mh)


def assert_extents_verified(tile_metas: list) -> None:
    """Build-time gate: EVERY tile must be verified before the layer may claim the
    contract. A package that would otherwise silently downgrade to "legacy" (and so pass
    the legacy validator) is refused here instead."""
    metas = tile_metas if isinstance(tile_metas, list) else []
    if not metas:
        raise ImageryContractError("no imagery tiles to verify")
    bad = [f"({t.get('row')},{t.get('column')})" for t in metas if not tile_verification_ok(t)]
    if bad:
        raise ImageryContractError(
            f"{len(bad)} of {len(metas)} tiles lack a valid extent verification: {', '.join(bad[:4])}"
        )


def verification_diagnostics(tile_metas: list, *, export_contract: str) -> dict:
    """Aggregate, truthful evidence that the exact-extent contract was actually enforced.

    Only ever emitted for a package built under `export_contract`; a legacy package that
    never performed the check gets NO verification keys at all rather than a false claim.
    """
    metas = [t for t in tile_metas if isinstance(t, dict)] if isinstance(tile_metas, list) else []
    verified = [t for t in metas if tile_verification_ok(t)]
    dims = [t for t in metas if _whole(t.get("width_px")) and _whole(t.get("height_px"))]
    tols = {t.get("extent_tolerance_deg") for t in verified}
    out = {
        "export_contract": str(export_contract),
        "adjust_aspect_ratio": ADJUST_ASPECT_RATIO,
        "extents_verified": bool(metas) and len(verified) == len(metas),
        "extents_verified_count": len(verified),
        "extent_mismatch_count": len(metas) - len(verified),
        "dimensions_verified_count": len(dims),
    }
    if len(tols) == 1:
        out["extent_tolerance_deg"] = tols.pop()
    return out


def validate_packaged_verification(layer: dict) -> tuple[bool, str | None]:
    """Package-validator gate for a bundle that CLAIMS the exact-extent contract.

    (ok, reason). A layer that does not claim the contract is legacy and passes untouched
    — legacy packages are never relabelled as verified. A layer that DOES claim it must
    back the claim up: every tile individually verified, and diagnostics whose counts
    agree with the real tile count. Absent, false, malformed or inconsistent metadata all
    fail, so a claim can never outlive the evidence for it.
    """
    if not isinstance(layer, dict) or layer.get("export_contract") != IMAGERY_EXPORT_CONTRACT:
        return True, None
    tiles = layer.get("tiles")
    if not isinstance(tiles, list) or not tiles:
        return False, "imagery claims the exact-extent contract but declares no tiles"
    for t in tiles:
        if not tile_verification_ok(t):
            rc = (t.get("row"), t.get("column")) if isinstance(t, dict) else None
            return False, f"imagery tile {rc} has no valid extent verification"
    diag = layer.get("diagnostics")
    if not isinstance(diag, dict):
        return False, "imagery claims the exact-extent contract but has no diagnostics"
    n = len(tiles)
    if diag.get("export_contract") != IMAGERY_EXPORT_CONTRACT:
        return False, "imagery diagnostics do not declare the exact-extent contract"
    if diag.get("adjust_aspect_ratio") is not False:
        return False, "imagery diagnostics do not record adjustAspectRatio=false"
    if diag.get("extents_verified") is not True:
        return False, "imagery diagnostics do not assert extents_verified"
    if diag.get("extents_verified_count") != n:
        return False, f"imagery extents_verified_count != tile count ({n})"
    if diag.get("extent_mismatch_count") != 0:
        return False, "imagery diagnostics report an extent mismatch"
    if diag.get("dimensions_verified_count") != n:
        return False, f"imagery dimensions_verified_count != tile count ({n})"
    declared = layer.get("tile_count")
    if declared is not None and _whole(declared) != n:
        return False, f"imagery tile_count {declared} != declared tiles ({n})"
    return True, None


def tile_diagnostics(plan: dict, tile_metas: list, present_files: set | None = None,
                     *, export_contract: str | None = None) -> dict:
    """Package-time evidence that the tiled imagery is actually sound.

    assert_no_gaps_or_overlaps() RAISES at build time but writes nothing, so a shipped
    bundle carried no proof the check ran. This records a bounded, truthful result:
    declared vs present tile files, gap/overlap status, and dimension consistency.
    Never raises — a diagnostic must not be able to fail a build.

    `export_contract` adds the exact-extent verification aggregate. It is supplied ONLY
    by a build that actually performed the per-tile verification; omitted, no
    verification key is emitted at all, so a legacy package is never labelled verified.
    """
    declared = [str(t.get("file")) for t in tile_metas if t.get("file")]
    # NB: an EMPTY set is a meaningful answer ("nothing present"), so test for None.
    present = set(present_files) if present_files is not None else set(declared)
    missing = sorted(f for f in declared if f not in present)
    dims = [(int(t["width_px"]), int(t["height_px"]))
            for t in tile_metas if t.get("width_px") and t.get("height_px")]
    gaps_ok, gaps_reason = True, None
    try:
        assert_no_gaps_or_overlaps(plan)
    except ImageryPlanError as e:
        gaps_ok, gaps_reason = False, str(e)[:120]
    except Exception:  # noqa: BLE001 - never let a diagnostic break packaging
        gaps_ok, gaps_reason = False, "diagnostic error"
    out = {
        "tiles_declared": len(declared),
        "tiles_present": len(declared) - len(missing),
        "missing_files": missing[:8],
        "bounds_gap_free": bool(gaps_ok),
        "bounds_overlap_free": bool(gaps_ok),
        "dimensions_measured": len(dims),
        # Aspect-matched export => tiles are NOT required to be identical; we record
        # whether every tile reported a measurable size, not that they all match.
        "dimensions_complete": len(dims) == len(declared),
    }
    if gaps_reason:
        out["bounds_reason"] = gaps_reason
    if export_contract:
        out.update(verification_diagnostics(tile_metas, export_contract=export_contract))
    return out


def is_jpeg(data: bytes | None) -> bool:
    return bool(data) and data[:3] == _JPEG_MAGIC


def is_png(data: bytes | None) -> bool:
    return bool(data) and data[:8] == _PNG_MAGIC


def is_supported_image(data: bytes | None) -> bool:
    return is_jpeg(data) or is_png(data)


# ---- bounded retry with exponential backoff + jitter -----------------------

def backoff_delay(attempt: int, *, base_delay_s: float, max_delay_s: float) -> float:
    """Exponential backoff for a 0-based attempt index (no jitter): base * 2^attempt,
    capped at max_delay_s. Deterministic — jitter is added separately/injectably."""
    return min(float(max_delay_s), float(base_delay_s) * (2 ** max(0, int(attempt))))


def run_with_retries(
    fn,
    *,
    retries: int,
    base_delay_s: float = 1.0,
    max_delay_s: float = 30.0,
    deadline_s: float | None = None,
    sleep=None,
    monotonic=None,
    jitter=None,
    is_retryable=None,
):
    """Call fn(attempt) with bounded retries + exponential backoff + jitter.

    Total attempts = retries + 1. A single transient failure (timeout/5xx) does NOT
    fail the whole thing; only exhausted retries (or the overall deadline) raise —
    the last exception, so the caller can attach exact tile coordinates + a sanitized
    upstream reason. `sleep`/`monotonic`/`jitter` are injectable for deterministic
    tests (no real sleeping). `is_retryable(exc)` (default: everything) decides whether
    a failure is transient.
    """
    import time

    _sleep = sleep or time.sleep
    _mono = monotonic or time.monotonic
    _jitter = jitter if jitter is not None else (lambda attempt: 0.0)
    start = _mono()
    attempt = 0
    last_exc: Exception | None = None
    while True:
        if deadline_s is not None and (_mono() - start) > float(deadline_s):
            raise ImageryDeadlineError(
                f"imagery worker deadline ({deadline_s}s) exhausted after {attempt} attempt(s)"
            ) from last_exc
        try:
            return fn(attempt)
        except Exception as e:  # noqa: BLE001 - retry policy decides terminal vs transient
            last_exc = e
            if is_retryable is not None and not is_retryable(e):
                raise
            if attempt >= int(retries):
                raise
            delay = backoff_delay(attempt, base_delay_s=base_delay_s, max_delay_s=max_delay_s) + float(_jitter(attempt))
            if deadline_s is not None and (_mono() - start) + delay > float(deadline_s):
                raise ImageryDeadlineError(
                    f"imagery worker deadline ({deadline_s}s) would be exceeded before retry"
                ) from e
            _sleep(delay)
            attempt += 1


def sanitize_reason(exc: Exception, *, limit: int = 160) -> str:
    """A short, secrets-free description of an upstream failure for the job's
    error_details. Strips URL query strings (tokens) and truncates."""
    import re

    msg = str(exc) or exc.__class__.__name__
    msg = re.sub(r"([?&])[^\s]*", r"\1<redacted>", msg)  # drop query strings/tokens
    msg = msg.replace("\n", " ").strip()
    return msg[:limit]
