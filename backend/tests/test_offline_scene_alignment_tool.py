"""Correctness tests for the road-vs-imagery alignment diagnostic.

Synthetic .eristerrain packages are built in-memory, so the tool is exercised on exactly
the bytes a real package contains. No network, no MinIO.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.tools import offline_scene_alignment as tool

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

# A deliberately NON-square AOI so a lon/lat swap or axis flip cannot pass by luck.
BOUNDS = {"min_lat": 38.40, "min_lon": -121.60, "max_lat": 38.50, "max_lon": -121.40}
INCIDENT = {"lat": 38.45, "lon": -121.50}
MIDLAT = (BOUNDS["min_lat"] + BOUNDS["max_lat"]) / 2.0


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


def make_package(*, imagery="single", roads=None, tiles=None, incident=INCIDENT, road_source=None) -> bytes:
    """Build a STORED .eristerrain zip with a manifest + roads + imagery."""
    ctx: dict = {}
    files: dict = {}

    if imagery == "single":
        files["imagery.png"] = _solid((40, 40, 40))
        ctx["imagery"] = {"available": True, "format": "single", "file": "imagery.png", "bounds": dict(BOUNDS)}
    elif imagery == "tiled":
        ctx_tiles = []
        for name, b, color in (tiles or []):
            files[name] = _solid(color, fmt="JPEG")
            ctx_tiles.append({"file": name, "bounds": b, "row": 0, "column": 0})
        ctx["imagery"] = {"available": True, "format": "tiled", "bounds": dict(BOUNDS), "tiles": ctx_tiles}
    else:
        ctx["imagery"] = {"available": False, "reason": "not_configured"}

    if roads is not None:
        gj = {"type": "FeatureCollection", "features": roads}
        files["roads.geojson"] = json.dumps(gj).encode()
        ctx["roads"] = {"available": True, "file": "roads.geojson",
                        "source": road_source or {"provider": "us_census_tigerweb",
                                                  "dataset": "U.S. Census Bureau TIGERweb Transportation Roads",
                                                  "attribution": "U.S. Census Bureau"}}
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

    def test_coordinates_outside_package_bounds_are_counted_not_silently_valid(self, tmp_path):
        far = _road([[-121.50, 38.45], [-120.00, 38.45]], "primary")  # runs far east of the AOI
        report, _ = _run(make_package(roads=[far]), tmp_path)
        assert report["coordinates_outside_package_bounds"] >= 1
        # the bbox honestly reports the out-of-bounds extent (nothing hidden)
        assert report["road_geometry_bbox"]["max_lon"] > BOUNDS["max_lon"]

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
