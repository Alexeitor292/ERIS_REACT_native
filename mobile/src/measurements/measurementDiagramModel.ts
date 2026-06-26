/**
 * Domain model for the measurement diagram.
 *
 * DiagramTemplate selects which Caltrans field measurement scenario is shown.
 *
 * Orientation is CANONICAL UPSTATION — always. Every render looks toward
 * increasing postmile, so LT (Caltrans left) elements are always on the left of
 * the diagram and RT on the right. There is intentionally no mirrored /
 * DOWNSTATION perspective and no user-facing view toggle; the orientation is
 * derived from the road's stationing direction, not chosen by the user.
 *
 * FailureSide indicates which Caltrans road side (LT, RT, or both) the landslide
 *   originates from. LT and RT are defined relative to increasing postmile and carry
 *   no implied compass direction, elevation, or cut/fill relationship.
 */

import type { RoadCrossSection } from "./roadCrossSectionModel";

export type DiagramTemplate =
  | "LANDSLIDE_THROUGH_ROAD"
  | "LANDSLIDE_ABOVE_ROAD"
  // Internal key retained for backward compatibility. The "_SLIPOUT" suffix is a
  // legacy Caltrans synonym; it is NOT shown to users — see DIAGRAM_TEMPLATE_LABELS.
  | "LANDSLIDE_BELOW_ROAD_SLIPOUT";

/**
 * User-facing labels for each diagram template. The internal enum keys are kept
 * stable (and are not persisted anywhere), but the approved user-facing term for
 * LANDSLIDE_BELOW_ROAD_SLIPOUT is "Landslide Below Road" — never "Slipout".
 */
export const DIAGRAM_TEMPLATE_LABELS: Record<DiagramTemplate, { full: string; short: string }> = {
  LANDSLIDE_THROUGH_ROAD: { full: "Landslide Through Road", short: "through road" },
  LANDSLIDE_ABOVE_ROAD: { full: "Landslide Above Road", short: "above road" },
  LANDSLIDE_BELOW_ROAD_SLIPOUT: { full: "Landslide Below Road", short: "below road" },
};

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

/**
 * Approximate terrain elevation profile on each side of the road.
 * Inferred from template + failure side when AUTO is not used.
 * LEFT_HIGH / RIGHT_HIGH indicate which side has a cut slope (terrain above road).
 * BOWL = both sides fill (road on embankment); CROWN = both sides cut.
 * FLAT = level ground on both sides (default / through-road).
 */
export type TerrainSideShape =
  | "LEFT_HIGH"   // LT side cut slope; RT side fill or flat
  | "RIGHT_HIGH"  // RT side cut slope; LT side fill or flat
  | "BOWL"        // both sides fill slope — road on embankment
  | "CROWN"       // both sides cut slope — road in cut section
  | "FLAT";       // terrain level with road edges

export type TerrainMaterialKind = "SOIL" | "ROCK" | "MIXED";
export type TerrainMoisture = "DRY" | "MOIST" | "WET" | "FLOWING";

export type TerrainAppearance = {
  dominantMaterial: TerrainMaterialKind;
  moisture: TerrainMoisture;
  moistureLevel: number;       // 0..1
  vegetationDensity: number;   // 0..1
  rockiness: number;           // 0..1
  soilPct: number;
  rockPct: number;
  clayPct: number;
  siltPct: number;
  sandPct: number;
  gravelPct: number;
  boulderPct: number;
  treesPct: number;
  shrubsPct: number;
  groundcoverPct: number;
  seep: boolean;
  spring: boolean;
  bedding: boolean;
  joints: boolean;
  fractures: boolean;
  pavementType: "ASPHALT" | "CONCRETE" | null;
};

export type MeasurementDiagramData = {
  template: DiagramTemplate;
  failureSide: FailureSide;
  terrainShape: TerrainSideShape;
  terrainAppearance: TerrainAppearance;
  crossSection: RoadCrossSection;
  measurements: MeasurementValues;
};
