// Pure, physically-derived terrain scale math for the native SceneKit renderer.
// This is the TESTED reference implementation that ErisTerrainSceneViewController.m
// mirrors in Objective-C (computePhysicalScale / buildTerrainNode) — keep in sync.
//
// The old renderer normalized terrain into a fixed visual box (worldSize * 0.35 /
// relief), so "1x" was meaningless. Here 1.0x is a PHYSICAL true-scale baseline:
// the vertical scene-units-per-meter equals the horizontal scene-units-per-meter
// derived from the package footprint, so a metre of elevation looks like a metre of
// ground. Vertical exaggeration is a pure display multiplier applied on top; the
// source-derived elevation grid (metres) is never modified.
//
// No react-native/expo imports (unit-tested under node --test).

import type { TerrainMeta } from "./eristerrainBundle";

const M_PER_DEG_LAT = 111_320.0;

export type Footprint = { widthM: number; heightM: number };
export type SceneScale = {
  sceneUnitsPerMeter: number; // horizontal AND (at 1.0x) vertical scene units per metre
  halfWidthUnits: number; // mesh half-extent on X (east/west), scene units
  halfDepthUnits: number; // mesh half-extent on Z (north/south), scene units
  widthM: number;
  heightM: number;
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Physical footprint (metres) of the packaged area. Prefers local_transform (origin
 * = NW corner; span = per-step × (n−1)); falls back to bounds. Longitude distance is
 * adjusted by cos(mid-lat). Returns null on degenerate/malformed metadata (caller
 * must fail safe, never crash).
 */
export function physicalFootprintMeters(
  meta: Pick<TerrainMeta, "rows" | "columns" | "bounds" | "local_transform"> | null | undefined,
): Footprint | null {
  if (!meta) return null;
  const rows = Number(meta.rows);
  const cols = Number(meta.columns);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) return null;

  let minLat: number, minLon: number, maxLat: number, maxLon: number;
  const lt = meta.local_transform;
  if (
    lt &&
    isFiniteNum(lt.origin_lon) &&
    isFiniteNum(lt.origin_lat) &&
    isFiniteNum(lt.lon_per_col) &&
    isFiniteNum(lt.lat_per_row) &&
    lt.lon_per_col > 0 &&
    lt.lat_per_row < 0
  ) {
    // origin is the NW corner: columns step east (+lon), rows step south (−lat).
    minLon = lt.origin_lon;
    maxLon = lt.origin_lon + lt.lon_per_col * (cols - 1);
    maxLat = lt.origin_lat;
    minLat = lt.origin_lat + lt.lat_per_row * (rows - 1);
  } else {
    const b = meta.bounds;
    if (
      !b ||
      !isFiniteNum(b.min_lat) ||
      !isFiniteNum(b.min_lon) ||
      !isFiniteNum(b.max_lat) ||
      !isFiniteNum(b.max_lon) ||
      b.max_lat <= b.min_lat ||
      b.max_lon <= b.min_lon
    ) {
      return null;
    }
    minLat = b.min_lat;
    minLon = b.min_lon;
    maxLat = b.max_lat;
    maxLon = b.max_lon;
  }

  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180) || 1e-6;
  const widthM = (maxLon - minLon) * M_PER_DEG_LAT * Math.abs(cosLat);
  const heightM = (maxLat - minLat) * M_PER_DEG_LAT;
  if (!(widthM > 0) || !(heightM > 0)) return null;
  return { widthM, heightM };
}

/**
 * Scene scale for a package: the larger horizontal dimension fills 2·worldSize scene
 * units; the smaller keeps the true aspect ratio (never forced square). The returned
 * sceneUnitsPerMeter is the true-scale (1.0x) vertical factor too. Null on degenerate
 * metadata.
 */
export function sceneScale(
  meta: Pick<TerrainMeta, "rows" | "columns" | "bounds" | "local_transform"> | null | undefined,
  worldSize: number,
): SceneScale | null {
  const fp = physicalFootprintMeters(meta);
  if (!fp || !(worldSize > 0)) return null;
  const maxDim = Math.max(fp.widthM, fp.heightM);
  const sceneUnitsPerMeter = (2 * worldSize) / maxDim;
  return {
    sceneUnitsPerMeter,
    halfWidthUnits: (fp.widthM * sceneUnitsPerMeter) / 2,
    halfDepthUnits: (fp.heightM * sceneUnitsPerMeter) / 2,
    widthM: fp.widthM,
    heightM: fp.heightM,
  };
}

// --- Draped-overlay physical lifts (metres above the mesh) -------------------
// Mirrors the ErisDrapeLayer table + sceneUnitsForMeters:/drapeLiftForLayer: in
// ErisTerrainSceneViewController.m. Each overlay hugs the imagery a few decimetres up —
// NOT the tens of metres the old worldSize-percentage lifts produced. The old road lift
// `worldSize * 0.018` on a ~3 km AOI put roads ~27 m above the imagery, and perspective
// parallax then made correctly located centrelines look horizontally displaced. Keep in
// sync with the kEris*DrapeLiftM constants.
export const DRAPE_LIFTS_M = {
  imagery: 0.05,
  road: 0.3,
  submitted: 0.35,
  boundary: 0.4,
  selectedRoad: 0.55,
  sliceIndicator: 0.65,
} as const;
export type DrapeLayer = keyof typeof DRAPE_LIFTS_M;

// The old (buggy) worldSize-percentage lift factors, kept ONLY so tests can prove the
// new metre-derived lifts are far smaller (a regression guard, not production code).
export const LEGACY_ROAD_LIFT_WORLDSIZE_FACTOR = 0.018;
export const INCIDENT_RING_DIAMETER_M = 10.0; // ground ring (8–12 m), not the old 75 m sphere

/** Scene-unit drape lift for a layer: metres × sceneUnitsPerMeter (metre-derived). */
export function drapeLiftSceneUnits(scale: Pick<SceneScale, "sceneUnitsPerMeter">, layer: DrapeLayer): number {
  return DRAPE_LIFTS_M[layer] * scale.sceneUnitsPerMeter;
}

/** Physical metres a scene-unit height represents (inverse of sceneUnitsForMeters:). */
export function sceneUnitsToMeters(scale: Pick<SceneScale, "sceneUnitsPerMeter">, sceneUnits: number): number {
  return scale.sceneUnitsPerMeter > 0 ? sceneUnits / scale.sceneUnitsPerMeter : NaN;
}

/**
 * Mesh Y (scene units) for an elevation, at a given exaggeration:
 *   sceneY = (elevationMeters − minElevationMeters) × sceneUnitsPerMeter × exaggeration
 * At 1.0x this is approximately true scale; the elevation metres are unchanged.
 */
export function elevationToSceneY(
  elevationMeters: number,
  minElevationMeters: number,
  sceneUnitsPerMeter: number,
  exaggeration: number,
): number {
  return (elevationMeters - minElevationMeters) * sceneUnitsPerMeter * exaggeration;
}

// Vertical-exaggeration slider policy (shared with the native slider).
export const VERT_EXAG_MIN = 0.5;
export const VERT_EXAG_MAX = 3.0;
export const VERT_EXAG_STEP = 0.1;
export const VERT_EXAG_DEFAULT = 1.0;

/** Snap a raw slider value to the 0.1 increment and clamp to [0.5, 3.0]. */
export function snapExaggeration(value: number): number {
  if (!Number.isFinite(value)) return VERT_EXAG_DEFAULT;
  const clamped = Math.max(VERT_EXAG_MIN, Math.min(VERT_EXAG_MAX, value));
  return Math.round(clamped / VERT_EXAG_STEP) * VERT_EXAG_STEP;
}

/** Human label for an exaggeration value (matches the native slider copy). */
export function exaggerationLabel(value: number): string {
  const x = snapExaggeration(value);
  const tag =
    x <= 0.6 ? "Flattened" : x < 1.0 ? "Reduced relief" : x === 1.0 ? "True scale" : x <= 1.5 ? "Field relief" : x <= 2.0 ? "Enhanced relief" : "High relief";
  return `${x.toFixed(1)}× ${tag}`;
}
