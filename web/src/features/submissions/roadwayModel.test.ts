import assert from "node:assert/strict";
import test from "node:test";

import { buildRoadModel, measureEncroachment, roadEdges, roadwayFieldValues, type CenterLine, type CrossSection, type LonLat } from "./roadwayModel.ts";

// Local metres around a point on SR 1 in Marin, to [lon, lat].
const LON0 = -122.58;
const LAT0 = 37.86;
const at = (x: number, y: number): LonLat => [LON0 + x / (111_320 * Math.cos((LAT0 * Math.PI) / 180)), LAT0 + y / 110_540];
const rect = (x0: number, y0: number, x1: number, y1: number): LonLat[][] => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];
const FT = 0.3048;

// Digitized west to east (increasing postmile), so the right side (NB here) is south.
const straight: CenterLine = { coordinates: [at(-200, 0), at(0, 0), at(200, 0)], align: "Right", direction: "EB" };
const twoLane: CrossSection = {
  left: { lanes: 1, traveled_way_ft: 12, outside_shoulder_ft: 4, inside_shoulder_ft: 0 },
  right: { lanes: 1, traveled_way_ft: 12, outside_shoulder_ft: 8, inside_shoulder_ft: 0 },
  median_width_ft: 0,
  highway_group: "U",
};

test("a slide off the south side reaching into the right lane", () => {
  const road = buildRoadModel(twoLane, [straight]);
  assert.equal(road.assumed, false);
  // Shoulder is 8 ft wide beyond a 12 ft lane: the slide reaches 2 m from the centre line.
  const e = measureEncroachment(rect(0, -20, 30, -2), road);
  assert.ok(e);
  assert.ok(Math.abs(e.lengthM - 30) <= 1.5, `Lr ${e.lengthM}`);
  const expectedW = (12 + 8) * FT - 2;
  assert.ok(Math.abs(e.widthM - expectedW) < 0.4, `Wr ${e.widthM} vs ${expectedW}`);
  assert.ok(Math.abs(e.roadwayWidthM - (12 + 12 + 4 + 8) * FT) < 0.01);
  assert.deepEqual(e.bandsHit, ["EB lane 1", "EB shoulder"]);
  assert.equal(e.lanesHit, 1);
  assert.equal(e.lanesTotal, 2);
  assert.equal(e.shoulderOnly, false);
  const fields = roadwayFieldValues(e);
  assert.match(fields.measure_roadway_length_ft, /^\d+$/);
  assert.match(fields.measure_roadway_width_ft, /^\d+\.\d$/);
});

test("the length follows a curve, not the chord", () => {
  // A quarter circle of 100 m radius around (0, -100), from north to east.
  const arc: LonLat[] = [];
  for (let i = 0; i <= 90; i += 1) {
    const a = (i * Math.PI) / 180;
    arc.push(at(100 * Math.sin(a), -100 + 100 * Math.cos(a)));
  }
  const road = buildRoadModel(twoLane, [{ coordinates: arc, align: "Right", direction: "EB" }]);
  // A wedge from the centre covering 45 degrees of the bend, well beyond the road.
  const wedge: LonLat[] = [at(0, -100)];
  for (let i = 20; i <= 65; i += 1) {
    const a = (i * Math.PI) / 180;
    wedge.push(at(130 * Math.sin(a), -100 + 130 * Math.cos(a)));
  }
  wedge.push(at(0, -100));
  const e = measureEncroachment([wedge], road);
  assert.ok(e);
  const arcLength = 100 * (Math.PI / 4);
  assert.ok(Math.abs(e.lengthM - arcLength) < 2.5, `Lr ${e.lengthM} vs ${arcLength}`);
  // The whole roadway is covered.
  assert.ok(Math.abs(e.widthM - e.roadwayWidthM) < 0.6);
  assert.equal(e.lanesHit, 2);
});

test("a slide clear of the road measures nothing", () => {
  const road = buildRoadModel(twoLane, [straight]);
  assert.equal(measureEncroachment(rect(0, 20, 30, 40), road), null);
});

test("without an inventory row the road is assumed and says so", () => {
  const road = buildRoadModel(null, [straight]);
  assert.equal(road.assumed, true);
  assert.match(road.notes.join(" "), /assumed two 12 ft lanes/);
  // Stops 0.5 m short of the centre line, so only the south lane is reached.
  const e = measureEncroachment(rect(0, -20, 10, -0.5), road);
  assert.ok(e && e.lanesHit === 1 && Math.abs(e.roadwayWidthM - 24 * FT) < 0.01);
});

test("a road recorded all on one side is split about the centerline", () => {
  const oneSided: CrossSection = {
    left: { lanes: 0, traveled_way_ft: 0, outside_shoulder_ft: 2, inside_shoulder_ft: 0 },
    right: { lanes: 2, traveled_way_ft: 24, outside_shoulder_ft: 2, inside_shoulder_ft: 0 },
    median_width_ft: 0,
  };
  const road = buildRoadModel(oneSided, [straight]);
  const lanes = road.carriageways[0].bands.filter((b) => b.kind === "lane");
  assert.equal(lanes.length, 2);
  assert.ok(lanes.some((b) => b.to <= 0) && lanes.some((b) => b.from >= 0), "one lane either side");
  assert.match(road.notes.join(" "), /split evenly/);
});

test("a divided highway: each carriageway on its own line, shoulder-only encroachment", () => {
  const divided: CrossSection = {
    left: { lanes: 2, traveled_way_ft: 24, outside_shoulder_ft: 8, inside_shoulder_ft: 4 },
    right: { lanes: 2, traveled_way_ft: 24, outside_shoulder_ft: 10, inside_shoulder_ft: 4 },
    median_width_ft: 60,
  };
  const rightLine: CenterLine = { coordinates: [at(-200, -12), at(200, -12)], align: "Right", direction: "EB" };
  const leftLine: CenterLine = { coordinates: [at(200, 12), at(-200, 12)], align: "Left", direction: "WB" };
  const road = buildRoadModel(divided, [rightLine, leftLine]);
  assert.equal(road.carriageways.length, 2);
  // The right carriageway's outside shoulder lies south of its line: lanes 12 ft either side
  // of the line, then 10 ft of shoulder, so from 3.66 m to 6.71 m south of y = -12.
  const e = measureEncroachment(rect(0, -30, 20, -12 - 12 * FT - 1), road);
  assert.ok(e);
  assert.equal(e.shoulderOnly, true);
  assert.deepEqual(e.bandsHit, ["EB shoulder"]);
  assert.ok(Math.abs(e.widthM - (10 * FT - 1)) < 0.4, `Wr ${e.widthM}`);
  // The inside shoulder faces the median (north of the right line).
  const inside = road.carriageways[0].bands.find((b) => b.label.includes("inside"));
  assert.ok(inside && inside.from < 0, "inside shoulder toward the median");
});

test("road edges are drawn as offset lines", () => {
  const road = buildRoadModel(twoLane, [straight]);
  const edges = roadEdges(road);
  assert.equal(edges.filter((e) => e.kind === "edge").length, 2);
  assert.ok(edges.some((e) => e.kind === "centre"));
});
