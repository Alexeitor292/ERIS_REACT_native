// Reading a drone survey's GeoTIFFs in the browser (geotiff.js), into the
// elevation patch and the orthomosaic image ERIS keeps (droneGrid.ts).
//
// Drone software (DroneDeploy, Pix4D, Metashape, Site Scan) exports an
// elevation model (DSM/DEM) and an orthomosaic as GeoTIFFs in a projected
// coordinate system (UTM, State Plane) or in longitude/latitude. The files can
// be hundreds of megabytes: they are read in horizontal bands and averaged down
// as they go, so they never sit in memory whole. Coordinates are converted with
// ArcGIS's projection engine, already part of the web app.

import { fromBlob, type GeoTIFFImage } from "geotiff";

import {
  BlockAverager,
  chooseGridSize,
  gridStats,
  latticeInterpolator,
  latticePoints,
  metresPerDegree,
  resampleToGrid,
  type Bounds,
  type DroneGrid,
  type LonLat,
} from "./droneGrid";

export type VerticalUnit = "m" | "ft" | "usft";
export const VERTICAL_UNIT_TO_M: Record<VerticalUnit, number> = { m: 1, ft: 0.3048, usft: 1200 / 3937 };
export const VERTICAL_UNIT_LABEL: Record<VerticalUnit, string> = { m: "metres", ft: "feet", usft: "US survey feet" };

export type Progress = (fraction: number, message: string) => void;

export type ElevationRead = {
  grid: DroneGrid;
  /** "EPSG:32610" and so on. */
  sourceCrs: string;
  nativeResolutionM: number;
  cellM: number;
  /** What the heights were read as, and what the file says (null when it says nothing). */
  verticalUnit: VerticalUnit;
  declaredVerticalUnit: VerticalUnit | null;
  stats: { min: number | null; max: number | null; validCells: number };
};

export type OrthoRead = { image: Blob; mime: string; corners: LonLat[]; width: number; height: number };

const LATTICE = 17;
const MAX_REDUCED_SIDE = 2048;
const BAND_VALUES = 6_000_000; // decoded values per band read, about 24 MB of float32
const MAX_ORTHO_SIDE = 2048;

const UNIT_CODES: Record<number, VerticalUnit> = { 9001: "m", 9002: "ft", 9003: "usft" };
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type SourceFrame = {
  wkid: number;
  width: number;
  height: number;
  /** Top-left corner of pixel (0, 0), and the pixel size (y negative going down). */
  originX: number;
  originY: number;
  resX: number;
  resY: number;
  linearUnit: VerticalUnit | null;
  declaredVerticalUnit: VerticalUnit | null;
};

function frameOf(image: GeoTIFFImage): SourceFrame {
  const keys = (image.getGeoKeys() ?? {}) as Record<string, number>;
  const projected = keys.ProjectedCSTypeGeoKey;
  const geographic = keys.GeographicTypeGeoKey;
  let wkid: number | undefined;
  if (projected && projected !== 32767) wkid = projected;
  else if (!projected && geographic && geographic !== 32767) wkid = geographic;
  if (!wkid) {
    throw new Error("This file's coordinate system is not an EPSG code ERIS can read. Export it in WGS 84, UTM or State Plane.");
  }
  let origin: number[];
  let resolution: number[];
  try {
    origin = image.getOrigin();
    resolution = image.getResolution();
  } catch {
    throw new Error("This file has no georeferencing (no position on the ground). Export it as a GeoTIFF.");
  }
  let [originX, originY] = origin;
  const [resX, resY] = resolution;
  if (keys.GTRasterTypeGeoKey === 2) {
    // PixelIsPoint: the tie point is the first pixel's centre, not its corner.
    originX -= resX / 2;
    originY -= resY / 2;
  }
  return {
    wkid,
    width: image.getWidth(),
    height: image.getHeight(),
    originX,
    originY,
    resX,
    resY,
    linearUnit: UNIT_CODES[keys.ProjLinearUnitsGeoKey] ?? null,
    declaredVerticalUnit: UNIT_CODES[keys.VerticalUnitsGeoKey] ?? null,
  };
}

async function projector() {
  const [{ default: Multipoint }, { default: SpatialReference }, projectOperator] = await Promise.all([
    import("@arcgis/core/geometry/Multipoint"),
    import("@arcgis/core/geometry/SpatialReference"),
    import("@arcgis/core/geometry/operators/projectOperator"),
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  const run = (points: Array<[number, number]>, from: number, to: number): Array<[number, number]> => {
    if (from === to) return points.map((p) => [p[0], p[1]]);
    const geometry = new Multipoint({ points, spatialReference: new SpatialReference({ wkid: from }) });
    const out = projectOperator.execute(geometry, new SpatialReference({ wkid: to })) as InstanceType<typeof Multipoint> | null;
    if (!out || out.points.length !== points.length) throw new Error(`Could not convert coordinates from EPSG:${from}.`);
    return out.points.map((p) => [p[0], p[1]]);
  };
  return run;
}

/** The file's corners (and edge midpoints) on the ground, as longitude/latitude bounds. */
function cornersInSource(f: SourceFrame): Array<[number, number]> {
  const x0 = f.originX;
  const y0 = f.originY;
  const x1 = f.originX + f.width * f.resX;
  const y1 = f.originY + f.height * f.resY;
  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  // Top-left, top-right, bottom-right, bottom-left, then the edge midpoints.
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [xm, y0], [x1, ym], [xm, y1], [x0, ym]];
}

function boundsOf(points: Array<[number, number]>): Bounds {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
}

/**
 * Read an elevation GeoTIFF (DSM/DEM) into the patch. `verticalUnit`, when
 * given, overrides what the file declares (or does not).
 */
export async function readElevation(file: File, options: { verticalUnit?: VerticalUnit; onProgress?: Progress } = {}): Promise<ElevationRead> {
  const progress = options.onProgress ?? (() => {});
  progress(0, "Opening the elevation file…");
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  if (image.getSamplesPerPixel() > 2) {
    throw new Error("This looks like an orthomosaic (a colour image). Choose the elevation file (DSM or DEM) here.");
  }
  const f = frameOf(image);
  const project = await projector();
  const lonLatCorners = project(cornersInSource(f), f.wkid, 4326);
  const bounds = boundsOf(lonLatCorners);
  const m = metresPerDegree((bounds.north + bounds.south) / 2);
  const nativeResolutionM = Math.max(((bounds.east - bounds.west) * m.lon) / f.width, ((bounds.north - bounds.south) * m.lat) / f.height);
  const { cols, rows, cellM } = chooseGridSize(bounds, nativeResolutionM);

  const factor = Math.max(1, Math.floor(cellM / nativeResolutionM), Math.ceil(f.width / MAX_REDUCED_SIDE), Math.ceil(f.height / MAX_REDUCED_SIDE));
  const nodata = image.getGDALNoData();
  const valid = (v: number) => Number.isFinite(v) && Math.abs(v) < 1e20 && (nodata == null || Math.abs(v - nodata) > 1e-6) && v > -9000;
  const averager = new BlockAverager(f.width, f.height, factor, valid);
  const bandRows = Math.max(factor, Math.floor(BAND_VALUES / f.width / factor) * factor);
  for (let y0 = 0; y0 < f.height; y0 += bandRows) {
    const y1 = Math.min(f.height, y0 + bandRows);
    progress(0.05 + 0.8 * (y0 / f.height), `Reading heights… ${Math.round((100 * y0) / f.height)}%`);
    const band = (await image.readRasters({ window: [0, y0, f.width, y1], samples: [0] })) as unknown as ArrayLike<number>[];
    averager.add(band[0], y0);
    await yieldToUi();
  }

  progress(0.88, "Placing the heights on the map…");
  const lattice = latticePoints(bounds, LATTICE);
  const projected = project(lattice as Array<[number, number]>, 4326, f.wkid);
  const toSource = latticeInterpolator(bounds, LATTICE, projected);
  const verticalUnit = options.verticalUnit ?? f.declaredVerticalUnit ?? (f.linearUnit === "ft" || f.linearUnit === "usft" ? f.linearUnit : "m");
  const grid = resampleToGrid({
    bounds,
    cols,
    rows,
    reduced: averager.finish(),
    reducedWidth: averager.width,
    reducedHeight: averager.height,
    factor,
    toPixel: (lon, lat) => {
      const [x, y] = toSource(lon, lat);
      return [(x - f.originX) / f.resX - 0.5, (y - f.originY) / f.resY - 0.5];
    },
    scale: VERTICAL_UNIT_TO_M[verticalUnit],
  });
  const stats = gridStats(grid);
  if (!stats.validCells) throw new Error("The elevation file has no heights ERIS can read (every cell is empty).");
  progress(1, "Done");
  return { grid, sourceCrs: `EPSG:${f.wkid}`, nativeResolutionM, cellM, verticalUnit, declaredVerticalUnit: f.declaredVerticalUnit, stats };
}

/**
 * Read an orthomosaic GeoTIFF into an image (at most 2048 pixels a side) and
 * the longitude/latitude of its four corners, to drape it over the ground.
 */
export async function readOrthomosaic(file: File, options: { onProgress?: Progress } = {}): Promise<OrthoRead> {
  const progress = options.onProgress ?? (() => {});
  progress(0, "Opening the orthomosaic…");
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const f = frameOf(image);
  const factor = Math.max(1, Math.ceil(Math.max(f.width, f.height) / MAX_ORTHO_SIDE));
  const width = Math.ceil(f.width / factor);
  const height = Math.ceil(f.height / factor);
  const sums = new Float64Array(width * height * 4);
  const counts = new Uint32Array(width * height);
  const nodata = image.getGDALNoData();
  const bandRows = Math.max(factor, Math.floor(BAND_VALUES / 4 / f.width / factor) * factor);
  for (let y0 = 0; y0 < f.height; y0 += bandRows) {
    const y1 = Math.min(f.height, y0 + bandRows);
    progress(0.05 + 0.85 * (y0 / f.height), `Reading the orthomosaic… ${Math.round((100 * y0) / f.height)}%`);
    const rgb = (await image.readRGB({ window: [0, y0, f.width, y1], interleave: true, enableAlpha: true })) as unknown as ArrayLike<number>;
    const channels = Math.round(rgb.length / (f.width * (y1 - y0)));
    for (let r = 0; r < y1 - y0; r += 1) {
      const target = Math.floor((y0 + r) / factor) * width;
      for (let x = 0; x < f.width; x += 1) {
        const s = (r * f.width + x) * channels;
        const [red, green, blue] = [rgb[s], rgb[s + 1], rgb[s + 2]];
        const alpha = channels > 3 ? rgb[s + 3] : 255;
        if (alpha === 0 || (nodata != null && red === nodata && green === nodata && blue === nodata)) continue;
        const i = target + Math.floor(x / factor);
        sums[i * 4] += red;
        sums[i * 4 + 1] += green;
        sums[i * 4 + 2] += blue;
        sums[i * 4 + 3] += alpha;
        counts[i] += 1;
      }
    }
    await yieldToUi();
  }
  progress(0.92, "Preparing the image…");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the orthomosaic image.");
  const pixels = context.createImageData(width, height);
  for (let i = 0; i < counts.length; i += 1) {
    const n = counts[i];
    if (!n) continue; // transparent where the drone did not fly
    pixels.data[i * 4] = sums[i * 4] / n;
    pixels.data[i * 4 + 1] = sums[i * 4 + 1] / n;
    pixels.data[i * 4 + 2] = sums[i * 4 + 2] / n;
    pixels.data[i * 4 + 3] = sums[i * 4 + 3] / n;
  }
  context.putImageData(pixels, 0, 0);
  const toBlob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  let blob = await toBlob("image/webp");
  let mime = "image/webp";
  if (!blob || blob.type !== "image/webp") {
    blob = await toBlob("image/png");
    mime = "image/png";
  }
  if (!blob) throw new Error("This browser cannot prepare the orthomosaic image.");
  const project = await projector();
  const corners = project(cornersInSource(f).slice(0, 4), f.wkid, 4326) as LonLat[];
  progress(1, "Done");
  return { image: blob, mime, corners, width, height };
}

/** A likely flight date from a file name ("…_2026-09-27_…", "20260927"), or null. */
export function dateFromFileName(name: string): string | null {
  const iso = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/.exec(name);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}
