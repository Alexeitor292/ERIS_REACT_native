import assert from "node:assert/strict";
import test from "node:test";

import {
  DEM_COVERAGE_CLASSES,
  demCoverageClassForPixelSize,
} from "./demResolutionCoverageModel.ts";

test("DEM coverage class boundaries are mutually exclusive", () => {
  assert.equal(demCoverageClassForPixelSize(1), "lte-1m");
  assert.equal(demCoverageClassForPixelSize(1.01), "gt-1-lt-5m");
  assert.equal(demCoverageClassForPixelSize(4.99), "gt-1-lt-5m");
  assert.equal(demCoverageClassForPixelSize(5), "gte-5-lt-10m");
  assert.equal(demCoverageClassForPixelSize(9.99), "gte-5-lt-10m");
  assert.equal(demCoverageClassForPixelSize(10), "10m");
  assert.equal(demCoverageClassForPixelSize(25), "25-30m");
  assert.equal(demCoverageClassForPixelSize(30), "25-30m");
  assert.equal(demCoverageClassForPixelSize(50), "50-90m");
  assert.equal(demCoverageClassForPixelSize(60), "50-90m");
  assert.equal(demCoverageClassForPixelSize(90), "50-90m");
  assert.equal(demCoverageClassForPixelSize(150), "gte-150m");
  assert.equal(demCoverageClassForPixelSize(250), "gte-150m");
  assert.equal(demCoverageClassForPixelSize(500), "gte-150m");
  assert.equal(demCoverageClassForPixelSize(1000), "gte-150m");
});

test("the Esri 2–6 m bucket is split using live PixelSize", () => {
  const finer = DEM_COVERAGE_CLASSES.find((coverageClass) => coverageClass.id === "gt-1-lt-5m");
  const mid = DEM_COVERAGE_CLASSES.find((coverageClass) => coverageClass.id === "gte-5-lt-10m");

  assert.deepEqual(finer?.sources, [{
    layerId: 2,
    sourceLabel: "2–6 m",
    definitionExpression: "PixelSize > 1 AND PixelSize < 5",
  }]);
  assert.deepEqual(mid?.sources, [{
    layerId: 2,
    sourceLabel: "2–6 m",
    definitionExpression: "PixelSize >= 5 AND PixelSize < 10",
  }]);
});
