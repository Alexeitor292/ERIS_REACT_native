import type {
  DiagramTemplate,
  FailureSide,
  MeasurementDiagramData,
  MeasurementValues,
  StationingView,
  TerrainSideShape,
} from "./measurementDiagramModel";
import { buildRoadSectionFromInventory } from "./buildRoadSectionFromInventory";

function parseNum(s: string | undefined | null): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Infer diagram template from GISA failure type fields.
 * Rock fall / topple / flow → failure from above.
 * Surficial sloughing / scoured toe / erosion / washout → below-road slipout.
 * Slide / spread / compound → through the road (default).
 */
export function inferTemplate(
  form: Record<string, string | undefined | null>,
): DiagramTemplate {
  const isSet = (k: string) => Boolean(form[k]?.trim());
  if (isSet("failure_rock_fall") || isSet("failure_topple") || isSet("failure_flow"))
    return "LANDSLIDE_ABOVE_ROAD";
  if (
    isSet("failure_surficial_failure") ||
    isSet("failure_scoured_toe") ||
    isSet("failure_erosion") ||
    isSet("failure_washout")
  )
    return "LANDSLIDE_BELOW_ROAD_SLIPOUT";
  return "LANDSLIDE_THROUGH_ROAD";
}

function inferTerrainShape(
  template: DiagramTemplate,
  failureSide: FailureSide,
): TerrainSideShape {
  if (template === "LANDSLIDE_ABOVE_ROAD") {
    if (failureSide === "LT") return "LEFT_HIGH";
    if (failureSide === "RT") return "RIGHT_HIGH";
    return "CROWN"; // BOTH: cut slopes on both sides
  }
  if (template === "LANDSLIDE_BELOW_ROAD_SLIPOUT") {
    // Fill side (failure/slipout) is opposite the cut (high) side
    if (failureSide === "LT") return "RIGHT_HIGH";
    if (failureSide === "RT") return "LEFT_HIGH";
    return "BOWL"; // BOTH: fill on both sides
  }
  return "FLAT"; // THROUGH_ROAD: no elevation assumption
}

export function buildMeasurementDiagramData(
  form: Record<string, string | undefined | null>,
  snapshot: Record<string, unknown> | null | undefined,
  template: DiagramTemplate | "AUTO",
  view: StationingView,
  failureSide: FailureSide,
  terrainShapeOverride: TerrainSideShape | "AUTO" = "AUTO",
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

  const resolvedTemplate =
    template === "AUTO" ? inferTemplate(form) : template;

  const terrainShape =
    terrainShapeOverride === "AUTO"
      ? inferTerrainShape(resolvedTemplate, failureSide)
      : terrainShapeOverride;

  return {
    template: resolvedTemplate,
    view,
    failureSide,
    terrainShape,
    crossSection,
    measurements,
  };
}
