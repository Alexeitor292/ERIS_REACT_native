// Tests for the road-classification + highway-first candidate-selection reference logic.
// Mirrors the Objective-C in ErisTerrainSceneViewController.m. Run:
//   node --test src/arcgis/roadClass.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classEligible,
  defaultDisplayMode,
  gatherCandidates,
  MAX_CANDIDATES,
  normalizeRoadClass,
  roadClassLabel,
  roadClassPriority,
  roadStyle,
  snapMaxMetersForClass,
  type SnapFeature,
} from "./roadClass.ts";

// ---- Part 12: Road classes -------------------------------------------------

test("primary/secondary/local/unclassified survive parsing with the right labels", () => {
  assert.equal(normalizeRoadClass("primary"), "primary");
  assert.equal(normalizeRoadClass("secondary"), "secondary");
  assert.equal(normalizeRoadClass("local"), "local");
  assert.equal(roadClassLabel("primary"), "Primary road / highway");
  assert.equal(roadClassLabel("secondary"), "Secondary road");
  assert.equal(roadClassLabel("local"), "Local road");
});

test("legacy / missing road_class degrades to unclassified (never a silent highway)", () => {
  assert.equal(normalizeRoadClass(undefined), "unclassified");
  assert.equal(normalizeRoadClass(null), "unclassified");
  assert.equal(normalizeRoadClass("motorway"), "unclassified"); // unknown value
  assert.equal(normalizeRoadClass(2), "unclassified"); // a numeric layer id is not a class
  assert.equal(roadClassLabel(undefined), "Unclassified road");
});

test("priority orders primary > secondary > local > unclassified", () => {
  assert.ok(roadClassPriority("primary") > roadClassPriority("secondary"));
  assert.ok(roadClassPriority("secondary") > roadClassPriority("local"));
  assert.ok(roadClassPriority("local") > roadClassPriority("unclassified"));
});

test("primary renders above and more prominently than local (width/opacity/order)", () => {
  const p = roadStyle("primary");
  const l = roadStyle("local");
  assert.ok(p.widthM > l.widthM, "primary is wider");
  assert.ok(p.opacity > l.opacity, "primary is more opaque");
  assert.ok(p.order > l.order, "primary renders on top");
  // hierarchy is monotonic primary > secondary > local
  assert.ok(roadStyle("primary").widthM > roadStyle("secondary").widthM);
  assert.ok(roadStyle("secondary").widthM > roadStyle("local").widthM);
});

test("class filter changes eligibility; default is Highways when primary is packaged", () => {
  assert.equal(classEligible("primary", "highways"), true);
  assert.equal(classEligible("local", "highways"), false);
  assert.equal(classEligible("secondary", "highways_secondary"), true);
  assert.equal(classEligible("local", "highways_secondary"), false);
  assert.equal(classEligible("local", "all"), true);
  assert.equal(defaultDisplayMode(["primary", "local"]), "highways");
  assert.equal(defaultDisplayMode(["local"]), "all"); // legacy/unclassified -> all
  assert.equal(defaultDisplayMode(["unclassified"]), "all");
});

// ---- Part 12: Snapping -----------------------------------------------------

const primaryFar: SnapFeature = { roadClass: "primary", name: "US-50", kind: "road_centerline", distM: 80, snapLat: 38.5, snapLon: -121.5 };
const localNear: SnapFeature = { roadClass: "local", name: "Oak St", kind: "road_centerline", distM: 5, snapLat: 38.5002, snapLon: -121.5002 };

test("Highway mode cannot select a closer local street", () => {
  const cands = gatherCandidates([localNear, primaryFar], "highways");
  assert.equal(cands.length, 1);
  assert.equal(cands[0].roadClass, "primary");
  assert.equal(cands[0].name, "US-50");
});

test("even in All Roads mode, an eligible highway out-ranks a closer local (highway-first)", () => {
  const cands = gatherCandidates([localNear, primaryFar], "all");
  assert.equal(cands[0].roadClass, "primary", "primary ranks first despite being farther");
  assert.ok(cands.some((c) => c.roadClass === "local"), "the local is still offered as an alternative");
});

test("primary within 90 m is eligible; a local beyond its 45 m tolerance is rejected", () => {
  assert.equal(snapMaxMetersForClass("primary"), 90);
  assert.equal(snapMaxMetersForClass("local"), 45);
  assert.equal(gatherCandidates([{ ...primaryFar, distM: 89 }], "highways").length, 1);
  assert.equal(gatherCandidates([{ ...primaryFar, distM: 91 }], "highways").length, 0);
  assert.equal(gatherCandidates([{ ...localNear, distM: 50 }], "all").length, 0, "local at 50 m > 45 m rejected");
  assert.equal(gatherCandidates([{ ...localNear, distM: 40 }], "all").length, 1);
});

test("candidate ordering is deterministic (class, then distance, then source order)", () => {
  const a: SnapFeature = { roadClass: "secondary", name: "A", distM: 30, snapLat: 38.5, snapLon: -121.5 };
  const b: SnapFeature = { roadClass: "secondary", name: "B", distM: 20, snapLat: 38.51, snapLon: -121.51 };
  const c: SnapFeature = { roadClass: "primary", name: "C", distM: 60, snapLat: 38.52, snapLon: -121.52 };
  const ranked = gatherCandidates([a, b, c], "all").map((x) => x.name);
  assert.deepEqual(ranked, ["C", "B", "A"]); // primary first, then nearer secondary
  // Deterministic across input permutations.
  const ranked2 = gatherCandidates([c, a, b], "all").map((x) => x.name);
  assert.deepEqual(ranked2, ["C", "B", "A"]);
});

test("metadata + snap distance reach the confirmation candidate", () => {
  const cands = gatherCandidates([primaryFar], "highways");
  assert.equal(cands[0].name, "US-50");
  assert.equal(cands[0].distM, 80);
  assert.equal(roadClassLabel(cands[0].roadClass), "Primary road / highway");
});

test("no silent wrong-class snap: Highway mode near only a local returns nothing", () => {
  assert.deepEqual(gatherCandidates([localNear], "highways"), []);
});

test("bearing features are never class candidates; candidate set is bounded + deduped", () => {
  assert.deepEqual(gatherCandidates([{ roadClass: "unclassified", kind: "road_bearing", distM: 1, snapLat: 38.5, snapLon: -121.5 }], "all"), []);
  // Five distinct nearby primaries -> capped at MAX_CANDIDATES.
  const many: SnapFeature[] = Array.from({ length: 5 }, (_, i) => ({
    roadClass: "primary",
    name: `P${i}`,
    distM: 10 + i,
    snapLat: 38.5 + i * 0.001,
    snapLon: -121.5 + i * 0.001,
  }));
  assert.equal(gatherCandidates(many, "highways").length, MAX_CANDIDATES);
  // Two near-identical primaries (< 8 m apart) dedup to one.
  const dupA: SnapFeature = { roadClass: "primary", name: "US-50", distM: 12, snapLat: 38.5, snapLon: -121.5 };
  const dupB: SnapFeature = { roadClass: "primary", name: "US-50", distM: 13, snapLat: 38.50002, snapLon: -121.50002 };
  assert.equal(gatherCandidates([dupA, dupB], "highways").length, 1);
});
