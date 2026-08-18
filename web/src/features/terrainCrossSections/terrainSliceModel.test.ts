import assert from "node:assert/strict";
import test from "node:test";

import type { CrossSectionProfile } from "./terrainCrossSectionModel.ts";
import {
  buildTerrainSliceSamplingGrid,
  terrainSliceFromSampledPoints,
} from "./terrainSliceModel.ts";

const profile: CrossSectionProfile = {
  samples: [
    { index: 0, distance_m: 0, longitude: -121.0, latitude: 39.0, elevation_m: 100, grade_percent: null },
    { index: 1, distance_m: 100, longitude: -120.999, latitude: 39.001, elevation_m: 140, grade_percent: 40 },
    { index: 2, distance_m: 200, longitude: -120.998, latitude: 39.002, elevation_m: 80, grade_percent: -60 },
  ],
  stats: {
    total_distance_m: 200,
    min_elevation_m: 80,
    max_elevation_m: 140,
    elevation_range_m: 60,
    elevation_gain_m: 40,
    elevation_loss_m: 60,
    sample_count: 3,
  },
};

test("terrain slice sampling grid spans the requested corridor width", () => {
  const grid = buildTerrainSliceSamplingGrid(profile, 120, { crossColumns: 9 });
  assert.equal(grid.rows, 3);
  assert.equal(grid.columns, 9);
  assert.equal(grid.width_m, 120);
  assert.equal(grid.points.length, 27);
  assert.ok(grid.footprint_ring.length >= 7);
  assert.deepEqual(grid.footprint_ring[0], grid.footprint_ring.at(-1));

  const firstLeft = grid.points[0];
  const firstRight = grid.points[8];
  assert.notEqual(firstLeft.longitude, firstRight.longitude);
  assert.notEqual(firstLeft.latitude, firstRight.latitude);
});

test("terrain slice data puts the cut base below the lowest sampled terrain", () => {
  const grid = buildTerrainSliceSamplingGrid(profile, 80, { crossColumns: 5 });
  const sampled = grid.points.map((point, index) => [
    point.longitude,
    point.latitude,
    index === 3 ? 205 : index === 8 ? 45 : 100 + index,
  ]);

  const slice = terrainSliceFromSampledPoints(grid, sampled);
  assert.equal(slice.min_elevation_m, 45);
  assert.equal(slice.max_elevation_m, 205);
  assert.equal(slice.elevation_range_m, 160);
  assert.ok(slice.base_elevation_m < slice.min_elevation_m);
  assert.ok(slice.min_elevation_m - slice.base_elevation_m >= 25);
});

test("terrain slice rejects incomplete elevation responses instead of inventing DEM values", () => {
  const grid = buildTerrainSliceSamplingGrid(profile, 50, { crossColumns: 3 });
  const sampled = grid.points.slice(0, -1).map((point) => [point.longitude, point.latitude, 100]);
  assert.throws(
    () => terrainSliceFromSampledPoints(grid, sampled),
    /unexpected terrain slice sample count/,
  );
});
