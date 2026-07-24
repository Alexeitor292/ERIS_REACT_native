"""The EXACT-EXTENT tiled-imagery export contract.

THE DEFECT THIS FILE EXISTS FOR. ERIS planned tile bounds in WGS84, requested a pixel
size matching each tile's METRIC aspect (~1:1), and sent bbox/bboxSR/imageSR=4326 with
`f=image` and no `adjustAspectRatio`. ArcGIS defaults adjustAspectRatio=TRUE and compares
the requested pixel aspect against the bbox aspect **in the OUTPUT spatial reference** —
degrees. At the incident latitude the tile is ~1.283:1 in degrees but ~1:1 in metres, so
the service silently EXPANDED each tile's bbox by ~28% of its height and returned pixels
covering more ground than was asked for. `f=image` returns only bytes, so nothing revealed
the swap: the manifest recorded the REQUESTED bounds over ADJUSTED pixels and every tile
row/column boundary repeated ~170 m of ground.

The contract: adjustAspectRatio=false, `f=json`, verify the service's own returned extent
/ size / spatial reference BEFORE downloading, validate the download URL, then measure the
delivered bytes. Anything else fails the tile CLOSED — pixels are never packaged under
bounds they do not cover.

No DB / no network. Run:
  pytest -m "not db" tests/test_offline_scene_exact_extent.py
"""

from __future__ import annotations

import math

import pytest

from app.services import offline_scene as offline_scene_svc
from app.services import offline_scene_context as ctxmod
from app.services import offline_scene_imagery as imagery

# The AOI from the field report (submission 20, package version g20260723055616-20):
# 5 rows x 5 columns, 25/25 tiles, every returned tile 1024x1024.
FIELD_BOUNDS = {
    "min_lon": -121.239445, "max_lon": -121.204871,
    "min_lat": 38.774981, "max_lat": 38.801931,
}
BOUNDS = {"min_lat": 38.48, "min_lon": -121.52, "max_lat": 38.52, "max_lon": -121.48}

SERVICE = "https://imagery.example.gov/arcgis/rest/services/NAIP/ImageServer"
# A realistic ArcGIS output href: same host, and carrying a token in the query. Every
# leak assertion below hunts for these two strings.
HREF = "https://imagery.example.gov/arcgis/rest/directories/arcgisoutput/NAIP/_ags_ab12.jpg?token=SECRET-TOKEN"
TOKEN = "SECRET-TOKEN"


def _jpeg_with_dims(w: int, h: int) -> bytes:
    """Minimal JPEG carrying a real SOF0 frame header — what a decoder actually reads."""
    sof = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big")
    sof += b"\x03" + b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + sof + b"\xff\xd9"


def _png_with_dims(w: int, h: int) -> bytes:
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
            + w.to_bytes(4, "big") + h.to_bytes(4, "big") + b"\x08\x02\x00\x00\x00")


def _extent(b: dict, wkid: int | None = 4326) -> dict:
    e = {"xmin": b["min_lon"], "ymin": b["min_lat"], "xmax": b["max_lon"], "ymax": b["max_lat"]}
    if wkid is not None:
        e["spatialReference"] = {"wkid": wkid, "latestWkid": wkid}
    return e


def _meta(b: dict, w: int, h: int, *, href: str = HREF, extent=..., wkid: int | None = 4326, **over) -> dict:
    m = {
        "href": href, "width": w, "height": h,
        "extent": _extent(b, wkid) if extent is ... else extent,
        "scale": 0,
    }
    m.update(over)
    return m


class FakeResp:
    def __init__(self, *, payload=None, content=b"", ctype="application/json", status=200, headers=None):
        self._p = payload
        self.status_code = status
        self.headers = {"Content-Type": ctype, **(headers or {})}
        self.content = content
        self.text = content.decode("latin-1") if isinstance(content, bytes) else str(content)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        if isinstance(self._p, Exception):
            raise self._p
        if self._p is None:
            raise ValueError("body is not JSON")
        return self._p


class FakeSession:
    """The two-step exact-extent export: exportImage metadata, then the href download.

    `hops` optionally queues (status, Location) redirect responses ahead of the image.
    Every request is recorded so the request contract itself can be asserted.
    """

    def __init__(self, meta, image: FakeResp | None = None, *, hops: list | None = None,
                 meta_resp: FakeResp | None = None):
        self._meta = meta
        self._meta_resp = meta_resp
        self._image = image if image is not None else FakeResp(content=_jpeg_with_dims(8, 8), ctype="image/jpeg")
        self._hops = list(hops or [])
        self.calls: list[dict] = []

    def get(self, url, params=None, timeout=None, allow_redirects=None):
        self.calls.append({"url": url, "params": params, "timeout": timeout,
                           "allow_redirects": allow_redirects})
        if url.endswith("/exportImage"):
            return self._meta_resp if self._meta_resp is not None else FakeResp(payload=self._meta)
        if self._hops:
            status, loc = self._hops.pop(0)
            return FakeResp(status=status, headers={"Location": loc})
        return self._image

    @property
    def meta_params(self) -> dict:
        return next(c["params"] for c in self.calls if c["url"].endswith("/exportImage"))

    @property
    def download_urls(self) -> list:
        return [c["url"] for c in self.calls if not c["url"].endswith("/exportImage")]


def _fetch(session, bounds=BOUNDS, *, tile_px=1024, quality=85):
    return ctxmod.fetch_imagery_tile(
        bounds, export_url=SERVICE, tile_px=tile_px, timeout_s=30,
        jpeg_quality=quality, session=session,
    )


def _sized_session(bounds=BOUNDS, tile_px=1024, **meta_over) -> FakeSession:
    """A session whose metadata and image both agree with the size we will request."""
    w, h = ctxmod.tile_export_dims(bounds, tile_px)
    return FakeSession(
        _meta(bounds, w, h, **meta_over),
        FakeResp(content=_jpeg_with_dims(w, h), ctype="image/jpeg"),
    )


# ============================================================================
# A — the request contract
# ============================================================================

class TestRequestContract:
    def test_upstream_format_and_contract_versions_are_explicit(self):
        assert imagery.UPSTREAM_EXPORT_FORMAT == "jpgpng"
        assert (
            imagery.IMAGERY_EXPORT_CONTRACT
            == "exact_extent_arcgis_export_jpgpng_v3"
        )
        assert (
            imagery.EXACT_EXTENT_EXPORT_CONTRACT_V2
            in imagery.VERIFIED_EXPORT_CONTRACTS
        )
        assert (
            imagery.IMAGERY_EXPORT_CONTRACT
            in imagery.VERIFIED_EXPORT_CONTRACTS
        )

    def test_adjust_aspect_ratio_false_is_always_sent(self):
        # THE fix. Omitting it lets ArcGIS default to true and re-fit the bbox.
        for b in (BOUNDS, FIELD_BOUNDS, {"min_lat": 0.0, "min_lon": 0.0, "max_lat": 0.05, "max_lon": 0.05}):
            for px in (256, 1024, 2048):
                p = ctxmod.export_tile_params(b, px, 85)
                assert p["adjustAspectRatio"] == "false"
        assert imagery.ADJUST_ASPECT_RATIO is False

    def test_asks_for_extent_bearing_json_metadata_not_raw_bytes(self):
        # f=image returns only bytes: an adjusted extent is structurally undetectable.
        assert ctxmod.export_tile_params(BOUNDS, 1024, 85)["f"] == "json"

    def test_bbox_sr_size_format_quality_are_exact(self):
        p = ctxmod.export_tile_params(BOUNDS, 1024, 73)
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        assert p["bbox"] == (f"{BOUNDS['min_lon']},{BOUNDS['min_lat']},"
                             f"{BOUNDS['max_lon']},{BOUNDS['max_lat']}")
        assert p["bboxSR"] == "4326" and p["imageSR"] == "4326"
        assert p["size"] == f"{w},{h}"
        assert p["format"] == "jpgpng"
        assert p["compressionQuality"] == "73"

    def test_the_contract_is_what_actually_goes_on_the_wire(self):
        s = _sized_session()
        _fetch(s, quality=90)
        p = s.meta_params
        assert p["adjustAspectRatio"] == "false" and p["f"] == "json"
        assert p["bboxSR"] == "4326" and p["imageSR"] == "4326"
        assert p["compressionQuality"] == "90"
        # metadata first, download second — pixels are never fetched before verification.
        assert s.calls[0]["url"].endswith("/exportImage")
        assert len(s.download_urls) == 1

    def test_metric_aspect_sizing_is_retained_for_square_ground_pixels(self):
        # Aspect matching is a QUALITY choice (~equal m/px on both axes) and is kept;
        # what makes the extent exact is adjustAspectRatio=false, not this.
        w, h = ctxmod.tile_export_dims(FIELD_BOUNDS, 1024)
        assert (w, h) == (1024, 1024)                       # ~1:1 in metres...
        lon_span = FIELD_BOUNDS["max_lon"] - FIELD_BOUNDS["min_lon"]
        lat_span = FIELD_BOUNDS["max_lat"] - FIELD_BOUNDS["min_lat"]
        assert abs(lon_span / lat_span - 1.282894) < 1e-5   # ...but ~1.283:1 in degrees


# ============================================================================
# B — the exact returned extent
# ============================================================================

class TestReturnedExtent:
    def _verify(self, extent, *, w=1024, h=1024, bounds=BOUNDS, **over):
        return imagery.verify_export_metadata(
            _meta(bounds, w, h, extent=extent, **over), bounds=bounds, width_px=w, height_px=h
        )

    def test_exact_extent_passes(self):
        v = self._verify(_extent(BOUNDS))
        assert v["extent_verified"] is True and v["extent_max_delta_deg"] == 0.0
        assert v["returned_width_px"] == 1024 and v["returned_height_px"] == 1024

    def test_serialization_noise_within_tolerance_passes(self):
        noisy = _extent(BOUNDS)
        for k in ("xmin", "ymin", "xmax", "ymax"):
            noisy[k] += 4e-10                     # below EXTENT_TOLERANCE_DEG
        v = self._verify(noisy)
        assert v["extent_verified"] is True
        assert 0 < v["extent_max_delta_deg"] <= imagery.EXTENT_TOLERANCE_DEG

    @pytest.mark.parametrize("key", ["ymin", "ymax"])
    def test_adjusted_north_or_south_fails(self, key):
        bad = _extent(BOUNDS)
        bad[key] += 1e-4                          # ~11 m: geographically meaningful
        with pytest.raises(imagery.ImageryContractError, match="adjusted the export"):
            self._verify(bad)

    @pytest.mark.parametrize("key", ["xmin", "xmax"])
    def test_adjusted_east_or_west_fails(self, key):
        bad = _extent(BOUNDS)
        bad[key] -= 1e-4
        with pytest.raises(imagery.ImageryContractError, match="adjusted the export"):
            self._verify(bad)

    def test_a_barely_over_tolerance_shift_still_fails(self):
        # "Close enough" is not a category: the tolerance covers rounding noise only.
        bad = _extent(BOUNDS)
        bad["ymax"] += imagery.EXTENT_TOLERANCE_DEG * 10
        with pytest.raises(imagery.ImageryContractError):
            self._verify(bad)

    def test_wrong_spatial_reference_fails(self):
        with pytest.raises(imagery.ImageryContractError, match="wkid"):
            self._verify(_extent(BOUNDS, wkid=3857))

    def test_missing_spatial_reference_fails(self):
        with pytest.raises(imagery.ImageryContractError, match="spatial reference"):
            self._verify(_extent(BOUNDS, wkid=None))

    def test_latest_wkid_alone_is_accepted(self):
        e = _extent(BOUNDS, wkid=None)
        e["spatialReference"] = {"latestWkid": 4326}
        assert self._verify(e)["extent_verified"] is True

    def test_missing_extent_fails(self):
        with pytest.raises(imagery.ImageryContractError, match="missing the returned extent"):
            self._verify(None)

    @pytest.mark.parametrize("val", [float("nan"), float("inf"), "-121.5", None, True, [1]])
    def test_malformed_or_non_finite_corner_fails(self, val):
        bad = _extent(BOUNDS)
        bad["xmax"] = val
        with pytest.raises(imagery.ImageryContractError, match="xmax"):
            self._verify(bad)

    def test_non_object_and_error_bodies_fail(self):
        for body in ([], "nope", 7, None):
            with pytest.raises(imagery.ImageryContractError, match="not a JSON object"):
                imagery.verify_export_metadata(body, bounds=BOUNDS, width_px=8, height_px=8)
        err = _meta(BOUNDS, 8, 8)
        err["error"] = {"code": 400, "message": "Invalid token SECRET-TOKEN"}
        with pytest.raises(imagery.ImageryContractError) as ei:
            imagery.verify_export_metadata(err, bounds=BOUNDS, width_px=8, height_px=8)
        assert TOKEN not in str(ei.value), "an error body may echo the request; never repeat it"

    def test_the_field_defect_is_rejected(self):
        """The exact adjustment ArcGIS performed on submission 20, reproduced."""
        plan = imagery.plan_imagery_tiles(FIELD_BOUNDS, tile_px=1024, target_mpp=0.6, source_native_mpp=0.6)
        tile = plan["tiles"][0]["bounds"]
        lon_span = tile["max_lon"] - tile["min_lon"]
        lat_span = tile["max_lat"] - tile["min_lat"]
        # adjustAspectRatio=true fits the DEGREE aspect to the requested 1:1 pixel aspect
        # by expanding the short (latitude) axis about the tile centre.
        excess = lon_span - lat_span
        adjusted = dict(tile)
        adjusted["min_lat"] -= excess / 2.0
        adjusted["max_lat"] += excess / 2.0
        assert excess / lat_span > 0.28, "the field report's ~28% duplicated ground per tile row"
        # ~170 m of repeated ground — and it is rejected outright.
        assert excess * 111_320.0 > 160.0
        with pytest.raises(imagery.ImageryContractError, match="adjusted the export"):
            imagery.verify_export_metadata(
                _meta(adjusted, 1024, 1024), bounds=tile, width_px=1024, height_px=1024,
            )

    def test_tolerance_is_far_below_one_pixel_and_far_above_float_noise(self):
        """The documented rationale, asserted rather than asserted-in-prose."""
        plan = imagery.plan_imagery_tiles(FIELD_BOUNDS, tile_px=1024, target_mpp=0.6, source_native_mpp=0.6)
        tile = plan["tiles"][0]["bounds"]
        deg_per_px = (tile["max_lon"] - tile["min_lon"]) / 1024.0
        assert imagery.EXTENT_TOLERANCE_DEG < deg_per_px / 1000.0, "sub-thousandth of a pixel"
        assert imagery.EXTENT_TOLERANCE_DEG > math.ulp(180.0) * 1000.0, "well above double ULP noise"


# ============================================================================
# C — dimensions, the href, and the delivered image
# ============================================================================

class TestDimensionsAndImage:
    def test_metadata_size_mismatch_fails(self):
        for w, h in ((1024, 800), (800, 1024), (1, 1)):
            with pytest.raises(imagery.ImageryContractError, match="was requested"):
                imagery.verify_export_metadata(
                    _meta(BOUNDS, w, h), bounds=BOUNDS, width_px=1024, height_px=1024)

    @pytest.mark.parametrize("val", [None, 0, -4, 1024.5, "1024", True])
    def test_missing_or_malformed_metadata_size_fails(self, val):
        with pytest.raises(imagery.ImageryContractError, match="width/height"):
            imagery.verify_export_metadata(
                _meta(BOUNDS, 1024, 1024, width=val), bounds=BOUNDS, width_px=1024, height_px=1024)

    def test_encoded_dimensions_must_match_the_declared_size(self):
        imagery.assert_encoded_dimensions(_jpeg_with_dims(64, 32), width_px=64, height_px=32)
        with pytest.raises(imagery.ImageryContractError, match="but 64x32 was declared"):
            imagery.assert_encoded_dimensions(_jpeg_with_dims(64, 33), width_px=64, height_px=32)

    def test_unreadable_or_non_image_bodies_fail(self):
        with pytest.raises(imagery.ImageryContractError, match="not a JPEG/PNG"):
            imagery.assert_encoded_dimensions(b'{"error":{"code":400}}', width_px=8, height_px=8)
        with pytest.raises(imagery.ImageryContractError, match="no readable image header"):
            imagery.assert_encoded_dimensions(b"\xff\xd8\xff" + b"\x00" * 64, width_px=8, height_px=8)

    def test_end_to_end_size_mismatch_fails_the_tile(self):
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        s = FakeSession(_meta(BOUNDS, w, h), FakeResp(content=_jpeg_with_dims(w, h - 1), ctype="image/jpeg"))
        with pytest.raises(imagery.ImageryContractError, match="was declared"):
            _fetch(s)

    def test_missing_href_fails(self):
        for href in (None, "", "   ", 7):
            with pytest.raises(imagery.ImageryContractError, match="missing the image href"):
                imagery.safe_export_href(href, service_url=SERVICE)

    def test_non_https_href_fails(self):
        for href in ("http://imagery.example.gov/x.jpg", "file:///etc/passwd",
                     "ftp://imagery.example.gov/x.jpg", "//imagery.example.gov/x.jpg"):
            with pytest.raises(imagery.ImageryContractError):
                imagery.safe_export_href(href, service_url=SERVICE)

    def test_userinfo_and_foreign_hosts_are_refused(self):
        for href in (
            "https://user:pass@imagery.example.gov/x.jpg",       # embedded credentials
            "https://imagery.example.gov@evil.test/x.jpg",       # host-confusion
            "https://evil.test/x.jpg",                           # different origin
            "https://imagery.example.gov.evil.test/x.jpg",       # suffix trick
            "https://169.254.169.254/latest/meta-data/",         # link-local metadata (SSRF)
            "https://imagery.example.gov:8443/x.jpg",            # different port
        ):
            with pytest.raises(imagery.ImageryContractError):
                imagery.safe_export_href(href, service_url=SERVICE)

    def test_same_origin_https_href_is_accepted(self):
        assert imagery.safe_export_href(HREF, service_url=SERVICE) == HREF
        # explicit :443 is the same origin as the default port
        assert imagery.safe_export_href("https://imagery.example.gov:443/a.jpg", service_url=SERVICE)
        # host comparison is case-insensitive
        assert imagery.safe_export_href("https://IMAGERY.Example.Gov/a.jpg", service_url=SERVICE)

    def test_json_or_html_download_body_fails(self):
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        for ctype in ("application/json", "text/html"):
            s = FakeSession(_meta(BOUNDS, w, h),
                            FakeResp(content=b'{"error":{"code":498,"message":"token SECRET-TOKEN"}}', ctype=ctype))
            with pytest.raises(imagery.ImageryContractError) as ei:
                _fetch(s)
            assert TOKEN not in str(ei.value)

    def test_metadata_body_that_is_not_json_fails(self):
        s = FakeSession(None, meta_resp=FakeResp(content=b"<html>error</html>", ctype="text/html"))
        with pytest.raises(imagery.ImageryContractError, match="not parsable JSON"):
            _fetch(s)

    def test_valid_jpeg_succeeds_and_reports_verification(self):
        s = _sized_session()
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        data, source, v = _fetch(s)
        assert imagery.is_jpeg(data)
        assert v["extent_verified"] is True and v["dimensions_verified"] is True
        assert (v["returned_width_px"], v["returned_height_px"]) == (w, h)
        assert (v["requested_width_px"], v["requested_height_px"]) == (w, h)
        assert source["provider"] == "usgs_naip"

    def test_supported_non_jpeg_is_re_encoded_and_re_measured(self):
        """PNG is a legitimate ImageServer format: normalise it to JPEG, then PROVE the
        re-encode preserved the verified pixel size rather than assuming it did."""
        pytest.importorskip("PIL")
        import io as _io

        from PIL import Image

        w, h = ctxmod.tile_export_dims(BOUNDS, 64)
        buf = _io.BytesIO()
        Image.new("RGB", (w, h), (10, 20, 30)).save(buf, format="PNG")
        s = FakeSession(_meta(BOUNDS, w, h), FakeResp(content=buf.getvalue(), ctype="image/png"))
        data, _src, v = _fetch(s, tile_px=64)
        assert imagery.is_jpeg(data), "packaged tiles are always JPEG"
        assert imagery.image_dimensions(data) == (w, h), "re-encode preserved the verified size"
        assert v["dimensions_verified"] is True and v["returned_width_px"] == w

    def test_an_undecodable_body_fails_closed_rather_than_packaging(self):
        # A bare PNG IHDR passes the magic + header check but cannot be decoded, so the
        # JPEG normalisation raises. The tile is never packaged.
        pytest.importorskip("PIL")
        w, h = ctxmod.tile_export_dims(BOUNDS, 64)
        s = FakeSession(_meta(BOUNDS, w, h), FakeResp(content=_png_with_dims(w, h), ctype="image/png"))
        with pytest.raises(Exception):
            _fetch(s, tile_px=64)

    def test_redirects_are_followed_within_the_origin_and_bounded(self):
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        img = FakeResp(content=_jpeg_with_dims(w, h), ctype="image/jpeg")
        ok = FakeSession(_meta(BOUNDS, w, h), img,
                         hops=[(302, "https://imagery.example.gov/redirected/a.jpg")])
        data, _s, v = _fetch(ok)
        assert imagery.is_jpeg(data) and v["dimensions_verified"] is True
        assert len(ok.download_urls) == 2                     # original + one hop
        # An off-origin redirect is refused rather than followed.
        off = FakeSession(_meta(BOUNDS, w, h), img, hops=[(302, "https://evil.test/a.jpg")])
        with pytest.raises(imagery.ImageryContractError):
            _fetch(off)
        # An unbounded redirect chain terminates.
        loop = FakeSession(_meta(BOUNDS, w, h), img,
                           hops=[(302, "https://imagery.example.gov/a.jpg")] * 12)
        with pytest.raises(imagery.ImageryContractError, match="redirect limit"):
            _fetch(loop)
        assert len(loop.download_urls) <= 5

    def test_NEITHER_leg_ever_auto_follows_redirects(self):
        # Including the f=json metadata request. requests follows up to 30 redirects by
        # default and re-checks nothing, so leaving that leg on autopilot would let the
        # configured service redirect the worker anywhere it liked.
        s = _sized_session()
        _fetch(s)
        assert s.calls, "no requests were made"
        assert all(c["allow_redirects"] is False for c in s.calls)

    def test_the_metadata_leg_revalidates_its_redirects_too(self):
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        img = FakeResp(content=_jpeg_with_dims(w, h), ctype="image/jpeg")

        class MetaRedirectSession(FakeSession):
            """Redirects the exportImage request itself before answering."""

            def __init__(self, meta, image, *, to, hops=1):
                super().__init__(meta, image)
                self._to, self._left = to, hops

            def get(self, url, params=None, timeout=None, allow_redirects=None):
                self.calls.append({"url": url, "params": params, "timeout": timeout,
                                   "allow_redirects": allow_redirects})
                if url.endswith("/exportImage") or url == self._to:
                    if self._left > 0:
                        self._left -= 1
                        return FakeResp(status=302, headers={"Location": self._to})
                    return FakeResp(payload=self._meta)
                return self._image

        # Same-origin redirect on the metadata leg is followed, and the query is not
        # re-appended to the new target.
        ok = MetaRedirectSession(_meta(BOUNDS, w, h), img, to="https://imagery.example.gov/moved/exportImage")
        data, _s, v = _fetch(ok)
        assert imagery.is_jpeg(data) and v["extent_verified"] is True
        followed = [c for c in ok.calls if c["url"] == "https://imagery.example.gov/moved/exportImage"]
        assert followed and followed[0]["params"] is None, "our query must not ride onto a new target"

        # An off-origin redirect on the metadata leg is REFUSED, not followed.
        evil = MetaRedirectSession(_meta(BOUNDS, w, h), img, to="https://evil.test/exportImage")
        with pytest.raises(imagery.ImageryContractError):
            _fetch(evil)
        assert not any(c["url"].startswith("https://evil.test") for c in evil.calls)

        # And the chain is bounded on that leg too.
        loop = MetaRedirectSession(_meta(BOUNDS, w, h), img,
                                   to="https://imagery.example.gov/loop/exportImage", hops=99)
        with pytest.raises(imagery.ImageryContractError, match="redirect limit"):
            _fetch(loop)
        assert len(loop.calls) <= 5

    def test_transport_errors_report_the_exception_class_only(self):
        """requests embeds the resolved URL in ConnectionError/SSLError/Timeout, and that
        string reaches the worker log and the job's error_details."""

        class ExplodingSession(FakeSession):
            def get(self, url, params=None, timeout=None, allow_redirects=None):
                raise OSError(
                    f"HTTPSConnectionPool(host='imagery.example.gov'): "
                    f"Max retries exceeded with url: /arcgis/x.jpg?token={TOKEN}")

        with pytest.raises(RuntimeError) as ei:
            _fetch(ExplodingSession(_meta(BOUNDS, 8, 8)))
        msg = str(ei.value)
        assert "OSError" in msg
        for secret in (TOKEN, "imagery.example.gov", "HTTPSConnectionPool", "?", "arcgis"):
            assert secret not in msg, f"{secret!r} leaked out of a transport error"
        assert TOKEN not in imagery.sanitize_reason(ei.value)
        # Still TRANSIENT: a connection blip must keep its retry budget.
        assert not isinstance(ei.value, imagery.ImageryContractError)


# ============================================================================
# D — safety: no leakage, retry/cancellation behaviour intact
# ============================================================================

class TestSafety:
    def test_no_href_query_or_token_reaches_the_packaged_metadata(self):
        s = _sized_session()
        data, source, v = _fetch(s)
        blob = repr(source) + repr(v)
        for secret in (TOKEN, "?", "href", "_ags_ab12", "arcgisoutput"):
            assert secret not in blob, f"{secret!r} leaked into packaged metadata"
        # The configured service URL is deliberate, documented provenance — and it is
        # the credential-free base URL, never the tokenised output href.
        assert source["service"] == SERVICE and "?" not in source["service"]

    def test_contract_failure_messages_carry_no_service_detail(self):
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        bad = _meta(BOUNDS, w, h)
        bad["extent"]["ymax"] += 0.01
        s = FakeSession(bad, FakeResp(content=_jpeg_with_dims(w, h), ctype="image/jpeg"))
        with pytest.raises(imagery.ImageryContractError) as ei:
            _fetch(s)
        msg = str(ei.value)
        for secret in (TOKEN, "imagery.example.gov", "arcgisoutput", "_ags_ab12"):
            assert secret not in msg
        assert TOKEN not in imagery.sanitize_reason(ei.value)

    def test_unsafe_href_messages_never_echo_the_href(self):
        for href in (f"https://evil.test/a.jpg?{TOKEN}", f"http://imagery.example.gov/a.jpg?token={TOKEN}"):
            with pytest.raises(imagery.ImageryContractError) as ei:
                imagery.safe_export_href(href, service_url=SERVICE)
            assert TOKEN not in str(ei.value) and "evil.test" not in str(ei.value)

    def test_deterministic_contract_failures_are_not_retried(self):
        """Bounded retry is preserved, but an adjusted extent is the SAME on every
        attempt — spending four attempts on it just delays a certain failure."""
        attempts = {"n": 0}

        def _boom(_a):
            attempts["n"] += 1
            raise imagery.ImageryContractError("returned extent differs")

        with pytest.raises(imagery.ImageryContractError):
            imagery.run_with_retries(
                _boom, retries=3, sleep=lambda *_: None,
                is_retryable=lambda e: not isinstance(e, imagery.ImageryContractError),
            )
        assert attempts["n"] == 1

    def test_transient_failures_are_still_retried_and_recover(self):
        attempts = {"n": 0}

        def _flaky(_a):
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise TimeoutError("upstream 504")
            return "ok"

        got = imagery.run_with_retries(
            _flaky, retries=3, sleep=lambda *_: None,
            is_retryable=lambda e: not isinstance(e, imagery.ImageryContractError),
        )
        assert got == "ok" and attempts["n"] == 3

    def test_the_overall_deadline_still_fires(self):
        clock = {"t": 0.0}

        def _mono():
            return clock["t"]

        def _sleep(d):
            clock["t"] += d

        with pytest.raises(imagery.ImageryDeadlineError):
            imagery.run_with_retries(
                lambda _a: (_ for _ in ()).throw(TimeoutError("slow")),
                retries=50, deadline_s=5.0, sleep=_sleep, monotonic=_mono,
                is_retryable=lambda e: not isinstance(e, imagery.ImageryContractError),
            )

    def test_the_request_timeout_is_applied_to_both_steps(self):
        s = _sized_session()
        _fetch(s)
        assert all(c["timeout"] == 30 for c in s.calls)

    def test_http_failures_report_the_status_only_never_the_url(self):
        """requests' own HTTPError embeds the fully-resolved URL — including the output
        path and its token — and that message reaches the job's error_details."""
        w, h = ctxmod.tile_export_dims(BOUNDS, 1024)
        # Failure on the metadata step.
        meta_fail = FakeSession(None, meta_resp=FakeResp(payload={}, status=503))
        with pytest.raises(RuntimeError) as ei:
            _fetch(meta_fail)
        assert "HTTP 503" in str(ei.value)
        assert "exportImage" not in str(ei.value) and "imagery.example.gov" not in str(ei.value)
        # Failure on the download step, where the URL carries the token.
        dl_fail = FakeSession(_meta(BOUNDS, w, h), FakeResp(status=502, ctype="image/jpeg"))
        with pytest.raises(RuntimeError) as ei2:
            _fetch(dl_fail)
        msg = str(ei2.value)
        assert "HTTP 502" in msg
        for secret in (TOKEN, "imagery.example.gov", "arcgisoutput", "_ags_ab12", "?"):
            assert secret not in msg
        # An HTTP failure stays TRANSIENT (retryable) — it is not a contract violation.
        assert not isinstance(ei2.value, imagery.ImageryContractError)


# ============================================================================
# E — manifest + package validation
# ============================================================================

def _tile(row=0, col=0, w=1024, h=768, **over) -> dict:
    t = {
        "row": row, "column": col, "file": f"imagery/{row}/{col}.jpg",
        "bounds": dict(BOUNDS), "sha256": "a" * 64, "bytes": 10,
        "width_px": w, "height_px": h,
        "extent_verified": True, "extent_max_delta_deg": 0.0,
        "extent_tolerance_deg": imagery.EXTENT_TOLERANCE_DEG,
        "requested_width_px": w, "requested_height_px": h,
        "returned_width_px": w, "returned_height_px": h,
        "dimensions_verified": True,
    }
    t.update(over)
    return t


def _verified_layer(tiles=None) -> dict:
    tiles = tiles if tiles is not None else [_tile(0, 0), _tile(0, 1)]
    plan = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=2.0, source_native_mpp=2.0)
    diag = imagery.tile_diagnostics(plan, tiles, present_files={t["file"] for t in tiles},
                                    export_contract=imagery.IMAGERY_EXPORT_CONTRACT)
    layer = ctxmod.tiled_imagery_layer(plan, tiles, {"provider": "usgs_naip"}, diagnostics=diag,
                                       export_contract=imagery.IMAGERY_EXPORT_CONTRACT)
    # Keep columns*rows == len(tiles) so the STRUCTURAL validator is satisfied and only
    # the verification rules are under test here.
    layer["columns"], layer["rows"] = len(tiles), 1
    return layer


class TestPackagedVerification:
    def test_every_tile_carries_a_verification_result(self):
        layer = _verified_layer()
        for t in layer["tiles"]:
            assert imagery.tile_verification_ok(t)

    def test_aggregate_counts_equal_the_tile_count(self):
        tiles = [_tile(0, 0), _tile(0, 1), _tile(1, 0)]
        d = _verified_layer(tiles)["diagnostics"]
        assert d["extents_verified"] is True
        assert d["extents_verified_count"] == len(tiles)
        assert d["dimensions_verified_count"] == len(tiles)
        assert d["extent_mismatch_count"] == 0
        assert d["adjust_aspect_ratio"] is False
        assert d["export_contract"] == imagery.IMAGERY_EXPORT_CONTRACT

    @pytest.mark.parametrize("broken", [
        {"extent_verified": False},
        {"extent_verified": 1},                                   # truthy is not True
        {"dimensions_verified": None},
        {"extent_max_delta_deg": 1.0},                            # exceeds the tolerance
        {"extent_max_delta_deg": float("nan")},
        {"extent_tolerance_deg": None},
        {"returned_width_px": 999},                               # disagrees with width_px
        {"width_px": None},
    ])
    def test_a_single_unverified_tile_fails_a_contract_package(self, broken):
        tiles = [_tile(0, 0), _tile(0, 1, **broken)]
        layer = _verified_layer([_tile(0, 0), _tile(0, 1)])
        layer["tiles"] = tiles                                     # claim survives, evidence does not
        ok, reason = imagery.validate_packaged_verification(layer)
        assert not ok and "extent verification" in reason

    def test_missing_or_lying_diagnostics_fail(self):
        base = _verified_layer()
        for mutate, expect in (
            (lambda ly: ly.pop("diagnostics"), "no diagnostics"),
            (lambda ly: ly["diagnostics"].update({"extents_verified": False}), "extents_verified"),
            (lambda ly: ly["diagnostics"].update({"extents_verified_count": 99}), "tile count"),
            (lambda ly: ly["diagnostics"].update({"extent_mismatch_count": 1}), "mismatch"),
            (lambda ly: ly["diagnostics"].update({"dimensions_verified_count": 0}), "tile count"),
            (lambda ly: ly["diagnostics"].update({"adjust_aspect_ratio": True}), "adjustAspectRatio"),
            (lambda ly: ly["diagnostics"].update({"export_contract": "something_else"}), "contract"),
            (lambda ly: ly.update({"tiles": []}), "no tiles"),
        ):
            layer = _verified_layer()
            mutate(layer)
            ok, reason = imagery.validate_packaged_verification(layer)
            assert not ok and expect in reason, (expect, reason)

    def test_a_legacy_layer_is_untouched_and_never_relabelled(self):
        plan = imagery.plan_imagery_tiles(BOUNDS, tile_px=1024, target_mpp=2.0, source_native_mpp=2.0)
        legacy_tiles = [{"row": 0, "column": 0, "file": "imagery/0/0.jpg",
                         "bounds": dict(BOUNDS), "sha256": "b" * 64, "bytes": 4}]
        legacy = ctxmod.tiled_imagery_layer(
            plan, legacy_tiles, {"provider": "usgs_naip"},
            diagnostics=imagery.tile_diagnostics(plan, legacy_tiles),
        )
        legacy["columns"], legacy["rows"] = 1, 1
        assert "export_contract" not in legacy
        # No verification key at all — a package that never ran the check says nothing.
        for k in ("extents_verified", "extents_verified_count", "extent_mismatch_count",
                  "dimensions_verified_count", "adjust_aspect_ratio"):
            assert k not in legacy["diagnostics"]
        ok, reason = imagery.validate_packaged_verification(legacy)
        assert ok and reason is None
        # And the ordinary structural validator still accepts it.
        assert ctxmod._validate_tiled_imagery_meta(legacy)[0] is True

    def test_the_metadata_validator_rejects_an_unbacked_claim(self):
        layer = _verified_layer()
        layer["tiles"][0].pop("extent_verified")
        ok, reason = ctxmod._validate_tiled_imagery_meta(layer)
        assert not ok and "extent verification" in reason

    def test_the_build_time_gate_refuses_a_partially_verified_set(self):
        imagery.assert_extents_verified([_tile(0, 0), _tile(0, 1)])
        with pytest.raises(imagery.ImageryContractError, match="lack a valid extent verification"):
            imagery.assert_extents_verified([_tile(0, 0), _tile(0, 1, extent_verified=False)])
        with pytest.raises(imagery.ImageryContractError, match="no imagery tiles"):
            imagery.assert_extents_verified([])


# ============================================================================
# F — package content identity
# ============================================================================

_SIG_INPUTS = dict(
    gisa_updated_at="2026-07-20T10:00:00",
    geometry_json={"type": "Point", "coordinates": [-121.22, 38.788]},
    road_bearing_deg=90.0,
    radius_m=1500.0,
    road_provider="caltrans_crs",
    road_filter_version="caltrans_crs:fs1-2",
)


class TestContentIdentity:
    def test_a_code_only_export_fix_now_changes_the_signature(self):
        """The reason package 19 could not simply be re-prepared.

        Everything a user can see — AOI, GISA data, radius, bearing, road provider and
        filter — is identical, so the old signature was byte-identical and no device
        would ever have re-downloaded the corrected imagery.
        """
        before = offline_scene_svc.content_signature(**_SIG_INPUTS)
        after = offline_scene_svc.content_signature(
            **_SIG_INPUTS, imagery_export_contract=imagery.IMAGERY_EXPORT_CONTRACT)
        assert before != after

    def test_different_export_contracts_produce_different_signatures(self):
        sigs = {
            offline_scene_svc.content_signature(**_SIG_INPUTS, imagery_export_contract=c)
            for c in ("unverified_extent_arcgis_export_v1", imagery.IMAGERY_EXPORT_CONTRACT,
                      "single_unverified_extent:single", "disabled")
        }
        assert len(sigs) == 4, "each export contract must be its own content identity"

    def test_unchanged_requests_under_the_same_contract_are_deterministic(self):
        a = offline_scene_svc.content_signature(
            **_SIG_INPUTS, imagery_export_contract=imagery.IMAGERY_EXPORT_CONTRACT)
        b = offline_scene_svc.content_signature(
            **_SIG_INPUTS, imagery_export_contract=imagery.IMAGERY_EXPORT_CONTRACT)
        assert a == b and len(a) == 16

    def test_omitting_the_contract_still_produces_the_legacy_signature(self):
        # Back-compat: callers that never pass it are unaffected.
        assert offline_scene_svc.content_signature(**_SIG_INPUTS) == \
            offline_scene_svc.content_signature(**_SIG_INPUTS, imagery_export_contract=None)

    def test_the_worker_identity_distinguishes_tiled_single_and_disabled(self, monkeypatch):
        from app.config import settings
        from app.worker import offline_scene_worker as worker

        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", True)
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "tiled")
        assert worker._imagery_content_identity() == imagery.IMAGERY_EXPORT_CONTRACT
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_MODE", "single")
        single = worker._imagery_content_identity()
        assert single != imagery.IMAGERY_EXPORT_CONTRACT and "unverified" in single
        monkeypatch.setattr(settings, "OFFLINE_SCENE_IMAGERY_ENABLED", False)
        assert worker._imagery_content_identity() == "disabled"

    def test_the_contract_string_is_versioned_so_future_changes_invalidate(self):
        # A bare name would make the next contract change indistinguishable.
        stem, marker, version = (
            imagery.IMAGERY_EXPORT_CONTRACT.rpartition("_v")
        )
        assert marker == "_v"
        assert stem
        assert version.isdigit()
        assert "exact_extent" in imagery.IMAGERY_EXPORT_CONTRACT

# ============================================================================
# F ? verified-contract compatibility across request-contract revisions
# ============================================================================

class TestVerifiedContractCompatibility:
    @staticmethod
    def _layer(contract: str) -> dict:
        tile = {
            "row": 0,
            "column": 0,
            "extent_verified": True,
            "dimensions_verified": True,
            "extent_max_delta_deg": 0.0,
            "extent_tolerance_deg": imagery.EXTENT_TOLERANCE_DEG,
            "returned_width_px": 8,
            "returned_height_px": 8,
            "width_px": 8,
            "height_px": 8,
        }

        return {
            "export_contract": contract,
            "tile_count": 1,
            "tiles": [tile],
            "diagnostics": {
                "export_contract": contract,
                "adjust_aspect_ratio": False,
                "extents_verified": True,
                "extents_verified_count": 1,
                "extent_mismatch_count": 0,
                "dimensions_verified_count": 1,
            },
        }

    @pytest.mark.parametrize(
        "contract",
        [
            imagery.EXACT_EXTENT_EXPORT_CONTRACT_V2,
            imagery.IMAGERY_EXPORT_CONTRACT,
        ],
    )
    def test_known_verified_contracts_remain_strict(self, contract):
        layer = self._layer(contract)

        assert imagery.validate_packaged_verification(layer) == (
            True,
            None,
        )

        layer["diagnostics"]["extent_mismatch_count"] = 1

        ok, reason = imagery.validate_packaged_verification(layer)

        assert ok is False
        assert "extent mismatch" in reason

    def test_diagnostics_must_match_the_layer_contract(self):
        layer = self._layer(imagery.IMAGERY_EXPORT_CONTRACT)
        layer["diagnostics"]["export_contract"] = (
            imagery.EXACT_EXTENT_EXPORT_CONTRACT_V2
        )

        ok, reason = imagery.validate_packaged_verification(layer)

        assert ok is False
        assert "do not match" in reason
