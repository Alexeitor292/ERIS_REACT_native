// Pure geometry + data contract for the map-driven 3D ROAD CROSS SECTION feature.
//
// This is the TESTED reference implementation that the native Objective-C code
// (ErisTerrainSceneViewController.m tap→snap→sample and ErisRoadSliceSceneViewController
// rendering) mirrors, and that the React Native realistic renderer consumes. Keep the
// three in sync via the tests in roadCrossSectionSlice.test.ts.
//
// Canonical orientation (NEVER mirrored): the cross-section is always viewed looking
// UPSTATION (toward increasing postmile). LT is always on the LEFT, RT on the RIGHT.
// Offsets are in FEET from the roadway centerline (median center): negative = LT,
// positive = RT. The cross-section axis points from LT→RT = the upstation bearing
// rotated +90° (clockwise / to the right of the direction of travel).
//
// Roadway layout comes from ERIS Road Inventory (RoadCrossSection, widths in feet) and
// is a SCHEMATIC engineered surface (no crown/superelevation unless that data exists).
// Ground elevation beyond the shoulder comes ONLY from the packaged USGS 3DEP offline
// terrain grid, sampled bilinearly; no elevation is ever invented outside coverage.
//
// No react-native/expo imports (unit-tested under node --test).

import type { RoadCrossSection } from "./roadCrossSectionModel";

export const FT_PER_M = 3.280839895;
export const M_PER_DEG_LAT = 111_320.0;

export function ftToM(ft: number): number {
  return ft / FT_PER_M;
}
export function mToFt(m: number): number {
  return m * FT_PER_M;
}

export type Side = "LT" | "RT" | "CENTER";
export type SampleStatus = "OK" | "NO_DATA" | "OUT_OF_BOUNDS";
export const ELEVATION_SOURCE = "USGS_3DEP_OFFLINE_GRID" as const;

export type CrossSectionSample = {
  side: Side;
  offsetFt: number;
  lat: number;
  lon: number;
  elevationM: number | null;
  elevationFt: number | null;
  source: typeof ELEVATION_SOURCE;
  status: SampleStatus;
  label?: string;
};

/** A roadway breakpoint along the section (a lane/shoulder/median edge or centerline). */
export type BreakpointKind =
  | "center"
  | "median_edge"
  | "inside_shoulder_edge"
  | "lane_divider"
  | "travelway_edge"
  | "outside_shoulder_edge";

export type RoadBreakpoint = { offsetFt: number; side: Side; kind: BreakpointKind; label: string };

export type RoadCrossSectionSlice = {
  selectedLat: number;
  selectedLon: number;
  snappedLat: number;
  snappedLon: number;

  upstationBearingDeg: number;
  crossSectionBearingDeg: number;

  road: RoadCrossSection;

  elevationSource: typeof ELEVATION_SOURCE;

  samples: CrossSectionSample[];

  keyMarkers: {
    ltOutsideShoulderEdge: CrossSectionSample | null;
    rtOutsideShoulderEdge: CrossSectionSample | null;
    lt10ft: CrossSectionSample | null;
    lt20ft: CrossSectionSample | null;
    lt50ft: CrossSectionSample | null;
    rt10ft: CrossSectionSample | null;
    rt20ft: CrossSectionSample | null;
    rt50ft: CrossSectionSample | null;
  };

  provenance: {
    roadLayoutSource: "ROAD_INVENTORY" | "FORM_FIELDS" | "DEFAULT";
    elevationSource: "USGS 3DEP source-derived offline terrain grid";
    packageVersion: string;
    snappedToRoadContext: boolean;
    roadContextSource?: string;
  };
};

// ---- bearing / offset math -------------------------------------------------

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Cross-section axis bearing (LT→RT) = upstation rotated +90° (RT is to the right). */
export function crossSectionBearingDeg(upstationBearingDeg: number): number {
  return norm360(upstationBearingDeg + 90);
}

/**
 * Orient a road-segment tangent to the UPSTATION direction. A polyline tangent is
 * ambiguous (two ways); when a bearing hint (e.g. the incident's roadBearingDeg,
 * which points upstation) is available, pick whichever of tangent / tangent+180 is
 * within 90° of it. With no hint, the tangent is used as-is.
 */
export function resolveUpstationBearing(tangentDeg: number, hintDeg: number | null | undefined): number {
  const t = norm360(tangentDeg);
  if (hintDeg == null || !Number.isFinite(hintDeg)) return t;
  const h = norm360(hintDeg);
  const diff = Math.abs(((t - h + 540) % 360) - 180); // angular distance 0..180
  return diff <= 90 ? t : norm360(t + 180);
}

/**
 * Move `offsetFt` feet from (centerLat,centerLon) along the cross-section bearing.
 * Positive offset ⇒ toward RT (right of upstation). Local equirectangular — exact
 * enough at a road-section scale (tens of metres).
 */
export function offsetToLatLon(
  centerLat: number,
  centerLon: number,
  crossBearingDeg: number,
  offsetFt: number,
): { lat: number; lon: number } {
  const dM = ftToM(offsetFt);
  const rad = (crossBearingDeg * Math.PI) / 180;
  const dNorthM = dM * Math.cos(rad);
  const dEastM = dM * Math.sin(rad);
  const cosLat = Math.cos((centerLat * Math.PI) / 180) || 1e-6;
  return {
    lat: centerLat + dNorthM / M_PER_DEG_LAT,
    lon: centerLon + dEastM / (M_PER_DEG_LAT * cosLat),
  };
}

// ---- roadway breakpoints (schematic layout from Road Inventory) -------------

/**
 * Ordered roadway breakpoints from LT-outer (most negative offset) to RT-outer (most
 * positive), with 0 at the roadway centerline (median center). Canonical UPSTATION:
 * LT on the left (negative), RT on the right (positive). Mirrors the SVG renderer's
 * element order but expressed as signed offsets so the 3D scene + RN renderer agree.
 */
export function roadBreakpointsFt(road: RoadCrossSection): RoadBreakpoint[] {
  const mh = Math.max(0, road.median_width_ft) / 2;
  const bp: RoadBreakpoint[] = [];

  // Center + median edges.
  bp.push({ offsetFt: 0, side: "CENTER", kind: "center", label: "Centerline" });
  if (road.median_width_ft > 0) {
    bp.push({ offsetFt: -mh, side: "LT", kind: "median_edge", label: "LT median edge" });
    bp.push({ offsetFt: mh, side: "RT", kind: "median_edge", label: "RT median edge" });
  }

  // Build one side from the centerline outward; sign applies LT(-)/RT(+).
  const side = (dir: -1 | 1, s: "LT" | "RT") => {
    const laneCount = dir < 0 ? road.lt_lane_count : road.rt_lane_count;
    const laneW = dir < 0 ? road.lt_lane_width_ft : road.rt_lane_width_ft;
    const insideShld = dir < 0 ? road.lt_inside_shoulder_ft : road.rt_inside_shoulder_ft;
    const outsideShld = dir < 0 ? road.lt_outside_shoulder_ft : road.rt_outside_shoulder_ft;

    let x = mh;
    if (insideShld > 0) {
      x += insideShld;
      bp.push({ offsetFt: dir * x, side: s, kind: "inside_shoulder_edge", label: `${s} inside shoulder edge` });
    }
    // Lane dividers (between lanes) + travel-way (outer pavement) edge.
    for (let i = 0; i < Math.max(0, Math.round(laneCount)); i++) {
      x += laneW;
      const isOuter = i === Math.round(laneCount) - 1;
      bp.push({
        offsetFt: dir * x,
        side: s,
        kind: isOuter ? "travelway_edge" : "lane_divider",
        label: isOuter ? `${s} pavement edge` : `${s} lane divider`,
      });
    }
    if (outsideShld > 0) {
      x += outsideShld;
    }
    bp.push({ offsetFt: dir * x, side: s, kind: "outside_shoulder_edge", label: `${s} outside shoulder edge` });
  };
  side(-1, "LT");
  side(1, "RT");

  bp.sort((a, b) => a.offsetFt - b.offsetFt);
  return bp;
}

/** The LT (negative) and RT (positive) outside-shoulder edge offsets, in feet. */
export function outsideShoulderEdgesFt(road: RoadCrossSection): { ltFt: number; rtFt: number } {
  const mh = Math.max(0, road.median_width_ft) / 2;
  const ltFt = -(mh + road.lt_inside_shoulder_ft + road.lt_lane_count * road.lt_lane_width_ft + road.lt_outside_shoulder_ft);
  const rtFt = mh + road.rt_inside_shoulder_ft + road.rt_lane_count * road.rt_lane_width_ft + road.rt_outside_shoulder_ft;
  return { ltFt, rtFt };
}

export const BEYOND_SHOULDER_STAKES_FT = [10, 20, 50] as const;

/** Ground-sample offsets (feet) beyond BOTH outside shoulders: the required 10/20/50 ft
 *  stakes plus dense intermediate points (default every 5 ft to 50 ft) so the terrain
 *  surface reads smoothly. Each carries its side + a label; stakes are flagged. */
export function beyondShoulderOffsetsFt(
  road: RoadCrossSection,
  opts?: { denseStepFt?: number; maxFt?: number },
): { offsetFt: number; side: "LT" | "RT"; label: string; isStake: boolean }[] {
  const step = opts?.denseStepFt ?? 5;
  const maxFt = opts?.maxFt ?? 50;
  const { ltFt, rtFt } = outsideShoulderEdgesFt(road);
  const out: { offsetFt: number; side: "LT" | "RT"; label: string; isStake: boolean }[] = [];
  const stakes = new Set<number>(BEYOND_SHOULDER_STAKES_FT as unknown as number[]);
  const marks = new Set<number>([...(BEYOND_SHOULDER_STAKES_FT as unknown as number[])]);
  for (let d = step; d <= maxFt; d += step) marks.add(d);
  const ordered = Array.from(marks).sort((a, b) => a - b);
  for (const d of ordered) {
    out.push({ offsetFt: ltFt - d, side: "LT", label: `LT +${d} ft`, isStake: stakes.has(d) });
    out.push({ offsetFt: rtFt + d, side: "RT", label: `RT +${d} ft`, isStake: stakes.has(d) });
  }
  return out;
}

/** Full ordered list of offsets to SAMPLE: roadway breakpoints + beyond-shoulder ground
 *  (dense + 10/20/50 stakes), sorted LT→RT, de-duplicated on offset. */
export function sampleOffsetsFt(
  road: RoadCrossSection,
  opts?: { denseStepFt?: number; maxFt?: number },
): { offsetFt: number; side: Side; label: string; kind: "road" | "ground"; isStake: boolean }[] {
  const items: { offsetFt: number; side: Side; label: string; kind: "road" | "ground"; isStake: boolean }[] = [];
  for (const b of roadBreakpointsFt(road)) {
    items.push({ offsetFt: b.offsetFt, side: b.side, label: b.label, kind: "road", isStake: false });
  }
  for (const g of beyondShoulderOffsetsFt(road, opts)) {
    items.push({ offsetFt: g.offsetFt, side: g.side, label: g.label, kind: "ground", isStake: g.isStake });
  }
  items.sort((a, b) => a.offsetFt - b.offsetFt);
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = it.offsetFt.toFixed(4);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- road snapping (nearest polyline projection) ---------------------------

export type LonLat = [number, number];
export type RoadFeature = { kind: string; coords: LonLat[] };
export type ProjectResult = { lat: number; lon: number; tangentBearingDeg: number; distanceM: number; t: number };

/** Local metres-per-degree east at a latitude (equirectangular). */
function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const mLat = (lat1 + lat2) / 2;
  const dN = (lat2 - lat1) * M_PER_DEG_LAT;
  const dE = (lon2 - lon1) * metersPerDegLon(mLat);
  return norm360((Math.atan2(dE, dN) * 180) / Math.PI);
}

/** Project a point onto a polyline; returns the nearest point, the segment tangent
 *  bearing there, and the planar distance in metres. Null for a degenerate polyline. */
export function projectPointToPolyline(lat: number, lon: number, poly: LonLat[]): ProjectResult | null {
  if (!Array.isArray(poly) || poly.length < 2) return null;
  const mPerLon = metersPerDegLon(lat);
  const px = lon * mPerLon;
  const py = lat * M_PER_DEG_LAT;
  let best: ProjectResult | null = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const [aLon, aLat] = poly[i];
    const [bLon, bLat] = poly[i + 1];
    if (![aLon, aLat, bLon, bLat].every(Number.isFinite)) continue;
    const ax = aLon * mPerLon, ay = aLat * M_PER_DEG_LAT;
    const bx = bLon * mPerLon, by = bLat * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const sx = ax + t * dx, sy = ay + t * dy;
    const distM = Math.hypot(px - sx, py - sy);
    if (best === null || distM < best.distanceM) {
      const snapLon = sx / mPerLon, snapLat = sy / M_PER_DEG_LAT;
      best = {
        lat: snapLat,
        lon: snapLon,
        tangentBearingDeg: bearingDeg(aLat, aLon, bLat, bLon),
        distanceM: distM,
        t,
      };
    }
  }
  return best;
}

export type SnapResult = {
  ok: boolean;
  snappedLat: number;
  snappedLon: number;
  tangentBearingDeg: number;
  distanceM: number;
  roadContextKind: string | null; // road_inventory | road_centerline | road_bearing | null
  reason?: string;
};

/**
 * Snap a tapped lat/lon to the nearest packaged road feature within `maxSnapM`.
 * Preference on ties/closeness is by feature order the caller provides (caller should
 * order richest-first: road_inventory / road_centerline before road_bearing). Returns
 * ok=false with a reason when nothing is within range (never a misleading far snap).
 */
export function snapToRoadContext(
  tapLat: number,
  tapLon: number,
  features: RoadFeature[],
  opts?: { maxSnapM?: number },
): SnapResult {
  const maxSnapM = opts?.maxSnapM ?? 60;
  let best: (ProjectResult & { kind: string }) | null = null;
  for (const f of features || []) {
    const pr = projectPointToPolyline(tapLat, tapLon, f.coords);
    if (!pr) continue;
    if (best === null || pr.distanceM < best.distanceM) best = { ...pr, kind: f.kind };
  }
  if (best === null) {
    return { ok: false, snappedLat: tapLat, snappedLon: tapLon, tangentBearingDeg: 0, distanceM: Infinity, roadContextKind: null, reason: "no_road_context" };
  }
  if (best.distanceM > maxSnapM) {
    return { ok: false, snappedLat: tapLat, snappedLon: tapLon, tangentBearingDeg: best.tangentBearingDeg, distanceM: best.distanceM, roadContextKind: best.kind, reason: "too_far" };
  }
  return { ok: true, snappedLat: best.lat, snappedLon: best.lon, tangentBearingDeg: best.tangentBearingDeg, distanceM: best.distanceM, roadContextKind: best.kind };
}

// ---- elevation sampling (mirrors the native grid sampler) -------------------

export type LocalTransform = { origin_lon: number; origin_lat: number; lon_per_col: number; lat_per_row: number };

/** lon/lat → fractional grid (col,row) via the manifest local transform. */
export function latLonToColRow(t: LocalTransform, lat: number, lon: number): { col: number; row: number } {
  return { col: (lon - t.origin_lon) / t.lon_per_col, row: (lat - t.origin_lat) / t.lat_per_row };
}

export type GridSampleResult = { elevationM: number | null; status: SampleStatus };

/**
 * Bilinearly sample a row-major float32 height grid at fractional (col,row). Returns
 * OUT_OF_BOUNDS when outside the grid (nothing invented), NO_DATA when any needed cell
 * is the no-data sentinel / non-finite. The grid is read-only — never mutated.
 */
export function bilinearSampleGrid(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  colF: number,
  rowF: number,
  noData: number,
): GridSampleResult {
  const eps = 1e-6;
  if (!(colF >= -eps && colF <= cols - 1 + eps && rowF >= -eps && rowF <= rows - 1 + eps)) {
    return { elevationM: null, status: "OUT_OF_BOUNDS" };
  }
  const cc = Math.min(Math.max(colF, 0), cols - 1);
  const rr = Math.min(Math.max(rowF, 0), rows - 1);
  const c0 = Math.floor(cc), r0 = Math.floor(rr);
  const c1 = Math.min(c0 + 1, cols - 1), r1 = Math.min(r0 + 1, rows - 1);
  const fc = cc - c0, fr = rr - r0;
  const at = (r: number, c: number) => grid[r * cols + c];
  const e00 = at(r0, c0), e01 = at(r0, c1), e10 = at(r1, c0), e11 = at(r1, c1);
  for (const e of [e00, e01, e10, e11]) {
    if (!Number.isFinite(e) || e === noData) return { elevationM: null, status: "NO_DATA" };
  }
  const top = e00 + (e01 - e00) * fc;
  const bot = e10 + (e11 - e10) * fc;
  return { elevationM: top + (bot - top) * fr, status: "OK" };
}

// ---- slice assembly --------------------------------------------------------

export type Sampler = (lat: number, lon: number) => GridSampleResult;

export type BuildSliceInput = {
  selectedLat: number;
  selectedLon: number;
  snappedLat: number;
  snappedLon: number;
  upstationBearingDeg: number;
  road: RoadCrossSection;
  packageVersion: string;
  snappedToRoadContext: boolean;
  roadContextSource?: string;
  denseStepFt?: number;
};

function mkSample(
  side: Side,
  offsetFt: number,
  centerLat: number,
  centerLon: number,
  crossBearingDeg: number,
  sampler: Sampler,
  label?: string,
): CrossSectionSample {
  const { lat, lon } = offsetToLatLon(centerLat, centerLon, crossBearingDeg, offsetFt);
  const r = sampler(lat, lon);
  return {
    side,
    offsetFt,
    lat,
    lon,
    elevationM: r.elevationM,
    elevationFt: r.elevationM == null ? null : mToFt(r.elevationM),
    source: ELEVATION_SOURCE,
    status: r.status,
    label,
  };
}

/** Assemble a full RoadCrossSectionSlice: sample every offset via `sampler` (which the
 *  native code backs with the offline grid; tests back it with a fake), and resolve the
 *  10/20/50 ft key markers on both sides. */
export function buildCrossSectionSlice(input: BuildSliceInput, sampler: Sampler): RoadCrossSectionSlice {
  const crossBearingDeg = crossSectionBearingDeg(input.upstationBearingDeg);
  const offsets = sampleOffsetsFt(input.road, { denseStepFt: input.denseStepFt });
  const samples = offsets.map((o) =>
    mkSample(o.side, o.offsetFt, input.snappedLat, input.snappedLon, crossBearingDeg, sampler, o.label),
  );

  const { ltFt, rtFt } = outsideShoulderEdgesFt(input.road);
  const marker = (side: Side, offsetFt: number, label: string): CrossSectionSample =>
    mkSample(side, offsetFt, input.snappedLat, input.snappedLon, crossBearingDeg, sampler, label);

  const keyMarkers = {
    ltOutsideShoulderEdge: marker("LT", ltFt, "LT outside shoulder edge"),
    rtOutsideShoulderEdge: marker("RT", rtFt, "RT outside shoulder edge"),
    lt10ft: marker("LT", ltFt - 10, "LT +10 ft"),
    lt20ft: marker("LT", ltFt - 20, "LT +20 ft"),
    lt50ft: marker("LT", ltFt - 50, "LT +50 ft"),
    rt10ft: marker("RT", rtFt + 10, "RT +10 ft"),
    rt20ft: marker("RT", rtFt + 20, "RT +20 ft"),
    rt50ft: marker("RT", rtFt + 50, "RT +50 ft"),
  };

  return {
    selectedLat: input.selectedLat,
    selectedLon: input.selectedLon,
    snappedLat: input.snappedLat,
    snappedLon: input.snappedLon,
    upstationBearingDeg: norm360(input.upstationBearingDeg),
    crossSectionBearingDeg: crossBearingDeg,
    road: input.road,
    elevationSource: ELEVATION_SOURCE,
    samples,
    keyMarkers,
    provenance: {
      roadLayoutSource: input.road.source,
      elevationSource: "USGS 3DEP source-derived offline terrain grid",
      packageVersion: input.packageVersion,
      snappedToRoadContext: input.snappedToRoadContext,
      roadContextSource: input.roadContextSource,
    },
  };
}

/** Elevation delta (feet) of a sample relative to an outside-shoulder-edge reference,
 *  or null when either is unavailable (honest — never fabricated). */
export function elevationDeltaFt(sample: CrossSectionSample | null, reference: CrossSectionSample | null): number | null {
  if (!sample || !reference || sample.elevationFt == null || reference.elevationFt == null) return null;
  return sample.elevationFt - reference.elevationFt;
}
