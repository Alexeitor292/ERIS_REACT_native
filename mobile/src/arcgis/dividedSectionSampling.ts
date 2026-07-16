// Pure section-sampling model for the OBSERVED divided corridor (Part 13).
//
// The TESTED mirror of buildDividedSectionForInspection:reason: in
// ErisTerrainSceneViewController.m — keep in lockstep.
//
// WHY THIS EXISTS
// The divided inspection already derives an exact section from observed geometry
// (crossAxis + sectionStart/sectionEnd, see dividedCorridorInspection.ts). But the terrain
// under it was still sampled along the DEFAULT roadway template's axis, between DEFAULT
// shoulder edges ±50 ft (~40 m). So the profile shown beneath two observed carriageways was
// measured along a *different line* and over a *shorter extent* than the section it claimed
// to be. Same picture, wrong ground.
//
// This module makes the model's section the SOLE contract:
//   station + crossAxis + [sectionMinOffsetM, sectionMaxOffsetM]
//     -> clip to the packaged grid  -> ONE set of clipped endpoints + offsets
//     -> the map slice line, the immersive section plane, and the technical profile all
//        consume that one result, so the three views cannot disagree.
//
// Everything here is geometry over PACKAGED data only. Nothing is extrapolated: an offset
// outside the clipped section is not a sample, and terrain the package lacks stays absent.
//
// No react-native/expo imports (unit-tested under node --test).

import { clipSegmentParam, type LonLat, type Rect } from "./corridorModel.ts";

const M_PER_DEG_LAT = 111_320.0;

/** Metres per foot — the technical renderer speaks feet. */
export const FT_PER_M = 3.280839895;

/** Target spacing between terrain samples along the section. */
export const SECTION_SAMPLE_SPACING_M = 1.0;

/** Hard ceiling on samples for one section (a 240 m max section at 1 m ≈ 241). */
export const MAX_SECTION_SAMPLES = 512;

/** Offsets closer than this are the same station; keeps anchors from duplicating. */
export const OFFSET_EPSILON_M = 1e-6;

/** Patch-local metres (east, north) — the space crossAxis lives in. */
export type Vec = { x: number; y: number };

export type SectionInput = {
  station: { lon: number; lat: number };
  /** Unit vector, oriented member A -> member B. */
  crossAxis: Vec;
  sectionMinOffsetM: number;
  sectionMaxOffsetM: number;
  memberAOffsetM: number;
  memberBOffsetM: number;
  /** The packaged elevation grid extent. */
  grid: Rect;
};

export type SectionPlan =
  | {
      ok: true;
      /** Clipped section endpoints, signed along crossAxis. */
      startOffsetM: number;
      endOffsetM: number;
      start: LonLat;
      end: LonLat;
      /** True when the package boundary cut the requested section. */
      truncated: boolean;
      /** Sorted, deduped sample offsets: anchors + even fill, all within the clipped span. */
      offsetsM: number[];
      /** Bearing of crossAxis in degrees (0 = north, 90 = east). */
      crossBearingDeg: number;
      /** Requested (pre-clip) span — what the geometry asked for. */
      requestedSpanM: number;
      /** Clipped span — what the package could actually support. */
      clippedSpanM: number;
    }
  | { ok: false; reason: SectionFailReason };

export type SectionFailReason =
  | "invalid_station"
  | "invalid_cross_axis"
  | "invalid_section_extent"
  | "section_outside_package"
  | "member_offset_outside_section";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Lon/lat of a signed offset along crossAxis from the station. */
export function offsetToLonLat(station: { lon: number; lat: number }, crossAxis: Vec, offsetM: number): LonLat {
  const cosLat = Math.cos((station.lat * Math.PI) / 180) || 1e-9;
  const east = crossAxis.x * offsetM;
  const north = crossAxis.y * offsetM;
  return [station.lon + east / (M_PER_DEG_LAT * cosLat), station.lat + north / M_PER_DEG_LAT];
}

/** Bearing of a local (east, north) vector: 0 = north, 90 = east. */
export function bearingOf(v: Vec): number {
  return ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360;
}

/**
 * Plan the terrain section for an observed divided corridor.
 *
 * The requested section comes straight from the inspection model; this clips it to the
 * packaged grid and lays out the sample offsets. Anchors that MUST be sampled explicitly —
 * the clipped ends, both observed carriageway centerlines, and the midpoint station — are
 * always present, so no marker has to be interpolated into existence.
 */
export function planDividedSection(input: SectionInput): SectionPlan {
  const { station, crossAxis, sectionMinOffsetM, sectionMaxOffsetM, memberAOffsetM, memberBOffsetM, grid } = input;

  if (!station || !finite(station.lon) || !finite(station.lat)) return { ok: false, reason: "invalid_station" };
  if (!crossAxis || !finite(crossAxis.x) || !finite(crossAxis.y)) return { ok: false, reason: "invalid_cross_axis" };
  const axisLen = Math.hypot(crossAxis.x, crossAxis.y);
  if (!(axisLen > 0.99 && axisLen < 1.01)) return { ok: false, reason: "invalid_cross_axis" }; // must be a unit axis
  if (!finite(sectionMinOffsetM) || !finite(sectionMaxOffsetM)) return { ok: false, reason: "invalid_section_extent" };
  if (!(sectionMaxOffsetM > sectionMinOffsetM)) return { ok: false, reason: "invalid_section_extent" };
  if (!finite(memberAOffsetM) || !finite(memberBOffsetM)) return { ok: false, reason: "invalid_section_extent" };
  if (
    memberAOffsetM < sectionMinOffsetM - OFFSET_EPSILON_M ||
    memberAOffsetM > sectionMaxOffsetM + OFFSET_EPSILON_M ||
    memberBOffsetM < sectionMinOffsetM - OFFSET_EPSILON_M ||
    memberBOffsetM > sectionMaxOffsetM + OFFSET_EPSILON_M
  ) {
    return { ok: false, reason: "member_offset_outside_section" };
  }

  const requestedSpanM = sectionMaxOffsetM - sectionMinOffsetM;
  const a = offsetToLonLat(station, crossAxis, sectionMinOffsetM);
  const b = offsetToLonLat(station, crossAxis, sectionMaxOffsetM);

  // ONE clip against the packaged grid. Everything downstream uses its result.
  const res = clipSegmentParam(a, b, grid);
  if (!res) return { ok: false, reason: "section_outside_package" };
  const [t0, t1] = res;
  const startOffsetM = sectionMinOffsetM + requestedSpanM * t0;
  const endOffsetM = sectionMinOffsetM + requestedSpanM * t1;
  const clippedSpanM = endOffsetM - startOffsetM;
  if (!(clippedSpanM > 0)) return { ok: false, reason: "section_outside_package" };
  const truncated = t0 > 1e-9 || t1 < 1 - 1e-9;

  const inSpan = (o: number) => o >= startOffsetM - OFFSET_EPSILON_M && o <= endOffsetM + OFFSET_EPSILON_M;

  // Anchors first: the ends, both observed centerlines, and the midpoint station.
  const anchors = [startOffsetM, endOffsetM, memberAOffsetM, memberBOffsetM, 0].filter(inSpan);

  // Even fill for a continuous profile.
  const steps = Math.min(MAX_SECTION_SAMPLES - 1, Math.max(1, Math.round(clippedSpanM / SECTION_SAMPLE_SPACING_M)));
  const step = clippedSpanM / steps;
  const fill: number[] = [];
  for (let i = 0; i <= steps; i++) fill.push(startOffsetM + step * i);

  const merged = [...anchors, ...fill].filter(inSpan).sort((x, y) => x - y);
  const offsetsM: number[] = [];
  for (const o of merged) {
    if (offsetsM.length === 0 || Math.abs(o - offsetsM[offsetsM.length - 1]) > OFFSET_EPSILON_M) offsetsM.push(o);
  }

  return {
    ok: true,
    startOffsetM,
    endOffsetM,
    start: offsetToLonLat(station, crossAxis, startOffsetM),
    end: offsetToLonLat(station, crossAxis, endOffsetM),
    truncated,
    offsetsM,
    crossBearingDeg: bearingOf(crossAxis),
    requestedSpanM,
    clippedSpanM,
  };
}

/**
 * Is `offsetM` an anchor that must resolve to a real sample? Mirrors the native
 * fail-closed check: a member centerline with no packaged terrain under it must not be
 * drawn at a guessed elevation.
 */
export function requiredAnchorOffsets(plan: Extract<SectionPlan, { ok: true }>, memberAOffsetM: number, memberBOffsetM: number): number[] {
  return [memberAOffsetM, memberBOffsetM].filter(
    (o) => o >= plan.startOffsetM - OFFSET_EPSILON_M && o <= plan.endOffsetM + OFFSET_EPSILON_M,
  );
}

/** Signed offset (m) -> the technical renderer's offsetFt. */
export const offsetFtOf = (offsetM: number): number => offsetM * FT_PER_M;

/** LT below the midpoint, RT above, CENTER exactly on it. */
export function sideForOffset(offsetM: number): "LT" | "RT" | "CENTER" {
  if (Math.abs(offsetM) <= OFFSET_EPSILON_M) return "CENTER";
  return offsetM < 0 ? "LT" : "RT";
}
