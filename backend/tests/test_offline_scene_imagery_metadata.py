"""Truthful imagery-resolution metadata + package diagnostics (D-worker).

GROUND SAMPLE DISTANCE controls genuine detail; tile pixel dimensions only control request
partitioning and texture management. These tests pin that the package never claims detail
finer than the source provides, that per-tile pixel dimensions are MEASURED from the decoded
header (not the requested size — the export is aspect-matched, so tiles are generally not
square), that an acquisition vintage is never invented, and that a shipped bundle carries
evidence its tiling is gap-free/overlap-free with every declared file present.

No DB / no network.
"""

from __future__ import annotations

from app.config import settings
from app.services import offline_scene_context as ctxmod
from app.services import offline_scene_imagery as imagery
from app.services.offline_scene_builder import HillshadeReliefBuilder

BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}
FAKE_JPEG_MAGIC_ONLY = b"\xff\xd8\xff" + b"\x00" * 512   # valid magic, NO frame header


def _jpeg_with_dims(w: int, h: int) -> bytes:
    """Minimal JPEG carrying a real SOF0 frame header — what a decoder actually reads."""
    sof = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big")
    sof += b"\x03" + b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + sof + b"\xff\xd9"


def _png_with_dims(w: int, h: int) -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
            + w.to_bytes(4, "big") + h.to_bytes(4, "big") + b"\x08\x02\x00\x00\x00")


def _verified_fetch(data: bytes, source: dict | None = None):
    """A stubbed `fetch_imagery_tile` returning (bytes, source, verification) exactly as
    the real exact-extent export does, with the verification derived from the tile's own
    header so it is self-consistent."""
    dims = imagery.image_dimensions(data)
    w, h = dims if dims else (0, 0)

    def _fetch(bounds, **k):
        return data, dict(source or {"provider": "usgs_naip"}), {
            "extent_verified": True,
            "extent_max_delta_deg": 0.0,
            "extent_tolerance_deg": imagery.EXTENT_TOLERANCE_DEG,
            "requested_width_px": w, "requested_height_px": h,
            "returned_width_px": w, "returned_height_px": h,
            "dimensions_verified": True,
        }

    return _fetch


def _plan(tile_px: int = 1024, target: float = 0.6, native: float | None = 0.6) -> dict:
    return imagery.plan_imagery_tiles(BOUNDS, tile_px=tile_px, target_mpp=target, source_native_mpp=native)


# ---- measured (not requested) pixel dimensions ------------------------------


class TestMeasuredImageDimensions:
    def test_jpeg_dimensions_come_from_the_real_sof_header(self):
        assert imagery.image_dimensions(_jpeg_with_dims(1024, 768)) == (1024, 768)
        assert imagery.image_dimensions(_jpeg_with_dims(2048, 2048)) == (2048, 2048)

    def test_png_dimensions_come_from_ihdr(self):
        assert imagery.image_dimensions(_png_with_dims(640, 480)) == (640, 480)

    def test_aspect_matched_tiles_are_not_square(self):
        """tile_size_px is a REQUEST partition; the real tile is whatever was returned."""
        assert imagery.image_dimensions(_jpeg_with_dims(1024, 512)) == (1024, 512)

    def test_undecodable_data_returns_none_and_never_raises(self):
        for bad in (None, b"", b"not an image at all........", FAKE_JPEG_MAGIC_ONLY,
                    b"\xff\xd8\xff\xc0\x00", b"\x89PNG\r\n\x1a\n"):
            assert imagery.image_dimensions(bad) is None


# ---- source-native GSD ------------------------------------------------------


class TestSourceNativeGsd:
    def test_plan_records_source_native_gsd(self):
        assert _plan()["source_native_meters_per_pixel"] == 0.6

    def test_effective_gsd_is_never_finer_than_the_source(self):
        p = _plan(target=0.1, native=1.0)          # ask far finer than the source
        assert p["target_meters_per_pixel"] >= 1.0
        assert p["effective_meters_per_pixel"] >= 1.0
        assert p["source_native_meters_per_pixel"] == 1.0

    def test_a_bigger_tile_px_does_not_create_finer_detail(self):
        a, b = _plan(tile_px=1024), _plan(tile_px=2048)
        assert a["effective_meters_per_pixel"] == b["effective_meters_per_pixel"] == 0.6
        assert a["source_native_meters_per_pixel"] == b["source_native_meters_per_pixel"] == 0.6

    def test_source_native_is_null_when_not_configured(self):
        assert _plan(native=None)["source_native_meters_per_pixel"] is None


# ---- package diagnostics ----------------------------------------------------


class TestTileDiagnostics:
    def test_confirms_files_present_and_bounds_gap_and_overlap_free(self):
        p = _plan()
        metas = [{**t, "width_px": 1024, "height_px": 1024} for t in p["tiles"]]
        d = imagery.tile_diagnostics(p, metas, present_files={t["file"] for t in p["tiles"]})
        assert d["tiles_declared"] == len(p["tiles"]) == d["tiles_present"]
        assert d["missing_files"] == []
        assert d["bounds_gap_free"] is True and d["bounds_overlap_free"] is True
        assert d["dimensions_measured"] == len(metas) and d["dimensions_complete"] is True

    def test_reports_a_missing_tile_file(self):
        p = _plan()
        d = imagery.tile_diagnostics(p, [dict(t) for t in p["tiles"]], present_files=set())
        assert d["tiles_present"] == 0 and len(d["missing_files"]) > 0

    def test_reports_unmeasured_dimensions(self):
        p = _plan()
        d = imagery.tile_diagnostics(p, [dict(t) for t in p["tiles"]])
        assert d["dimensions_measured"] == 0 and d["dimensions_complete"] is False

    def test_detects_a_broken_plan_and_never_raises(self):
        p = _plan()
        broken = dict(p, tiles=[dict(t) for t in p["tiles"]])
        broken["tiles"][0]["bounds"] = dict(broken["tiles"][0]["bounds"], max_lon=999.0)
        d = imagery.tile_diagnostics(broken, broken["tiles"])
        assert d["bounds_gap_free"] is False and "bounds_reason" in d

    def test_never_raises_on_garbage(self):
        d = imagery.tile_diagnostics({"columns": 0, "rows": 0, "tiles": [], "bounds": {}}, [])
        assert d["bounds_gap_free"] is False and d["tiles_declared"] == 0


# ---- manifest layer ---------------------------------------------------------


class TestTiledImageryLayerMetadata:
    def _layer(self, **kw):
        p = _plan()
        metas = [{**t, "sha256": "a" * 64, "bytes": 1000, "width_px": 1024, "height_px": 512}
                 for t in p["tiles"]]
        return ctxmod.tiled_imagery_layer(p, metas, {"provider": "usgs_naip"}, **kw), p, metas

    def test_reports_resolution_measured_pixels_bytes_and_quality(self):
        layer, plan, metas = self._layer(jpeg_quality=85)
        assert layer["source_native_meters_per_pixel"] == 0.6
        assert layer["target_meters_per_pixel"] == plan["target_meters_per_pixel"]
        assert layer["effective_meters_per_pixel"] == plan["effective_meters_per_pixel"]
        assert layer["pixel_count"] == 1024 * 512 * len(metas), "measured, never requested"
        assert layer["bytes"] == 1000 * len(metas)
        assert layer["tile_count"] == len(metas)
        assert layer["jpeg_quality"] == 85
        assert layer["tiles"][0]["width_px"] == 1024 and layer["tiles"][0]["height_px"] == 512

    def test_tile_size_px_is_a_partition_not_a_resolution_claim(self):
        layer, _, _ = self._layer()
        assert layer["tile_size_px"] == 1024
        assert layer["tiles"][0]["height_px"] == 512, "the real dims come from the decoded header"

    def test_vintage_is_omitted_and_flagged_unavailable_when_unknown(self):
        layer, _, _ = self._layer()
        assert layer["vintage_available"] is False and "vintage" not in layer

    def test_vintage_is_reported_only_when_truthfully_declared(self):
        layer, _, _ = self._layer(vintage="NAIP 2022")
        assert layer["vintage_available"] is True and layer["vintage"] == "NAIP 2022"
        blank, _, _ = self._layer(vintage="   ")
        assert blank["vintage_available"] is False and "vintage" not in blank

    def test_layer_carries_the_diagnostic_result(self):
        p = _plan()
        metas = [{**t, "sha256": "a" * 64, "bytes": 10, "width_px": 8, "height_px": 8} for t in p["tiles"]]
        diag = imagery.tile_diagnostics(p, metas, present_files={t["file"] for t in p["tiles"]})
        layer = ctxmod.tiled_imagery_layer(p, metas, None, diagnostics=diag)
        assert layer["diagnostics"]["bounds_gap_free"] is True
        assert layer["diagnostics"]["tiles_present"] == len(p["tiles"])

    def test_legacy_call_without_new_kwargs_still_works(self):
        p = _plan()
        metas = [{**t, "sha256": "a" * 64, "bytes": 10} for t in p["tiles"]]
        layer = ctxmod.tiled_imagery_layer(p, metas, None)
        assert layer["available"] is True and layer["vintage_available"] is False
        assert "pixel_count" not in layer, "no measured dims -> no pixel claim"


# ---- builder integration ----------------------------------------------------


def _ctx():
    return {
        "submission_id": 11, "package_version": "gimg-1",
        "center": {"lat": 38.5, "lon": -121.5}, "radius_m": 1500.0,
        "bounds": BOUNDS, "content_signature": "sig",
        "overlays": {"incident": {"lat": 38.5, "lon": -121.5}, "roadBearingDeg": None,
                     "geometry": None, "sampleExtent": None},
    }


def _tiled_settings(monkeypatch):
    monkeypatch.setattr(settings, "OFFLINE_SCENE_ROADS_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_OVERVIEW_ENABLED", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", True)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "tiled")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MANDATORY", False)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TARGET_MPP", "2.0")
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_SOURCE_NATIVE_MPP", 2.0)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TILE_PX", 1024)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_TILE_RETRIES", 1)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MAX_TILES", 64)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MAX_MB", 256)
    monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_SOURCE_VINTAGE", "")


class TestBuilderImageryMetadata:
    def test_builder_measures_and_packages_truthful_metadata(self, monkeypatch):
        _tiled_settings(monkeypatch)
        tile = _jpeg_with_dims(1024, 768)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile",
                            _verified_fetch(tile, {"provider": "usgs_naip", "attribution": "NAIP"}))
        b = HillshadeReliefBuilder()
        b._session = object()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        img = layers["imagery"]
        assert img["available"] is True
        assert img["source_native_meters_per_pixel"] == 2.0
        assert img["jpeg_quality"] == settings.OFFLINE_SCENE_IMAGERY_JPEG_QUALITY
        assert img["vintage_available"] is False and "vintage" not in img
        assert img["pixel_count"] == 1024 * 768 * img["tile_count"], "measured from the SOF header"
        for t in img["tiles"]:
            assert t["width_px"] == 1024 and t["height_px"] == 768
        d = img["diagnostics"]
        assert d["bounds_gap_free"] is True and d["bounds_overlap_free"] is True
        assert d["tiles_present"] == d["tiles_declared"] == img["tile_count"]
        assert d["dimensions_complete"] is True
        for t in img["tiles"]:
            assert t["file"] in assets

    def test_unmeasurable_tile_now_fails_closed_under_the_exact_extent_contract(self, monkeypatch):
        # BEHAVIOUR CHANGE, deliberate. An unmeasurable header used to package fine (we
        # simply omitted pixel_count). Under the exact-extent contract the measured
        # dimensions ARE the proof that the delivered pixels are the ones the service
        # verified, so an unreadable header can no longer back the claim and the tile
        # fails closed instead of being packaged with an unverifiable registration.
        _tiled_settings(monkeypatch)
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile",
                            _verified_fetch(FAKE_JPEG_MAGIC_ONLY, {"provider": "usgs_naip"}))
        b = HillshadeReliefBuilder()
        b._session = object()
        layers, assets = b._build_context_layers(_ctx(), base_bytes=0)
        img = layers["imagery"]
        assert img["available"] is False
        assert img["reason"].startswith("tile_failed")
        assert not any(k.startswith("imagery/") for k in assets), "no partial imagery"
        # The honesty rule it used to guard still holds at the layer level: a layer built
        # from unmeasured tiles never claims a pixel count.
        legacy = ctxmod.tiled_imagery_layer(_plan(), [{"file": "imagery/0/0.jpg", "bytes": 10}], None)
        assert "pixel_count" not in legacy

    def test_declared_vintage_is_packaged(self, monkeypatch):
        _tiled_settings(monkeypatch)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_SOURCE_VINTAGE", "NAIP 2022")
        monkeypatch.setattr(ctxmod, "fetch_imagery_tile", _verified_fetch(_jpeg_with_dims(64, 64)))
        b = HillshadeReliefBuilder()
        b._session = object()
        layers, _ = b._build_context_layers(_ctx(), base_bytes=0)
        assert layers["imagery"]["vintage_available"] is True
        assert layers["imagery"]["vintage"] == "NAIP 2022"
