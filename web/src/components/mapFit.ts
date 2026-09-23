/**
 * Where a map should look: one extent that shows every point comfortably.
 *
 * ArcGIS's shortcuts do not give that. `view.goTo(point)` — or `goTo` of
 * several graphics at the same spot — only re-centres at the current zoom, so a
 * one-report Incident Group stayed at state level. `goTo(graphics)` fits them edge
 * to edge, under the map's own buttons. And a GraphicsLayer's `fullExtent` is
 * the whole world (Layer's default, never recomputed from its graphics), so
 * fitting to it zoomed a submission's map out to the five continents.
 *
 * These helpers compute the extent from the positions themselves: padded on
 * every side, and never tighter than a minimum span, so a single pin opens on
 * its surroundings instead of the pavement. Dependency-free: `node --test` runs
 * this file directly.
 */

export type LonLat = { longitude: number; latitude: number };
export type LonLatExtent = { xmin: number; ymin: number; xmax: number; ymax: number };

const METRES_PER_DEGREE_LAT = 111_320;
const WEB_MERCATOR_RADIUS_M = 6_378_137;

function isValid(point: LonLat): boolean {
  return Number.isFinite(point.longitude)
    && Number.isFinite(point.latitude)
    && Math.abs(point.longitude) <= 180
    && Math.abs(point.latitude) <= 90;
}

/** A GeoJSON position as lon/lat; Web Mercator metres (|x| > 180 or |y| > 90) are converted. */
function positionToLonLat(x: number, y: number): LonLat {
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return { longitude: x, latitude: y };
  return {
    longitude: (x / WEB_MERCATOR_RADIUS_M) * (180 / Math.PI),
    latitude: (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI),
  };
}

/** Every position in a coordinate array, however deeply nested (rings, paths, parts). */
export function coordinatePositions(value: unknown): LonLat[] {
  if (!Array.isArray(value)) return [];
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [positionToLonLat(value[0], value[1])];
  }
  return value.flatMap((item) => coordinatePositions(item));
}

/** Every position in a GeoJSON geometry, including each member of a GeometryCollection. */
export function geoJsonPositions(geometry: unknown): LonLat[] {
  if (!geometry || typeof geometry !== "object") return [];
  const record = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (String(record.type ?? "") === "GeometryCollection" && Array.isArray(record.geometries)) {
    return record.geometries.flatMap((member) => geoJsonPositions(member));
  }
  return coordinatePositions(record.coordinates);
}

export type FitOptions = {
  /** The narrowest the view may be, in metres, both across and top to bottom. */
  minSpanM?: number;
  /** Space added on each side, as a share of the points' own span. */
  padding?: number;
};

/**
 * The extent that shows every point with room around it, or null when there is
 * nothing to show. Invalid positions are ignored rather than stretching the view.
 */
export function comfortableExtent(points: LonLat[], { minSpanM = 300, padding = 0.25 }: FitOptions = {}): LonLatExtent | null {
  const valid = points.filter(isValid);
  if (valid.length === 0) return null;

  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const point of valid) {
    xmin = Math.min(xmin, point.longitude);
    xmax = Math.max(xmax, point.longitude);
    ymin = Math.min(ymin, point.latitude);
    ymax = Math.max(ymax, point.latitude);
  }

  const centreX = (xmin + xmax) / 2;
  const centreY = (ymin + ymax) / 2;
  const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.max(0.05, Math.cos((centreY * Math.PI) / 180));
  const width = Math.max((xmax - xmin) * (1 + 2 * padding), minSpanM / metresPerDegreeLon);
  const height = Math.max((ymax - ymin) * (1 + 2 * padding), minSpanM / METRES_PER_DEGREE_LAT);

  return {
    xmin: centreX - width / 2,
    xmax: centreX + width / 2,
    ymin: Math.max(-90, centreY - height / 2),
    ymax: Math.min(90, centreY + height / 2),
  };
}
