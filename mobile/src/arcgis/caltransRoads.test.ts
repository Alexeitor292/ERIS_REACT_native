// Verifies the native offline road pipeline handles a Caltrans (caltrans_crs) roads.geojson
// exactly like any other `road_centerline` package: the ERIS-trusted `road_class` drives
// classification/selection, the extra Caltrans display properties (route_id / functional_class
// / functional_class_label / provider) are ignored by the selection logic, divided-corridor
// selection still works, and malformed metadata fails closed. These exercise the pure mirrors
// (roadClass.ts / roadSelection.ts) that are kept in lockstep with the Objective-C renderer.
//
// No react-native/expo imports (unit-tested under node --experimental-strip-types --test).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultDisplayMode,
  gatherCandidates,
  normalizeRoadClass,
  roadStyle,
  snapMaxMetersForClass,
  type SnapFeature,
} from "./roadClass.ts";
import {
  candidateLabel,
  featureRoadClass,
  hasSelectionSchema,
  isEligibleCandidate,
  parseSelection,
  rankCandidates,
} from "./roadSelection.ts";

// A normalized Caltrans road feature's `properties`, as packaged by the backend
// (offline_scene_caltrans.build_caltrans_properties) BEFORE divided-corridor pairing adds
// selection metadata. Note the identity split: `provider_object_id` is the provider's
// OBJECTID (provenance/pagination only) while `source_feature_id` is the DURABLE ERIS
// identity, which is a string and independent of OBJECTID reassignment.
function caltransProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_object_id: 477930,
    source_feature_id: "caltrans:9f2c1a77b4de3105c6a8b2e4",
    route_id: "SHS_050._P",
    NAME: "Route 50",
    functional_class: 1,
    functional_class_label: "Interstate",
    county: "SACRAMENTO",
    district: 3,
    provider: "caltrans_crs",
    road_class: "primary",
    road_class_label: "Primary road / highway",
    kind: "road_centerline",
    ...overrides,
  };
}

test("Caltrans highway props classify as primary via the ERIS-trusted road_class", () => {
  const p = caltransProps();
  assert.equal(featureRoadClass(p), "primary");
  assert.equal(normalizeRoadClass(p.road_class), "primary");
  // The interstate/freeway/arterial detail is preserved for display but never drives class.
  assert.equal(p.functional_class_label, "Interstate");
});

test("extra Caltrans display properties never affect classification or the selection schema", () => {
  // provider/route_id/functional_class are display metadata; only road_class matters.
  const spoof = caltransProps({ road_class: "secondary" });
  assert.equal(featureRoadClass(spoof), "secondary");
  // A feature with NO selection schema (pre-pairing) must not be treated as one.
  assert.equal(hasSelectionSchema(caltransProps()), false);
  // Unknown keys do not crash parseSelection.
  const info = parseSelection(caltransProps({ some_future_key: 1 }));
  assert.equal(info.selectable, false);
  assert.equal(info.hasSchema, false);
});

test("packaged Caltrans freeways default to Highways display mode", () => {
  assert.equal(defaultDisplayMode(["primary"]), "highways");
  assert.equal(defaultDisplayMode(["primary", "secondary"]), "highways");
});

test("an opt-in F_System 3 surface arterial is secondary, never a freeway candidate", () => {
  // The backend maps F_System 3 ("Principal Arterial - Other") to road_class "secondary",
  // so it is NOT presented or selected as a freeway in Highways mode.
  const arterial = caltransProps({
    functional_class: 3,
    functional_class_label: "Principal Arterial - Other",
    road_class: "secondary",
    road_class_label: "Secondary road",
    NAME: "Route 49",
  });
  assert.equal(featureRoadClass(arterial), "secondary");
  const snap: SnapFeature = {
    roadClass: "secondary", kind: "road_centerline", name: "Route 49",
    distM: 5, snapLat: 38.5, snapLon: -121.5,
  };
  assert.deepEqual(gatherCandidates([snap], "highways"), []); // not a highway candidate
  assert.equal(gatherCandidates([snap], "highways_secondary").length, 1); // still selectable
});

test("highway-first selection prefers a Caltrans highway over a nearer non-highway", () => {
  const highway: SnapFeature = {
    roadClass: "primary", kind: "road_centerline", name: "Route 50",
    distM: 40, snapLat: 38.5, snapLon: -121.5,
  };
  const arterial: SnapFeature = {
    roadClass: "secondary", kind: "road_centerline", name: "Some Blvd",
    distM: 8, snapLat: 38.5001, snapLon: -121.5001,
  };
  const out = gatherCandidates([arterial, highway], "highways");
  assert.equal(out.length, 1); // secondary is not eligible in "highways" mode
  assert.equal(out[0].roadClass, "primary");
  assert.equal(out[0].name, "Route 50");
});

test("Caltrans primary uses the widest style + most generous snap tolerance", () => {
  const style = roadStyle("primary");
  assert.equal(style.widthM, 9.0);
  assert.equal(snapMaxMetersForClass("primary"), 90);
});

test("a divided_highway_corridor derived from Caltrans _P/_S carriageways is selectable + labelled", () => {
  // After pairing, a corridor feature carries the additive selection schema plus the same
  // Caltrans display props. It must remain selectable and human-labelled.
  const corridor = caltransProps({
    selection_kind: "divided_highway_corridor",
    selectable: true,
    feature_id: "corridor-1",
    // Pairing-derived ids ("r"/"p" + hash), never provider OBJECTIDs.
    member_source_feature_ids: ["r8129076df999", "r8343c6f29897"],
    member_part_feature_ids: ["pa7bbf53e0041", "pf7e341870b32"],
  });
  const info = parseSelection(corridor);
  assert.equal(info.selectable, true);
  assert.equal(info.selectionKind, "divided_highway_corridor");
  assert.equal(candidateLabel(corridor), "Divided highway corridor");
  assert.equal(isEligibleCandidate(corridor), true);
});

test("an ordinary Caltrans road shows its route name in the candidate label", () => {
  const road = caltransProps({ selection_kind: "ordinary_road", selectable: true });
  assert.equal(candidateLabel(road), "Route 50"); // from NAME
});

test("malformed Caltrans selection metadata fails closed (never a silent candidate)", () => {
  // selection_kind present but selectable not exactly true -> not selectable.
  const bad = caltransProps({ selection_kind: "divided_highway_corridor", selectable: "yes" });
  assert.equal(parseSelection(bad).selectable, false);
  assert.equal(isEligibleCandidate(bad), false);
  // An unknown selection_kind is not selectable either.
  const unknown = caltransProps({ selection_kind: "teleporter", selectable: true });
  assert.equal(parseSelection(unknown).selectable, false);
});

test("ranking keeps a corridor above an individual carriageway of the same class", () => {
  const corridor = { props: caltransProps({ selection_kind: "divided_highway_corridor", selectable: true }), distM: 30, order: 0 };
  const carriageway = { props: caltransProps({ selection_kind: "individual_carriageway", selectable: true }), distM: 5, order: 1 };
  const ranked = rankCandidates([carriageway, corridor]);
  assert.equal(parseSelection(ranked[0].props).selectionKind, "divided_highway_corridor");
});

test("a package without any roads (empty feature set) selects nothing safely", () => {
  assert.deepEqual(gatherCandidates([], "highways"), []);
  assert.equal(defaultDisplayMode([]), "all");
});
