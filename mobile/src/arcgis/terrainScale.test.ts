// Tests for the physically-derived terrain scale math.
// Run: node --test src/arcgis/terrainScale.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TerrainMeta } from "./eristerrainBundle.ts";
import {
  DRAPE_LIFTS_M,
  drapeLiftSceneUnits,
  elevationToSceneY,
  exaggerationLabel,
  INCIDENT_RING_DIAMETER_M,
  LEGACY_ROAD_LIFT_WORLDSIZE_FACTOR,
  physicalFootprintMeters,
  sceneScale,
  sceneUnitsToMeters,
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

// A ~3 km AOI (matches the field package scale that exposed the 27 m road-float bug).
const META_3KM: Pick<TerrainMeta, "rows" | "columns" | "bounds" | "local_transform"> = {
  rows: 3,
  columns: 3,
  bounds: { min_lat: 38.485, min_lon: -121.517, max_lat: 38.512, max_lon: -121.483 },
  local_transform: { origin_lon: -121.517, origin_lat: 38.512, lon_per_col: 0.017, lat_per_row: -0.0135 },
};

test("physical scale: road drape lift is metre-derived and ~0.30 m, NOT the old ~27 m", () => {
  const s = sceneScale(META_3KM, WS)!;
  assert.ok(s && Math.max(s.widthM, s.heightM) > 2500 && Math.max(s.widthM, s.heightM) < 3500, "AOI is ~3 km");

  // New metre-derived road lift converts back to ~0.30 m — well below 1 m.
  const roadLiftUnits = drapeLiftSceneUnits(s, "road");
  const roadLiftMeters = sceneUnitsToMeters(s, roadLiftUnits);
  assert.ok(near(roadLiftMeters, DRAPE_LIFTS_M.road), "road lift round-trips to its metre value");
  assert.ok(roadLiftMeters < 1.0, `road lift ${roadLiftMeters} m must be < 1 m`);

  // The OLD worldSize-percentage lift (worldSize * 0.018) is ~27 m on this AOI — the bug.
  const legacyUnits = WS * LEGACY_ROAD_LIFT_WORLDSIZE_FACTOR;
  const legacyMeters = sceneUnitsToMeters(s, legacyUnits);
  assert.ok(legacyMeters > 20 && legacyMeters < 35, `legacy lift ${legacyMeters} m ≈ 27 m (documents the bug)`);
  assert.ok(roadLiftMeters < legacyMeters / 20, "new lift is dramatically smaller than the old one");
});

test("physical scale: incident marker is a ~10 m ring, never a 75 m footprint", () => {
  assert.ok(INCIDENT_RING_DIAMETER_M >= 8 && INCIDENT_RING_DIAMETER_M <= 12, "8–12 m ground ring");
  assert.ok(INCIDENT_RING_DIAMETER_M < 75, "not the old 75 m sphere");
});

test("physical scale: draped layers are ordered, closely stacked, all < 1 m (no parallax gap)", () => {
  const order: (keyof typeof DRAPE_LIFTS_M)[] = ["imagery", "road", "submitted", "boundary", "selectedRoad", "sliceIndicator"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(DRAPE_LIFTS_M[order[i]] > DRAPE_LIFTS_M[order[i - 1]], `${order[i]} lifts above ${order[i - 1]}`);
  }
  for (const k of order) assert.ok(DRAPE_LIFTS_M[k] < 1.0, `${k} lift < 1 m`);
  // imagery, road and the selected slice indicator are within ~0.6 m of each other — no
  // large parallax-producing separation between the aerial drape and the overlays.
  assert.ok(DRAPE_LIFTS_M.sliceIndicator - DRAPE_LIFTS_M.imagery < 0.7);
});
