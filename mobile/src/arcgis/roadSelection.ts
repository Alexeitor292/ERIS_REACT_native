// Pure reference logic for the ADDITIVE divided-highway selection schema packaged by the
// worker (see docs/adr-divided-highway-corridor-pairing.md). This is the TESTED mirror of
// the Objective-C in ErisTerrainSceneViewController.m — keep the two in lockstep.
//
// Contract highlights:
//  * `selection_kind` holds EXACTLY four selectable candidate kinds; a diagnostics role
//    lives in `diagnostic_kind` and is never a candidate;
//  * only a real `road_centerline` may carry a selection_kind — ERIS context geometry
//    (road_bearing / road_inventory / submitted_road_geometry) stays packaged and usable
//    for orientation/context but is NEVER a road candidate;
//  * a legacy package (no selection schema at all) keeps the previous class-aware
//    behaviour — no package migration;
//  * malformed metadata FAILS CLOSED for that feature (never selectable, never a crash).
//
// No react-native/expo imports (unit-tested under node --test).

import { normalizeRoadClass, roadClassPriority, type RoadClass } from "./roadClass.ts";

export type SelectionKind = "divided_highway_corridor" | "individual_carriageway" | "ordinary_road" | "ramp";

export const SELECTABLE_KINDS: readonly SelectionKind[] = [
  "divided_highway_corridor",
  "individual_carriageway",
  "ordinary_road",
  "ramp",
];

export const DIAGNOSTIC_CARRIAGEWAY_MEMBER = "carriageway_member";
export const ROAD_CENTERLINE_KIND = "road_centerline";

/** Ranking WITHIN eligible primary features: corridor > individual roadway > ramp. */
export const SELECTION_RANK: Record<SelectionKind, number> = {
  divided_highway_corridor: 3,
  individual_carriageway: 2,
  ramp: 1,
  ordinary_road: 0,
};

export type RoadProps = Record<string, unknown>;

export type SelectionInfo = {
  /** One of the four, or null for diagnostics/context/legacy-unknown. */
  selectionKind: SelectionKind | null;
  selectable: boolean;
  diagnosticKind: string | null;
  diagnostic: boolean;
  /** True when this feature carries the additive selection schema at all. */
  hasSchema: boolean;
  featureId: string | null;
  sourceFeatureId: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function asSelectionKind(v: unknown): SelectionKind | null {
  return typeof v === "string" && (SELECTABLE_KINDS as readonly string[]).includes(v) ? (v as SelectionKind) : null;
}

/** Whether a feature carries the additive schema (an explicit null still counts). */
export function hasSelectionSchema(props: RoadProps | null | undefined): boolean {
  if (!props || typeof props !== "object") return false;
  return "selection_kind" in props || "diagnostic_kind" in props || "selectable" in props;
}

/** Whether the PACKAGE uses the new schema (authoritative when any feature declares it). */
export function packageUsesSelectionSchema(features: { properties?: RoadProps }[] | null | undefined): boolean {
  return (features ?? []).some((f) => hasSelectionSchema(f?.properties));
}

/**
 * Parse the selection role of one feature. Fails CLOSED: an unknown/malformed
 * `selection_kind`, or `selectable` that is not exactly `true`, yields a non-selectable
 * feature rather than a guess.
 */
export function parseSelection(props: RoadProps | null | undefined): SelectionInfo {
  const p = (props ?? {}) as RoadProps;
  const hasSchema = hasSelectionSchema(p);
  const kind = asSelectionKind(p.selection_kind);
  const diagnosticKind = str(p.diagnostic_kind);
  // `selectable` must be EXACTLY true, and the kind must be one of the four.
  const selectable = hasSchema ? p.selectable === true && kind !== null : false;
  return {
    selectionKind: kind,
    selectable,
    diagnosticKind,
    diagnostic: p.diagnostic === true || diagnosticKind !== null,
    hasSchema,
    featureId: str(p.feature_id),
    sourceFeatureId: str(p.source_feature_id),
  };
}

/** A diagnostics-only raw carriageway member — rendered only in the diagnostics layer. */
export function isDiagnosticMember(props: RoadProps | null | undefined): boolean {
  return str((props ?? {}).diagnostic_kind) === DIAGNOSTIC_CARRIAGEWAY_MEMBER;
}

/** A retained non-candidate context line (road_bearing / road_inventory / submitted / ...). */
export function isContextFeature(props: RoadProps | null | undefined): boolean {
  const info = parseSelection(props);
  if (!info.hasSchema) return false;
  return !info.selectable && !info.diagnostic;
}

/**
 * Candidate eligibility.
 *  * New schema  -> selectable === true AND selection_kind is one of the four.
 *  * Legacy      -> the previous class-aware behaviour: any road_centerline line.
 * Context features and diagnostics members are NEVER candidates.
 */
export function isEligibleCandidate(props: RoadProps | null | undefined, legacyPackage = false): boolean {
  const p = (props ?? {}) as RoadProps;
  if (hasSelectionSchema(p)) return parseSelection(p).selectable;
  if (!legacyPackage) return false; // a schema package must not silently admit unschema'd features
  // Legacy fallback: only real centerlines were ever candidates.
  return p.kind === ROAD_CENTERLINE_KIND || p.kind === undefined;
}

/** Human label for a candidate. Never claims a compass direction or one-way status. */
export function candidateLabel(props: RoadProps | null | undefined): string {
  const p = (props ?? {}) as RoadProps;
  switch (parseSelection(p).selectionKind) {
    case "divided_highway_corridor":
      return "Divided highway corridor";
    case "individual_carriageway":
      return "Individual highway roadway"; // NOT eastbound/westbound — no authoritative direction
    case "ramp":
      return "Ramp";
    case "ordinary_road":
    default:
      return str(p.NAME) ?? "Road";
  }
}

// ---- corridor references ----------------------------------------------------

export type CorridorRefs = {
  memberSourceFeatureIds: string[];
  memberPartFeatureIds: string[];
  memberGeometry: { a: [number, number][]; b: [number, number][] } | null;
  memberGeometryKind: string | null;
  separationM: Record<string, number> | null;
  corridorLengthM: number | null;
  orientationDeg: number | null;
  orientationSource: string | null;
  pairingMethod: string | null;
  pairingVersion: number | null;
};

const coordList = (v: unknown): [number, number][] =>
  Array.isArray(v)
    ? v.filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [Number(c[0]), Number(c[1])] as [number, number])
    : [];

/**
 * Parse a divided corridor's relationships. Returns null when the feature is not a corridor
 * or its member references are malformed (FAIL CLOSED — never a half-built corridor).
 */
export function parseCorridorRefs(props: RoadProps | null | undefined): CorridorRefs | null {
  const p = (props ?? {}) as RoadProps;
  if (parseSelection(p).selectionKind !== "divided_highway_corridor") return null;
  const sources = Array.isArray(p.member_source_feature_ids) ? p.member_source_feature_ids.filter((x) => typeof x === "string") : [];
  const parts = Array.isArray(p.member_part_feature_ids) ? p.member_part_feature_ids.filter((x) => typeof x === "string") : [];
  if (sources.length !== 2 || parts.length !== 2) return null; // malformed -> fail closed
  const mg = p.member_geometry as { a?: unknown; b?: unknown } | undefined;
  const a = coordList(mg?.a);
  const b = coordList(mg?.b);
  const pairing = (p.pairing ?? {}) as Record<string, unknown>;
  return {
    memberSourceFeatureIds: sources as string[],
    memberPartFeatureIds: parts as string[],
    memberGeometry: a.length >= 2 && b.length >= 2 ? { a, b } : null,
    memberGeometryKind: str(p.member_geometry_kind),
    separationM: (p.separation_m as Record<string, number>) ?? null,
    corridorLengthM: typeof p.corridor_length_m === "number" ? p.corridor_length_m : null,
    orientationDeg: typeof p.orientation_deg === "number" ? p.orientation_deg : null,
    orientationSource: str(p.orientation_source),
    pairingMethod: str(pairing.method),
    pairingVersion: typeof pairing.version === "number" ? pairing.version : null,
  };
}

/** Orientation may only be called authoritative when Road Inventory supplied it. */
export function orientationIsAuthoritative(props: RoadProps | null | undefined): boolean {
  return str((props ?? {}).orientation_source) === "road_inventory";
}

// ---- ranking ----------------------------------------------------------------

export type RankableCandidate = {
  props: RoadProps;
  distM: number;
  /** stable source order from the packaged feature list */
  order: number;
};

/**
 * Deterministic candidate ranking:
 *   1. road class (primary > secondary > local > unclassified);
 *   2. WITHIN a class, selection rank: divided corridor > individual roadway > ramp;
 *      so a ramp can never displace an eligible corridor or mainline roadway merely
 *      because both carry road_class "primary";
 *   3. distance;
 *   4. stable source order.
 */
export function rankCandidates<T extends RankableCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((x, y) => {
    const cx = roadClassPriority((x.props as { road_class?: unknown }).road_class);
    const cy = roadClassPriority((y.props as { road_class?: unknown }).road_class);
    if (cx !== cy) return cy - cx;
    const sx = SELECTION_RANK[parseSelection(x.props).selectionKind ?? "ordinary_road"];
    const sy = SELECTION_RANK[parseSelection(y.props).selectionKind ?? "ordinary_road"];
    if (sx !== sy) return sy - sx;
    if (Math.abs(x.distM - y.distM) > 1e-6) return x.distM - y.distM;
    return x.order - y.order;
  });
}

/** The road class of a feature (trusted ERIS field only). */
export function featureRoadClass(props: RoadProps | null | undefined): RoadClass {
  return normalizeRoadClass((props ?? {}).road_class);
}
