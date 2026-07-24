// DEFECT B: exactly one visible terrain surface per base mode, and satellite imagery unlit.
//
// Run: node --experimental-strip-types --test src/arcgis/terrainSurfacePolicy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type BaseMode,
  surfacesAreMutuallyExclusive,
  terrainSurfacePolicy,
} from "./terrainSurfacePolicy.ts";

const MODES: BaseMode[] = ["relief", "satellite", "hybrid"];
const READY = { tiledImageryReady: true, singleImageAvailable: false };
const SINGLE = { tiledImageryReady: false, singleImageAvailable: true };
const NONE = { tiledImageryReady: false, singleImageAvailable: false };

test("base and tiled surfaces are NEVER both visible (all mode/input combos)", () => {
  for (const mode of MODES) {
    for (const inputs of [READY, SINGLE, NONE, { tiledImageryReady: true, singleImageAvailable: true }]) {
      const p = terrainSurfacePolicy(mode, inputs);
      assert.ok(surfacesAreMutuallyExclusive(p), `${mode} / ${JSON.stringify(inputs)} showed both surfaces`);
      // At least one surface is always visible (never a blank scene).
      assert.ok(p.baseTerrainVisible || p.tiledImageryVisible, `${mode} showed no surface`);
    }
  }
});

test("Terrain Relief uses the base mesh, never imagery", () => {
  for (const inputs of [READY, SINGLE, NONE]) {
    const p = terrainSurfacePolicy("relief", inputs);
    assert.equal(p.baseTerrainVisible, true);
    assert.equal(p.tiledImageryVisible, false);
    assert.equal(p.imageryUnlit, false);
    assert.equal(p.reason, "relief");
  }
});

test("Satellite with ready tiles: base HIDDEN, tiled visible, imagery UNLIT", () => {
  const p = terrainSurfacePolicy("satellite", READY);
  assert.equal(p.baseTerrainVisible, false);
  assert.equal(p.tiledImageryVisible, true);
  assert.equal(p.imageryUnlit, true);
  assert.equal(p.hillshadeOnImagery, false); // satellite = imagery alone
  assert.equal(p.reason, "tiled_satellite");
});

test("Hybrid with ready tiles: base HIDDEN, tiled visible, hillshade on the SAME surface", () => {
  const p = terrainSurfacePolicy("hybrid", READY);
  assert.equal(p.baseTerrainVisible, false);
  assert.equal(p.tiledImageryVisible, true);
  assert.equal(p.imageryUnlit, true);
  assert.equal(p.hillshadeOnImagery, true); // multiply onto the imagery surface, not a 2nd mesh
  assert.equal(p.reason, "tiled_hybrid");
});

test("legacy single-image repaints the base mesh (one surface), never a tiled surface", () => {
  const sat = terrainSurfacePolicy("satellite", SINGLE);
  assert.equal(sat.baseTerrainVisible, true);
  assert.equal(sat.tiledImageryVisible, false);
  assert.equal(sat.legacySingleImageOnBase, true);
  // Mirrors the native legacy branch, which also sets SCNLightingModelConstant.
  assert.equal(sat.imageryUnlit, true);
  assert.equal(sat.reason, "legacy_single");
  const hyb = terrainSurfacePolicy("hybrid", SINGLE);
  assert.equal(hyb.hillshadeOnImagery, true);
  assert.equal(hyb.legacySingleImageOnBase, true);
});

test("missing/incomplete imagery falls back to relief (never a partial tiled surface)", () => {
  for (const mode of ["satellite", "hybrid"] as BaseMode[]) {
    const p = terrainSurfacePolicy(mode, NONE);
    assert.equal(p.baseTerrainVisible, true);
    assert.equal(p.tiledImageryVisible, false);
    assert.equal(p.reason, "relief_fallback");
  }
});

test("ready tiles take priority over a legacy single image", () => {
  const p = terrainSurfacePolicy("satellite", { tiledImageryReady: true, singleImageAvailable: true });
  assert.equal(p.tiledImageryVisible, true);
  assert.equal(p.legacySingleImageOnBase, false);
});
