/**
 * Domain model for the measurement diagram.
 *
 * DiagramTemplate selects which Caltrans field measurement scenario is shown.
 * StationingView controls visual perspective only:
 *   UPSTATION  = looking toward increasing postmile; LT elements on left of diagram.
 *   DOWNSTATION = looking toward decreasing postmile; diagram is mirrored so LT
 *                 elements appear on the right.
 * FailureSide indicates which Caltrans road side (LT, RT, or both) the landslide
 *   originates from. LT and RT are defined relative to increasing postmile and carry
 *   no implied compass direction, elevation, or cut/fill relationship.
 */

import type { RoadCrossSection } from "./roadCrossSectionModel";

export type DiagramTemplate =
  | "LANDSLIDE_THROUGH_ROAD"
  | "LANDSLIDE_ABOVE_ROAD"
  | "LANDSLIDE_BELOW_ROAD_SLIPOUT";

export type StationingView = "UPSTATION" | "DOWNSTATION";

export type FailureSide = "LT" | "RT" | "BOTH";

export type MeasurementValues = {
  slopeHeight_ft?: number | null;      // H-S   (measure_slope_height_ft)
  originalSlopeDeg?: number | null;    // Φ-OS  (measure_original_slope_deg)
  landslideWidth_ft?: number | null;   // W-M   (measure_landslide_width_ft)
  landslideLength_ft?: number | null;  // TLS   (measure_landslide_length_ft)
  mainScarpHeight_ft?: number | null;  // H-HS  (measure_main_scarp_height_ft)
  landslideSlopeDeg?: number | null;   // Φ-SS  (measure_landslide_slope_deg)
  roadwayLength_ft?: number | null;    // Lr    (measure_roadway_length_ft)
  roadwayWidth_ft?: number | null;     // R&S   (measure_roadway_width_ft)
};

export type MeasurementDiagramData = {
  template: DiagramTemplate;
  view: StationingView;
  failureSide: FailureSide;
  crossSection: RoadCrossSection;
  measurements: MeasurementValues;
};
