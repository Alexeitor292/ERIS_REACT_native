// Tests for the additive divided-highway selection schema reader.
// Run: node --test src/arcgis/roadSelection.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateLabel,
  DIAGNOSTIC_CARRIAGEWAY_MEMBER,
  hasSelectionSchema,
  isContextFeature,
  isDiagnosticMember,
  isEligibleCandidate,
  orientationIsAuthoritative,
  packageUsesSelectionSchema,
  parseCorridorRefs,
  parseSelection,
  rankCandidates,
  SELECTABLE_KINDS,
} from "./roadSelection.ts";

const corridor = {
  kind: "road_centerline", road_class: "primary", NAME: "US-50",
  selection_kind: "divided_highway_corridor", selectable: true, diagnostic: false,
  feature_id: "c111", member_source_feature_ids: ["rA", "rB"], member_part_feature_ids: ["pA", "pB"],
  member_geometry: { a: [[-121.5, 38.5], [-121.49, 38.5]], b: [[-121.5, 38.5002], [-121.49, 38.5002]] },
  member_geometry_kind: "observed_source_centerlines_clipped_to_run",
  separation_m: { mean: 22.3, min: 21.0, max: 23.4, samples: 40 },
  corridor_length_m: 570.0, orientation_deg: 90.0, orientation_source: "geometry_derived",
  pairing: { method: "station_local_mutual_nearest", version: 1 },
};
const individual = { kind: "road_centerline", road_class: "primary", NAME: "US-50", selection_kind: "individual_carriageway", selectable: true, diagnostic: false, feature_id: "p2", source_feature_id: "rA" };
const ramp = { kind: "road_centerline", road_class: "primary", NAME: "Ramp 12A", MTFCC: "S1630", selection_kind: "ramp", selectable: true, diagnostic: false, feature_id: "p3" };
const ordinary = { kind: "road_centerline", road_class: "local", NAME: "Oak St", selection_kind: "ordinary_road", selectable: true, diagnostic: false, feature_id: "p4" };
const member = { kind: "road_centerline", road_class: "primary", selection_kind: null, diagnostic_kind: DIAGNOSTIC_CARRIAGEWAY_MEMBER, selectable: false, diagnostic: true, feature_id: "pA", source_feature_id: "rA" };
const bearing = { kind: "road_bearing", bearing_deg: 90, selection_kind: null, selectable: false, diagnostic: false, feature_id: "p9", source_feature_id: "rZ" };
const inventory = { kind: "road_inventory", route_name: "50", selection_kind: null, selectable: false, diagnostic: false, feature_id: "p10" };
const legacy = { kind: "road_centerline", road_class: "primary", NAME: "US-50" }; // no schema at all

test("the four selectable kinds are exactly the accepted enum", () => {
  assert.deepEqual([...SELECTABLE_KINDS].sort(), ["divided_highway_corridor", "individual_carriageway", "ordinary_road", "ramp"]);
});

test("eligible candidates require selectable:true AND a valid selection_kind", () => {
  for (const f of [corridor, individual, ramp, ordinary]) assert.equal(isEligibleCandidate(f), true, JSON.stringify(f.selection_kind));
  assert.equal(isEligibleCandidate(member), false, "a diagnostics member is never a candidate");
  assert.equal(isEligibleCandidate(bearing), false, "road_bearing is never a candidate");
  assert.equal(isEligibleCandidate(inventory), false, "road_inventory is never a candidate");
});

test("diagnostics members and context features are classified distinctly", () => {
  assert.equal(isDiagnosticMember(member), true);
  assert.equal(isDiagnosticMember(bearing), false);
  assert.equal(isContextFeature(bearing), true);
  assert.equal(isContextFeature(inventory), true);
  assert.equal(isContextFeature(member), false, "a diagnostics member is not a context feature");
  assert.equal(isContextFeature(corridor), false);
});

test("malformed metadata FAILS CLOSED (never selectable, never throws)", () => {
  assert.equal(isEligibleCandidate({ selection_kind: "motorway", selectable: true }), false, "unknown kind");
  assert.equal(isEligibleCandidate({ selection_kind: "ramp", selectable: "yes" }), false, "selectable must be exactly true");
  assert.equal(isEligibleCandidate({ selection_kind: "ramp" }), false, "missing selectable");
  assert.equal(isEligibleCandidate({ selection_kind: 7, selectable: true }), false);
  assert.doesNotThrow(() => parseSelection(null));
  assert.doesNotThrow(() => parseSelection(undefined));
  assert.equal(parseSelection(null).selectable, false);
});

test("legacy packages (no schema) keep the previous class-aware behaviour", () => {
  assert.equal(hasSelectionSchema(legacy), false);
  assert.equal(packageUsesSelectionSchema([{ properties: legacy }]), false);
  assert.equal(packageUsesSelectionSchema([{ properties: legacy }, { properties: corridor }]), true);
  // In a legacy package a plain centerline is still selectable...
  assert.equal(isEligibleCandidate(legacy, true), true);
  // ...but in a schema package an unschema'd feature is not silently admitted.
  assert.equal(isEligibleCandidate(legacy, false), false);
});

test("labels never claim a compass direction or one-way status", () => {
  assert.equal(candidateLabel(corridor), "Divided highway corridor");
  assert.equal(candidateLabel(individual), "Individual highway roadway");
  assert.equal(candidateLabel(ramp), "Ramp");
  assert.equal(candidateLabel(ordinary), "Oak St");
  for (const bad of ["eastbound", "westbound", "northbound", "southbound"]) {
    assert.ok(!candidateLabel(individual).toLowerCase().includes(bad), `label must not say ${bad}`);
  }
});

test("corridor references parse, and malformed member refs fail closed", () => {
  const refs = parseCorridorRefs(corridor)!;
  assert.deepEqual(refs.memberSourceFeatureIds, ["rA", "rB"]);
  assert.deepEqual(refs.memberPartFeatureIds, ["pA", "pB"]);
  assert.equal(refs.memberGeometry!.a.length, 2);
  assert.equal(refs.memberGeometryKind, "observed_source_centerlines_clipped_to_run");
  assert.equal(refs.separationM!.mean, 22.3);
  assert.equal(refs.pairingMethod, "station_local_mutual_nearest");
  assert.equal(refs.pairingVersion, 1);
  assert.equal(parseCorridorRefs(individual), null, "not a corridor");
  assert.equal(parseCorridorRefs({ ...corridor, member_source_feature_ids: ["rA"] }), null, "one member -> fail closed");
  assert.equal(parseCorridorRefs({ ...corridor, member_part_feature_ids: [] }), null, "no parts -> fail closed");
});

test("orientation is only authoritative when Road Inventory supplied it", () => {
  assert.equal(orientationIsAuthoritative(corridor), false, "geometry_derived is NOT authoritative");
  assert.equal(orientationIsAuthoritative({ orientation_source: "road_inventory" }), true);
});

test("a ramp can never displace an eligible corridor or mainline roadway", () => {
  // The ramp is much closer, but all three are road_class primary.
  const ranked = rankCandidates([
    { props: ramp, distM: 3, order: 0 },
    { props: corridor, distM: 70, order: 1 },
    { props: individual, distM: 40, order: 2 },
  ]);
  assert.deepEqual(ranked.map((r) => parseSelection(r.props).selectionKind), [
    "divided_highway_corridor", "individual_carriageway", "ramp",
  ]);
});

test("ranking: class first, then selection rank, then distance, then source order", () => {
  const a = { props: individual, distM: 30, order: 0 };
  const b = { props: individual, distM: 10, order: 1 };
  const c = { props: ordinary, distM: 1, order: 2 }; // local class -> always after primary
  assert.deepEqual(rankCandidates([a, b, c]).map((r) => r.order), [1, 0, 2]);
  // stable source order breaks an exact tie
  const t1 = { props: individual, distM: 10, order: 5 };
  const t2 = { props: individual, distM: 10, order: 3 };
  assert.deepEqual(rankCandidates([t1, t2]).map((r) => r.order), [3, 5]);
});

test("a corridor is one candidate — its two members are never offered underneath it", () => {
  const features = [corridor, member, { ...member, feature_id: "pB", source_feature_id: "rB" }];
  const candidates = features.filter((f) => isEligibleCandidate(f));
  assert.equal(candidates.length, 1);
  assert.equal(parseSelection(candidates[0]).selectionKind, "divided_highway_corridor");
});
