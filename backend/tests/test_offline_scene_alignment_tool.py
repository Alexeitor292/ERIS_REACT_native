"""Correctness tests for the road-vs-imagery alignment diagnostic.

Synthetic .eristerrain packages are built in-memory, so the tool is exercised on exactly
the bytes a real package contains. No network, no MinIO.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.services.offline_scene_context import road_clip_bounds
from app.tools import offline_scene_alignment as tool

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

# A deliberately NON-square AOI so a lon/lat swap or axis flip cannot pass by luck.
BOUNDS = {"min_lat": 38.40, "min_lon": -121.60, "max_lat": 38.50, "max_lon": -121.40}
INCIDENT = {"lat": 38.45, "lon": -121.50}
MIDLAT = (BOUNDS["min_lat"] + BOUNDS["max_lat"]) / 2.0

# Roads are packaged clipped to terrain bounds + buffer, so they legitimately extend
# PAST the terrain/imagery frame. Use the REAL contract function, not a hand-rolled copy.
BUFFER_M = 250.0
CLIP = road_clip_bounds(BOUNDS, BUFFER_M)
_AUTO = object()


def _solid(color, size=(64, 64), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


def _road(coords, road_class=None, kind="road_centerline", extra=None):
    props = {"kind": kind}
    if road_class:
        props["road_class"] = road_class
        props["road_class_label"] = tool.CLASS_STYLE and road_class
    props.update(extra or {})
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props}


def make_package(*, imagery="single", roads=None, tiles=None, incident=INCIDENT, road_source=None,
                 clip_bounds=_AUTO, buffer_m=BUFFER_M, extent_verified=False) -> bytes:
    """Build a STORED .eristerrain zip with a manifest + roads + imagery.

    `extent_verified` adds the exact-extent export contract to a TILED package (per-tile
    verification + the aggregate diagnostics). Default False = a LEGACY package, which is
    what every pre-existing test here models."""
    from app.services import offline_scene_imagery as imgmod

    ctx: dict = {}
    files: dict = {}

    if imagery == "single":
        files["imagery.png"] = _solid((40, 40, 40))
        ctx["imagery"] = {"available": True, "format": "single", "file": "imagery.png", "bounds": dict(BOUNDS)}
    elif imagery == "tiled":
        ctx_tiles = []
        for i, (name, b, color) in enumerate(tiles or []):
            files[name] = _solid(color, fmt="JPEG")
            t = {"file": name, "bounds": b, "row": 0, "column": i if extent_verified else 0}
            if extent_verified:
                t.update({
                    "width_px": 64, "height_px": 64,
                    "extent_verified": True, "extent_max_delta_deg": 0.0,
                    "extent_tolerance_deg": imgmod.EXTENT_TOLERANCE_DEG,
                    "requested_width_px": 64, "requested_height_px": 64,
                    "returned_width_px": 64, "returned_height_px": 64,
                    "dimensions_verified": True,
                })
            ctx_tiles.append(t)
        ctx["imagery"] = {"available": True, "format": "tiled", "bounds": dict(BOUNDS), "tiles": ctx_tiles}
        if extent_verified:
            ctx["imagery"]["export_contract"] = imgmod.IMAGERY_EXPORT_CONTRACT
            ctx["imagery"]["tile_count"] = len(ctx_tiles)
            ctx["imagery"]["diagnostics"] = imgmod.verification_diagnostics(
                ctx_tiles, export_contract=imgmod.IMAGERY_EXPORT_CONTRACT)
    else:
        ctx["imagery"] = {"available": False, "reason": "not_configured"}

    if roads is not None:
        gj = {"type": "FeatureCollection", "features": roads}
        files["roads.geojson"] = json.dumps(gj).encode()
        ctx["roads"] = {"available": True, "file": "roads.geojson",
                        "source": road_source or {"provider": "us_census_tigerweb",
                                                  "dataset": "U.S. Census Bureau TIGERweb Transportation Roads",
                                                  "attribution": "U.S. Census Bureau"}}
        # clip_bounds=None models a LEGACY package built before the contract was recorded.
        cb = CLIP if clip_bounds is _AUTO else clip_bounds
        if cb is not None:
            ctx["roads"]["clip_bounds"] = dict(cb)
            ctx["roads"]["buffer_m"] = buffer_m
    else:
        ctx["roads"] = {"available": False, "reason": "no_data"}

    manifest = {
        "format": "eristerrain", "format_version": 2, "package_version": "gtest-99",
        "terrain": {"bounds": dict(BOUNDS), "rows": 3, "columns": 3},
        "area": {"bounds": dict(BOUNDS)},
        "overlays": {"incident": dict(incident)} if incident else {},
        "context_layers": ctx,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        for n, d in files.items():
            zf.writestr(n, d)
    return buf.getvalue()


def _run(pkg_bytes, tmp_path, max_px=512):
    tmp_path.mkdir(parents=True, exist_ok=True)
    p = tmp_path / "p.eristerrain"
    p.write_bytes(pkg_bytes)
    return tool.run(p, tmp_path / "out", max_px=max_px), (tmp_path / "out")


# ---- transform / orientation ----------------------------------------------

class TestTransform:
    def test_nw_and_se_corners_map_to_image_corners(self):
        w, h = tool.canvas_size(BOUNDS, 512)
        t = tool.transform_for(BOUNDS, w, h)
        nw = tool.lonlat_to_px(BOUNDS["min_lon"], BOUNDS["max_lat"], t)
        se = tool.lonlat_to_px(BOUNDS["max_lon"], BOUNDS["min_lat"], t)
        assert nw == pytest.approx((0.0, 0.0), abs=1e-6)
        assert se == pytest.approx((w, h), abs=1e-6)

    def test_north_is_up_and_east_is_right(self):
        w, h = tool.canvas_size(BOUNDS, 512)
        t = tool.transform_for(BOUNDS, w, h)
        x_w, _ = tool.lonlat_to_px(BOUNDS["min_lon"], MIDLAT, t)
        x_e, _ = tool.lonlat_to_px(BOUNDS["max_lon"], MIDLAT, t)
        _, y_n = tool.lonlat_to_px(-121.50, BOUNDS["max_lat"], t)
        _, y_s = tool.lonlat_to_px(-121.50, BOUNDS["min_lat"], t)
        assert x_e > x_w      # east -> right
        assert y_n < y_s      # north -> up (smaller y)
        assert t["north_up"] is True and t["east_right"] is True
        assert t["lat_per_px"] < 0  # y grows southward

    def test_known_centerline_lands_on_expected_pixels(self, tmp_path):
        # A horizontal primary road at the AOI mid-latitude must render across the middle row.
        road = _road([[BOUNDS["min_lon"], MIDLAT], [BOUNDS["max_lon"], MIDLAT]], "primary")
        report, out = _run(make_package(roads=[road]), tmp_path)
        t = report["transform"]
        w, h = t["width_px"], t["height_px"]
        _, y_expect = tool.lonlat_to_px(-121.50, MIDLAT, t)
        assert abs(y_expect - h / 2) < 1.0

        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        mag = tool.CLASS_STYLE["primary"]["color"]
        # The magenta line sits on the expected row. Sample away from the image centre —
        # the incident marker is drawn on top at the AOI centre.
        assert im.getpixel((w // 4, int(round(y_expect)))) == mag
        assert im.getpixel((3 * w // 4, int(round(y_expect)))) == mag
        # ...and the road is NOT near the top of the image (north != mid-latitude)
        col = [im.getpixel((w // 4, y)) for y in range(0, int(h * 0.2))]
        assert mag not in col


# ---- imagery placement (single + tiled) ------------------------------------

class TestImageryPlacement:
    def _tiles_west_east(self, scrambled_names: bool):
        midlon = (BOUNDS["min_lon"] + BOUNDS["max_lon"]) / 2
        west_b = {**BOUNDS, "max_lon": midlon}
        east_b = {**BOUNDS, "min_lon": midlon}
        # Deliberately give the WEST tile the name that sorts LAST, so filename order
        # disagrees with geographic order.
        wname, ename = ("imagery/0/9.jpg", "imagery/0/0.jpg") if scrambled_names else ("imagery/0/0.jpg", "imagery/0/1.jpg")
        return [(wname, west_b, (255, 0, 0)), (ename, east_b, (0, 0, 255))]  # west RED, east BLUE

    def test_tiles_are_placed_by_declared_bounds_not_filename_order(self, tmp_path):
        tiles = self._tiles_west_east(scrambled_names=True)
        report, out = _run(make_package(imagery="tiled", tiles=tiles, roads=[]), tmp_path)
        assert report["imagery_format"] == "tiled"
        assert report["imagery_tiles_placed"] == 2 == report["imagery_tiles_declared"]
        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        w, h = im.size
        # west half must be RED and east half BLUE despite the scrambled filenames
        assert im.getpixel((w // 4, h // 2))[0] > 200 and im.getpixel((w // 4, h // 2))[2] < 60
        assert im.getpixel((3 * w // 4, h // 2))[2] > 200 and im.getpixel((3 * w // 4, h // 2))[0] < 60

    def test_filename_order_does_not_change_the_output(self, tmp_path):
        a, _ = _run(make_package(imagery="tiled", tiles=self._tiles_west_east(False), roads=[]), tmp_path / "a")
        b, _ = _run(make_package(imagery="tiled", tiles=self._tiles_west_east(True), roads=[]), tmp_path / "b")
        # identical geographic mapping regardless of the tile file names
        assert a["transform"] == b["transform"]
        img_a = Image.open(tmp_path / "a" / "out" / tool.IMAGE_NAME).tobytes()
        img_b = Image.open(tmp_path / "b" / "out" / tool.IMAGE_NAME).tobytes()
        assert img_a == img_b

    def test_single_and_tiled_use_the_same_geographic_mapping(self, tmp_path):
        road = _road([[BOUNDS["min_lon"], MIDLAT], [BOUNDS["max_lon"], MIDLAT]], "primary")
        single, _ = _run(make_package(imagery="single", roads=[road]), tmp_path / "s")
        tiled, _ = _run(make_package(imagery="tiled", tiles=self._tiles_west_east(False), roads=[road]), tmp_path / "t")
        assert single["transform"] == tiled["transform"]
        assert single["imagery_format"] == "single" and tiled["imagery_format"] == "tiled"

    def test_extent_verified_tiles_are_still_placed_by_declared_bounds(self, tmp_path):
        """Adding verification metadata must not change WHERE a tile goes: placement is
        still driven solely by each tile's own declared bounds."""
        tiles = self._tiles_west_east(scrambled_names=True)
        plain, _ = _run(make_package(imagery="tiled", tiles=tiles, roads=[]), tmp_path / "p")
        verified, out = _run(
            make_package(imagery="tiled", tiles=tiles, roads=[], extent_verified=True), tmp_path / "v")
        assert plain["transform"] == verified["transform"]
        assert verified["imagery_tiles_placed"] == 2
        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        w, h = im.size
        assert im.getpixel((w // 4, h // 2))[0] > 200      # west still RED
        assert im.getpixel((3 * w // 4, h // 2))[2] > 200  # east still BLUE


# ---- exact-extent verification status in the report -------------------------

class TestExtentVerificationReporting:
    def _tiles(self):
        midlon = (BOUNDS["min_lon"] + BOUNDS["max_lon"]) / 2
        return [("imagery/0/0.jpg", {**BOUNDS, "max_lon": midlon}, (255, 0, 0)),
                ("imagery/0/1.jpg", {**BOUNDS, "min_lon": midlon}, (0, 0, 255))]

    def test_a_verified_package_reports_verified_with_counts(self, tmp_path):
        report, _ = _run(make_package(imagery="tiled", tiles=self._tiles(), roads=[],
                                      extent_verified=True), tmp_path)
        ev = report["imagery_extent_verification"]
        assert ev["status"] == "verified"
        assert ev["contract"].startswith("exact_extent")
        assert ev["extents_verified"] is True
        assert ev["extents_verified_count"] == ev["tiles_declared"] == 2
        assert ev["extent_mismatch_count"] == 0
        assert ev["dimensions_verified_count"] == 2
        assert ev["adjust_aspect_ratio"] is False
        assert ev["reason"] is None

    def test_a_legacy_package_is_reported_as_legacy_not_as_verified_or_failed(self, tmp_path):
        report, _ = _run(make_package(imagery="tiled", tiles=self._tiles(), roads=[]), tmp_path)
        ev = report["imagery_extent_verification"]
        assert ev["status"] == "not_declared_legacy" and ev["contract"] is None
        # It must NOT imply the check passed...
        assert ev.get("extents_verified") is None
        # ...and a single-image / no-imagery package is likewise not misreported.
        single, _ = _run(make_package(imagery="single", roads=[]), tmp_path / "s")
        assert single["imagery_extent_verification"]["status"] == "not_declared_legacy"
        none, _ = _run(make_package(imagery=None, roads=[]), tmp_path / "n")
        assert none["imagery_extent_verification"]["status"] == "no_imagery"

    def test_a_claim_without_evidence_is_reported_inconsistent(self, tmp_path):
        pkg = make_package(imagery="tiled", tiles=self._tiles(), roads=[], extent_verified=True)
        # Strip one tile's proof while leaving the contract claim in place.
        zf = zipfile.ZipFile(io.BytesIO(pkg))
        man = json.loads(zf.read("manifest.json"))
        man["context_layers"]["imagery"]["tiles"][1].pop("extent_verified")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
            out.writestr("manifest.json", json.dumps(man))
            for n in zf.namelist():
                if n != "manifest.json":
                    out.writestr(n, zf.read(n))
        report, _ = _run(buf.getvalue(), tmp_path)
        ev = report["imagery_extent_verification"]
        assert ev["status"] == "declared_but_inconsistent" and ev["reason"]

    def test_the_verification_status_leaks_nothing(self, tmp_path):
        src = {"provider": "us_census_tigerweb", "dataset": "TIGERweb",
               "attribution": "U.S. Census Bureau",
               "service": "https://u:P@ss@tigerweb.example.gov/x?token=SECRET"}
        report, out = _run(make_package(imagery="tiled", tiles=self._tiles(),
                                        roads=[_road([[-121.55, 38.45], [-121.45, 38.45]], "primary")],
                                        road_source=src, extent_verified=True), tmp_path)
        blob = (out / tool.REPORT_NAME).read_text()
        for bad in ("SECRET", "token", "P@ss", "?", "href", "exportImage", "arcgisoutput"):
            assert bad not in blob, f"report leaked {bad!r}"
        assert report["imagery_extent_verification"]["status"] == "verified"


# ---- roads: classes, malformed, out-of-bounds, report hygiene ---------------

class TestRoadsAndReport:
    def test_class_specific_rendering(self, tmp_path):
        roads = [
            _road([[-121.58, 38.42], [-121.42, 38.42]], "primary"),
            _road([[-121.58, 38.45], [-121.42, 38.45]], "secondary"),
            _road([[-121.58, 38.48], [-121.42, 38.48]], "local"),
        ]
        report, out = _run(make_package(roads=roads), tmp_path)
        assert report["road_class_counts"] == {"primary": 1, "secondary": 1, "local": 1}
        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        px = {c for _, c in (im.getcolors(maxcolors=1 << 24) or [])}
        for cls in ("primary", "secondary", "local"):
            assert tool.CLASS_STYLE[cls]["color"] in px, f"{cls} colour missing"

    def test_malformed_roads_are_ignored_safely_and_counted(self, tmp_path):
        roads = [
            _road([[-121.55, 38.45], [-121.45, 38.45]], "primary"),   # good
            "not-a-feature",                                          # junk
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-121.5, 38.45]}, "properties": {}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [["x", None]]}, "properties": {}},
        ]
        report, _ = _run(make_package(roads=roads), tmp_path)
        assert report["road_feature_count"] == 1
        assert report["malformed_features_dropped"] == 3

    def test_coordinates_outside_road_clip_bounds_are_counted_not_silently_valid(self, tmp_path):
        far = _road([[-121.50, 38.45], [-120.00, 38.45]], "primary")  # runs far east of the AOI
        report, _ = _run(make_package(roads=[far]), tmp_path)
        assert report["coordinates_outside_road_clip_bounds"] >= 1    # a contract violation
        # the bbox honestly reports the out-of-bounds extent (nothing hidden)
        assert report["road_geometry_bbox"]["max_lon"] > BOUNDS["max_lon"]

    def test_selection_kind_counts_are_reported_including_a_zero_ramp(self, tmp_path):
        """The evidence JSON must expose the SELECTION partition, with every category
        present — a `ramp: 0` is itself the evidence of the Rocklin mislabeling defect."""
        roads = [
            _road([[-121.55, 38.45], [-121.45, 38.45]], "primary",
                  extra={"selection_kind": "divided_highway_corridor", "selectable": True}),
            _road([[-121.55, 38.46], [-121.45, 38.46]], "primary",
                  extra={"selection_kind": "individual_carriageway", "selectable": True}),
            _road([[-121.55, 38.47], [-121.45, 38.47]], "primary",
                  extra={"diagnostic_kind": "carriageway_member", "selectable": False}),
        ]
        report, out = _run(make_package(roads=roads), tmp_path)
        sk = report["selection_kind_counts"]
        assert sk["divided_highway_corridor"] == 1
        assert sk["individual_carriageway"] == 1
        assert sk["ramp"] == 0, "a missing ramp category must be explicit, not absent"
        assert sk["ordinary_road"] == 0
        assert report["diagnostic_kind_counts"] == {"carriageway_member": 1}
        assert report["selectable_feature_count"] == 2
        assert report["diagnostic_feature_count"] == 1
        # The JSON is the machine evidence; the counts must round-trip from disk.
        on_disk = json.loads((out / tool.REPORT_NAME).read_text())
        assert on_disk["selection_kind_counts"] == sk

    def test_ramp_counts_are_reported_when_present(self, tmp_path):
        roads = [
            _road([[-121.55, 38.45], [-121.45, 38.45]], "primary",
                  extra={"selection_kind": "ramp", "selectable": True}),
            _road([[-121.55, 38.46], [-121.45, 38.46]], "primary",
                  extra={"selection_kind": "ramp", "selectable": True}),
        ]
        report, _ = _run(make_package(roads=roads), tmp_path)
        assert report["selection_kind_counts"]["ramp"] == 2

    def test_categories_are_visually_distinguishable_and_diagnostics_are_thinner(self, tmp_path):
        """Each category gets its own colour, and the non-selectable diagnostic is the
        THINNEST so it can never read as a normal selectable road."""
        # Distinct colours per category.
        colors = {k: tool.SELECTION_STYLE[k]["color"] for k in tool.SELECTION_STYLE}
        colors["diagnostic"] = tool.DIAGNOSTIC_STYLE["color"]
        assert len(set(colors.values())) == len(colors), "categories must be distinguishable"
        # The diagnostic is strictly thinner than every selectable category.
        for k, style in tool.SELECTION_STYLE.items():
            assert tool.DIAGNOSTIC_STYLE["width"] < style["width"], k
        # ...and the categories actually reach the canvas.
        roads = [
            _road([[-121.55, 38.44], [-121.45, 38.44]], "primary",
                  extra={"selection_kind": "divided_highway_corridor", "selectable": True}),
            _road([[-121.55, 38.46], [-121.45, 38.46]], "primary",
                  extra={"selection_kind": "ramp", "selectable": True}),
        ]
        _report, out = _run(make_package(roads=roads), tmp_path)
        px = {c for _, c in (Image.open(out / tool.IMAGE_NAME).convert("RGB")
                             .getcolors(maxcolors=1 << 24) or [])}
        assert tool.SELECTION_STYLE["divided_highway_corridor"]["color"] in px
        assert tool.SELECTION_STYLE["ramp"]["color"] in px

    def test_a_legend_is_drawn_without_moving_any_road_coordinate(self, tmp_path):
        """The legend is an overlay: identical road geometry must produce identical
        transforms and bboxes with or without it."""
        roads = [_road([[-121.55, 38.45], [-121.45, 38.45]], "primary",
                       extra={"selection_kind": "ramp", "selectable": True})]
        report, out = _run(make_package(roads=roads), tmp_path)
        # The legend paints its background + label colours into the canvas corner.
        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        w, h = im.size
        corner = im.crop((0, h - h // 4, w // 2, h)).getcolors(maxcolors=1 << 24) or []
        cc = {c for _, c in corner}
        assert tool.LEGEND_FG in cc or tool.LEGEND_BG in cc, "legend not drawn"
        # Coordinates untouched: the reported road bbox equals the input coordinates.
        bbox = report["road_geometry_bbox"]
        assert abs(bbox["min_lon"] - (-121.55)) < 1e-9
        assert abs(bbox["max_lon"] - (-121.45)) < 1e-9
        assert abs(bbox["min_lat"] - 38.45) < 1e-9 and abs(bbox["max_lat"] - 38.45) < 1e-9

    def test_the_legend_never_covers_the_map_or_the_incident(self, tmp_path):
        """REGRESSION (audit, HIGH): the legend used to be an OPAQUE panel painted over the
        lower-left corner, erasing imagery, roads and even the incident marker — destroying
        the very evidence this tool exists to show. It now lives in a band BELOW the map."""
        incident = {"lat": 38.41, "lon": -121.58}      # lower-left of the AOI
        roads = [_road([[-121.58, 38.405], [-121.42, 38.405]], "primary",
                       extra={"selection_kind": "ramp", "selectable": True})]
        report, out = _run(make_package(roads=roads, incident=incident), tmp_path, max_px=512)
        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        w, total_h = im.size
        map_h = report["output_image"]["map_height_px"]
        band = report["output_image"]["legend_band_px"]
        assert total_h == map_h + band and band > 0
        # The incident marker survives (it used to vanish entirely under the panel).
        map_area = im.crop((0, 0, w, map_h))
        colors = {c for _, c in (map_area.getcolors(maxcolors=1 << 24) or [])}
        assert tool.INCIDENT_COLOR in colors, "the legend erased the incident marker"
        # The road survives across the FULL width, including the lower-left third.
        ramp_rgb = tool.SELECTION_STYLE["ramp"]["color"]
        left = map_area.crop((0, 0, w // 3, map_h))
        right = map_area.crop((2 * w // 3, 0, w, map_h))
        n_left = sum(n for n, c in (left.getcolors(maxcolors=1 << 24) or []) if c == ramp_rgb)
        n_right = sum(n for n, c in (right.getcolors(maxcolors=1 << 24) or []) if c == ramp_rgb)
        assert n_left > 0 and n_right > 0
        assert n_left > n_right * 0.5, f"left third truncated: {n_left} vs {n_right}"
        # No legend background bleeds into the map area.
        assert tool.LEGEND_BG not in colors or tool.LEGEND_BG == tool.NO_IMAGERY_BG

    def test_an_out_of_enum_selection_kind_is_surfaced_not_absorbed(self, tmp_path):
        """REGRESSION (audit, HIGH): an unknown selection_kind inflated
        selectable_feature_count while being absent from selection_kind_counts (breaking the
        sum invariant) and was drawn in the SAME colour as individual_carriageway."""
        roads = [
            _road([[-121.55, 38.45], [-121.45, 38.45]], "primary",
                  extra={"selection_kind": "frontage_road", "selectable": True}),
            _road([[-121.55, 38.46], [-121.45, 38.46]], "primary",
                  extra={"selection_kind": "carriageway_member", "selectable": True}),
        ]
        report, out = _run(make_package(roads=roads), tmp_path)
        assert report["unknown_selection_kind_counts"] == {"carriageway_member": 1, "frontage_road": 1}
        assert all(v == 0 for v in report["selection_kind_counts"].values())
        # The tool's own invariant holds again.
        assert (sum(report["selection_kind_counts"].values())
                + sum(report["unknown_selection_kind_counts"].values())
                == report["selectable_feature_count"] == 2)
        # ...and it is drawn in the alarming colour, NOT the individual_carriageway colour.
        colors = {c for _, c in (Image.open(out / tool.IMAGE_NAME).convert("RGB")
                                 .getcolors(maxcolors=1 << 24) or [])}
        assert tool.INVALID_SELECTION_STYLE["color"] in colors
        assert tool.INVALID_SELECTION_STYLE["color"] != tool.SELECTION_STYLE["individual_carriageway"]["color"]

    def test_legacy_package_without_selection_metadata_still_renders(self, tmp_path):
        """A package predating the selection partition must not crash or invent categories."""
        roads = [_road([[-121.55, 38.45], [-121.45, 38.45]], "primary")]
        report, _ = _run(make_package(roads=roads), tmp_path)
        assert report["selection_kind_counts"] == {
            "divided_highway_corridor": 0, "individual_carriageway": 0,
            "ramp": 0, "ordinary_road": 0,
        }
        assert report["diagnostic_kind_counts"] == {}
        assert report["road_feature_count"] == 1

    def test_report_contains_no_credentials_paths_or_secrets(self, tmp_path):
        src = {"provider": "us_census_tigerweb", "dataset": "TIGERweb",
               "attribution": "U.S. Census Bureau",
               "service": "https://u:P@ss@tigerweb.example.gov/x?token=SECRET"}
        road = _road([[-121.55, 38.45], [-121.45, 38.45]], "primary")
        report, out = _run(make_package(roads=[road], road_source=src), tmp_path)
        blob = (out / tool.REPORT_NAME).read_text()
        for bad in ("SECRET", "token", "P@ss", "?", "minio", "MINIO", "/tmp", "C:\\"):
            assert bad not in blob, f"report leaked {bad!r}"
        # provider/dataset ARE kept (useful, non-sensitive)
        assert json.loads(blob)["road_source"]["provider"] == "us_census_tigerweb"
        assert "service" not in json.loads(blob)["road_source"]

    def test_report_carries_the_non_authoritative_note_and_outputs(self, tmp_path):
        report, out = _run(make_package(roads=[_road([[-121.55, 38.45], [-121.45, 38.45]], "local")]), tmp_path)
        assert "cannot" in report["note"].lower() or "CANNOT" in report["note"]
        assert (out / tool.IMAGE_NAME).exists() and (out / tool.REPORT_NAME).exists()
        assert report["package_version"] == "gtest-99"
        assert report["terrain_bounds"] == BOUNDS

    def test_package_without_imagery_still_renders_roads(self, tmp_path):
        report, out = _run(make_package(imagery=None, roads=[_road([[-121.55, 38.45], [-121.45, 38.45]], "primary")]), tmp_path)
        assert report["imagery_format"] is None
        assert report["road_feature_count"] == 1
        assert (out / tool.IMAGE_NAME).exists()

    def test_cli_main_writes_outputs(self, tmp_path):
        p = tmp_path / "p.eristerrain"
        p.write_bytes(make_package(roads=[_road([[-121.55, 38.45], [-121.45, 38.45]], "primary")]))
        rc = tool.main(["--package", str(p), "--output-dir", str(tmp_path / "cli"), "--max-px", "256"])
        assert rc == 0
        assert (tmp_path / "cli" / tool.IMAGE_NAME).exists()
        assert (tmp_path / "cli" / tool.REPORT_NAME).exists()


# ---- the road CLIPPING CONTRACT (buffered roads are valid, not "out of bounds") ----

class TestRoadClipBounds:
    """Roads are clipped to terrain bounds + buffer, so they legitimately extend past the
    terrain/imagery frame. Judging them against terrain bounds alone (PR #50 review) calls
    perfectly valid buffered geometry 'out of bounds'."""

    # A road just OUTSIDE the terrain frame but INSIDE the 250 m road buffer.
    BUFFERED_LON = BOUNDS["max_lon"] + (CLIP["max_lon"] - BOUNDS["max_lon"]) / 2.0

    def test_buffered_coordinate_is_not_a_clip_violation(self, tmp_path):
        assert BOUNDS["max_lon"] < self.BUFFERED_LON < CLIP["max_lon"]   # genuinely in the buffer
        road = _road([[-121.50, 38.45], [self.BUFFERED_LON, 38.45]], "primary")
        report, _ = _run(make_package(roads=[road]), tmp_path)

        # Outside the terrain frame: EXPECTED, that is the buffer doing its job.
        assert report["coordinates_outside_terrain_bounds"] >= 1
        # But NOT a contract violation, and NOT malformed/dropped.
        assert report["coordinates_outside_road_clip_bounds"] == 0
        assert report["malformed_features_dropped"] == 0
        assert report["road_feature_count"] == 1          # still drawn, not discarded

    def test_coordinate_outside_clip_bounds_is_counted(self, tmp_path):
        road = _road([[-121.50, 38.45], [-120.00, 38.45]], "primary")    # way past the buffer
        report, _ = _run(make_package(roads=[road]), tmp_path)
        assert report["coordinates_outside_road_clip_bounds"] >= 1
        assert report["road_clip_bounds_status"] == "declared"

    def test_clip_bounds_and_buffer_are_reported_exactly_as_declared(self, tmp_path):
        road = _road([[-121.55, 38.45], [-121.45, 38.45]], "local")
        report, _ = _run(make_package(roads=[road]), tmp_path)
        assert report["road_clip_bounds"] == CLIP        # exactly the packaged contract
        assert report["road_buffer_m"] == BUFFER_M
        assert report["road_clip_bounds_status"] == "declared"
        # and the contract is genuinely LARGER than the terrain frame
        assert report["road_clip_bounds"]["max_lon"] > report["terrain_bounds"]["max_lon"]

    def test_legacy_package_reports_unknown_not_zero(self, tmp_path):
        """No clip_bounds declared -> we must NOT pretend terrain bounds are equivalent."""
        road = _road([[-121.50, 38.45], [self.BUFFERED_LON, 38.45]], "primary")
        report, _ = _run(make_package(roads=[road], clip_bounds=None), tmp_path)

        assert report["road_clip_bounds"] is None
        assert report["road_buffer_m"] is None
        assert report["road_clip_bounds_status"] == "not_declared_legacy"
        # UNKNOWN, not a clean bill of health...
        assert report["coordinates_outside_road_clip_bounds"] is None
        # ...while the terrain-bounds fact is still reported honestly.
        assert report["coordinates_outside_terrain_bounds"] >= 1
        assert report["malformed_features_dropped"] == 0

    def test_buffered_geometry_is_drawn_out_to_the_canvas_edge(self, tmp_path):
        """A road running from inside the frame into the buffer is drawn all the way to the
        canvas edge — Pillow clips it there. It is never truncated at the terrain boundary
        nor treated as erroneous."""
        road = _road([[-121.45, 38.45], [self.BUFFERED_LON, 38.45]], "primary")
        report, out = _run(make_package(roads=[road]), tmp_path)
        assert report["road_feature_count"] == 1
        assert report["coordinates_outside_terrain_bounds"] >= 1   # it does leave the frame
        assert report["coordinates_outside_road_clip_bounds"] == 0  # but is perfectly valid

        im = Image.open(out / tool.IMAGE_NAME).convert("RGB")
        w, h = im.size
        primary = tool.CLASS_STYLE["primary"]["color"]
        # the LAST column still carries the road: it was drawn out to the edge, not cut
        # short at max_lon (which would leave the right edge as bare imagery).
        edge = {im.getpixel((w - 1, y)) for y in range(h)}
        assert primary in edge, "buffered road was truncated at the terrain boundary"

    def test_legacy_report_still_has_no_credentials_or_paths(self, tmp_path):
        src = {"provider": "us_census_tigerweb", "dataset": "TIGERweb",
               "attribution": "U.S. Census Bureau",
               "service": "https://u:P@ss@tigerweb.example.gov/x?token=SECRET"}
        road = _road([[-121.55, 38.45], [-121.45, 38.45]], "local")
        _, out = _run(make_package(roads=[road], clip_bounds=None, road_source=src), tmp_path)
        blob = (out / tool.REPORT_NAME).read_text()
        for bad in ("SECRET", "token", "P@ss", "eristerrain", "/tmp", "C:\\"):
            assert bad not in blob, f"report leaked {bad!r}"
