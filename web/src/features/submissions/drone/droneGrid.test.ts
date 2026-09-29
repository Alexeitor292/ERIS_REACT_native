import assert from "node:assert/strict";
import test from "node:test";

import {
  alignmentPoints,
  BlockAverager,
  cellIndex,
  cellSizeM,
  chooseGridSize,
  decodeGrid,
  edgeDistance,
  fillSea,
  encodeGrid,
  latticeInterpolator,
  latticePoints,
  resampleToGrid,
  sampleGrid,
  SEA_LEVEL_M,
  verticalOffset,
  type DroneGrid,
} from "./droneGrid.ts";

// A 4 × 3 patch rising 1 m per column, west to east.
const grid: DroneGrid = {
  west: -122.5, east: -122.496, north: 37.803, south: 37.8, cols: 4, rows: 3,
  values: Float32Array.from([10, 11, 12, 13, 10, 11, 12, 13, 10, 11, 12, 13]),
};

test("the stored patch round-trips, NaN included", () => {
  const withGap = { ...grid, values: Float32Array.from(grid.values, (v, i) => (i === 5 ? NaN : v)) };
  const back = decodeGrid(encodeGrid(withGap));
  assert.deepEqual({ ...back, values: [] }, { ...withGap, values: [] });
  assert.ok(Number.isNaN(back.values[5]));
  assert.equal(back.values[6], 12);
  assert.throws(() => decodeGrid(new Uint8Array(20)), /Not an ERIS/);
});

test("heights are read between cell centres, and nothing outside the patch", () => {
  const centre = (c: number) => grid.west + ((c + 0.5) / 4) * (grid.east - grid.west);
  assert.ok(Math.abs(sampleGrid(grid, centre(1), 37.8015)! - 11) < 1e-6);
  assert.ok(Math.abs(sampleGrid(grid, (centre(1) + centre(2)) / 2, 37.8015)! - 11.5) < 1e-6);
  assert.equal(sampleGrid(grid, -122.6, 37.8015), null);
});

test("a gap uses the neighbours that have data, and a hole says so", () => {
  const holey = { ...grid, values: Float32Array.from(grid.values, (v, i) => (i === 1 || i === 5 || i === 9 ? NaN : v)) };
  const centre1 = grid.west + (1.5 / 4) * (grid.east - grid.west);
  assert.equal(sampleGrid(holey, centre1, 37.8015), null);
  const between = grid.west + (2.25 / 4) * (grid.east - grid.west); // three quarters over column 2
  assert.equal(sampleGrid(holey, between, 37.8015), 12);
});

test("cells are sized on the ground", () => {
  const { dx, dy } = cellSizeM(grid);
  assert.ok(Math.abs(dx - 88) < 1 && Math.abs(dy - 110.5) < 1);
});

test("the offset is the median difference on stable ground", () => {
  const pairs = Array.from({ length: 20 }, (_, i) => ({ terrain: 100 + i, drone: 130 + i + (i === 3 ? 5 : 0) }));
  const result = verticalOffset(pairs)!;
  assert.equal(result.offsetM, -30);
  assert.equal(result.count, 20);
  assert.equal(verticalOffset(pairs.slice(0, 5)), null); // too few to trust
});

test("alignment points stay on data and out of the affected area", () => {
  const all = alignmentPoints(grid, [], 16);
  assert.equal(all.length, 16);
  const west = [[-122.5, 37.803], [-122.498, 37.803], [-122.498, 37.8], [-122.5, 37.8], [-122.5, 37.803]] as Array<[number, number]>;
  assert.ok(alignmentPoints(grid, [west], 16).every(([lon]) => lon > -122.498));
});

test("the patch is as fine as the drone, within limits", () => {
  const bounds = { west: -122.5, east: -122.499, north: 37.801, south: 37.8 }; // about 88 m × 111 m
  assert.equal(chooseGridSize(bounds, 0.05).cellM, 0.2);
  const coarse = chooseGridSize(bounds, 0.5);
  assert.equal(coarse.cellM, 0.5);
  assert.ok(chooseGridSize({ ...bounds, north: 37.803 }, 0.05).cellM > 0.3); // 332 m tall: capped at 1024 cells
  assert.ok(coarse.cols <= 1024 && coarse.rows <= 1024);
  assert.ok(chooseGridSize({ ...bounds, east: -122.45 }, 0.05).cols <= 1024);
});

test("a big raster is averaged block by block, band by band", () => {
  const width = 4;
  const averager = new BlockAverager(width, 4, 2, (v) => v !== -9999);
  averager.add([1, 3, 5, 7, 1, 3, 5, 7], 0);
  averager.add([-9999, -9999, 2, 2, -9999, -9999, 4, 4], 2);
  const reduced = averager.finish();
  assert.deepEqual(Array.from(reduced.slice(0, 2)), [2, 6]);
  assert.ok(Number.isNaN(reduced[2]));
  assert.equal(reduced[3], 3);
});

test("the lattice maps longitude and latitude to the file's own coordinates", () => {
  const bounds = { west: 0, east: 1, north: 1, south: 0 };
  const points = latticePoints(bounds, 3);
  const projected = points.map(([lon, lat]) => [lon * 1000 + 500, lat * 2000] as [number, number]); // an affine "projection"
  const toXY = latticeInterpolator(bounds, 3, projected);
  const [x, y] = toXY(0.25, 0.8);
  assert.ok(Math.abs(x - 750) < 1e-9 && Math.abs(y - 1600) < 1e-9);
});

test("a patch is resampled from the reduced raster, and its units converted", () => {
  // A 4 × 4 source whose value is its column index; reduced by 2 → columns 0.5, 2.5.
  const averager = new BlockAverager(4, 4, 2, () => true);
  averager.add([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3], 0);
  const bounds = { west: 0, east: 4, north: 4, south: 0 };
  const patch = resampleToGrid({
    bounds, cols: 4, rows: 4, reduced: averager.finish(), reducedWidth: 2, reducedHeight: 2, factor: 2,
    toPixel: (lon, lat) => [lon - 0.5, 4 - lat - 0.5], // pixel centres at half-units
    scale: 0.3048,
  });
  // Cell centre x = 0.5 → pixel 0 → reduced −0.25 → clamped to the first block (0.5).
  assert.ok(Math.abs(patch.values[0] - 0.5 * 0.3048) < 1e-6);
  assert.ok(Math.abs(patch.values[1] - 1 * 0.3048) < 1e-6);
});

test("edge distance counts cells to the nearest gap or the grid's edge, capped", () => {
  const cols = 7, rows = 5;
  const values = new Float32Array(cols * rows).fill(10);
  values[2 * cols + 3] = NaN; // a hole in the middle
  const grid = { west: 0, south: 0, east: 0.007, north: 0.005, cols, rows, values };
  const d = edgeDistance(grid, 3);
  assert.equal(d[2 * cols + 3], 0); // the hole
  assert.equal(d[0], 1); // a corner touches the outside
  assert.equal(d[2 * cols + 2], 1); // next to the hole
  assert.equal(d[2 * cols + 1], 2); // two cells from the hole, two from the edge
  assert.ok([...d].every((v) => v <= 3));
  assert.equal(cellIndex(grid, 0.0035, 0.0025), 2 * cols + 3);
  assert.equal(cellIndex(grid, 0.01, 0.0025), -1);
});

test("gaps facing the sea read as sea level; gaps beside high ground stay without data", () => {
  // 5 columns × 4 rows. Row 0: a hill at 50 m with a gap beside it (beyond the flight).
  // Row 1: slope. Row 2: beach at 1.5 m. Row 3: the sea, no data.
  const N = NaN;
  const values = Float32Array.from([
    50, 50, 50, N, N,
    30, 30, 30, 30, 30,
    1.5, 1.5, 1.5, 1.5, 1.5,
    N, N, N, N, N,
  ]);
  const grid = { west: 0, south: 0, east: 0.005, north: 0.004, cols: 5, rows: 4, values };
  const offset = -0.5; // heights as flown sit half a metre above the terrain model
  const { grid: filled, filled: count } = fillSea(grid, offset);
  assert.equal(count, 5);
  for (let c = 0; c < 5; c += 1) assert.equal(filled.values[15 + c], SEA_LEVEL_M - offset); // sea level after the offset
  assert.ok(Number.isNaN(filled.values[3]) && Number.isNaN(filled.values[4])); // beside the hill: still no data
  assert.equal(filled.values[10], 1.5); // what was mapped is untouched
  assert.ok(Number.isNaN(values[15])); // the survey itself is not changed
});
