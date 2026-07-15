// Pure road-classification + highway-first candidate-selection reference logic. This is
// the TESTED mirror of the Objective-C in ErisTerrainSceneViewController.m
// (ErisRoadClassLabel / ErisRoadClassPriority / ErisRoadStyleForClass /
// ErisSnapMaxMetersForClass / gatherCandidatesAtLat:) — keep the two in lockstep.
//
// The class is the ERIS-GENERATED road_class from PR #50 ("primary"/"secondary"/
// "local"); a legacy package with no road_class is honestly "unclassified" (never a
// silent highway). Provider attributes (NAME/MTFCC/RTTYP/BASENAME/source_layer_id) are
// DISPLAY metadata only and never drive classification or selection.
//
// No react-native/expo imports (unit-tested under node --test).

export type RoadClass = "primary" | "secondary" | "local" | "unclassified";

export const ROAD_CLASS_LABELS: Record<RoadClass, string> = {
  primary: "Primary road / highway",
  secondary: "Secondary road",
  local: "Local road",
  unclassified: "Unclassified road",
};

/** Normalize an arbitrary road_class value to a known class ("unclassified" if absent). */
export function normalizeRoadClass(value: unknown): RoadClass {
  return value === "primary" || value === "secondary" || value === "local" ? value : "unclassified";
}

export function roadClassLabel(rc: unknown): string {
  return ROAD_CLASS_LABELS[normalizeRoadClass(rc)];
}

/** Selection/dedupe priority: primary > secondary > local > unclassified. */
export function roadClassPriority(rc: unknown): number {
  return { primary: 3, secondary: 2, local: 1, unclassified: 0 }[normalizeRoadClass(rc)];
}

// Class render style (width/opacity hierarchy in addition to colour). Mirrors
// ErisRoadStyleForClass. Higher classes are wider + more opaque + drawn on top.
export type RoadStyle = { widthM: number; opacity: number; order: number; liftM: number };
export const ROAD_STYLES: Record<RoadClass, RoadStyle> = {
  primary: { widthM: 9.0, opacity: 1.0, order: 40, liftM: 0.36 },
  secondary: { widthM: 5.0, opacity: 0.92, order: 30, liftM: 0.33 },
  local: { widthM: 2.5, opacity: 0.68, order: 20, liftM: 0.3 },
  unclassified: { widthM: 3.5, opacity: 0.85, order: 25, liftM: 0.31 },
};
export function roadStyle(rc: unknown): RoadStyle {
  return ROAD_STYLES[normalizeRoadClass(rc)];
}

// Per-class snap tolerance (metres). Highways get a generous tolerance for divided
// carriageways + generalized TIGER geometry; locals a tight one. Mirrors the
// kErisSnapMax*M constants.
export const SNAP_MAX_M: Record<RoadClass, number> = {
  primary: 90,
  secondary: 65,
  local: 45,
  unclassified: 45,
};
export function snapMaxMetersForClass(rc: unknown): number {
  return SNAP_MAX_M[normalizeRoadClass(rc)];
}

export const MAX_CANDIDATES = 3;

// Road Display / selection mode (which classes are visible + selectable). Mirrors
// ErisRoadDisplayMode.
export type RoadDisplayMode = "highways" | "highways_secondary" | "all";

/** Whether a class is eligible under a selection mode. */
export function classEligible(rc: unknown, mode: RoadDisplayMode): boolean {
  const p = roadClassPriority(rc);
  if (mode === "highways") return p >= 3; // primary only
  if (mode === "highways_secondary") return p >= 2; // primary + secondary
  return true; // all incl. local/unclassified
}

/** Default Road Display: Highways when primary roads are packaged, else All roads. */
export function defaultDisplayMode(packagedClasses: Iterable<string>): RoadDisplayMode {
  return [...packagedClasses].some((c) => normalizeRoadClass(c) === "primary") ? "highways" : "all";
}

export type SnapFeature = {
  roadClass?: string;
  name?: string;
  kind?: string;
  /** projected snap for this feature: distance (m), and snap point/tangent (opaque here). */
  distM: number;
  snapLat: number;
  snapLon: number;
  tangentDeg?: number;
};

export type Candidate = SnapFeature & { roadClass: RoadClass; priority: number; order: number };

/**
 * HIGHWAY-FIRST candidate selection (pure mirror of gatherCandidatesAtLat:). Given each
 * eligible road feature's projected snap, keep it only if within ITS class tolerance and
 * allowed by the mode, then rank deterministically by (1) class priority DESC — so a
 * closer local can never out-rank an eligible highway — (2) distance ASC, (3) stable
 * source order, dedup near-identical lines, and cap at MAX_CANDIDATES.
 * `road_bearing` features are never class candidates (they are a separate fallback).
 */
export function gatherCandidates(features: SnapFeature[], mode: RoadDisplayMode): Candidate[] {
  const eligible: Candidate[] = [];
  features.forEach((f, order) => {
    if (f.kind === "road_bearing") return;
    const rc = normalizeRoadClass(f.roadClass);
    if (!classEligible(rc, mode)) return; // never snap to a non-selected class
    if (!(f.distM <= snapMaxMetersForClass(rc))) return; // per-class tolerance
    eligible.push({ ...f, roadClass: rc, priority: roadClassPriority(rc), order });
  });
  eligible.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // higher class first
    if (Math.abs(a.distM - b.distM) > 1e-6) return a.distM - b.distM;
    return a.order - b.order; // stable source order
  });
  const out: Candidate[] = [];
  for (const c of eligible) {
    const dup = out.some((k) => k.roadClass === c.roadClass && metersBetween(k.snapLat, k.snapLon, c.snapLat, c.snapLon) < 8);
    if (!dup) out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

const M_PER_DEG_LAT = 111_320.0;
export function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const mLat = (aLat + bLat) / 2;
  const dN = (bLat - aLat) * M_PER_DEG_LAT;
  const dE = (bLon - aLon) * M_PER_DEG_LAT * Math.cos((mLat * Math.PI) / 180);
  return Math.hypot(dN, dE);
}
