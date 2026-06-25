/**
 * Data model for a road cross-section derived from CA Highway Inventory data.
 *
 * Widths are in feet. The cross-section is always described in the UPSTATION
 * direction (facing increasing postmile): LT is the left lane, RT is the right
 * lane. This is the canonical and only orientation — the renderer never mirrors.
 */

export type MedianCategory =
  | "NONE"      // no median — undivided highway, painted centerline only
  | "PAINTED"   // painted or marker-type center separation
  | "RAISED"    // raised curb or traffic island
  | "BARRIER"   // concrete barrier (K-rail, Jersey, etc.)
  | "DEPRESSED"; // depressed median / open landscaped median

export type RoadCrossSection = {
  // Lane geometry (all widths in feet)
  lt_lane_count: number;
  rt_lane_count: number;
  lt_lane_width_ft: number;        // average width per LT lane
  rt_lane_width_ft: number;        // average width per RT lane
  lt_outside_shoulder_ft: number;  // outermost LT shoulder
  lt_inside_shoulder_ft: number;   // LT shoulder between lanes and median
  rt_inside_shoulder_ft: number;   // RT shoulder between median and lanes
  rt_outside_shoulder_ft: number;  // outermost RT shoulder
  median_width_ft: number;         // 0 for undivided
  median_category: MedianCategory;

  // Total widths (derived)
  total_width_ft: number; // sum of all above elements

  // Segment metadata (optional, from inventory snapshot)
  begin_pm?: number;
  end_pm?: number;
  length_miles?: number;
  route_name?: string;
  county_code?: string;
  terrain_code?: string | null;
  design_speed?: number | null;
  adt?: number | null;
  landmark?: string | null;

  // Data provenance
  source: "ROAD_INVENTORY" | "FORM_FIELDS" | "DEFAULT";
};
