// Tests for the realistic cross-section render-model (drives the RN SVG renderer +
// mirrors the native SceneKit scene). Run: node --test src/components/roadCrossSectionSliceModel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RoadCrossSection } from "./../measurements/roadCrossSectionModel.ts";
import { buildCrossSectionSlice, type GridSampleResult } from "./../measurements/roadCrossSectionSlice.ts";
import { buildSliceRenderModel, deckSpansFt } from "./roadCrossSectionSliceModel.ts";

const DIVIDED: RoadCrossSection = {
  lt_lane_count: 2, rt_lane_count: 2, lt_lane_width_ft: 12, rt_lane_width_ft: 12,
  lt_outside_shoulder_ft: 8, lt_inside_shoulder_ft: 4, rt_inside_shoulder_ft: 4, rt_outside_shoulder_ft: 8,
  median_width_ft: 22, median_category: "RAISED", total_width_ft: 94,
  route_name: "SR-17", county_code: "SCL", begin_pm: 5, end_pm: 6, source: "ROAD_INVENTORY",
};
const UNDIVIDED: RoadCrossSection = {
  lt_lane_count: 1, rt_lane_count: 1, lt_lane_width_ft: 12, rt_lane_width_ft: 12,
  lt_outside_shoulder_ft: 4, lt_inside_shoulder_ft: 0, rt_inside_shoulder_ft: 0, rt_outside_shoulder_ft: 4,
  median_width_ft: 0, median_category: "NONE", total_width_ft: 32, source: "DEFAULT",
};

// A rising-to-the-east ground so LT/RT differ; all OK.
const okSampler = (lat: number, lon: number): GridSampleResult => ({ elevationM: 100 + (lon + 121.5) * 1000, status: "OK" });
const noneSampler = (): GridSampleResult => ({ elevationM: null, status: "OUT_OF_BOUNDS" });

function sliceOf(road: RoadCrossSection, sampler = okSampler) {
  return buildCrossSectionSlice(
    { selectedLat: 38.5, selectedLon: -121.5, snappedLat: 38.5, snappedLon: -121.5, upstationBearingDeg: 0, road, packageVersion: "v", snappedToRoadContext: true, roadContextSource: "road_inventory" },
    sampler,
  );
}

test("deck spans include shoulders, lanes and median for a divided highway", () => {
  const spans = deckSpansFt(DIVIDED).map((s) => s.kind);
  for (const k of ["lt_shoulder", "lt_lanes", "lt_inside_shoulder", "median", "rt_inside_shoulder", "rt_lanes", "rt_shoulder"]) {
    assert.ok(spans.includes(k as never), `missing span ${k}`);
  }
  // undivided: no median, no inside shoulders
  const u = deckSpansFt(UNDIVIDED).map((s) => s.kind);
  assert.ok(!u.includes("median" as never) && !u.includes("lt_inside_shoulder" as never));
  assert.ok(u.includes("lt_lanes" as never) && u.includes("rt_shoulder" as never));
});

test("render model draws deck, lane dividers, edge lines and LT/RT ordering", () => {
  const m = buildSliceRenderModel(sliceOf(DIVIDED), { width: 400, height: 300 });
  assert.ok(m.deckSpans.length >= 5);
  // divided 2+2 lanes -> one interior divider per side
  assert.equal(m.laneDividers.length, 2);
  assert.equal(m.edgeLines.length, 2);
  // spans are ordered left→right on screen
  const xs = m.deckSpans.map((s) => s.x0);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  // centerline between the two pavement edges
  assert.ok(m.centerlineX > m.edgeLines[0] && m.centerlineX < m.edgeLines[1]);
});

test("six stakes (LT/RT × 10/20/50 ft) with elevation + delta text", () => {
  const m = buildSliceRenderModel(sliceOf(DIVIDED));
  assert.equal(m.stakes.length, 6);
  const lt = m.stakes.filter((s) => s.side === "LT").map((s) => s.distanceFt).sort((a, b) => a - b);
  assert.deepEqual(lt, [10, 20, 50]);
  const rt50 = m.stakes.find((s) => s.side === "RT" && s.distanceFt === 50)!;
  assert.equal(rt50.status, "OK");
  assert.match(rt50.elevationText, /ft$/);
  assert.match(rt50.deltaText, /ft$/); // delta vs the RT shoulder edge
  assert.ok(m.hasElevation);
});

test("labels expose LT/RT, Looking upstation, route/postmile, and honest provenance", () => {
  const m = buildSliceRenderModel(sliceOf(DIVIDED));
  assert.equal(m.labels.lt, "LT");
  assert.equal(m.labels.rt, "RT");
  assert.equal(m.labels.lookingUpstation, "Looking upstation");
  assert.equal(m.labels.route, "Route SR-17");
  assert.equal(m.labels.postmile, "PM 5–6");
  assert.equal(m.labels.roadLayoutLabel, "Roadway layout: Road Inventory");
  assert.match(m.labels.elevationLabel, /USGS 3DEP offline grid/);
  assert.match(m.labels.schematicNote, /schematic/);
  assert.match(m.labels.snapNote, /Snapped to road_inventory/);
  // default-layout package labels honestly
  const def = buildSliceRenderModel(sliceOf(UNDIVIDED));
  assert.equal(def.labels.roadLayoutLabel, "Roadway layout: default assumptions");
});

test("missing samples are shown honestly (No data / Outside package), never invented", () => {
  const m = buildSliceRenderModel(sliceOf(DIVIDED, noneSampler));
  assert.equal(m.hasElevation, false);
  assert.ok(m.stakes.every((s) => s.status === "OUT_OF_BOUNDS" && s.elevationText === "Outside package"));
  assert.ok(m.ltGroundMissing && m.rtGroundMissing);
  // NO_DATA distinctly rendered
  const noData = buildSliceRenderModel(sliceOf(DIVIDED, () => ({ elevationM: null, status: "NO_DATA" })));
  assert.ok(noData.stakes.every((s) => s.elevationText === "No data"));
});

test("technical overlay toggles exact dimension + stake-value labels", () => {
  const off = buildSliceRenderModel(sliceOf(DIVIDED), { technical: false });
  assert.equal(off.dims.length, 0);
  const on = buildSliceRenderModel(sliceOf(DIVIDED), { technical: true });
  assert.ok(on.dims.length >= off.deckSpans.length); // one per span + per stake
  assert.ok(on.dims.some((d) => /Median/.test(d.text)));
  assert.ok(on.dims.some((d) => /RT\+50ft/.test(d.text)));
});
