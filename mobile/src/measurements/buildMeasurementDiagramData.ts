import type {
  DiagramTemplate,
  FailureSide,
  MeasurementDiagramData,
  MeasurementValues,
  StationingView,
} from "./measurementDiagramModel";
import { buildRoadSectionFromInventory } from "./buildRoadSectionFromInventory";

function parseNum(s: string | undefined | null): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
}

export function buildMeasurementDiagramData(
  form: Record<string, string | undefined | null>,
  snapshot: Record<string, unknown> | null | undefined,
  template: DiagramTemplate,
  view: StationingView,
  failureSide: FailureSide,
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

  return { template, view, failureSide, crossSection, measurements };
}
