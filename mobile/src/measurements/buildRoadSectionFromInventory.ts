/**
 * Builds a RoadCrossSection from a road inventory snapshot.
 *
 * Snapshot keys use the snake_case names produced by the backend when it
 * serializes a road_segments row. Fields that are not present in the current
 * schema (e.g., traveled-way widths, inside shoulders) are derived from
 * defaults so that the diagram renders correctly even for older snapshots.
 *
 * Priority for each width:
 *   1. Explicit snapshot field
 *   2. Derived from related field (e.g., TWW ÷ lane_count)
 *   3. Caltrans standard default
 */

import type { MedianCategory, RoadCrossSection } from "./roadCrossSectionModel";

// ── Caltrans defaults ────────────────────────────────────────────────────────
const DEFAULT_LANE_W_FT = 12;        // standard travel lane (Caltrans HDM)
const DEFAULT_FREEWAY_OSHLD_FT = 8;  // typical freeway outside shoulder
const DEFAULT_HWY_OSHLD_FT = 4;      // typical 2-lane highway outside shoulder
const DEFAULT_ISHLD_FT = 0;          // inside shoulder absent unless divided
const MIN_TOTAL_FT = 20;             // floor to avoid zero-width diagrams

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n !== null ? Math.max(1, Math.round(n)) : null;
}

function pick(...vals: (unknown)[]): number | null {
  for (const v of vals) {
    const n = toNum(v);
    if (n !== null) return n;
  }
  return null;
}

function classifyMedian(code: unknown): MedianCategory {
  const s = String(code ?? "").trim().toUpperCase();
  if (!s || s === "0" || s === "N" || s === "NONE") return "NONE";
  if (s === "P" || s === "C" || s === "1" || s === "M") return "PAINTED";
  if (s === "R" || s === "K" || s === "2" || s === "RAISED") return "RAISED";
  if (s === "B" || s === "3" || s === "BARRIER") return "BARRIER";
  if (s === "D" || s === "4" || s === "DEPRESSED") return "DEPRESSED";
  // Unknown but non-zero codes → treat as raised
  return "RAISED";
}

function isDivided(medianCat: MedianCategory, medianW: number): boolean {
  return medianCat !== "NONE" && medianW > 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildRoadSectionFromInventory(
  snapshot: Record<string, unknown> | null | undefined,
  fallbackRoadwayWidth?: number | null,
): RoadCrossSection {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return buildFallback(fallbackRoadwayWidth);
  }

  const sn = snapshot;

  // Lane counts
  const ltLanes = toInt(sn.left_lanes ?? sn.lt_lane_count ?? sn.lt_lanes) ?? 1;
  const rtLanes = toInt(sn.right_lanes ?? sn.rt_lane_count ?? sn.rt_lanes) ?? 1;

  // Lane widths: explicit → TWW / lane_count → default
  let ltLaneW: number;
  const ltTww = pick(sn.left_traveled_way_width, sn.lt_traveled_way_width, sn.lt_tww);
  if (ltTww !== null && ltLanes > 0) {
    ltLaneW = ltTww / ltLanes;
  } else {
    ltLaneW = pick(sn.lt_lane_width, sn.left_lane_width) ?? DEFAULT_LANE_W_FT;
  }

  let rtLaneW: number;
  const rtTww = pick(sn.right_traveled_way_width, sn.rt_traveled_way_width, sn.rt_tww);
  if (rtTww !== null && rtLanes > 0) {
    rtLaneW = rtTww / rtLanes;
  } else {
    rtLaneW = pick(sn.rt_lane_width, sn.right_lane_width) ?? DEFAULT_LANE_W_FT;
  }

  // Median
  const medianW = pick(sn.median_width, sn.median_width_ft, sn.median_width_amt) ?? 0;
  const medianCat = classifyMedian(sn.median_type ?? sn.median_type_code);

  const divided = isDivided(medianCat, medianW);

  // Shoulder widths: explicit → default based on road type
  const defaultOShld = (ltLanes + rtLanes >= 4) ? DEFAULT_FREEWAY_OSHLD_FT : DEFAULT_HWY_OSHLD_FT;
  const defaultIShld = divided ? 4 : DEFAULT_ISHLD_FT;

  const ltOShld = pick(
    sn.left_outside_shoulder_width, sn.lt_outside_shoulder_width,
    sn.lt_o_shd_tot_width, sn.left_outside_shoulder,
  ) ?? defaultOShld;

  const ltIShld = divided
    ? (pick(sn.left_inside_shoulder_width, sn.lt_inside_shoulder_width,
        sn.lt_i_shd_tot_width, sn.left_inside_shoulder) ?? defaultIShld)
    : 0;

  const rtIShld = divided
    ? (pick(sn.right_inside_shoulder_width, sn.rt_inside_shoulder_width,
        sn.rt_i_shd_tot_width, sn.right_inside_shoulder) ?? defaultIShld)
    : 0;

  const rtOShld = pick(
    sn.right_outside_shoulder_width, sn.rt_outside_shoulder_width,
    sn.rt_o_shd_tot_width, sn.right_outside_shoulder,
  ) ?? defaultOShld;

  const total = Math.max(
    MIN_TOTAL_FT,
    ltOShld + ltIShld + ltLanes * ltLaneW +
    medianW +
    rtLanes * rtLaneW + rtIShld + rtOShld,
  );

  return {
    lt_lane_count: ltLanes,
    rt_lane_count: rtLanes,
    lt_lane_width_ft: ltLaneW,
    rt_lane_width_ft: rtLaneW,
    lt_outside_shoulder_ft: ltOShld,
    lt_inside_shoulder_ft: ltIShld,
    rt_inside_shoulder_ft: rtIShld,
    rt_outside_shoulder_ft: rtOShld,
    median_width_ft: medianW,
    median_category: medianCat,
    total_width_ft: total,
    begin_pm: toNum(sn.begin_pm) ?? undefined,
    end_pm: toNum(sn.end_pm) ?? undefined,
    length_miles: toNum(sn.length_miles) ?? undefined,
    route_name: sn.route_name != null ? String(sn.route_name) : undefined,
    county_code: sn.county_code != null ? String(sn.county_code) : undefined,
    terrain_code: sn.terrain_code != null ? String(sn.terrain_code) : null,
    design_speed: toNum(sn.design_speed) ?? null,
    adt: toNum(sn.adt) ?? null,
    landmark: sn.landmark_short_desc != null ? String(sn.landmark_short_desc) : null,
    source: "ROAD_INVENTORY",
  };
}

function buildFallback(roadwayWidth?: number | null): RoadCrossSection {
  const w = toNum(roadwayWidth);
  if (w !== null && w > 0) {
    // Best estimate from total roadway encroachment width
    const halfW = w / 2;
    const laneCount = Math.max(1, Math.round(halfW / DEFAULT_LANE_W_FT));
    const laneW = halfW / laneCount;
    const total = Math.max(MIN_TOTAL_FT, w);
    return {
      lt_lane_count: laneCount,
      rt_lane_count: laneCount,
      lt_lane_width_ft: laneW,
      rt_lane_width_ft: laneW,
      lt_outside_shoulder_ft: 0,
      lt_inside_shoulder_ft: 0,
      rt_inside_shoulder_ft: 0,
      rt_outside_shoulder_ft: 0,
      median_width_ft: 0,
      median_category: "NONE",
      total_width_ft: total,
      source: "FORM_FIELDS",
    };
  }
  // Bare minimum: 2-lane undivided highway
  return {
    lt_lane_count: 1,
    rt_lane_count: 1,
    lt_lane_width_ft: DEFAULT_LANE_W_FT,
    rt_lane_width_ft: DEFAULT_LANE_W_FT,
    lt_outside_shoulder_ft: DEFAULT_HWY_OSHLD_FT,
    lt_inside_shoulder_ft: 0,
    rt_inside_shoulder_ft: 0,
    rt_outside_shoulder_ft: DEFAULT_HWY_OSHLD_FT,
    median_width_ft: 0,
    median_category: "NONE",
    total_width_ft: 2 * (DEFAULT_LANE_W_FT + DEFAULT_HWY_OSHLD_FT),
    source: "DEFAULT",
  };
}
