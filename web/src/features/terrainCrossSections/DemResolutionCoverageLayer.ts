import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GroupLayer from "@arcgis/core/layers/GroupLayer";
import Graphic from "@arcgis/core/Graphic";
import type Geometry from "@arcgis/core/geometry/Geometry";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import * as intersectsOperator from "@arcgis/core/geometry/operators/intersectsOperator";

import {
  DEM_COVERAGE_CLASSES,
  demCoverageClassForPixelSize,
  type DemCoverageClassId,
  type DemCoverageDatasetSummary,
  type DemCoverageProfileSummary,
} from "./demResolutionCoverageModel";

export const WORLD_ELEVATION_DATA_EXTENTS_URL =
  "https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/DataExtents/MapServer";

const DEM_COVERAGE_REFRESH_MINUTES = 60;
const DEM_COVERAGE_OUT_FIELDS = [
  "OBJECTID",
  "PixelSize",
  "Source",
  "Source_URL",
  "ProductName",
  "Dataset_ID",
  "Product",
  "LE90",
  "CE90",
  "VerticalDatum",
  "Date_Start",
  "Date_End",
];

type CoverageFeature = {
  geometry: Geometry;
  pixelSizeM: number;
  source: string | null;
  productName: string | null;
  datasetId: string | null;
};

function popupTemplate(sourceLabel: string) {
  return {
    title: `${sourceLabel} source footprint · {ProductName}`,
    content: [{
      type: "fields",
      fieldInfos: [
        { fieldName: "PixelSize", label: "Native pixel size / source resolution (m)", format: { places: 2, digitSeparator: true } },
        { fieldName: "Source", label: "Source" },
        { fieldName: "ProductName", label: "Product name" },
        { fieldName: "Dataset_ID", label: "Dataset ID" },
        { fieldName: "Product", label: "Product" },
        { fieldName: "LE90", label: "LE90" },
        { fieldName: "CE90", label: "CE90" },
        { fieldName: "VerticalDatum", label: "Vertical datum" },
        { fieldName: "Date_Start", label: "Acquisition start", format: { dateFormat: "short-date" } },
        { fieldName: "Date_End", label: "Acquisition end", format: { dateFormat: "short-date" } },
        { fieldName: "Source_URL", label: "Source URL" },
      ],
    }],
  } as never;
}

function createCoverageFeatureLayer(
  classId: DemCoverageClassId,
  classLabel: string,
  rgb: readonly [number, number, number],
  source: { layerId: number; sourceLabel: string; definitionExpression?: string },
) {
  return new FeatureLayer({
    id: `dem-coverage-${classId}-${source.layerId}-${source.definitionExpression ? source.definitionExpression.replace(/\W+/g, "-") : "all"}`,
    url: `${WORLD_ELEVATION_DATA_EXTENTS_URL}/${source.layerId}`,
    title: `${classLabel} · ${source.sourceLabel}`,
    visible: true,
    definitionExpression: source.definitionExpression,
    outFields: [...DEM_COVERAGE_OUT_FIELDS],
    refreshInterval: DEM_COVERAGE_REFRESH_MINUTES,
    popupTemplate: popupTemplate(source.sourceLabel),
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        // Children are deliberately opaque. The GroupLayer supplies transparency so a finer
        // footprint replaces, rather than alpha-mixes with, a coarser fallback footprint.
        color: [rgb[0], rgb[1], rgb[2], 1],
        outline: { color: [rgb[0], rgb[1], rgb[2], 0.8], width: 0.65 },
      },
    } as never,
    elevationInfo: { mode: "on-the-ground" },
  });
}

export function createDemResolutionCoverageLayer() {
  // ArcGIS layer index 0 is bottom-most. Coarse fallback sources draw first; finer sources draw
  // last. Combined with opaque child symbols this makes the visible class mean "finest cataloged
  // footprint here", while GroupLayer opacity keeps the basemap usable.
  const layers = [...DEM_COVERAGE_CLASSES]
    .reverse()
    .flatMap((coverageClass) => coverageClass.sources.map((source) =>
      createCoverageFeatureLayer(coverageClass.id, coverageClass.label, coverageClass.rgb, source)));

  return new GroupLayer({
    title: "Esri DEM source coverage",
    visible: false,
    visibilityMode: "inherited",
    opacity: 0.34,
    blendMode: "normal",
    layers,
  });
}

export function refreshDemResolutionCoverageLayer(group: GroupLayer) {
  group.layers.forEach((layer) => {
    if (layer instanceof FeatureLayer) layer.refresh();
  });
}

function featurePixelSize(graphic: Graphic): number | null {
  const value = Number(graphic.attributes?.PixelSize);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function featureString(graphic: Graphic, field: string): string | null {
  const value = graphic.attributes?.[field];
  return value == null || value === "" ? null : String(value);
}

async function queryCoverageFeaturesAlongLine(group: GroupLayer, line: Polyline): Promise<CoverageFeature[]> {
  const layers = group.layers.toArray().filter((layer): layer is FeatureLayer => layer instanceof FeatureLayer);
  const featureSets = await Promise.all(layers.map(async (layer) => {
    const query = layer.createQuery();
    query.geometry = line;
    query.spatialRelationship = "intersects";
    query.returnGeometry = true;
    query.outFields = [...DEM_COVERAGE_OUT_FIELDS];
    query.outSpatialReference = SpatialReference.WGS84;
    const result = await layer.queryFeatures(query);
    return result.features;
  }));

  return featureSets.flatMap((features) => features.flatMap((feature) => {
    const pixelSizeM = featurePixelSize(feature);
    if (pixelSizeM == null || !feature.geometry) return [];
    return [{
      geometry: feature.geometry,
      pixelSizeM,
      source: featureString(feature, "Source"),
      productName: featureString(feature, "ProductName"),
      datasetId: featureString(feature, "Dataset_ID"),
    }];
  }));
}

/**
 * Resolve the finest cataloged Esri source footprint at every sampled profile coordinate.
 *
 * Data Extents intentionally contains overlapping fallback datasets. Choosing the minimum
 * PixelSize among footprints that actually contain each coordinate mirrors the overlay's
 * "finer wins" semantics and prevents global/coarse fallback footprints from being reported as
 * the source resolution when a finer cataloged dataset covers the same coordinate.
 */
export async function summarizeDemCoverageAlongProfile(
  group: GroupLayer,
  samples: Array<{ longitude: number; latitude: number }>,
): Promise<DemCoverageProfileSummary> {
  if (samples.length === 0) {
    return {
      min_pixel_size_m: null,
      max_pixel_size_m: null,
      covered_sample_count: 0,
      total_sample_count: 0,
      mixed_resolution: false,
      datasets: [],
    };
  }

  const line = new Polyline({
    paths: [samples.map((sample) => [sample.longitude, sample.latitude])],
    spatialReference: SpatialReference.WGS84,
  });
  const features = await queryCoverageFeaturesAlongLine(group, line);
  const winners: CoverageFeature[] = [];

  for (const sample of samples) {
    const point = new Point({
      longitude: sample.longitude,
      latitude: sample.latitude,
      spatialReference: SpatialReference.WGS84,
    });
    let winner: CoverageFeature | null = null;
    for (const feature of features) {
      if (winner && feature.pixelSizeM >= winner.pixelSizeM) continue;
      if (intersectsOperator.execute(feature.geometry, point)) winner = feature;
    }
    if (winner) winners.push(winner);
  }

  const resolutions = winners.map((winner) => winner.pixelSizeM);
  const min = resolutions.length ? Math.min(...resolutions) : null;
  const max = resolutions.length ? Math.max(...resolutions) : null;
  const counts = new Map<string, DemCoverageDatasetSummary>();

  for (const winner of winners) {
    const key = [winner.pixelSizeM.toFixed(6), winner.source ?? "", winner.productName ?? "", winner.datasetId ?? ""].join("|");
    const current = counts.get(key);
    if (current) {
      current.sample_count += 1;
    } else {
      counts.set(key, {
        pixel_size_m: winner.pixelSizeM,
        source: winner.source,
        product_name: winner.productName,
        dataset_id: winner.datasetId,
        sample_count: 1,
      });
    }
  }

  return {
    min_pixel_size_m: min,
    max_pixel_size_m: max,
    covered_sample_count: winners.length,
    total_sample_count: samples.length,
    mixed_resolution: min != null && max != null && Math.abs(max - min) > 0.01,
    datasets: [...counts.values()].sort((a, b) => b.sample_count - a.sample_count || a.pixel_size_m - b.pixel_size_m),
  };
}

export function coverageClassForSummary(summary: DemCoverageProfileSummary): DemCoverageClassId | null {
  if (summary.min_pixel_size_m == null || summary.max_pixel_size_m == null) return null;
  if (Math.abs(summary.max_pixel_size_m - summary.min_pixel_size_m) > 0.01) return null;
  return demCoverageClassForPixelSize(summary.min_pixel_size_m);
}
