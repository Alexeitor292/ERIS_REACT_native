import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import MapImageLayer from "@arcgis/core/layers/MapImageLayer";
import TileLayer from "@arcgis/core/layers/TileLayer";

const USGS_TRANSPORTATION = "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer";
const CGS_MAP = "https://gis.conservation.ca.gov/server/rest/services/CGS/Geologic_Map_of_California";
const GEOLOGY_VECTOR_SCALE = 2_000_000;

export const ROAD_CREDIT = "Roads: USGS The National Map, U.S. Census Bureau TIGER/Line, U.S. Forest Service";
export const GEOLOGY_CREDIT = "Geology: California Geological Survey (2010) · 1:750,000";
export const GEOLOGY_LEGEND_URL = `${CGS_MAP}/MapServer/legend`;
export const CROSS_SECTION_OVERLAYS = ["roads", "geology"] as const;
export type CrossSectionOverlay = typeof CROSS_SECTION_OVERLAYS[number];
export type CrossSectionOverlays = Record<CrossSectionOverlay, boolean>;

export const CROSS_SECTION_OVERLAY_LABELS: Record<CrossSectionOverlay, string> = {
  roads: "Roads",
  geology: "Geology",
};

export function createCrossSectionRoads() {
  return new MapImageLayer({
    url: USGS_TRANSPORTATION,
    title: "Highways and streets",
    imageFormat: "png32",
    // Only road features and road labels. Local streets are off by default in
    // the USGS service, which also includes airports, trails, and railroads.
    sublayers: [
      { id: 2, minScale: 18_489_298, maxScale: 5_000_000 },
      { id: 3, minScale: 5_000_000, maxScale: 500_000 },
      { id: 8, maxScale: 5_000_000 },
      { id: 9, minScale: 5_000_000, maxScale: 500_000 },
      ...[16, 17, 18].map((id) => ({ id, minScale: 500_000 })),
      { id: 20, minScale: 75_000 },
      { id: 21, minScale: 25_000 },
      { id: 29, minScale: 500_000 },
      { id: 30, minScale: 500_000 },
      { id: 31, minScale: 125_000 },
      { id: 32, minScale: 25_000 },
      { id: 33, minScale: 75_000 },
    ],
  });
}

export function createCrossSectionGeology() {
  // Use the published vector data and symbology. The statewide map's raster
  // cache stops drawing well before the scale at which a section is captured.
  return [
    new TileLayer({
      url: `${CGS_MAP}/MapServer`,
      title: "CGS statewide geologic map",
      maxScale: GEOLOGY_VECTOR_SCALE,
      opacity: 0.55,
    }),
    new FeatureLayer({
      url: `${CGS_MAP}/FeatureServer/12`,
      title: "CGS generalized rock types",
      minScale: GEOLOGY_VECTOR_SCALE,
      maxScale: 0,
      opacity: 0.55,
      popupEnabled: false,
      labelsVisible: true,
      labelingInfo: [{
        labelExpressionInfo: { expression: "$feature.PTYPE" },
        labelPlacement: "always-horizontal",
        minScale: 600_000,
        symbol: {
          type: "text",
          color: "#30263a",
          haloColor: "white",
          haloSize: 1.5,
          font: { size: 12, weight: "bold" },
        },
      }],
    }),
    new FeatureLayer({
      url: `${CGS_MAP}/FeatureServer/8`,
      title: "CGS onshore contacts and faults",
      minScale: GEOLOGY_VECTOR_SCALE,
      maxScale: 0,
      opacity: 0.8,
      popupEnabled: false,
    }),
  ];
}
