// NoData-aware divided terrain: the profile must never be drawn across missing terrain, and
// a critical anchor must have its OWN exact sample.
//
// Run: node --experimental-strip-types --test src/arcgis/dividedTerrainRuns.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contiguousValidRuns,
  criticalAnchorsSatisfied,
  exactAnchorElevation,
  interpolateWithinRuns,
  isolatedPoints,
  renderableRuns,
  renderableSegments,
  type TerrainSample,
} from "./dividedTerrainRuns.ts";

const ok = (offsetFt: number, elevationFt: number): TerrainSample => ({ offsetFt, status: "OK", elevationFt });
const noData = (offsetFt: number): TerrainSample => ({ offsetFt, status: "NO_DATA", elevationFt: null });
const oob = (offsetFt: number): TerrainSample => ({ offsetFt, status: "OUT_OF_BOUNDS", elevationFt: null });

test("all samples valid -> exactly one run", () => {
  const runs = contiguousValidRuns([ok(-10, 100), ok(0, 101), ok(10, 102)]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 3);
});

test("one invalid middle sample -> two runs, never joined", () => {
  const runs = contiguousValidRuns([ok(-10, 100), noData(0), ok(10, 102)]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((p) => p.offsetFt), [-10]);
  assert.deepEqual(runs[1].map((p) => p.offsetFt), [10]);
});

test("several adjacent invalid samples collapse into a single gap", () => {
  const runs = contiguousValidRuns([ok(-20, 100), ok(-10, 100), noData(0), oob(5), noData(8), ok(10, 102), ok(20, 103)]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((p) => p.offsetFt), [-20, -10]);
  assert.deepEqual(runs[1].map((p) => p.offsetFt), [10, 20]);
});

test("invalid first and last samples do not create empty runs", () => {
  const runs = contiguousValidRuns([noData(-20), ok(-10, 100), ok(0, 101), oob(10)]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].map((p) => p.offsetFt), [-10, 0]);
});

test("two valid runs are both renderable; a one-point run is isolated, never joined", () => {
  const runs = contiguousValidRuns([ok(-20, 100), ok(-10, 100), noData(0), ok(10, 102), noData(15), ok(20, 104), ok(30, 105)]);
  assert.equal(runs.length, 3);
  const drawn = renderableRuns(runs);
  assert.equal(drawn.length, 2);                       // the single-point run is not drawn
  assert.deepEqual(isolatedPoints(runs).map((p) => p.offsetFt), [10]);
});

test("non-finite / boolean / missing elevations are gaps, not ground", () => {
  const bad: TerrainSample[] = [
    ok(-10, 100),
    { offsetFt: -5, status: "OK", elevationFt: Number.NaN },
    { offsetFt: 0, status: "OK", elevationFt: Number.POSITIVE_INFINITY },
    { offsetFt: 3, status: "OK", elevationFt: undefined },
    { offsetFt: 4, status: "OK", elevationFt: true as unknown as number },
    ok(10, 102),
  ];
  const runs = contiguousValidRuns(bad);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.flat().map((p) => p.offsetFt), [-10, 10]);
});

test("samples outside the section extent end the run", () => {
  const runs = contiguousValidRuns([ok(-100, 90), ok(-10, 100), ok(0, 101)], -50, 50);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].map((p) => p.offsetFt), [-10, 0]);
});

test("interpolation works inside a run", () => {
  const runs = contiguousValidRuns([ok(0, 100), ok(10, 110)]);
  const r = interpolateWithinRuns(runs, 5);
  assert.equal(r.found, true);
  assert.equal(r.elevationFt, 105);
});

test("interpolation CANNOT cross a gap between runs", () => {
  const runs = contiguousValidRuns([ok(-10, 100), noData(0), ok(10, 200)]);
  // 0 sits exactly in the hole; -5 and 5 sit between the two runs.
  for (const x of [-5, 0, 5]) {
    const r = interpolateWithinRuns(runs, x);
    assert.equal(r.found, false, `offset ${x} must not resolve across the gap`);
    assert.equal(r.elevationFt, null);
  }
  // ...but each run still resolves within itself.
  assert.equal(interpolateWithinRuns(runs, -10).found, true);
  assert.equal(interpolateWithinRuns(runs, 10).found, true);
});

test("interpolation outside every run is not found", () => {
  const runs = contiguousValidRuns([ok(0, 100), ok(10, 110)]);
  assert.equal(interpolateWithinRuns(runs, -1).found, false);
  assert.equal(interpolateWithinRuns(runs, 11).found, false);
});

test("exact anchor requires its OWN sample, not an interpolatable neighbourhood", () => {
  const runs = contiguousValidRuns([ok(-10, 100), ok(10, 120)]);
  // 0 IS interpolatable inside this run, but it is not an exact sample.
  assert.equal(interpolateWithinRuns(runs, 0).found, true);
  assert.equal(exactAnchorElevation(runs, 0).found, false);
  assert.equal(exactAnchorElevation(runs, -10).found, true);
  assert.equal(exactAnchorElevation(runs, -10).elevationFt, 100);
});

test("missing midpoint anchor is detected even when the profile is continuous", () => {
  const runs = contiguousValidRuns([ok(-10, 100), ok(10, 120)]);
  assert.equal(criticalAnchorsSatisfied(runs, [-10, 10]), true);
  assert.equal(criticalAnchorsSatisfied(runs, [-10, 0, 10]), false);   // midpoint absent
});

test("missing member-A / member-B anchors are detected", () => {
  const runs = contiguousValidRuns([ok(-10, 100), noData(0), ok(10, 120)]);
  assert.equal(criticalAnchorsSatisfied(runs, [-10]), true);           // A present
  assert.equal(criticalAnchorsSatisfied(runs, [0]), false);            // midpoint in the hole
  assert.equal(criticalAnchorsSatisfied(runs, [-10, 10]), true);
  assert.equal(criticalAnchorsSatisfied(runs, [-10, 5, 10]), false);   // B absent
});

test("no rendered segment straddles an invalid sample", () => {
  const samples = [ok(-20, 100), ok(-10, 101), noData(0), ok(10, 102), ok(20, 103)];
  const runs = contiguousValidRuns(samples);
  const segs = renderableSegments(runs);
  // Every segment joins two samples that are ADJACENT in the original valid stream.
  for (const [a, b] of segs) {
    const between = samples.filter((s) => s.offsetFt > a.offsetFt && s.offsetFt < b.offsetFt);
    assert.equal(between.length, 0, `segment ${a.offsetFt}->${b.offsetFt} skips a sample`);
  }
  // Specifically: nothing bridges -10 -> 10 across the hole at 0.
  assert.ok(!segs.some(([a, b]) => a.offsetFt === -10 && b.offsetFt === 10));
  assert.deepEqual(segs.map(([a, b]) => [a.offsetFt, b.offsetFt]), [[-20, -10], [10, 20]]);
});

test("a fill can never span from one valid run to another", () => {
  const runs = contiguousValidRuns([ok(-20, 100), ok(-10, 101), noData(0), ok(10, 102), ok(20, 103)]);
  // Each drawable run is closed on its own, so the count of fills equals the run count.
  const drawn = renderableRuns(runs);
  assert.equal(drawn.length, 2);
  for (const run of drawn) {
    assert.ok(run.length >= 2);
    assert.ok(run.every((p) => Number.isFinite(p.elevationFt)));
  }
});

test("empty / malformed input degrades safely", () => {
  assert.deepEqual(contiguousValidRuns(null), []);
  assert.deepEqual(contiguousValidRuns([]), []);
  assert.deepEqual(contiguousValidRuns([null, undefined, noData(0)]), []);
  assert.equal(interpolateWithinRuns([], 0).found, false);
  assert.equal(exactAnchorElevation([], 0).found, false);
});
