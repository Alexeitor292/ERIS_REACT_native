// Pure overlay geometry normalization + terrain-mesh coordinate mapping for the
// native 'eristerrain' renderer. This is the TESTED reference implementation that
// ErisTerrainSceneViewController.m mirrors in Objective-C: keep the two in sync.
//
// Responsibilities:
//   * Normalize the uploaded incident geometry — GeoJSON geometry / Feature /
//     FeatureCollection / GeometryCollection, and Esri JSON (x/y, points, paths,
//     rings) — into flat lon/lat primitives, converting Web Mercator when coords
//     are clearly projected. No coordinates are invented.
//   * Map lon/lat -> grid (col,row) via the manifest local_transform, and grid
//     (col,row) -> the SceneKit mesh's local XZ (matching the native mesh layout).
//   * Clip geometry to the packaged grid bounds by dropping out-of-bounds vertices.
//   * Build a sample-extent rectangle ring.
//
// No react-native/expo imports, so it unit-tests under `node --test`.

import type { TerrainMeta } from "./eristerrainBundle";

export type LonLat = [number, number];
export type OverlayKind = "point" | "line" | "polygon";
export type OverlayPrimitive = { kind: OverlayKind; coords: LonLat[] };
export type MeshXZ = { x: number; z: number };

const WEB_MERCATOR_MAX = 20037508.34;

function webMercatorToLonLat(x: number, y: number): LonLat {
  const lon = (x / WEB_MERCATOR_MAX) * 180;
  let lat = (y / WEB_MERCATOR_MAX) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lon, lat];
}

/**
 * Coerce a raw [x,y(,...)] coordinate to [lon,lat]. Converts Web Mercator when the
 * values are clearly projected (|x|>180 or |y|>90) — this is a measurement, not an
 * invented coordinate. Returns null when not a finite numeric pair.
 */
export function toLonLat(c: unknown): LonLat | null {
  if (!Array.isArray(c) || c.length < 2) return null;
  const x = Number(c[0]);
  const y = Number(c[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 180 || Math.abs(y) > 90) return webMercatorToLonLat(x, y);
  return [x, y];
}

function toLonLatList(arr: unknown): LonLat[] {
  if (!Array.isArray(arr)) return [];
  const out: LonLat[] = [];
  for (const c of arr) {
    const ll = toLonLat(c);
    if (ll) out.push(ll);
  }
  return out;
}

/**
 * Normalize GeoJSON or Esri JSON geometry into flat overlay primitives (lon/lat).
 * Supports GeoJSON Point / MultiPoint / LineString / MultiLineString / Polygon /
 * MultiPolygon, Feature, FeatureCollection, GeometryCollection; and Esri x/y,
 * points, paths, rings. Unknown shapes yield an empty list (nothing invented).
 */
export function normalizeOverlayGeometry(geom: unknown): OverlayPrimitive[] {
  if (!geom || typeof geom !== "object") return [];
  const g = geom as Record<string, unknown>;
  const type = typeof g.type === "string" ? g.type : null;
  const out: OverlayPrimitive[] = [];

  if (type === "FeatureCollection") {
    const feats = Array.isArray(g.features) ? g.features : [];
    for (const f of feats) out.push(...normalizeOverlayGeometry(f));
    return out;
  }
  if (type === "Feature") return normalizeOverlayGeometry(g.geometry);
  if (type === "GeometryCollection") {
    const geoms = Array.isArray(g.geometries) ? g.geometries : [];
    for (const gg of geoms) out.push(...normalizeOverlayGeometry(gg));
    return out;
  }
  if (type) {
    const coords = g.coordinates;
    const list = Array.isArray(coords) ? coords : [];
    switch (type) {
      case "Point": {
        const p = toLonLat(coords);
        if (p) out.push({ kind: "point", coords: [p] });
        break;
      }
      case "MultiPoint":
        for (const c of list) {
          const p = toLonLat(c);
          if (p) out.push({ kind: "point", coords: [p] });
        }
        break;
      case "LineString": {
        const l = toLonLatList(coords);
        if (l.length) out.push({ kind: "line", coords: l });
        break;
      }
      case "MultiLineString":
        for (const ln of list) {
          const l = toLonLatList(ln);
          if (l.length) out.push({ kind: "line", coords: l });
        }
        break;
      case "Polygon":
        for (const ring of list) {
          const r = toLonLatList(ring);
          if (r.length) out.push({ kind: "polygon", coords: r });
        }
        break;
      case "MultiPolygon":
        for (const poly of list) {
          for (const ring of Array.isArray(poly) ? poly : []) {
            const r = toLonLatList(ring);
            if (r.length) out.push({ kind: "polygon", coords: r });
          }
        }
        break;
    }
    return out;
  }

  // Esri JSON geometry.
  if (typeof g.x === "number" && typeof g.y === "number") {
    const p = toLonLat([g.x, g.y]);
    if (p) out.push({ kind: "point", coords: [p] });
  } else if (Array.isArray(g.points)) {
    for (const c of g.points) {
      const p = toLonLat(c);
      if (p) out.push({ kind: "point", coords: [p] });
    }
  } else if (Array.isArray(g.paths)) {
    for (const path of g.paths) {
      const l = toLonLatList(path);
      if (l.length) out.push({ kind: "line", coords: l });
    }
  } else if (Array.isArray(g.rings)) {
    for (const ring of g.rings) {
      const r = toLonLatList(ring);
      if (r.length) out.push({ kind: "polygon", coords: r });
    }
  }
  return out;
}

/** lon/lat -> fractional grid (col,row) via the manifest local transform. */
export function lonLatToColRow(t: TerrainMeta, lon: number, lat: number): { col: number; row: number } {
  const lt = t.local_transform;
  return { col: (lon - lt.origin_lon) / lt.lon_per_col, row: (lat - lt.origin_lat) / lt.lat_per_row };
}

/**
 * grid (col,row) -> SceneKit mesh local XZ. Matches the native mesh: X = east
 * (col), Z = south (row), the mesh spanning [-worldSize, +worldSize] on each axis.
 */
export function colRowToMeshXZ(rows: number, cols: number, col: number, row: number, worldSize: number): MeshXZ {
  return {
    x: (col / (cols - 1) - 0.5) * (2 * worldSize),
    z: (row / (rows - 1) - 0.5) * (2 * worldSize),
  };
}

/** lon/lat -> SceneKit mesh local XZ (compose transform + mesh layout). */
export function lonLatToMeshXZ(t: TerrainMeta, lon: number, lat: number, worldSize: number): MeshXZ {
  const { col, row } = lonLatToColRow(t, lon, lat);
  return colRowToMeshXZ(t.rows, t.columns, col, row, worldSize);
}

/** Whether a lon/lat falls within the packaged grid (inclusive, small epsilon). */
export function isLonLatInBounds(t: TerrainMeta, lon: number, lat: number, eps = 1e-9): boolean {
  const { col, row } = lonLatToColRow(t, lon, lat);
  return col >= -eps && col <= t.columns - 1 + eps && row >= -eps && row <= t.rows - 1 + eps;
}

/** Drop vertices outside the packaged bounds (no invented/interpolated coordinates). */
export function clipToBounds(t: TerrainMeta, coords: LonLat[]): LonLat[] {
  return coords.filter(([lon, lat]) => isLonLatInBounds(t, lon, lat));
}

/** Closed rectangle ring (lon/lat) for a sample extent. */
export function sampleExtentRing(e: {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}): LonLat[] {
  return [
    [e.minLon, e.minLat],
    [e.maxLon, e.minLat],
    [e.maxLon, e.maxLat],
    [e.minLon, e.maxLat],
    [e.minLon, e.minLat],
  ];
}
