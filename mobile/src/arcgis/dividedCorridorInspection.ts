// Pure divided-corridor inspection geometry — built ONCE, then consumed unchanged by both
// Immersive and Technical. This is the TESTED mirror of the Objective-C model; keep them in
// lockstep.
//
// TRUTHFULNESS IS THE POINT. From TIGER geometry we can observe only: two source
// centrelines, a geometry-derived midpoint, the measured centreline separation, and the
// packaged terrain/imagery. We can NOT observe pavement edges, carriageway width, lane
// count/width, shoulders, median category or physical median width, or traffic direction.
// The old single-road DEFAULT template (one lane each way, 32 ft) must never be stretched
// across a freeway corridor — so this model fails CLOSED rather than fabricating a
// schematic, and explicitly forbids the schematic/default paths downstream.
//
// No react-native/expo imports (unit-tested under node --test).

import { projectToPolyline, type LonLat } from "./corridorModel.ts";

const M_PER_DEG_LAT = 111_320.0;

/** Outside-terrain margin beyond each member projection (~65 ft). */
export const OUTSIDE_MARGIN_M = 20.0;
/** Members must straddle the corridor station by at least this much to be believable. */
export const STRADDLE_TOLERANCE_M = 0.5;
/** Separation consistency tolerance vs the packaged stats: max(5 m, 25% of median). */
export const SEPARATION_TOLERANCE_ABS_M = 5.0;
export const SEPARATION_TOLERANCE_FRAC = 0.25;
/** A divided highway with centrelines closer than this, or farther than this, is implausible. */
export const MIN_PLAUSIBLE_SEPARATION_M = 2.0;
export const MAX_PLAUSIBLE_SEPARATION_M = 200.0;

export const RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR = "observed_divided_corridor";

export type Vec = { x: number; y: number };   // local metres: +x east, +y north

export type SeparationStats = { min?: number; max?: number; mean?: number; median?: number; stdev?: number; samples?: number };

export type DividedCorridorInput = {
  stationLon: number;
  stationLat: number;
  /** the derived midpoint corridor centreline */
  corridor: LonLat[];
  memberA: LonLat[];
  memberB: LonLat[];
  packagedSeparation?: SeparationStats | null;
  memberSourceFeatureIds?: string[] | null;
  memberPartFeatureIds?: string[] | null;
  featureId?: string | null;
};

export type MemberProjection = {
  lon: number;
  lat: number;
  /** signed offset along the cross-section axis, metres (A and B straddle 0) */
  offsetM: number;
  /** straight-line distance from the corridor station, metres */
  distanceFromStationM: number;
  tangent: Vec;
};

export type DividedCorridorInspection = {
  ok: true;
  featureId: string | null;
  selectionKind: "divided_highway_corridor";
  stationLon: number;
  stationLat: number;
  corridorTangent: Vec;
  memberA: MemberProjection;
  memberB: MemberProjection;
  /** axially averaged local tangent — NOT a travel direction */
  axialTangent: Vec;
  /** unit vector perpendicular to axialTangent, oriented A -> B */
  crossAxis: Vec;
  /** direct centreline-to-centreline distance, metres (OBSERVED) */
  separationM: number;
  /** separation measured along the cross axis, metres */
  separationAlongAxisM: number;
  packagedSeparation: SeparationStats | null;
  memberSourceFeatureIds: string[];
  memberPartFeatureIds: string[];
  /** section extent as signed offsets along crossAxis (includes both members + margins) */
  sectionMinOffsetM: number;
  sectionMaxOffsetM: number;
  sectionStart: LonLat;
  sectionEnd: LonLat;
  rendering: {
    rendering_mode: typeof RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR;
    /** the DEFAULT one-lane-each-way deck must never be drawn for a corridor */
    schematic_roadway_allowed: false;
    default_two_way_template_allowed: false;
  };
  observed: string[];
  unavailable: string[];
};

export type DividedCorridorFailure = { ok: false; reason: string };
export type DividedCorridorResult = DividedCorridorInspection | DividedCorridorFailure;

// ---- local metric frame -----------------------------------------------------

const cosLat = (lat: number) => Math.cos((lat * Math.PI) / 180) || 1e-9;
const toM = (lon: number, lat: number, lon0: number, lat0: number): Vec => ({
  x: (lon - lon0) * M_PER_DEG_LAT * cosLat(lat0),
  y: (lat - lat0) * M_PER_DEG_LAT,
});
const toLL = (v: Vec, lon0: number, lat0: number): LonLat => [
  lon0 + v.x / (M_PER_DEG_LAT * cosLat(lat0)),
  lat0 + v.y / M_PER_DEG_LAT,
];
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
const norm = (v: Vec) => Math.hypot(v.x, v.y);
const unit = (v: Vec): Vec | null => {
  const n = norm(v);
  return n > 1e-9 ? { x: v.x / n, y: v.y / n } : null;
};
/** bearing (deg, north-referenced) -> local unit vector */
const bearingToVec = (deg: number): Vec => ({ x: Math.sin((deg * Math.PI) / 180), y: Math.cos((deg * Math.PI) / 180) });

const validLine = (c: unknown): c is LonLat[] =>
  Array.isArray(c) && c.length >= 2 &&
  c.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

export const OBSERVED = [
  "Two packaged source carriageway centerlines",
  "Geometry-derived midpoint corridor centerline",
  "Measured centerline-to-centerline separation",
  "Packaged terrain elevation profile",
  "Packaged aerial imagery",
  "Geometry-derived orientation",
];

export const UNAVAILABLE = [
  "Pavement edges",
  "Carriageway width",
  "Lane count",
  "Lane width",
  "Inside/outside shoulder dimensions",
  "Median category",
  "Physical median width",
  "Concrete barrier presence",
  "Traffic direction",
  "Authoritative upstation",
];

/**
 * Build the divided-corridor inspection geometry at the selected midpoint-corridor station.
 * Returns `{ok:false, reason}` rather than ever fabricating a roadway.
 */
export function buildDividedCorridorInspection(input: DividedCorridorInput): DividedCorridorResult {
  const { stationLon: lon0, stationLat: lat0 } = input;
  if (!Number.isFinite(lon0) || !Number.isFinite(lat0)) return { ok: false, reason: "invalid_station" };
  if (!validLine(input.corridor)) return { ok: false, reason: "missing_corridor_geometry" };
  if (!validLine(input.memberA)) return { ok: false, reason: "missing_member_a_geometry" };
  if (!validLine(input.memberB)) return { ok: false, reason: "missing_member_b_geometry" };

  const srcIds = input.memberSourceFeatureIds ?? [];
  const partIds = input.memberPartFeatureIds ?? [];
  if (srcIds.length !== 2 || partIds.length !== 2) return { ok: false, reason: "unresolved_member_references" };

  // 1. local tangent of the SELECTED corridor at the station.
  const cProj = projectToPolyline(input.corridor, lon0, lat0);
  if (!cProj) return { ok: false, reason: "invalid_corridor_projection" };
  const corridorTangent = bearingToVec(cProj.tangentDeg);

  // 2-3. project the station onto each member (already clipped to this paired run) and
  // capture each member's LOCAL tangent there.
  const pa = projectToPolyline(input.memberA, lon0, lat0);
  const pb = projectToPolyline(input.memberB, lon0, lat0);
  if (!pa) return { ok: false, reason: "invalid_member_a_projection" };
  if (!pb) return { ok: false, reason: "invalid_member_b_projection" };

  // 4. AXIAL average: coordinate order must not matter, so align B's tangent into A's
  // hemisphere before averaging. This is an axis, never a travel direction.
  const tA = bearingToVec(pa.tangentDeg);
  let tB = bearingToVec(pb.tangentDeg);
  if (dot(tA, tB) < 0) tB = { x: -tB.x, y: -tB.y };
  const axialTangent = unit({ x: tA.x + tB.x, y: tA.y + tB.y });
  if (!axialTangent) return { ok: false, reason: "unstable_axial_tangent" };

  // 5. perpendicular cross axis, oriented deterministically from member A toward member B
  // so the signed offsets are stable.
  const va = toM(pa.snapLon, pa.snapLat, lon0, lat0);
  const vb = toM(pb.snapLon, pb.snapLat, lon0, lat0);
  let crossAxis: Vec = { x: axialTangent.y, y: -axialTangent.x };
  const aToB = { x: vb.x - va.x, y: vb.y - va.y };
  if (dot(crossAxis, aToB) < 0) crossAxis = { x: -crossAxis.x, y: -crossAxis.y };

  // 6. signed offsets + separations.
  const offsetA = dot(va, crossAxis);
  const offsetB = dot(vb, crossAxis);
  const separationM = norm(aToB);
  const separationAlongAxisM = Math.abs(offsetB - offsetA);

  // 7. fail-closed validation.
  if (!Number.isFinite(separationM)) return { ok: false, reason: "non_finite_separation" };
  if (separationM < MIN_PLAUSIBLE_SEPARATION_M || separationM > MAX_PLAUSIBLE_SEPARATION_M) {
    return { ok: false, reason: "implausible_separation" };
  }
  // The members must STRADDLE the derived corridor station — both on one side means the
  // midpoint does not sit between them and the "corridor" is not what it claims.
  if (!(offsetA < -STRADDLE_TOLERANCE_M && offsetB > STRADDLE_TOLERANCE_M)) {
    return { ok: false, reason: "members_do_not_straddle_station" };
  }
  const packaged = input.packagedSeparation ?? null;
  const ref = packaged?.median ?? packaged?.mean;
  if (typeof ref === "number" && Number.isFinite(ref) && ref > 0) {
    const tol = Math.max(SEPARATION_TOLERANCE_ABS_M, SEPARATION_TOLERANCE_FRAC * ref);
    if (Math.abs(separationM - ref) > tol) return { ok: false, reason: "separation_inconsistent_with_package" };
  }

  // 8. section extent: both members + bounded outside margins.
  const sectionMinOffsetM = Math.min(offsetA, offsetB) - OUTSIDE_MARGIN_M;
  const sectionMaxOffsetM = Math.max(offsetA, offsetB) + OUTSIDE_MARGIN_M;
  const sectionStart = toLL({ x: crossAxis.x * sectionMinOffsetM, y: crossAxis.y * sectionMinOffsetM }, lon0, lat0);
  const sectionEnd = toLL({ x: crossAxis.x * sectionMaxOffsetM, y: crossAxis.y * sectionMaxOffsetM }, lon0, lat0);

  return {
    ok: true,
    featureId: input.featureId ?? null,
    selectionKind: "divided_highway_corridor",
    stationLon: lon0,
    stationLat: lat0,
    corridorTangent,
    memberA: { lon: pa.snapLon, lat: pa.snapLat, offsetM: offsetA, distanceFromStationM: pa.distM, tangent: tA },
    memberB: { lon: pb.snapLon, lat: pb.snapLat, offsetM: offsetB, distanceFromStationM: pb.distM, tangent: tB },
    axialTangent,
    crossAxis,
    separationM,
    separationAlongAxisM,
    packagedSeparation: packaged,
    memberSourceFeatureIds: srcIds,
    memberPartFeatureIds: partIds,
    sectionMinOffsetM,
    sectionMaxOffsetM,
    sectionStart,
    sectionEnd,
    rendering: {
      rendering_mode: RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR,
      schematic_roadway_allowed: false,
      default_two_way_template_allowed: false,
    },
    observed: [...OBSERVED],
    unavailable: [...UNAVAILABLE],
  };
}

/** The ONLY sanctioned wording for the interval between the observed centrelines. */
export const MEDIAN_SEPARATION_LABEL = "Median / separation area";
export const MEDIAN_SEPARATION_DETAIL =
  "Interval between observed carriageway centerlines. Pavement edges and physical median width are unavailable.";
export const MEMBER_A_LABEL = "Observed carriageway centerline A";
export const MEMBER_B_LABEL = "Observed carriageway centerline B";

/** Compact provenance line for the persistent banner. */
export function provenanceSummary(m: DividedCorridorInspection, imageryProvider?: string | null, gsd?: number | null): string {
  const bits = [`Observed divided corridor • ${m.separationM.toFixed(1)} m centerline separation`];
  if (imageryProvider || (typeof gsd === "number" && gsd > 0)) {
    bits.push([imageryProvider || null, typeof gsd === "number" && gsd > 0 ? `${gsd.toFixed(2)} m/px` : null].filter(Boolean).join(" • "));
  }
  return bits.join("\n");
}
