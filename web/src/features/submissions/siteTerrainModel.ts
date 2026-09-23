// Dependency-free (runs under `node --test`): measuring a landslide from its
// outline and the terrain.
//
// The outline is a site area drawn on the location map ([lon, lat] rings). We
// sample the DEM on a grid inside it and in a band around it, then:
// - fit a plane to the samples inside     -> the slide's slope (β) and fall line;
// - fit a plane to the band around it     -> the original slope (α) of the ground
//                                            the slide sits in;
// - project the outline on the fall line  -> length (Ld, along the slope) and
//                                            width (Wd, across it);
// - take the relief of inside + band      -> slope height (H).
// Main scarp height, and the roadway encroachment, are not measurable from a
// terrain model and are left to the engineer.

export type LonLat = [number, number];
export type Ring = LonLat[];
export type Sample = { lon: number; lat: number; z: number };

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_AT_EQUATOR = 111_320;
export const FT_PER_M = 3.280839895;

type XY = [number, number];

/** A flat local frame in metres around (lon0, lat0), accurate over a site. */
export function localFrame(lon0: number, lat0: number) {
  const kx = M_PER_DEG_LON_AT_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: ([lon, lat]: LonLat): XY => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLonLat: ([x, y]: XY): LonLat => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT],
  };
}

function ringCentroid(ring: Ring): LonLat {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

/** Even-odd point in polygon (outer ring plus holes), in local metres. */
export function pointInRings([x, y]: XY, rings: XY[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment([px, py]: XY, [ax, ay]: XY, [bx, by]: XY): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToRings(p: XY, rings: XY[][]): number {
  let best = Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i += 1) best = Math.min(best, distanceToSegment(p, ring[i - 1], ring[i]));
  return best;
}

function shoelaceArea(ring: XY[]): number {
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) total += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(total) / 2;
}

export type SamplePlan = { inside: LonLat[]; around: LonLat[]; spacingM: number; bufferM: number };

/**
 * Grid points inside the outline (about `targetInside` of them, never closer
 * than `minSpacingM`) and in a band around it (`bufferM` wide, scaled to the
 * outline's size) for the original ground.
 */
export function buildSamplePlan(rings: Ring[], targetInside = 600, minSpacingM = 1.5): SamplePlan {
  const [lon0, lat0] = ringCentroid(rings[0]);
  const frame = localFrame(lon0, lat0);
  const xyRings = rings.map((ring) => ring.map(frame.toXY));
  const area = Math.max(1, shoelaceArea(xyRings[0]));
  const spacing = Math.max(minSpacingM, Math.sqrt(area / targetInside));
  const buffer = Math.min(60, Math.max(15, 0.25 * Math.sqrt(area)));
  const xs = xyRings[0].map((p) => p[0]);
  const ys = xyRings[0].map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs) - buffer, Math.max(...xs) + buffer, Math.min(...ys) - buffer, Math.max(...ys) + buffer];
  const inside: LonLat[] = [];
  const around: LonLat[] = [];
  for (let y = minY; y <= maxY; y += spacing) {
    for (let x = minX; x <= maxX; x += spacing) {
      const p: XY = [x, y];
      if (pointInRings(p, xyRings)) inside.push(frame.toLonLat(p));
      else if (distanceToRings(p, xyRings) <= buffer) around.push(frame.toLonLat(p));
    }
  }
  return { inside, around, spacingM: spacing, bufferM: buffer };
}

type Plane = { a: number; b: number; c: number };

/** Least-squares plane z = a·x + b·y + c through local-metre samples. */
export function fitPlane(points: Array<{ x: number; y: number; z: number }>): Plane | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const { x, y, z } of points) {
    sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  // Solve the 3x3 normal equations with Cramer's rule.
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const r = [sxz, syz, sz];
  const det3 = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return null;
  const withColumn = (col: number) => m.map((row, i) => row.map((v, j) => (j === col ? r[i] : v)));
  return { a: det3(withColumn(0)) / d, b: det3(withColumn(1)) / d, c: det3(withColumn(2)) / d };
}

const deg = (radians: number) => (radians * 180) / Math.PI;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export type SiteMeasurement = {
  landslideSlopeDeg: number;
  originalSlopeDeg: number | null;
  /** Compass bearing the slope faces (downhill), degrees clockwise from north. */
  downslopeBearingDeg: number;
  horizontalLengthM: number;
  slopeLengthM: number;
  widthM: number;
  slopeHeightM: number;
  /** The 2nd and 98th percentile elevations the height is taken between. */
  lowElevationM: number;
  highElevationM: number;
  insideSamples: number;
  aroundSamples: number;
  /** True when the slope is too gentle for a reliable fall line; length follows the outline's long axis. */
  directionFromOutline: boolean;
};

/** Measure the outline against DEM samples inside it and around it. */
export function measureSiteArea(rings: Ring[], inside: Sample[], around: Sample[]): SiteMeasurement | null {
  if (inside.length < 6) return null;
  const [lon0, lat0] = ringCentroid(rings[0]);
  const frame = localFrame(lon0, lat0);
  const toPoint = (s: Sample) => {
    const [x, y] = frame.toXY([s.lon, s.lat]);
    return { x, y, z: s.z };
  };
  const insidePlane = fitPlane(inside.map(toPoint));
  if (!insidePlane) return null;
  const aroundPlane = around.length >= 12 ? fitPlane(around.map(toPoint)) : null;

  const gradient = Math.hypot(insidePlane.a, insidePlane.b);
  const landslideSlopeDeg = deg(Math.atan(gradient));
  const outline = rings[0].map(frame.toXY);

  // The fall line runs down the gradient. On near-flat ground it is noise, so
  // use the outline's long axis instead: the principal axis of the samples
  // inside it (a grid, so it weighs the area, not where the corners happen to be).
  let ux: number;
  let uy: number;
  const directionFromOutline = landslideSlopeDeg < 2;
  if (!directionFromOutline) {
    ux = -insidePlane.a / gradient;
    uy = -insidePlane.b / gradient;
  } else {
    const pts = inside.map(toPoint);
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const { x, y } of pts) {
      cxx += (x - mx) ** 2; cyy += (y - my) ** 2; cxy += (x - mx) * (y - my);
    }
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    ux = Math.cos(angle);
    uy = Math.sin(angle);
  }
  const along = outline.map(([x, y]) => x * ux + y * uy);
  const across = outline.map(([x, y]) => -x * uy + y * ux);
  const horizontalLengthM = Math.max(...along) - Math.min(...along);
  const widthM = Math.max(...across) - Math.min(...across);
  const slopeLengthM = horizontalLengthM / Math.cos(Math.atan(gradient));

  const elevations = [...inside, ...around].map((s) => s.z).sort((a, b) => a - b);
  const lowElevationM = percentile(elevations, 0.02);
  const highElevationM = percentile(elevations, 0.98);

  return {
    landslideSlopeDeg,
    originalSlopeDeg: aroundPlane ? deg(Math.atan(Math.hypot(aroundPlane.a, aroundPlane.b))) : null,
    downslopeBearingDeg: (deg(Math.atan2(ux, uy)) + 360) % 360,
    horizontalLengthM,
    slopeLengthM,
    widthM,
    slopeHeightM: highElevationM - lowElevationM,
    lowElevationM,
    highElevationM,
    insideSamples: inside.length,
    aroundSamples: around.length,
    directionFromOutline,
  };
}

export type MeasurementField =
  | "measure_slope_height_ft"
  | "measure_original_slope_deg"
  | "measure_landslide_width_ft"
  | "measure_landslide_length_ft"
  | "measure_landslide_slope_deg";

/** The form fields a measurement fills, rounded as an engineer would write them. */
export function measurementFieldValues(m: SiteMeasurement): Partial<Record<MeasurementField, string>> {
  const feet = (meters: number) => (meters * FT_PER_M).toFixed(0);
  const angle = (degrees: number) => degrees.toFixed(1);
  const values: Partial<Record<MeasurementField, string>> = {
    measure_slope_height_ft: feet(m.slopeHeightM),
    measure_landslide_width_ft: feet(m.widthM),
    measure_landslide_length_ft: feet(m.slopeLengthM),
    measure_landslide_slope_deg: angle(m.landslideSlopeDeg),
  };
  if (m.originalSlopeDeg != null) values.measure_original_slope_deg = angle(m.originalSlopeDeg);
  return values;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** "212° (SSW)". */
export function bearingLabel(bearing: number): string {
  return `${Math.round(bearing)}° (${COMPASS[Math.round(bearing / 22.5) % 16]})`;
}
