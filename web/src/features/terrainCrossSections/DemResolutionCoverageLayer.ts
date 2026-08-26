import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GroupLayer from "@arcgis/core/layers/GroupLayer";

import { DEM_COVERAGE_CLASSES } from "./demResolutionCoverageModel";

export const WORLD_ELEVATION_DATA_EXTENTS_URL =
  "https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/DataExtents/MapServer";

const DEM_COVERAGE_REFRESH_MINUTES = 60;
const DEM_COVERAGE_OUT_FIELDS = [
  "PixelSize",
  "Source",
  "Source_URL",
  "ProductName",
  "Product",
  "LE90",
  "CE90",
  "VerticalDatum",
  "Date_Start",
  "Date_End",
];

function popupTemplate(sourceLabel: string) {
  return {
    title: `${sourceLabel} DEM source · {ProductName}`,
    content: [{
      type: "fields",
      fieldInfos: [
        { fieldName: "PixelSize", label: "Pixel size / resolution (m)", format: { places: 2, digitSeparator: true } },
        { fieldName: "Source", label: "Source" },
        { fieldName: "ProductName", label: "Product name" },
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
  classLabel: string,
  rgb: readonly [number, number, number],
  source: { layerId: number; sourceLabel: string; definitionExpression?: string },
) {
  return new FeatureLayer({
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
        color: [rgb[0], rgb[1], rgb[2], 0.24],
        outline: { color: [rgb[0], rgb[1], rgb[2], 0.58], width: 0.65 },
      },
    } as never,
    elevationInfo: { mode: "on-the-ground" },
  });
}

export function createDemResolutionCoverageLayer() {
  // ArcGIS operational layer index 0 is bottom-most. Keep coarse sources first so finer
  // advertised footprints render above them where source footprints overlap.
  const layers = [...DEM_COVERAGE_CLASSES]
    .reverse()
    .flatMap((coverageClass) => coverageClass.sources.map((source) =>
      createCoverageFeatureLayer(coverageClass.label, coverageClass.rgb, source)));

  return new GroupLayer({
    title: "Esri DEM resolution coverage",
    visible: false,
    visibilityMode: "inherited",
    layers,
  });
}

export function refreshDemResolutionCoverageLayer(group: GroupLayer) {
  group.layers.forEach((layer) => {
    if (layer instanceof FeatureLayer) layer.refresh();
  });
}
