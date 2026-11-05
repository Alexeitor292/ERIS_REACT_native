// What USGS 3DEP has where: the map's coverage colours (DemResolutionCoverageLayer.ts), and the
// heights along a path with the source under each (readUsgsPoints). Dependency-free, for node --test.

export type DemCoverageClassId = "1m" | "3m" | "10m" | "30m";

export type DemCoverageClass = {
  id: DemCoverageClassId;
  label: string;
  cssColor: string;
  rgb: readonly [number, number, number];
  /** The layer in USGS's 3DEP Elevation Index, and the name it must have there. */
  layerId: number;
  layerName: string;
};

export type DemCoverageDatasetSummary = {
  pixel_size_m: number;
  source: string | null;
  product_name: string | null;
  dataset_id: string | null;
  sample_count: number;
};

export type DemCoverageProfileSummary = {
  min_pixel_size_m: number | null;
  max_pixel_size_m: number | null;
  covered_sample_count: number;
  total_sample_count: number;
  mixed_resolution: boolean;
  datasets: DemCoverageDatasetSummary[];
};

// Finest first.
export const DEM_COVERAGE_CLASSES: readonly DemCoverageClass[] = [
  { id: "1m", label: "1 m lidar", cssColor: "#22c55e", rgb: [34, 197, 94], layerId: 1, layerName: "1 meter" },
  { id: "3m", label: "About 3 m", cssColor: "#14b8a6", rgb: [20, 184, 166], layerId: 2, layerName: "1/9 arc-second" },
  { id: "10m", label: "About 10 m", cssColor: "#f59e0b", rgb: [245, 158, 11], layerId: 4, layerName: "1/3 arc-second" },
  { id: "30m", label: "About 30 m", cssColor: "#ef4444", rgb: [239, 68, 68], layerId: 5, layerName: "1 arc-second" },
];

/** Whether USGS's catalog still names each layer as this file expects. */
export function demCoverageLayersMatch(service: { layers?: Array<{ id: number; name: string }> } | null | undefined): boolean {
  return DEM_COVERAGE_CLASSES.every(({ layerId, layerName }) => service?.layers?.some((layer) => layer.id === layerId && layer.name === layerName));
}

export const DEM_COVERAGE_LEGEND = DEM_COVERAGE_CLASSES.map(({ id, label, cssColor }) => ({
  id,
  label,
  cssColor,
}));

export function demCoverageClassForPixelSize(pixelSizeM: number): DemCoverageClassId | null {
  if (!Number.isFinite(pixelSizeM) || pixelSizeM <= 0) return null;
  if (pixelSizeM < 2) return "1m";
  if (pixelSizeM < 5) return "3m";
  if (pixelSizeM < 20) return "10m";
  return "30m";
}

/** USGS reports a source's cell size in metres, or in degrees for the arc-second products. */
export function pixelSizeFromUsgsResolution(resolution: number): number | null {
  if (!Number.isFinite(resolution) || resolution <= 0) return null;
  return resolution < 0.01 ? resolution * 111_320 : resolution;
}

export type UsgsSample = { resolution?: number | null; value?: string | number | null; attributes?: { Name?: string | null } | null };

/** What a path read, from USGS's answer to which source lies under each of its points. */
export function summarizeUsgsSamples(samples: UsgsSample[], totalSampleCount = samples.length): DemCoverageProfileSummary {
  const counts = new Map<string, DemCoverageDatasetSummary>();
  const sizes: number[] = [];
  for (const sample of samples) {
    const size = pixelSizeFromUsgsResolution(Number(sample.resolution));
    if (size == null || !Number.isFinite(Number(sample.value))) continue;
    sizes.push(size);
    const name = sample.attributes?.Name ?? null;
    const key = `${size.toFixed(6)}|${name ?? ""}`;
    const current = counts.get(key);
    if (current) current.sample_count += 1;
    else counts.set(key, { pixel_size_m: size, source: "USGS 3DEP", product_name: name, dataset_id: null, sample_count: 1 });
  }
  const min = sizes.length ? Math.min(...sizes) : null;
  const max = sizes.length ? Math.max(...sizes) : null;
  return {
    min_pixel_size_m: min,
    max_pixel_size_m: max,
    covered_sample_count: sizes.length,
    total_sample_count: totalSampleCount,
    mixed_resolution: min != null && max != null && Math.abs(max - min) > 0.01,
    datasets: [...counts.values()].sort((a, b) => b.sample_count - a.sample_count || a.pixel_size_m - b.pixel_size_m),
  };
}

/** Shares of a path by finest-first class: [{ label: "1 m lidar", share: 0.84 }, ...]. */
export function coverageShares(summary: DemCoverageProfileSummary): Array<{ id: DemCoverageClassId; label: string; share: number }> {
  if (!summary.covered_sample_count) return [];
  return DEM_COVERAGE_CLASSES.flatMap((coverageClass) => {
    const count = summary.datasets
      .filter((dataset) => demCoverageClassForPixelSize(dataset.pixel_size_m) === coverageClass.id)
      .reduce((sum, dataset) => sum + dataset.sample_count, 0);
    return count ? [{ id: coverageClass.id, label: coverageClass.label, share: count / summary.covered_sample_count }] : [];
  });
}

/** In words, what a path is built on: said plainly, because it is what its precision depends on. */
export function demQualityNote(metadata: { source_coverage?: DemCoverageProfileSummary } | null | undefined): string {
  const coverage = metadata?.source_coverage;
  if (!coverage || !coverage.covered_sample_count) {
    return "USGS could not say which of its sources lie under this path just now. Heights are from the finest it has at each point.";
  }
  const shares = coverageShares(coverage);
  const only = shares.length === 1 ? shares[0] : null;
  if (only?.id === "1m") return "All of this path is on USGS 1 m lidar, the finest elevation model USGS has.";
  const parts = shares.map((part) => `${Math.round(part.share * 100)}% ${part.label.toLowerCase()}`).join(", ");
  return `This path is ${parts}. That is the finest USGS has at each point.`;
}

const USGS_ELEVATION_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";
// USGS answers 1,000 points in a few seconds.
const POINTS_PER_REQUEST = 1000;

type UsgsAnswer = { samples?: Array<UsgsSample & { locationId?: number }> };

async function askUsgs(points: Array<[number, number]>, send: typeof fetch): Promise<UsgsAnswer["samples"]> {
  const body = new URLSearchParams({
    geometryType: "esriGeometryMultipoint",
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    returnFirstValueOnly: "true",
    interpolation: "RSP_BilinearInterpolation",
    outFields: "Name",
    f: "json",
  });
  let problem = "no answer";
  // USGS repeats an error for the same address for a while, so a retry changes the address.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    try {
      const response = await send(`${USGS_ELEVATION_URL}/getSamples${attempt ? `?attempt=${attempt}` : ""}`, { method: "POST", body });
      if (response.ok) {
        const answer = (await response.json()) as UsgsAnswer;
        if (answer.samples) return answer.samples;
        problem = "an answer with no heights";
      } else {
        problem = `status ${response.status}`;
      }
    } catch (reason) {
      problem = reason instanceof Error ? reason.message : String(reason);
    }
  }
  throw new Error(`Could not read the USGS elevation (${problem}). Try again shortly.`);
}

/**
 * Heights at [lon, lat] points from the finest source USGS has at each, and which sources those
 * were. USGS answers for exact points, so a long path costs no more than a short one, unlike
 * reading its tiles. Saved cross sections keep these heights, which USGS's public domain allows.
 */
export async function readUsgsPoints(
  points: Array<[number, number]>,
  send: typeof fetch = fetch,
): Promise<{ z: Array<number | null>; coverage: DemCoverageProfileSummary }> {
  const z: Array<number | null> = new Array(points.length).fill(null);
  const found: UsgsSample[] = [];
  for (let start = 0; start < points.length; start += POINTS_PER_REQUEST) {
    const samples = await askUsgs(points.slice(start, start + POINTS_PER_REQUEST), send);
    samples?.forEach((sample, position) => {
      const value = Number(sample.value);
      if (!Number.isFinite(value)) return;
      z[start + (sample.locationId ?? position)] = value;
      found.push(sample);
    });
  }
  return { z, coverage: summarizeUsgsSamples(found, points.length) };
}
