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

# CATEGORY styling by SELECTION ROLE, which is what an operator is actually triaging:
# a derived corridor midpoint, a selectable mainline carriageway, a selectable ramp, and a
# NON-selectable diagnostics member. Roles are visually distinct in BOTH hue and width, and
# the diagnostics member is deliberately the thinnest + dashed-looking so it can never be
# mistaken for a normal selectable road. Styling only — no coordinate is altered and no
# visual offset is applied.
SELECTION_STYLE = {
    "divided_highway_corridor": {"color": (255, 235, 0), "width": 8, "label": "Divided corridor midpoint"},
    "individual_carriageway": {"color": (255, 0, 200), "width": 5, "label": "Individual mainline carriageway"},
    "ramp": {"color": (0, 200, 255), "width": 4, "label": "Ramp"},
    "ordinary_road": {"color": (150, 160, 175), "width": 2, "label": "Ordinary road"},
}
# Non-selectable raw carriageway member: thinnest, muted, so it reads as a diagnostic.
DIAGNOSTIC_STYLE = {"color": (130, 95, 175), "width": 1, "label": "Carriageway-member diagnostic (not selectable)"}
CONTEXT_STYLE = {"color": (180, 255, 80), "width": 2, "label": "Context geometry (bearing/inventory/submitted)"}
# A selection_kind outside the known enum: drawn in a colour used by nothing else so role
# drift is visible rather than disguised as a legitimate category.
INVALID_SELECTION_STYLE = {"color": (255, 60, 60), "width": 6, "label": "Unknown selection_kind"}
LEGEND_BG = (0, 0, 0)
LEGEND_FG = (255, 255, 255)
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

    def imagery_extent_verification(self) -> dict:
        """The package's OWN declared exact-extent verification status.

        READ, never recomputed — this tool cannot re-contact the service, and it must not
        imply an answer it did not obtain. Reports counts and the contract name only:
        no href, query string, token or service URL ever reaches the JSON report.

        A package predating the contract declares nothing, and is reported as
        `not_declared_legacy` rather than as passing or failing a check it never ran.
        """
        from ..services import offline_scene_imagery as imagery

        layer = self.context_layers.get("imagery")
        if not isinstance(layer, dict) or layer.get("available") is not True:
            return {"status": "no_imagery", "contract": None}
        contract = layer.get("export_contract")
        if not isinstance(contract, str) or not contract:
            return {"status": "not_declared_legacy", "contract": None}
        ok, reason = imagery.validate_packaged_verification(layer)
        diag = layer.get("diagnostics") if isinstance(layer.get("diagnostics"), dict) else {}
        tiles = layer.get("tiles") if isinstance(layer.get("tiles"), list) else []
        return {
            "status": "verified" if ok else "declared_but_inconsistent",
            "contract": contract,
            "adjust_aspect_ratio": diag.get("adjust_aspect_ratio"),
            "extents_verified": diag.get("extents_verified"),
            "extents_verified_count": diag.get("extents_verified_count"),
            "extent_mismatch_count": diag.get("extent_mismatch_count"),
            "dimensions_verified_count": diag.get("dimensions_verified_count"),
            "extent_tolerance_deg": diag.get("extent_tolerance_deg"),
            "tiles_declared": len(tiles),
            # Built from OUR counts/coordinates only — never from a service response.
            "reason": None if ok else reason,
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


def legend_band_height(w: int) -> int:
    """Height of the reserved legend band appended BELOW the map."""
    line_h = max(14, w // 90)
    pad = max(8, w // 160)
    return line_h * 5 + pad * 2


def _render_legend_band(w: int, selection_counts: dict, diagnostic_counts: dict):
    """The category legend rendered into its OWN image band.

    Deliberately NOT an overlay on the map. This tool exists to answer "do the packaged
    road coordinates line up with the packaged imagery", so painting an opaque panel over
    the lower-left corner would destroy the very evidence being checked — it hid roads and
    could erase the incident marker entirely. The band is composited BELOW the geographic
    frame instead, so every map pixel stays inspectable.

    Every category that CAN appear is listed with its live count, so a zero is explicit
    (a "Ramp  (0)" line is itself the evidence of the mislabeling defect)."""
    from PIL import Image, ImageDraw

    rows = [(SELECTION_STYLE[k]["color"], SELECTION_STYLE[k]["width"],
             SELECTION_STYLE[k]["label"], int(selection_counts.get(k, 0)))
            for k in ("divided_highway_corridor", "individual_carriageway", "ramp", "ordinary_road")]
    rows.append((DIAGNOSTIC_STYLE["color"], DIAGNOSTIC_STYLE["width"], DIAGNOSTIC_STYLE["label"],
                 int(sum(diagnostic_counts.values()))))
    line_h = max(14, w // 90)
    pad = max(8, w // 160)
    swatch_w = max(26, w // 42)
    band_h = legend_band_height(w)
    band = Image.new("RGB", (w, band_h), LEGEND_BG)
    d = ImageDraw.Draw(band)
    y = pad
    for color, width_px, label, count in rows:
        cy = y + line_h // 2
        d.line([(pad, cy), (pad + swatch_w, cy)], fill=color, width=max(1, int(width_px)))
        d.text((pad * 2 + swatch_w, y), f"{label}  ({count})", fill=LEGEND_FG)
        y += line_h
    return band


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

    selection_counts: dict = {}
    diagnostic_counts: dict = {}
    unknown_selection_counts: dict = {}   # selection_kind values outside the known enum

    def _category_style(props: dict):
        """Style by SELECTION ROLE so the categories an operator triages are visually
        distinct. A non-selectable diagnostics member is the thinnest so it never reads as a
        normal selectable road. Falls back to road-class styling for legacy packages that
        carry no selection metadata."""
        dk = props.get("diagnostic_kind")
        if isinstance(dk, str) and dk:
            return DIAGNOSTIC_STYLE
        sk = props.get("selection_kind")
        if isinstance(sk, str) and sk:
            # An unknown role gets its OWN alarming style — never the colour the legend
            # attributes to a real category, which would disguise enum drift.
            return SELECTION_STYLE.get(sk, INVALID_SELECTION_STYLE)
        if props.get("kind") != "road_centerline":
            return CONTEXT_STYLE
        return CLASS_STYLE.get(props.get("road_class"), OTHER_ROAD_STYLE)

    # Draw diagnostics + context first, then ordinary/ramp, then mainline, then the derived
    # corridor midpoint LAST so the authoritative selection sits on top and stays visible.
    def order_key(f):
        p = f.get("properties") if isinstance(f, dict) and isinstance(f.get("properties"), dict) else {}
        dk = p.get("diagnostic_kind")
        if isinstance(dk, str) and dk:
            return 0
        sk = p.get("selection_kind")
        if isinstance(sk, str) and sk in SELECTION_STYLE:
            return {"ordinary_road": 1, "ramp": 2,
                    "individual_carriageway": 3, "divided_highway_corridor": 4}[sk]
        # Legacy (no selection metadata): keep the original class ordering.
        return {"local": 0, "secondary": 1, "primary": 2}.get(p.get("road_class"), 0)

    valid_feats = [f for f in feats if isinstance(f, dict)]
    malformed += len(feats) - len(valid_feats)

    for f in sorted(valid_feats, key=order_key):
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        rc = props.get("road_class")
        kind = props.get("kind")
        style = _category_style(props)
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
            # The SELECTION partition actually shipped (what native will offer the user).
            # An OUT-OF-ENUM selection_kind is tracked separately, never folded into a known
            # category: silently absorbing it would hide exactly the role/enum drift this
            # renderer exists to expose (the Rocklin ramp mislabeling was that class of bug).
            dk = props.get("diagnostic_kind")
            sk = props.get("selection_kind")
            if isinstance(dk, str) and dk:
                diagnostic_counts[dk] = diagnostic_counts.get(dk, 0) + 1
            elif isinstance(sk, str) and sk:
                if sk in SELECTION_STYLE:
                    selection_counts[sk] = selection_counts.get(sk, 0) + 1
                else:
                    unknown_selection_counts[sk] = unknown_selection_counts.get(sk, 0) + 1
        else:
            malformed += 1  # a feature with no drawable line part

    # Incident marker.
    inc = pkg.incident
    if inc:
        ix, iy = lonlat_to_px(inc["lon"], inc["lat"], t)
        r = max(6, w // 140)
        draw.ellipse([ix - r, iy - r, ix + r, iy + r], fill=INCIDENT_COLOR, outline=(255, 255, 255), width=2)

    # CATEGORY LEGEND — composited into a RESERVED BAND BELOW the map (never over it), so
    # the reader can tell a corridor midpoint from a mainline carriageway, a ramp and a
    # non-selectable diagnostic without any geographic pixel being covered. It touches no
    # road coordinate and applies no visual offset.
    from PIL import Image as _Image

    band = _render_legend_band(w, selection_counts, diagnostic_counts)
    composed = _Image.new("RGB", (w, h + band.height), NO_IMAGERY_BG)
    composed.paste(canvas, (0, 0))
    composed.paste(band, (0, h))
    canvas = composed

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
        # Whether the PACKAGE declares that every tile's returned extent was verified
        # against the requested extent at export time. Non-sensitive counts only.
        "imagery_extent_verification": pkg.imagery_extent_verification(),
        "road_feature_count": drawn,
        "road_class_counts": counts,                    # only classes actually present
        "road_kind_counts": kinds,
        # The SELECTION PARTITION actually shipped — what native will offer the user. Every
        # selectable category is reported explicitly (including a 0) so a missing category
        # such as `ramp` is visible evidence rather than a silent absence.
        "selection_kind_counts": {
            k: int(selection_counts.get(k, 0))
            for k in ("divided_highway_corridor", "individual_carriageway", "ramp", "ordinary_road")
        },
        "diagnostic_kind_counts": dict(sorted(diagnostic_counts.items())),
        # Any selection_kind outside the known enum — surfaced, never absorbed, so
        # sum(selection_kind_counts) + sum(unknown) == selectable_feature_count holds.
        "unknown_selection_kind_counts": dict(sorted(unknown_selection_counts.items())),
        "selectable_feature_count": int(sum(selection_counts.values()) + sum(unknown_selection_counts.values())),
        "diagnostic_feature_count": int(sum(diagnostic_counts.values())),
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
        # `map_height_px` is the GEOGRAPHIC frame the transform applies to; the legend band
        # is appended below it, so height_px > map_height_px. No map pixel is covered.
        "output_image": {"width_px": w, "height_px": h + legend_band_height(w),
                         "map_height_px": h, "legend_band_px": legend_band_height(w),
                         "file": IMAGE_NAME},
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
    _ev = report["imagery_extent_verification"]
    print(f"imagery_extent_verify  : {_ev['status']}"
          + (f" ({_ev.get('extents_verified_count')}/{_ev.get('tiles_declared')} tiles, "
             f"mismatches={_ev.get('extent_mismatch_count')})" if _ev.get("contract") else ""))
    print(f"road_feature_count     : {report['road_feature_count']}")
    print(f"road_class_counts      : {report['road_class_counts']}")
    print(f"selection_kind_counts  : {report['selection_kind_counts']}")
    print(f"diagnostic_kind_counts : {report['diagnostic_kind_counts']}")
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
