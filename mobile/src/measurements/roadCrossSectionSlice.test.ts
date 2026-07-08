// Tests for the pure road cross-section slice math (the contract native + RN mirror).
// Run: node --test src/measurements/roadCrossSectionSlice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RoadCrossSection } from "./roadCrossSectionModel.ts";
import {
  BEYOND_SHOULDER_STAKES_FT,
  beyondShoulderOffsetsFt,
  bilinearSampleGrid,
  buildCrossSectionSlice,
  crossSectionBearingDeg,
  elevationDeltaFt,
  ftToM,
  latLonToColRow,
  mToFt,
  offsetToLatLon,
  outsideShoulderEdgesFt,
  projectPointToPolyline,
  resolveUpstationBearing,
  roadBreakpointsFt,
  sampleOffsetsFt,
  snapToRoadContext,
  type GridSampleResult,
} from "./roadCrossSectionSlice.ts";

function near(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) <= Math.abs(b) * eps + 1e-9;
}

// Divided highway (symmetric): 2 lanes/side @12, inside shoulder 4, outside 8, median 22 raised.
const DIVIDED: RoadCrossSection = {
  lt_lane_count: 2, rt_lane_count: 2, lt_lane_width_ft: 12, rt_lane_width_ft: 12,
  lt_outside_shoulder_ft: 8, lt_inside_shoulder_ft: 4, rt_inside_shoulder_ft: 4, rt_outside_shoulder_ft: 8,
  median_width_ft: 22, median_category: "RAISED",
  total_width_ft: 94, route_name: "SR-17", county_code: "SCL", begin_pm: 5, end_pm: 6,
  source: "ROAD_INVENTORY",
};
// Undivided 2-lane: 1 lane/side @12, outside 4, no median.
const UNDIVIDED: RoadCrossSection = {
  lt_lane_count: 1, rt_lane_count: 1, lt_lane_width_ft: 12, rt_lane_width_ft: 12,
  lt_outside_shoulder_ft: 4, lt_inside_shoulder_ft: 0, rt_inside_shoulder_ft: 0, rt_outside_shoulder_ft: 4,
  median_width_ft: 0, median_category: "NONE", total_width_ft: 32, source: "DEFAULT",
};

// ---- feet/metres + bearings ------------------------------------------------

test("feet/metres conversion round-trips", () => {
  assert.ok(near(mToFt(ftToM(50)), 50));
  assert.ok(near(ftToM(3.280839895), 1));
});

test("cross-section bearing is upstation + 90 (RT to the right)", () => {
  assert.equal(crossSectionBearingDeg(0), 90);
  assert.equal(crossSectionBearingDeg(90), 180);
  assert.equal(crossSectionBearingDeg(300), 30);
});

test("resolveUpstationBearing orients tangent toward the hint hemisphere", () => {
  // tangent 10°, hint 200° (opposite) -> flip to 190°.
  assert.ok(near(resolveUpstationBearing(10, 200), 190));
  // tangent 10°, hint 20° (same) -> keep 10°.
  assert.ok(near(resolveUpstationBearing(10, 20), 10));
  // no hint -> tangent as-is.
  assert.ok(near(resolveUpstationBearing(123, null), 123));
});

test("offset maps to lat/lon: +offset toward RT (right of upstation)", () => {
  // upstation north (0) -> cross-section east (90): +10 ft moves EAST (lon up), lat ~same.
  const rt = offsetToLatLon(38.5, -121.5, crossSectionBearingDeg(0), 10);
  assert.ok(rt.lon > -121.5 && near(rt.lat, 38.5, 1e-4));
  const lt = offsetToLatLon(38.5, -121.5, crossSectionBearingDeg(0), -10);
  assert.ok(lt.lon < -121.5); // LT is west here
  // upstation east (90) -> cross-section south (180): +offset moves SOUTH (lat down).
  const rtS = offsetToLatLon(38.5, -121.5, crossSectionBearingDeg(90), 10);
  assert.ok(rtS.lat < 38.5 && near(rtS.lon, -121.5, 1e-4));
});

// ---- roadway breakpoints (schematic layout) --------------------------------

test("divided highway breakpoints: center, median edges, inside/outside shoulders, dividers, LT<0<RT", () => {
  const bp = roadBreakpointsFt(DIVIDED);
  const offs = bp.map((b) => b.offsetFt);
  // sorted LT->RT
  assert.deepEqual(offs, [...offs].sort((a, b) => a - b));
  // symmetric divided road: expected edges (see module math)
  assert.deepEqual(offs, [-47, -39, -27, -15, -11, 0, 11, 15, 27, 39, 47]);
  // center is CENTER side; negatives LT, positives RT
  assert.equal(bp.find((b) => b.offsetFt === 0)!.side, "CENTER");
  assert.ok(bp.filter((b) => b.offsetFt < 0).every((b) => b.side === "LT"));
  assert.ok(bp.filter((b) => b.offsetFt > 0).every((b) => b.side === "RT"));
  // median edges present at ±11
  assert.ok(bp.some((b) => b.kind === "median_edge" && b.offsetFt === -11));
  assert.ok(bp.some((b) => b.kind === "median_edge" && b.offsetFt === 11));
  // outer pavement edge (travelway) at ±39, outside shoulder edge at ±47
  assert.ok(bp.some((b) => b.kind === "travelway_edge" && b.offsetFt === 39));
  assert.ok(bp.some((b) => b.kind === "outside_shoulder_edge" && b.offsetFt === 47));
});

test("undivided highway breakpoints: no median edges, no inside shoulders", () => {
  const bp = roadBreakpointsFt(UNDIVIDED);
  assert.deepEqual(bp.map((b) => b.offsetFt), [-16, -12, 0, 12, 16]);
  assert.ok(!bp.some((b) => b.kind === "median_edge"));
  assert.ok(!bp.some((b) => b.kind === "inside_shoulder_edge"));
  assert.ok(bp.some((b) => b.kind === "travelway_edge" && b.offsetFt === -12));
  assert.ok(bp.some((b) => b.kind === "outside_shoulder_edge" && b.offsetFt === 16));
});

test("outside shoulder edges equal the signed half-widths from centerline", () => {
  assert.deepEqual(outsideShoulderEdgesFt(DIVIDED), { ltFt: -47, rtFt: 47 });
  assert.deepEqual(outsideShoulderEdgesFt(UNDIVIDED), { ltFt: -16, rtFt: 16 });
});

test("beyond-shoulder offsets include 10/20/50 stakes on BOTH sides + dense fill", () => {
  const g = beyondShoulderOffsetsFt(UNDIVIDED, { denseStepFt: 5, maxFt: 50 });
  const lt = g.filter((x) => x.side === "LT").map((x) => x.offsetFt);
  const rt = g.filter((x) => x.side === "RT").map((x) => x.offsetFt);
  // stakes at shoulder edge (±16) + 10/20/50
  for (const d of BEYOND_SHOULDER_STAKES_FT) {
    assert.ok(lt.includes(-16 - d), `LT +${d}`);
    assert.ok(rt.includes(16 + d), `RT +${d}`);
  }
  // dense fill present (e.g. +5, +15)
  assert.ok(rt.includes(16 + 5) && rt.includes(16 + 15));
  // stakes flagged
  assert.equal(g.find((x) => x.side === "RT" && x.offsetFt === 16 + 50)!.isStake, true);
  assert.equal(g.find((x) => x.side === "RT" && x.offsetFt === 16 + 5)!.isStake, false);
});

test("sampleOffsetsFt merges road + ground, sorted and de-duplicated", () => {
  const s = sampleOffsetsFt(DIVIDED, { denseStepFt: 10, maxFt: 50 });
  const offs = s.map((x) => x.offsetFt);
  assert.deepEqual(offs, [...offs].sort((a, b) => a - b));
  assert.equal(new Set(offs).size, offs.length); // no duplicate offsets
  assert.ok(s.some((x) => x.kind === "road" && x.offsetFt === 0));
  assert.ok(s.some((x) => x.kind === "ground" && x.isStake && x.offsetFt === 47 + 50));
});

// ---- snapping --------------------------------------------------------------

test("projectPointToPolyline finds nearest point + tangent bearing + distance", () => {
  // A due-east road segment at lat 38.5 from lon -121.51..-121.49.
  const poly: [number, number][] = [[-121.51, 38.5], [-121.49, 38.5]];
  const pr = projectPointToPolyline(38.5009, -121.5, poly)!; // ~100 m north of the road
  assert.ok(pr);
  assert.ok(near(pr.lon, -121.5, 1e-4) && near(pr.lat, 38.5, 1e-4)); // projects onto the road
  assert.ok(pr.distanceM > 80 && pr.distanceM < 120); // ~100 m offset
  assert.ok(near(pr.tangentBearingDeg, 90, 0.05)); // due east
});

test("snapToRoadContext: within range ok, too far / none rejected honestly", () => {
  const features = [{ kind: "road_inventory", coords: [[-121.51, 38.5], [-121.49, 38.5]] as [number, number][] }];
  const ok = snapToRoadContext(38.5004, -121.5, features, { maxSnapM: 80 });
  assert.equal(ok.ok, true);
  assert.equal(ok.roadContextKind, "road_inventory");
  assert.ok(near(ok.snappedLat, 38.5, 1e-4));

  const far = snapToRoadContext(38.51, -121.5, features, { maxSnapM: 60 }); // ~1.1 km away
  assert.equal(far.ok, false);
  assert.equal(far.reason, "too_far");

  const none = snapToRoadContext(38.5, -121.5, [], { maxSnapM: 60 });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "no_road_context");
  assert.equal(none.roadContextKind, null);
});

// ---- elevation sampling ----------------------------------------------------

const T = { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: -0.02 };

test("lat/lon to grid col/row via local transform", () => {
  const a = latLonToColRow(T, 38.5, -121.5);
  assert.ok(near(a.col, 1) && near(a.row, 1));
  const b = latLonToColRow(T, 38.52, -121.52);
  assert.ok(near(b.col, 0) && near(b.row, 0));
});

test("bilinear sampling: exact point, interpolation, no-data, out-of-bounds", () => {
  const rows = 3, cols = 3, noData = -9999;
  // row-major: row0 [0,1,2], row1 [10,11,12], row2 [20,21,22]
  const grid = [0, 1, 2, 10, 11, 12, 20, 21, 22];
  // exact grid point (col1,row1) = 11
  assert.deepEqual(bilinearSampleGrid(grid, rows, cols, 1, 1, noData), { elevationM: 11, status: "OK" });
  // midpoint between (0,0)=0 and (1,0)=1 -> 0.5
  assert.deepEqual(bilinearSampleGrid(grid, rows, cols, 0.5, 0, noData), { elevationM: 0.5, status: "OK" });
  // center of the 2x2 top-left cell -> mean(0,1,10,11)=5.5
  assert.ok(near(bilinearSampleGrid(grid, rows, cols, 0.5, 0.5, noData).elevationM!, 5.5));
  // no-data neighbour poisons the sample
  const gnd = [0, 1, 2, 10, noData, 12, 20, 21, 22];
  assert.equal(bilinearSampleGrid(gnd, rows, cols, 1, 1, noData).status, "NO_DATA");
  // outside grid bounds
  assert.deepEqual(bilinearSampleGrid(grid, rows, cols, 5, 1, noData), { elevationM: null, status: "OUT_OF_BOUNDS" });
  assert.equal(bilinearSampleGrid(grid, rows, cols, 1, -0.5, noData).status, "OUT_OF_BOUNDS");
});

// ---- slice assembly --------------------------------------------------------

test("buildCrossSectionSlice assembles samples + 10/20/50 markers with correct sides", () => {
  // Fake sampler: elevation rises 1 m per 0.001° east, flat in lat (deterministic, OK).
  const sampler = (lat: number, lon: number): GridSampleResult => ({ elevationM: 100 + (lon + 121.5) * 1000, status: "OK" });
  const slice = buildCrossSectionSlice(
    {
      selectedLat: 38.5001, selectedLon: -121.5001,
      snappedLat: 38.5, snappedLon: -121.5,
      upstationBearingDeg: 0, // north -> cross east
      road: DIVIDED,
      packageVersion: "gtest-1",
      snappedToRoadContext: true,
      roadContextSource: "road_inventory",
    },
    sampler,
  );
  assert.equal(slice.crossSectionBearingDeg, 90);
  assert.equal(slice.elevationSource, "USGS_3DEP_OFFLINE_GRID");
  // key markers: LT at negative offsets, RT positive; all OK with elevationFt set
  assert.equal(slice.keyMarkers.lt50ft!.offsetFt, -97); // ltShoulder(-47) - 50
  assert.equal(slice.keyMarkers.rt50ft!.offsetFt, 97);
  assert.ok(slice.keyMarkers.rt50ft!.elevationFt! > slice.keyMarkers.lt50ft!.elevationFt!); // east is higher
  assert.equal(slice.keyMarkers.ltOutsideShoulderEdge!.status, "OK");
  // provenance
  assert.equal(slice.provenance.roadLayoutSource, "ROAD_INVENTORY");
  assert.equal(slice.provenance.snappedToRoadContext, true);
  assert.equal(slice.provenance.packageVersion, "gtest-1");
  // every offset produced a sample with the source tag
  assert.ok(slice.samples.length >= 11);
  assert.ok(slice.samples.every((s) => s.source === "USGS_3DEP_OFFLINE_GRID"));
});

test("buildCrossSectionSlice surfaces NO_DATA / OUT_OF_BOUNDS honestly (no invented elevation)", () => {
  const sampler = (): GridSampleResult => ({ elevationM: null, status: "OUT_OF_BOUNDS" });
  const slice = buildCrossSectionSlice(
    {
      selectedLat: 0, selectedLon: 0, snappedLat: 0, snappedLon: 0,
      upstationBearingDeg: 45, road: UNDIVIDED, packageVersion: "v", snappedToRoadContext: false,
    },
    sampler,
  );
  assert.ok(slice.samples.every((s) => s.elevationM === null && s.elevationFt === null && s.status === "OUT_OF_BOUNDS"));
  assert.equal(slice.keyMarkers.rt10ft!.status, "OUT_OF_BOUNDS");
});

test("elevationDeltaFt is relative to the shoulder edge, null when data missing", () => {
  const a = { elevationFt: 110 } as never;
  const ref = { elevationFt: 100 } as never;
  assert.equal(elevationDeltaFt(a, ref), 10);
  assert.equal(elevationDeltaFt({ elevationFt: null } as never, ref), null);
  assert.equal(elevationDeltaFt(a, null), null);
});
