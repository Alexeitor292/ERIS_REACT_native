import type {
  DiagramTemplate,
  FailureSide,
  MeasurementDiagramData,
  MeasurementValues,
  TerrainSideShape,
} from "./measurementDiagramModel";
import { buildRoadSectionFromInventory } from "./buildRoadSectionFromInventory";
import { buildTerrainAppearance } from "./buildTerrainAppearance";
import type { GisaElevationProfile } from "../api/submissions";

function parseNum(s: string | undefined | null): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve terrain shape from a persisted USGS 3DEP elevation profile.
 * UNKNOWN and missing profiles both fall back to FLAT (safe schematic).
 */
function terrainShapeFromElevationProfile(
  profile?: GisaElevationProfile | null,
): TerrainSideShape {
  switch (profile?.classification) {
    case "LEFT_HIGH":  return "LEFT_HIGH";
    case "RIGHT_HIGH": return "RIGHT_HIGH";
    case "BOWL":       return "BOWL";
    case "CROWN":      return "CROWN";
    case "FLAT":       return "FLAT";
    default:           return "FLAT"; // UNKNOWN or null
  }
}

export function buildMeasurementDiagramData(
  form: Record<string, string | undefined | null>,
  snapshot: Record<string, unknown> | null | undefined,
  template: DiagramTemplate | "AUTO",
  failureSide: FailureSide,
  terrainShapeOverride: TerrainSideShape | "AUTO" = "AUTO",
  elevationProfile?: GisaElevationProfile | null,
): MeasurementDiagramData {
  const measurements: MeasurementValues = {
    slopeHeight_ft: parseNum(form.measure_slope_height_ft),
    originalSlopeDeg: parseNum(form.measure_original_slope_deg),
    landslideWidth_ft: parseNum(form.measure_landslide_width_ft),
    landslideLength_ft: parseNum(form.measure_landslide_length_ft),
    mainScarpHeight_ft: parseNum(form.measure_main_scarp_height_ft),
    landslideSlopeDeg: parseNum(form.measure_landslide_slope_deg),
    roadwayLength_ft: parseNum(form.measure_roadway_length_ft),
    roadwayWidth_ft: parseNum(form.measure_roadway_width_ft),
  };

  const crossSection = buildRoadSectionFromInventory(
    snapshot,
    measurements.roadwayWidth_ft,
  );
  const terrainAppearance = buildTerrainAppearance(form);

  // Template AUTO: conservative default until GEO/map-derived classification is available.
  // We intentionally do not infer template from failure_* form checkboxes.
  const resolvedTemplate: DiagramTemplate =
    template === "AUTO" ? "LANDSLIDE_THROUGH_ROAD" : template;

  // Terrain AUTO: use persisted elevation_profile.classification from USGS 3DEP/EPQS.
  // Manual override takes priority when terrainShapeOverride !== "AUTO".
  const terrainShape: TerrainSideShape =
    terrainShapeOverride === "AUTO"
      ? terrainShapeFromElevationProfile(elevationProfile)
      : terrainShapeOverride;

  return {
    template: resolvedTemplate,
    failureSide,
    terrainShape,
    terrainAppearance,
    crossSection,
    measurements,
  };
}
