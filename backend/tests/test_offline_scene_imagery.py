"""Pure tests for HIGH-DEFINITION TILED offline aerial imagery.

No DB / no network. Covers tile planning (square + rectangular AOIs, no gap/overlap,
max upstream export size, source-resolution clamp, deterministic effective m/px,
tile-count budget), image-response validation, bounded retry/backoff (one timed-out
tile eventually succeeds; exhausted retries fail), and the builder's all-or-nothing
tiled packaging (durable per-tile progress, no partial imagery, mandatory failure
with exact tile coordinates + sanitized reason). Legacy single-image compatibility
lives in test_offline_scene_context.py.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.config import settings
from app.services import offline_scene_builder as builder
from app.services import offline_scene_context as ctxmod
from app.services import offline_scene_imagery as imagery
from app.services.offline_scene_builder import HillshadeReliefBuilder, OfflineSceneBuildError

# ~4.4 km N-S AOI near lat 38.5 (rectangular after cos-lat: narrower E-W).
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
SQUARE = {"min_lat": 0.0, "min_lon": 0.0, "max_lat": 0.05, "max_lon": 0.05}  # equator: ~square metres


def _jpeg_with_dims(w: int, h: int) -> bytes:
    """Minimal JPEG carrying a real SOF0 frame header — what a decoder actually reads."""
    sof = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big")
    sof += b"\x03" + b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + sof + b"\xff\xd9"


# A measurable JPEG: under the exact-extent contract a packaged tile MUST have readable
# dimensions that match the size the service declared, so a magic-only body can no
# longer be packaged at all.
FAKE_JPEG = _jpeg_with_dims(1024, 1024)


def _verified_fetch(data: bytes, source: dict | None = None):
    """A stubbed `fetch_imagery_tile` returning exactly what the real verified export
    returns: (bytes, source, verification). The verification is derived from the tile's
    OWN header, so it is self-consistent the way a genuine one is."""
    dims = imagery.image_dimensions(data)
    w, h = dims if dims else (0, 0)

    def _fetch(bounds, **k):
        return data, dict(source or {"provider": "usgs_naip", "attribution": "NAIP"}), {
            "extent_verified": True,
            "extent_max_delta_deg": 0.0,
            "extent_tolerance_deg": imagery.EXTENT_TOLERANCE_DEG,
            "requested_width_px": w, "requested_height_px": h,
            "returned_width_px": w, "returned_height_px": h,
            "dimensions_verified": True,
        }

    return _fetch


# ---- tile planning ---------------------------------------------------------

class TestTargetMpp:
    def test_source_native_sentinel_uses_native(self):
        assert imagery.resolve_target_mpp("source_native_or_0.6", 1.0) == 1.0
        # native unknown -> 0.6 fallback
        assert imagery.resolve_target_mpp("source_native_or_0.6", 0) == 0.6

    def test_numeric_target_clamped_not_finer_than_source(self):
        # requested 0.3 but source only 1.0 m/px -> never plan finer than 1.0.
        assert imagery.resolve_target_mpp("0.3", 1.0) == 1.0
        assert imagery.resolve_target_mpp(0.3, 1.0) == 1.0
        # requested coarser than source -> honour the coarser request.
        assert imagery.resolve_target_mpp("2.0", 1.0) == 2.0


class TestTilePlanning:
    def test_square_aoi_is_symmetric(self):
        plan = imagery.plan_imagery_tiles(SQUARE, tile_px=1024, target_mpp=1.0, source_native_mpp=1.0)
        assert plan["columns"] == plan["rows"]  # equator square metres -> square tile grid
        imagery.assert_no_gaps_or_overlaps(plan)

    def test_rectangular_aoi_more_rows_than_columns(self):
        # BOUNDS is taller than wide (cos-lat) -> at least as many rows as columns.
        plan = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.6, source_native_mpp=0.6)
        assert plan["rows"] >= plan["columns"]
        assert plan["columns"] * plan["rows"] == len(plan["tiles"])
        imagery.assert_no_gaps_or_overlaps(plan)

    def test_no_gaps_or_overlaps_shared_exact_edges(self):
        plan = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.6)
        cols, rows = plan["columns"], plan["rows"]
        by = {(t["row"], t["column"]): t["bounds"] for t in plan["tiles"]}
        # adjacent columns share the EXACT edge; adjacent rows too (float-exact).
        for r in range(rows):
            for c in range(cols - 1):
                assert by[(r, c)]["max_lon"] == by[(r, c + 1)]["min_lon"]
        for r in range(rows - 1):
            for c in range(cols):
                assert by[(r, c)]["min_lat"] == by[(r + 1, c)]["max_lat"]
        # outer edges exactly equal the AOI.
        assert by[(0, 0)]["min_lon"] == BOUNDS["min_lon"] and by[(0, 0)]["max_lat"] == BOUNDS["max_lat"]
        assert by[(rows - 1, cols - 1)]["max_lon"] == BOUNDS["max_lon"]
        assert by[(rows - 1, cols - 1)]["min_lat"] == BOUNDS["min_lat"]

    def test_files_are_row_col_jpg(self):
        plan = imagery.plan_imagery_tiles(SQUARE, tile_px=1024, target_mpp=1.0)
        for t in plan["tiles"]:
            assert t["file"] == f"imagery/{t['row']}/{t['column']}.jpg"

    def test_max_export_size_respected(self):
        # tile_px must be <= max_export_px; a tile export never approaches the max.
        with pytest.raises(imagery.ImageryPlanError):
            imagery.plan_imagery_tiles(SQUARE, tile_px=8192, target_mpp=1.0, max_export_px=4096)
        plan = imagery.plan_imagery_tiles(SQUARE, tile_px=2048, target_mpp=1.0, max_export_px=4096)
        assert plan["tile_size_px"] == 2048 <= 4096

    def test_source_resolution_clamp_reduces_tiles(self):
        fine = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.3, source_native_mpp=None, max_tiles=1000)
        clamped = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.3, source_native_mpp=2.0, max_tiles=1000)
        # clamping to a coarser source-native GSD yields FEWER tiles (no over-request).
        assert len(clamped["tiles"]) < len(fine["tiles"])
        assert clamped["target_meters_per_pixel"] >= 2.0

    def test_effective_resolution_is_deterministic_and_honest(self):
        plan = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.6, source_native_mpp=0.6)
        again = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.6, source_native_mpp=0.6)
        assert plan["effective_meters_per_pixel"] == again["effective_meters_per_pixel"]  # deterministic
        # Reported effective is never overstated: real detail can't exceed source-native,
        # and (post-clamp) never claims finer than the resolved target.
        assert plan["effective_meters_per_pixel"] >= 0.6 - 1e-9  # not finer than source-native
        assert plan["effective_meters_per_pixel"] <= plan["target_meters_per_pixel"] + 1e-9

    def test_tile_count_budget_fails_precisely(self):
        with pytest.raises(imagery.ImageryPlanError) as ei:
            imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=0.05, source_native_mpp=None, max_tiles=8)
        msg = str(ei.value)
        assert "exceeding the max of 8" in msg and "tiles" in msg


# ---- image-response validation ---------------------------------------------

class TestImageValidation:
    def test_jpeg_png_accepted_json_rejected(self):
        assert imagery.is_jpeg(FAKE_JPEG) and imagery.is_supported_image(FAKE_JPEG)
        assert imagery.is_png(b"\x89PNG\r\n\x1a\n----")
        assert not imagery.is_supported_image(b'{"error":{"code":400}}')
        assert not imagery.is_supported_image(b"<html>gateway timeout</html>")
        assert not imagery.is_supported_image(b"")


# ---- bounded retry / backoff -----------------------------------------------

class TestRetry:
    def test_backoff_is_exponential_and_capped(self):
        d = [imagery.backoff_delay(a, base_delay_s=1.0, max_delay_s=8.0) for a in range(5)]
        assert d == [1.0, 2.0, 4.0, 8.0, 8.0]

    def test_one_timed_out_tile_eventually_succeeds(self):
        calls = {"n": 0}

        def fn(attempt):
            calls["n"] += 1
            if attempt < 2:
                raise TimeoutError("read timed out")
            return "ok"

        out = imagery.run_with_retries(fn, retries=3, sleep=lambda *_: None, jitter=lambda a: 0.0)
        assert out == "ok" and calls["n"] == 3  # failed twice, succeeded on the 3rd

    def test_exhausted_retries_raise_last_exception(self):
        def fn(attempt):
            raise TimeoutError("upstream 504")

        with pytest.raises(TimeoutError):
            imagery.run_with_retries(fn, retries=2, sleep=lambda *_: None, jitter=lambda a: 0.0)

    def test_overall_deadline_short_circuits(self):
        clock = {"t": 0.0}

        def mono():
            return clock["t"]

        def sleep(d):
            clock["t"] += d

        def fn(attempt):
            raise TimeoutError("slow")

        with pytest.raises(imagery.ImageryDeadlineError):
            imagery.run_with_retries(
                fn, retries=100, base_delay_s=1.0, deadline_s=3.0, sleep=sleep, monotonic=mono, jitter=lambda a: 0.0
            )

    def test_sanitize_reason_strips_query_tokens(self):
        r = imagery.sanitize_reason(RuntimeError("GET https://svc.gov/exportImage?token=SECRET&f=image failed"))
        assert "SECRET" not in r and "<redacted>" in r


# ---- builder: all-or-nothing tiled packaging -------------------------------

def _ctx():
    return {
        "submission_id": 11,
        "package_version": "gtiled-1",
        "center": {"lat": 38.5, "lon": -121.5},
        "radius_m": 1500.0,
        "bounds": BOUNDS,
        "content_signature": "sig",
        "overlays": {"incident": {"lat": 38.5, "lon": -121.5}, "roadBearingDeg": None, "geometry": None, "sampleExtent": None},
    }


def _tiled_settings(monkeypatch, *, mandatory=False, retries=1):
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "tiled")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MANDATORY", mandatory)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TARGET_MPP", "2.0")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_SOURCE_NATIVE_MPP", 2.0)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TILE_PX", 1024)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TILE_RETRIES", retries)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MAX_TILES", 64)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MAX_MB", 256)


class TestBuilderTiledImagery:
    def _builder(self):
        b = HillshadeReliefBuilder()
        b._sleep = lambda *_: None  # never really sleep in tests
        return b

    def test_tiled_imagery_packaged_with_progress(self, monkeypatch):
        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        progress: list = []
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0, progress=lambda status, msg: progress.append(msg))

        img = layers["imagery"]
        assert img["available"] is True and img["format"] == "tiled"
        n = img["columns"] * img["rows"]
        assert n == len(img["tiles"]) == img["tile_count"] >= 2  # rectangular AOI -> multiple tiles
        # every declared tile is present in the assets, keyed by imagery/{r}/{c}.jpg
        for t in img["tiles"]:
            assert t["file"] in assets and t["sha256"] and t["bytes"] == len(FAKE_JPEG)
            assert t["file"] == f"imagery/{t['row']}/{t['column']}.jpg"
        # durable per-tile progress line the mobile app renders verbatim.
        assert f"Packaging aerial imagery: {n} of {n} tiles" in progress
        assert any(m.startswith("Packaging aerial imagery: 1 of ") for m in progress)

    def test_bundle_with_tiled_imagery_validates(self, monkeypatch):
        import numpy as np

        from app.services import offline_scene_terrain as tf

        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        heights = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        meta = tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        usgs = {"dataset": "USGS 3DEP", "version": "2026-07-07", "resolution": "3 m/px", "service": "svc"}
        basemap = {"provider": "usgs_hillshade", "source_label": "hs", "has_imagery": True, "has_hillshade": True}
        manifest = builder.build_manifest(_ctx(), usgs, basemap, meta, layers)
        pkg = builder.assemble_bundle(grid, b"HS", {}, manifest, assets)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert ok, reason
        m = json.loads(zipfile.ZipFile(io.BytesIO(pkg)).read("manifest.json"))
        assert m["context_layers"]["imagery"]["format"] == "tiled"

    def test_missing_tile_fails_closed(self, monkeypatch):
        import numpy as np

        from app.services import offline_scene_terrain as tf

        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        heights = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        meta = tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        dropped = layers["imagery"]["tiles"][0]["file"]
        assets.pop(dropped)  # a declared-available tile is missing from the bundle
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, layers)
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, assets)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and dropped in reason

    def test_corrupt_tile_checksum_fails_closed(self, monkeypatch):
        import numpy as np

        from app.services import offline_scene_terrain as tf

        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        heights = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        meta = tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        bad = layers["imagery"]["tiles"][0]["file"]
        assets[bad] = FAKE_JPEG + b"TAMPER"
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, layers)
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, assets)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "checksum mismatch" in reason

    def test_mandatory_tile_failure_raises_with_coordinates(self, monkeypatch):
        _tiled_settings(monkeypatch, mandatory=True, retries=1)

        def _boom(bounds, **k):
            raise TimeoutError("GET https://svc.gov/exportImage?token=SECRET timed out")

        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _boom)
        b = self._builder()
        with pytest.raises(OfflineSceneBuildError) as ei:
            b._build_context_layers(_ctx(), base_bytes=0)
        msg = str(ei.value)
        assert "tile (0,0)" in msg and "SECRET" not in msg  # exact coord, sanitized reason

    def test_optional_tile_failure_marks_unavailable_no_partial(self, monkeypatch):
        _tiled_settings(monkeypatch, mandatory=False, retries=0)
        seen = {"n": 0}

        def _fail_after_first(bounds, **k):
            seen["n"] += 1
            if seen["n"] == 1:
                return _verified_fetch(FAKE_JPEG)(bounds, **k)
            raise TimeoutError("upstream 504")

        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _fail_after_first)
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        assert layers["imagery"]["available"] is False
        assert layers["imagery"]["reason"].startswith("tile_failed")
        # NO partial imagery: the one tile that DID succeed was rolled back.
        assert not any(k.startswith("imagery/") for k in assets)

    def test_packaged_tiles_carry_the_exact_extent_contract_and_evidence(self, monkeypatch):
        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        layers, _assets = self._builder()._build_context_layers(_ctx(), base_bytes=0)
        img = layers["imagery"]
        assert img["export_contract"] == imagery.IMAGERY_EXPORT_CONTRACT
        n = img["tile_count"]
        for t in img["tiles"]:
            assert imagery.tile_verification_ok(t)
            assert t["extent_verified"] is True and t["dimensions_verified"] is True
            assert t["returned_width_px"] == t["width_px"] == 1024
        d = img["diagnostics"]
        assert d["extents_verified"] is True
        assert d["extents_verified_count"] == d["dimensions_verified_count"] == n
        assert d["extent_mismatch_count"] == 0
        assert d["adjust_aspect_ratio"] is False
        assert d["export_contract"] == imagery.IMAGERY_EXPORT_CONTRACT

    def test_a_bundle_claiming_the_contract_without_evidence_fails_closed(self, monkeypatch):
        import numpy as np

        from app.services import offline_scene_terrain as tf

        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(FAKE_JPEG))
        heights = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
        grid, stats = tf.encode_height_grid(heights)
        meta = tf.build_terrain_metadata(stats, BOUNDS, tf.grid_sha256(grid))
        b = self._builder()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        # A package that still CLAIMS the contract but has lost one tile's proof must not
        # validate — the claim can never outlive the evidence for it.
        layers["imagery"]["tiles"][0].pop("extent_verified")
        manifest = builder.build_manifest(_ctx(), self._usgs(), self._basemap(), meta, layers)
        pkg = builder.assemble_bundle(grid, b"", {}, manifest, assets)
        ok, reason = builder.validate_bundle_bytes(pkg)
        assert not ok and "extent verification" in reason

    def test_an_unverified_fetch_result_never_reaches_a_package(self, monkeypatch):
        """Fail-closed at the builder: if a fetch somehow returns an incomplete
        verification, the tile is rolled back rather than packaged as legacy."""
        _tiled_settings(monkeypatch, mandatory=False, retries=0)

        def _unverified(bounds, **k):
            return FAKE_JPEG, {"provider": "usgs_naip"}, {"extent_verified": False}

        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _unverified)
        layers, assets = self._builder()._build_context_layers(_ctx(), base_bytes=0)
        assert layers["imagery"]["available"] is False
        assert "export_contract" not in layers["imagery"]
        assert not any(k.startswith("imagery/") for k in assets), "no partial imagery"

    def test_a_deterministic_contract_failure_is_not_retried(self, monkeypatch):
        _tiled_settings(monkeypatch, mandatory=True, retries=3)
        calls = {"n": 0}

        def _adjusted(bounds, **k):
            calls["n"] += 1
            raise imagery.ImageryContractError(
                "returned extent differs from the requested extent by 7.6e-04 deg")

        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _adjusted)
        with pytest.raises(OfflineSceneBuildError) as ei:
            self._builder()._build_context_layers(_ctx(), base_bytes=0)
        assert calls["n"] == 1, "an adjusted extent is identical on every attempt"
        assert "tile (0,0)" in str(ei.value)

    def _usgs(self):
        return {"dataset": "USGS 3DEP", "version": "2026-07-07", "resolution": "3 m/px", "service": "svc"}

    def _basemap(self):
        return {"provider": "usgs_hillshade", "source_label": "hs", "has_imagery": True, "has_hillshade": True}
