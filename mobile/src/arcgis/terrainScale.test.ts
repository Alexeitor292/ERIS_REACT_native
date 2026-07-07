// Tests for the physically-derived terrain scale math.
// Run: node --test src/arcgis/terrainScale.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TerrainMeta } from "./eristerrainBundle.ts";
import {
  elevationToSceneY,
  exaggerationLabel,
  physicalFootprintMeters,
  sceneScale,
  snapExaggeration,
  VERT_EXAG_DEFAULT,
  VERT_EXAG_MAX,
  VERT_EXAG_MIN,
} from "./terrainScale.ts";

// A 3x3 grid over a 0.04deg x 0.04deg AOI near lat 38.5; NW corner = (min_lon,max_lat).
const META: Pick<TerrainMeta, "rows" | "columns" | "bounds" | "local_transform"> = {
  rows: 3,
  columns: 3,
  bounds: { min_lat: 38.48, min_lon: -121.52, max_lat: 38.52, max_lon: -121.48 },
  local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: -0.02 },
};
const WS = 100;

function near(a: number, b: number, epsRel = 1e-6) {
  return Math.abs(a - b) <= Math.abs(b) * epsRel + 1e-9;
}

test("physical footprint (metres) from local_transform, cos-lat adjusted", () => {
  const fp = physicalFootprintMeters(META)!;
  // height = 0.04deg * 111320
  assert.ok(near(fp.heightM, 0.04 * 111320));
  // width = 0.04deg * 111320 * cos(38.5deg)  (< height, since |cos|<1)
  assert.ok(near(fp.widthM, 0.04 * 111320 * Math.cos((38.5 * Math.PI) / 180)));
  assert.ok(fp.widthM < fp.heightM);
});

test("local_transform and bounds agree", () => {
  const fromBounds = physicalFootprintMeters({ ...META, local_transform: undefined as never })!;
  const fromLt = physicalFootprintMeters(META)!;
  assert.ok(near(fromBounds.widthM, fromLt.widthM) && near(fromBounds.heightM, fromLt.heightM));
});

test("scene scale preserves physical aspect ratio (not forced square)", () => {
  const s = sceneScale(META, WS)!;
  // larger dimension (height) fills 2*worldSize; smaller (width) keeps the ratio.
  assert.ok(near(s.halfDepthUnits, WS)); // height is the max dim -> half-extent == worldSize
  assert.ok(s.halfWidthUnits < s.halfDepthUnits); // narrower east-west -> smaller X extent
  assert.ok(near(s.halfWidthUnits / s.halfDepthUnits, s.widthM / s.heightM));
  // scene-units-per-metre = 2*worldSize / max(width,height)
  assert.ok(near(s.sceneUnitsPerMeter, (2 * WS) / s.heightM));
});

test("1.0x is true scale: sceneY uses the horizontal scene-units-per-metre", () => {
  const s = sceneScale(META, WS)!;
  const y1 = elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 1.0);
  assert.ok(near(y1, 50 * s.sceneUnitsPerMeter)); // 50 m of relief * units/m
});

test("2.0x exactly doubles and 0.5x exactly halves the vertical display height", () => {
  const s = sceneScale(META, WS)!;
  const y1 = elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 1.0);
  const y2 = elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 2.0);
  const yHalf = elevationToSceneY(150, 100, s.sceneUnitsPerMeter, 0.5);
  assert.ok(near(y2, 2 * y1));
  assert.ok(near(yHalf, 0.5 * y1));
});

test("horizontal scale does NOT change when vertical exaggeration changes", () => {
  const s = sceneScale(META, WS)!;
  // sceneScale has no exaggeration input; horizontal half-extents are fixed.
  for (const exag of [0.5, 1.0, 2.0, 3.0]) {
    // Only Y depends on exag; X/Z (halfWidthUnits/halfDepthUnits) are exag-independent.
    const y = elevationToSceneY(120, 100, s.sceneUnitsPerMeter, exag);
    assert.ok(near(y, 20 * s.sceneUnitsPerMeter * exag));
  }
  assert.ok(near(s.halfWidthUnits, (s.widthM * s.sceneUnitsPerMeter) / 2));
});

test("degenerate / malformed metadata fails safe (null, never throws)", () => {
  assert.equal(physicalFootprintMeters(null), null);
  assert.equal(physicalFootprintMeters({ rows: 1, columns: 3, bounds: META.bounds } as never), null);
  assert.equal(
    physicalFootprintMeters({ rows: 3, columns: 3, bounds: { min_lat: 1, min_lon: 1, max_lat: 1, max_lon: 2 } } as never),
    null,
  ); // zero-height bounds
  assert.equal(sceneScale(null, WS), null);
  assert.equal(sceneScale(META, 0), null); // bad worldSize
  // Invalid local_transform (lon_per_col <= 0) falls back to bounds.
  const s = sceneScale({ ...META, local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: -1, lat_per_row: -0.02 } }, WS);
  assert.ok(s && s.sceneUnitsPerMeter > 0);
});

test("snap + labels: 0.5..3.0 step 0.1, true-scale default", () => {
  assert.equal(snapExaggeration(1.04), 1.0);
  assert.equal(snapExaggeration(1.06), 1.1);
  assert.equal(snapExaggeration(0.1), VERT_EXAG_MIN); // clamp low
  assert.equal(snapExaggeration(9), VERT_EXAG_MAX); // clamp high
  assert.equal(snapExaggeration(Number.NaN), VERT_EXAG_DEFAULT);
  assert.match(exaggerationLabel(1.0), /1\.0× True scale/);
  assert.match(exaggerationLabel(0.5), /Flattened/);
  assert.match(exaggerationLabel(2.0), /Enhanced relief/);
  assert.match(exaggerationLabel(3.0), /High relief/);
});
