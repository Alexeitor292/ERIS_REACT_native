export type CrossSectionControlPoint = {
  longitude: number;
  latitude: number;
};

export type CrossSectionSample = {
  index: number;
  distance_m: number;
  longitude: number;
  latitude: number;
  elevation_m: number;
  grade_percent: number | null;
};

export type CrossSectionStats = {
  total_distance_m: number;
  min_elevation_m: number;
  max_elevation_m: number;
  elevation_range_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  sample_count: number;
};

export type DemResolutionMode = "best-available" | "auto" | "target-1m" | "target-3m" | "target-10m";

export type CrossSectionDemMetadata = {
  source: "ARCGIS_WORLD_ELEVATION";
  requested_mode: DemResolutionMode;
  requested_resolution_m: number | null;
  actual_min_resolution_m: number | null;
  actual_max_resolution_m: number | null;
  resolution_sample_count: number;
  mixed_resolution: boolean;
};

export type CrossSectionProfile = {
  samples: CrossSectionSample[];
  stats: CrossSectionStats;
  dem?: CrossSectionDemMetadata;
};

const EARTH_RADIUS_M = 6_371_008.8;

function radians(value: number) {
  return value * Math.PI / 180;
}

export function distanceMeters(
  a: Pick<CrossSectionControlPoint, "longitude" | "latitude">,
  b: Pick<CrossSectionControlPoint, "longitude" | "latitude">,
): number {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function controlPointDistances(points: CrossSectionControlPoint[]): number[] {
  if (points.length === 0) return [];
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + distanceMeters(points[index - 1], points[index]));
  }
  return distances;
}

export function pathLengthMeters(points: CrossSectionControlPoint[]): number {
  const distances = controlPointDistances(points);
  return distances.length ? distances[distances.length - 1] : 0;
}

export function adaptiveSampleSpacingMeters(
  totalDistanceM: number,
  options: { preferredSpacingM?: number; maxSamples?: number } = {},
): number {
  const preferred = Math.max(1, Number(options.preferredSpacingM ?? 10));
  const maxSamples = Math.max(100, Math.floor(options.maxSamples ?? 1800));
  if (!Number.isFinite(totalDistanceM) || totalDistanceM <= 0) return preferred;

  // There is intentionally no cross-section distance cap. For very long paths,
  // increase the DEM sampling interval instead of rejecting the analysis.
  const required = totalDistanceM / Math.max(1, maxSamples - 1);
  const raw = Math.max(preferred, required);
  if (raw <= 10) return Math.ceil(raw);
  if (raw <= 100) return Math.ceil(raw / 5) * 5;
  if (raw <= 1000) return Math.ceil(raw / 25) * 25;
  return Math.ceil(raw / 100) * 100;
}

export function demResolutionQueryValue(mode: DemResolutionMode): "finest-contiguous" | "auto" | number {
  switch (mode) {
    case "best-available":
      return "finest-contiguous";
    case "target-1m":
      return 1;
    case "target-3m":
      return 3;
    case "target-10m":
      return 10;
    case "auto":
    default:
      return "auto";
  }
}

export function demResolutionModeLabel(mode: DemResolutionMode): string {
  switch (mode) {
    case "best-available":
      return "Best available";
    case "target-1m":
      return "Target 1 m";
    case "target-3m":
      return "Target 3 m";
    case "target-10m":
      return "Target 10 m";
    case "auto":
    default:
      return "Automatic";
  }
}

export function requestedDemResolutionMeters(mode: DemResolutionMode): number | null {
  const value = demResolutionQueryValue(mode);
  return typeof value === "number" ? value : null;
}

export function summarizeDemResolution(
  sampleInfo: Array<{ demResolution?: number | null }> | null | undefined,
  mode: DemResolutionMode,
): CrossSectionDemMetadata {
  const resolutions = (sampleInfo ?? [])
    .map((sample) => Number(sample?.demResolution))
    .filter((value) => Number.isFinite(value) && value > 0);
  const min = resolutions.length ? Math.min(...resolutions) : null;
  const max = resolutions.length ? Math.max(...resolutions) : null;
  const mixed = min != null && max != null && Math.abs(max - min) > 0.01;

  return {
    source: "ARCGIS_WORLD_ELEVATION",
    requested_mode: mode,
    requested_resolution_m: requestedDemResolutionMeters(mode),
    actual_min_resolution_m: min,
    actual_max_resolution_m: max,
    resolution_sample_count: resolutions.length,
    mixed_resolution: mixed,
  };
}

export function formatDemResolution(metadata: CrossSectionDemMetadata | null | undefined): string {
  if (!metadata || metadata.actual_min_resolution_m == null || metadata.actual_max_resolution_m == null) return "Unavailable";
  const format = (value: number) => value < 10 ? `${value.toFixed(2)} m` : `${value.toFixed(1)} m`;
  if (!metadata.mixed_resolution) return format(metadata.actual_min_resolution_m);
  return `${format(metadata.actual_min_resolution_m)}–${format(metadata.actual_max_resolution_m)}`;
}

export function profileFromPath(
  path: number[][],
  noDataValue?: number | null,
  dem?: CrossSectionDemMetadata,
): CrossSectionProfile | null {
  if (!Array.isArray(path) || path.length < 2) return null;

  const valid = path
    .map((point) => ({
      longitude: Number(point?.[0]),
      latitude: Number(point?.[1]),
      elevation_m: Number(point?.[2]),
    }))
    .filter((point) => (
      Number.isFinite(point.longitude)
      && Number.isFinite(point.latitude)
      && Number.isFinite(point.elevation_m)
      && (noDataValue == null || point.elevation_m !== noDataValue)
    ));

  if (valid.length < 2) return null;

  const samples: CrossSectionSample[] = [];
  let distance = 0;
  let gain = 0;
  let loss = 0;

  for (let index = 0; index < valid.length; index += 1) {
    const current = valid[index];
    let grade: number | null = null;
    if (index > 0) {
      const previous = valid[index - 1];
      const horizontal = distanceMeters(previous, current);
      distance += horizontal;
      const delta = current.elevation_m - previous.elevation_m;
      if (delta > 0) gain += delta;
      if (delta < 0) loss += Math.abs(delta);
      grade = horizontal > 0 ? delta / horizontal * 100 : null;
    }
    samples.push({
      index,
      distance_m: distance,
      longitude: current.longitude,
      latitude: current.latitude,
      elevation_m: current.elevation_m,
      grade_percent: grade,
    });
  }

  const elevations = samples.map((sample) => sample.elevation_m);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);

  return {
    samples,
    stats: {
      total_distance_m: distance,
      min_elevation_m: min,
      max_elevation_m: max,
      elevation_range_m: max - min,
      elevation_gain_m: gain,
      elevation_loss_m: loss,
      sample_count: samples.length,
    },
    ...(dem ? { dem } : {}),
  };
}

export function feetFromMeters(value: number): number {
  return value * 3.280839895;
}

export function milesFromMeters(value: number): number {
  return value / 1609.344;
}

export function formatHorizontalDistance(valueM: number, metric: boolean): string {
  if (metric) {
    return valueM >= 1000 ? `${(valueM / 1000).toFixed(2)} km` : `${Math.round(valueM)} m`;
  }
  const feet = feetFromMeters(valueM);
  return valueM >= 1609.344 ? `${milesFromMeters(valueM).toFixed(2)} mi` : `${Math.round(feet).toLocaleString()} ft`;
}

export function formatElevation(valueM: number, metric: boolean): string {
  return metric ? `${valueM.toFixed(1)} m` : `${feetFromMeters(valueM).toFixed(1)} ft`;
}
