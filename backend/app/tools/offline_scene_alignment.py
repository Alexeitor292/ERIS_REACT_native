"""
Road-vs-imagery ALIGNMENT DIAGNOSTIC for an .eristerrain package.

Answers ONE question, deterministically and without SceneKit:

    Do the packaged road coordinates line up with the packaged aerial imagery,
    using only the exact bytes inside the package?

It renders the packaged imagery (single OR tiled, each tile placed by its OWN declared
geographic bounds — never by filename order), draws the packaged roads on top coloured by
road class, marks the incident and the package boundary, and writes a machine-readable
report of the exact lon/lat -> pixel transform it used.

    python -m app.tools.offline_scene_alignment \
        --package /tmp/package.eristerrain \
        --output-dir /tmp/eris-alignment

Outputs: road-imagery-alignment.png, road-imagery-alignment.json

Contract:
  * Reads ONLY files inside the package. No network. No MinIO. No credentials.
  * North is UP and east is RIGHT (the package's north-up contract).
  * The report NEVER contains credentials, query strings, tokens, local paths, or secrets.

IMPORTANT (interpretation): this tool measures the internal consistency of the PACKAGE's
coordinates against the PACKAGE's imagery. It cannot declare that the imagery's visible
pavement centrelines are authoritative, and it is not a survey. See
docs/adr-offline-road-context-source.md.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import zipfile
from pathlib import Path

MAX_CANVAS_PX = 2048
IMAGE_NAME = "road-imagery-alignment.png"
REPORT_NAME = "road-imagery-alignment.json"

# Diagnostic-only styling (deliberately garish so misalignment is obvious).
CLASS_STYLE = {
    "primary": {"color": (255, 0, 200), "width": 7},      # magenta, thick
    "secondary": {"color": (255, 150, 0), "width": 4},    # orange, medium
    "local": {"color": (0, 230, 255), "width": 2},        # cyan, thin
}
OTHER_ROAD_STYLE = {"color": (180, 255, 80), "width": 3}  # bearing/inventory/submitted
BOUNDARY_COLOR = (255, 255, 0)
INCIDENT_COLOR = (60, 120, 255)
NO_IMAGERY_BG = (24, 28, 36)

DISCLAIMER = (
    "Measures package-coordinate consistency only: it compares the packaged road "
    "coordinates against the packaged imagery using the package's own declared bounds. "
    "It CANNOT declare the imagery's visible pavement centrelines authoritative, and it "
    "is not a survey or an engineering-grade check."
)


# ---- geo helpers (pure, deterministic) --------------------------------------

def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _valid_bounds(b) -> bool:
    if not isinstance(b, dict):
        return False
    if not all(_finite(b.get(k)) for k in ("min_lat", "min_lon", "max_lat", "max_lon")):
        return False
    return b["max_lat"] > b["min_lat"] and b["max_lon"] > b["min_lon"]


def canvas_size(bounds: dict, max_px: int = MAX_CANVAS_PX) -> tuple[int, int]:
    """Deterministic canvas dimensions for `bounds`, using the METRIC aspect (cos-lat) so
    the diagnostic is not horizontally stretched. Longer metric axis gets `max_px`."""
    lon_span = bounds["max_lon"] - bounds["min_lon"]
    lat_span = bounds["max_lat"] - bounds["min_lat"]
    mid_lat = (bounds["min_lat"] + bounds["max_lat"]) / 2.0
    mw = lon_span * max(1e-9, abs(math.cos(math.radians(mid_lat))))
    mh = lat_span
    if mw >= mh:
        w = int(max_px)
        h = max(1, round(max_px * (mh / mw)))
    else:
        h = int(max_px)
        w = max(1, round(max_px * (mw / mh)))
    return w, h


def transform_for(bounds: dict, w: int, h: int) -> dict:
    """The exact, deterministic lon/lat -> pixel transform. NORTH-UP: origin is the NW
    corner (min_lon, max_lat) at pixel (0,0); east is +x, south is +y."""
    return {
        "origin_lon": bounds["min_lon"],
        "origin_lat": bounds["max_lat"],
        "lon_per_px": (bounds["max_lon"] - bounds["min_lon"]) / w,
        "lat_per_px": -(bounds["max_lat"] - bounds["min_lat"]) / h,
        "width_px": w,
        "height_px": h,
        "north_up": True,
        "east_right": True,
    }


def lonlat_to_px(lon: float, lat: float, t: dict) -> tuple[float, float]:
    x = (lon - t["origin_lon"]) / t["lon_per_px"]
    y = (lat - t["origin_lat"]) / t["lat_per_px"]  # lat_per_px is negative -> south is +y
    return x, y


def _in_bounds(lon: float, lat: float, b: dict, eps: float = 1e-9) -> bool:
    return (b["min_lon"] - eps <= lon <= b["max_lon"] + eps) and (b["min_lat"] - eps <= lat <= b["max_lat"] + eps)


# ---- package reading (packaged bytes only) ---------------------------------

class Package:
    def __init__(self, path: str | Path):
        self._zf = zipfile.ZipFile(str(path))
        self.manifest = json.loads(self._zf.read("manifest.json"))

    def read(self, name: str) -> bytes:
        return self._zf.read(name)

    def has(self, name: str) -> bool:
        return name in self._zf.namelist()

    def close(self):
        self._zf.close()

    # -- manifest views --
    @property
    def version(self) -> str:
        return str(self.manifest.get("package_version") or "")

    @property
    def context_layers(self) -> dict:
        cl = self.manifest.get("context_layers")
        return cl if isinstance(cl, dict) else {}

    @property
    def terrain_bounds(self) -> dict | None:
        b = (self.manifest.get("terrain") or {}).get("bounds")
        if _valid_bounds(b):
            return b
        b = ((self.manifest.get("area") or {}).get("bounds"))
        return b if _valid_bounds(b) else None

    @property
    def incident(self) -> dict | None:
        inc = (self.manifest.get("overlays") or {}).get("incident")
        if isinstance(inc, dict) and _finite(inc.get("lat")) and _finite(inc.get("lon")):
            return {"lat": float(inc["lat"]), "lon": float(inc["lon"])}
        return None

    def imagery(self) -> dict:
        """{'format': 'tiled'|'single'|None, 'bounds': {...}|None, 'tiles': [...], 'file': str|None}"""
        layer = self.context_layers.get("imagery")
        if not isinstance(layer, dict) or layer.get("available") is not True:
            return {"format": None, "bounds": None, "tiles": [], "file": None}
        tiles = layer.get("tiles")
        if layer.get("format") == "tiled" and isinstance(tiles, list) and tiles:
            return {
                "format": "tiled",
                "bounds": layer.get("bounds") if _valid_bounds(layer.get("bounds")) else None,
                "tiles": [t for t in tiles if isinstance(t, dict) and _valid_bounds(t.get("bounds")) and isinstance(t.get("file"), str)],
                "file": None,
            }
        f = layer.get("file")
        if isinstance(f, str) and f:
            return {
                "format": "single",
                "bounds": layer.get("bounds") if _valid_bounds(layer.get("bounds")) else None,
                "tiles": [],
                "file": f,
            }
        return {"format": None, "bounds": None, "tiles": [], "file": None}

    def roads(self) -> dict:
        layer = self.context_layers.get("roads")
        if not isinstance(layer, dict) or layer.get("available") is not True:
            return {"type": "FeatureCollection", "features": []}
        name = layer.get("file") or "roads.geojson"
        if not self.has(name):
            return {"type": "FeatureCollection", "features": []}
        try:
            gj = json.loads(self.read(name))
        except Exception:
            return {"type": "FeatureCollection", "features": []}
        return gj if isinstance(gj, dict) else {"type": "FeatureCollection", "features": []}

    def road_clip(self) -> dict:
        """The DECLARED road clipping contract from the manifest.

        Roads are packaged clipped to terrain bounds + OFFLINE_SCENE_ROAD_BUFFER_M, so
        road coordinates outside the terrain footprint are EXPECTED, not errors. Only the
        package's own declared `clip_bounds` can decide a real contract violation.

        A legacy package predating this field declares nothing: we say so explicitly
        (`not_declared_legacy`) and refuse to substitute terrain bounds, which would
        falsely condemn every buffered coordinate."""
        layer = self.context_layers.get("roads")
        if not isinstance(layer, dict) or layer.get("available") is not True:
            return {"bounds": None, "buffer_m": None, "status": "not_declared_legacy"}
        b = layer.get("clip_bounds")
        if not _valid_bounds(b):
            return {"bounds": None, "buffer_m": None, "status": "not_declared_legacy"}
        buf = layer.get("buffer_m")
        return {
            "bounds": b,
            "buffer_m": float(buf) if _finite(buf) else None,
            "status": "declared",
        }

    def road_source(self) -> dict:
        """Provider/dataset ONLY — never the service URL/query (no secrets in the report)."""
        layer = self.context_layers.get("roads")
        src = layer.get("source") if isinstance(layer, dict) and isinstance(layer.get("source"), dict) else {}
        return {
            "provider": src.get("provider"),
            "dataset": src.get("dataset"),
            "attribution": src.get("attribution"),
        }


# ---- rendering -------------------------------------------------------------

def _build_background(pkg: Package, img_info: dict, frame: dict, w: int, h: int):
    """Imagery mosaic on the diagnostic canvas. Each TILE is pasted according to its OWN
    declared geographic bounds (never filename order); single imagery is placed by its
    declared bounds. North-up preserved."""
    from PIL import Image

    canvas = Image.new("RGB", (w, h), NO_IMAGERY_BG)
    t = transform_for(frame, w, h)

    def paste(data: bytes, b: dict):
        x0, y0 = lonlat_to_px(b["min_lon"], b["max_lat"], t)  # NW corner
        x1, y1 = lonlat_to_px(b["max_lon"], b["min_lat"], t)  # SE corner
        px0, py0 = int(round(x0)), int(round(y0))
        tw, th = max(1, int(round(x1 - x0))), max(1, int(round(y1 - y0)))
        try:
            im = Image.open(io.BytesIO(data)).convert("RGB").resize((tw, th))
        except Exception:
            return False
        canvas.paste(im, (px0, py0))
        return True

    placed = 0
    if img_info["format"] == "single" and img_info["file"] and pkg.has(img_info["file"]):
        if paste(pkg.read(img_info["file"]), img_info["bounds"] or frame):
            placed = 1
    elif img_info["format"] == "tiled":
        for tile in img_info["tiles"]:
            if pkg.has(tile["file"]) and paste(pkg.read(tile["file"]), tile["bounds"]):
                placed += 1
    return canvas, t, placed


def _iter_lines(geom):
    """Yield lists of [lon,lat] for LineString / MultiLineString only."""
    if not isinstance(geom, dict):
        return
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "LineString" and isinstance(c, list):
        yield c
    elif t == "MultiLineString" and isinstance(c, list):
        for part in c:
            if isinstance(part, list):
                yield part


def render(pkg: Package, max_px: int = MAX_CANVAS_PX) -> tuple[object, dict]:
    """Render the diagnostic image and build the report. Returns (PIL.Image, report)."""
    from PIL import ImageDraw

    pkg_bounds = pkg.terrain_bounds
    img_info = pkg.imagery()
    # The geographic frame: the imagery bounds when imagery exists (that is what we are
    # checking roads against), else the package bounds.
    frame = img_info["bounds"] or pkg_bounds
    if not _valid_bounds(frame):
        raise ValueError("package has no usable bounds (terrain/area/imagery)")

    w, h = canvas_size(frame, max_px)
    canvas, t, tiles_placed = _build_background(pkg, img_info, frame, w, h)
    draw = ImageDraw.Draw(canvas)

    # Package boundary (contrasting outline).
    if _valid_bounds(pkg_bounds):
        bx0, by0 = lonlat_to_px(pkg_bounds["min_lon"], pkg_bounds["max_lat"], t)
        bx1, by1 = lonlat_to_px(pkg_bounds["max_lon"], pkg_bounds["min_lat"], t)
        draw.rectangle([bx0, by0, bx1, by1], outline=BOUNDARY_COLOR, width=3)

    gj = pkg.roads()
    clip = pkg.road_clip()
    clip_bounds = clip["bounds"]
    feats = gj.get("features") if isinstance(gj.get("features"), list) else []
    counts: dict = {}
    kinds: dict = {}
    malformed = 0
    # Two DIFFERENT questions. Outside terrain = expected (roads are buffered).
    # Outside the declared clip_bounds = a packaging contract violation.
    outside_terrain = 0
    outside_clip = 0 if clip_bounds else None
    minx = miny = math.inf
    maxx = maxy = -math.inf
    drawn = 0

    # Draw local -> secondary -> primary so highways end up ON TOP and stay visible.
    def order_key(f):
        p = f.get("properties") if isinstance(f, dict) and isinstance(f.get("properties"), dict) else {}
        return {"local": 0, "secondary": 1, "primary": 2}.get(p.get("road_class"), 0)

    valid_feats = [f for f in feats if isinstance(f, dict)]
    malformed += len(feats) - len(valid_feats)

    for f in sorted(valid_feats, key=order_key):
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        rc = props.get("road_class")
        kind = props.get("kind")
        style = CLASS_STYLE.get(rc, OTHER_ROAD_STYLE)
        any_part = False
        for line in _iter_lines(f.get("geometry")):
            pts = []
            for c in line:
                if not (isinstance(c, (list, tuple)) and len(c) >= 2 and _finite(c[0]) and _finite(c[1])):
                    continue
                lon, lat = float(c[0]), float(c[1])
                if _valid_bounds(pkg_bounds) and not _in_bounds(lon, lat, pkg_bounds):
                    outside_terrain += 1   # EXPECTED for buffered road context — not an error
                if clip_bounds is not None and not _in_bounds(lon, lat, clip_bounds):
                    outside_clip += 1      # a real contract violation; never silently valid
                minx, maxx = min(minx, lon), max(maxx, lon)
                miny, maxy = min(miny, lat), max(maxy, lat)
                # Drawn regardless: geometry legitimately inside the road buffer but outside
                # the terrain frame is NOT erroneous. Pillow clips it at the canvas edge.
                pts.append(lonlat_to_px(lon, lat, t))
            if len(pts) >= 2:
                draw.line(pts, fill=style["color"], width=style["width"], joint="curve")
                any_part = True
        if any_part:
            drawn += 1
            if isinstance(rc, str):
                counts[rc] = counts.get(rc, 0) + 1
            if isinstance(kind, str):
                kinds[kind] = kinds.get(kind, 0) + 1
        else:
            malformed += 1  # a feature with no drawable line part

    # Incident marker.
    inc = pkg.incident
    if inc:
        ix, iy = lonlat_to_px(inc["lon"], inc["lat"], t)
        r = max(6, w // 140)
        draw.ellipse([ix - r, iy - r, ix + r, iy + r], fill=INCIDENT_COLOR, outline=(255, 255, 255), width=2)

    road_bbox = None
    if drawn and minx <= maxx:
        road_bbox = {"min_lon": minx, "min_lat": miny, "max_lon": maxx, "max_lat": maxy}

    report = {
        "package_version": pkg.version,
        "terrain_bounds": pkg_bounds,
        "imagery_format": img_info["format"],           # "single" | "tiled" | None
        "imagery_bounds": img_info["bounds"],
        "imagery_tiles_declared": len(img_info["tiles"]),
        "imagery_tiles_placed": tiles_placed,
        "road_feature_count": drawn,
        "road_class_counts": counts,                    # only classes actually present
        "road_kind_counts": kinds,
        "road_geometry_bbox": road_bbox,
        "malformed_features_dropped": malformed,
        # The road clipping contract, as DECLARED BY THE PACKAGE (never recomputed here).
        "road_clip_bounds": clip_bounds,               # null on a legacy package
        "road_buffer_m": clip["buffer_m"],
        "road_clip_bounds_status": clip["status"],     # "declared" | "not_declared_legacy"
        # EXPECTED to be > 0: road context is buffered past the terrain/imagery footprint.
        "coordinates_outside_terrain_bounds": outside_terrain,
        # A packaging CONTRACT VIOLATION. Normally 0. null when the package declares no
        # clip_bounds — unknown, and we will not pretend terrain bounds are equivalent.
        "coordinates_outside_road_clip_bounds": outside_clip,
        "road_source": pkg.road_source(),               # provider/dataset/attribution only
        "output_image": {"width_px": w, "height_px": h, "file": IMAGE_NAME},
        "transform": t,                                 # deterministic lon/lat -> pixel
        "note": DISCLAIMER,
    }
    return canvas, report


def run(package_path: str | Path, output_dir: str | Path, max_px: int = MAX_CANVAS_PX) -> dict:
    """Render the diagnostic + write both outputs. Returns the report dict."""
    pkg = Package(package_path)
    try:
        canvas, report = render(pkg, max_px=max_px)
    finally:
        pkg.close()
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    canvas.save(out / IMAGE_NAME, format="PNG", optimize=True)
    (out / REPORT_NAME).write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m app.tools.offline_scene_alignment",
        description="Road-vs-imagery alignment diagnostic for an .eristerrain package (offline, no network).",
    )
    ap.add_argument("--package", required=True, help="path to the .eristerrain package")
    ap.add_argument("--output-dir", required=True, help="directory for the PNG + JSON outputs")
    ap.add_argument("--max-px", type=int, default=MAX_CANVAS_PX, help=f"max canvas dimension (default {MAX_CANVAS_PX})")
    a = ap.parse_args(argv)

    report = run(a.package, a.output_dir, max_px=a.max_px)
    # Console summary (no paths/secrets beyond what the operator already typed).
    print(f"package_version        : {report['package_version']}")
    print(f"imagery_format         : {report['imagery_format']} "
          f"(tiles placed {report['imagery_tiles_placed']}/{report['imagery_tiles_declared']})")
    print(f"road_feature_count     : {report['road_feature_count']}")
    print(f"road_class_counts      : {report['road_class_counts']}")
    print(f"malformed_dropped      : {report['malformed_features_dropped']}")
    print(f"road_clip_bounds       : {report['road_clip_bounds_status']} "
          f"(buffer_m={report['road_buffer_m']})")
    print(f"outside_terrain_bounds : {report['coordinates_outside_terrain_bounds']} "
          f"(expected > 0: road context is buffered)")
    violations = report["coordinates_outside_road_clip_bounds"]
    if violations is None:
        print("outside_road_clip      : unknown (package declares no clip_bounds; legacy)")
    else:
        print(f"outside_road_clip      : {violations} "
              f"{'OK' if violations == 0 else '<-- CONTRACT VIOLATION'}")
    print(f"image                  : {report['output_image']['width_px']}x{report['output_image']['height_px']} -> {IMAGE_NAME}")
    print(f"NOTE: {DISCLAIMER}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
