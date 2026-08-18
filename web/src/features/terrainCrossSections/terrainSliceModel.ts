import type { CrossSectionProfile, CrossSectionSample } from "./terrainCrossSectionModel";

const EARTH_RADIUS_M = 6_371_008.8;

export type TerrainSliceGridPoint = {
  longitude: number;
  latitude: number;
  elevation_m?: number;
};

export type TerrainSliceSamplingGrid = {
  rows: number;
  columns: number;
  width_m: number;
  points: TerrainSliceGridPoint[];
  footprint_ring: Array<[number, number]>;
};

export type TerrainSliceData = {
  rows: number;
  columns: number;
  width_m: number;
  points: Array<Required<TerrainSliceGridPoint>>;
  footprint_ring: Array<[number, number]>;
  min_elevation_m: number;
  max_elevation_m: number;
  elevation_range_m: number;
  base_elevation_m: number;
};

function radians(value: number) {
  return value * Math.PI / 180;
}

function degrees(value: number) {
  return value * 180 / Math.PI;
}

function normalizeBearing(value: number) {
  return (value % 360 + 360) % 360;
}

function initialBearingDegrees(a: Pick<CrossSectionSample, "longitude" | "latitude">, b: Pick<CrossSectionSample, "longitude" | "latitude">) {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeBearing(degrees(Math.atan2(y, x)));
}

function destinationPoint(
  origin: Pick<CrossSectionSample, "longitude" | "latitude">,
  bearingDeg: number,
  distanceM: number,
): TerrainSliceGridPoint {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = radians(bearingDeg);
  const lat1 = radians(origin.latitude);
  const lon1 = radians(origin.longitude);

  const sinLat2 = Math.sin(lat1) * Math.cos(angular)
    + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );

  return {
    longitude: ((degrees(lon2) + 540) % 360) - 180,
    latitude: degrees(lat2),
  };
}

function sampledAlongIndices(profile: CrossSectionProfile, maxAlongSamples: number): number[] {
  const samples = profile.samples;
  if (samples.length <= maxAlongSamples) return samples.map((_, index) => index);

  let minIndex = 0;
  let maxIndex = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].elevation_m < samples[minIndex].elevation_m) minIndex = index;
    if (samples[index].elevation_m > samples[maxIndex].elevation_m) maxIndex = index;
  }

  const indices = new Set<number>([0, samples.length - 1, minIndex, maxIndex]);
  const target = Math.max(4, maxAlongSamples);
  for (let i = 0; i < target; i += 1) {
    indices.add(Math.round(i * (samples.length - 1) / Math.max(1, target - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

function tangentBearing(profile: CrossSectionProfile, sampleIndex: number): number {
  const samples = profile.samples;
  const previous = samples[Math.max(0, sampleIndex - 1)];
  const next = samples[Math.min(samples.length - 1, sampleIndex + 1)];
  if (previous === next) return 0;
  return initialBearingDegrees(previous, next);
}

export function buildTerrainSliceSamplingGrid(
  profile: CrossSectionProfile,
  widthM: number,
  options: { maxAlongSamples?: number; crossColumns?: number } = {},
): TerrainSliceSamplingGrid {
  const boundedWidth = Math.max(5, Math.min(2000, Number(widthM) || 100));
  const maxAlongSamples = Math.max(12, Math.floor(options.maxAlongSamples ?? 140));
  let columns = Math.max(3, Math.floor(options.crossColumns ?? 9));
  if (columns % 2 === 0) columns += 1;

  const alongIndices = sampledAlongIndices(profile, maxAlongSamples);
  const halfWidth = boundedWidth / 2;
  const offsets = Array.from({ length: columns }, (_, index) => (
    -halfWidth + boundedWidth * index / Math.max(1, columns - 1)
  ));

  const points: TerrainSliceGridPoint[] = [];
  const rows: TerrainSliceGridPoint[][] = [];

  for (const sampleIndex of alongIndices) {
    const sample = profile.samples[sampleIndex];
    const bearing = tangentBearing(profile, sampleIndex);
    const crossBearing = normalizeBearing(bearing + 90);
    const row = offsets.map((offset) => destinationPoint(sample, crossBearing, offset));
    rows.push(row);
    points.push(...row);
  }

  const leftEdge = rows.map((row) => row[0]);
  const rightEdge = rows.map((row) => row[row.length - 1]).reverse();
  const footprint = [...leftEdge, ...rightEdge].map((point) => [point.longitude, point.latitude] as [number, number]);
  if (footprint.length) footprint.push(footprint[0]);

  return {
    rows: rows.length,
    columns,
    width_m: boundedWidth,
    points,
    footprint_ring: footprint,
  };
}

export function terrainSliceFromSampledPoints(
  grid: TerrainSliceSamplingGrid,
  sampledPoints: number[][],
  noDataValue?: number | null,
): TerrainSliceData {
  if (sampledPoints.length !== grid.points.length) {
    throw new Error("ArcGIS returned an unexpected terrain slice sample count.");
  }

  const points = sampledPoints.map((point, index) => {
    const longitude = Number(point?.[0]);
    const latitude = Number(point?.[1]);
    const elevation = Number(point?.[2]);
    if (
      !Number.isFinite(longitude)
      || !Number.isFinite(latitude)
      || !Number.isFinite(elevation)
      || (noDataValue != null && elevation === noDataValue)
    ) {
      throw new Error("Terrain elevation is unavailable inside the selected slice width. Try a narrower slice.");
    }
    return {
      longitude,
      latitude,
      elevation_m: elevation,
      source_index: index,
    };
  });

  const elevations = points.map((point) => point.elevation_m);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const range = Math.max(0, max - min);
  const cutDepth = Math.max(25, range * 0.4);

  return {
    rows: grid.rows,
    columns: grid.columns,
    width_m: grid.width_m,
    points: points.map(({ longitude, latitude, elevation_m }) => ({ longitude, latitude, elevation_m })),
    footprint_ring: grid.footprint_ring,
    min_elevation_m: min,
    max_elevation_m: max,
    elevation_range_m: range,
    base_elevation_m: min - cutDepth,
  };
}
