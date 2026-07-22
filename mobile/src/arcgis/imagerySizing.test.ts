// Tests for local tile-native immersive corridor imagery sizing.
// Run: node --test src/arcgis/imagerySizing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boundsIntersect,
  corridorTextureSizing,
  groundSizeMeters,
  imageryProvenanceSummary,
  MAX_CORRIDOR_TEXTURE_PX,
  tilesIntersectingCorridor,
  type ImageryTileMeta,
  type LonLatBounds,
} from "./imagerySizing.ts";

const M = 111_320.0;
const LAT = 38.5;
const cos = Math.cos((LAT * Math.PI) / 180);
/** bounds centred at (-121.5, 38.5) spanning widthM x heightM */
const around = (widthM: number, heightM: number): LonLatBounds => ({
  min_lon: -121.5 - widthM / 2 / (M * cos),
  max_lon: -121.5 + widthM / 2 / (M * cos),
  min_lat: LAT - heightM / 2 / M,
  max_lat: LAT + heightM / 2 / M,
});

test("ground size is cos-lat corrected", () => {
  const g = groundSizeMeters(around(260, 260));
  assert.ok(Math.abs(g.widthM - 260) < 1, `${g.widthM}`);
  assert.ok(Math.abs(g.heightM - 260) < 1, `${g.heightM}`);
});

test("only tiles intersecting the corridor are gathered — never the whole AOI", () => {
  const tiles: ImageryTileMeta[] = [
    { file: "imagery/0/0.jpg", bounds: around(100, 100) },                       // overlaps
    { file: "imagery/0/1.jpg", bounds: { min_lon: -121.40, max_lon: -121.39, min_lat: 38.5, max_lat: 38.51 } }, // far east
    { file: "imagery/1/0.jpg", bounds: { min_lon: -121.60, max_lon: -121.59, min_lat: 38.5, max_lat: 38.51 } }, // far west
  ];
  const hit = tilesIntersectingCorridor(tiles, around(260, 260));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].file, "imagery/0/0.jpg");
  assert.equal(tilesIntersectingCorridor(tiles, around(0.5, 0.5)).length, 1);
  assert.deepEqual(tilesIntersectingCorridor([], around(260, 260)), []);
  assert.deepEqual(tilesIntersectingCorridor(null, around(260, 260)), []);
});

test("touching edges do not count as intersecting", () => {
  const a = { min_lon: -121.5, max_lon: -121.49, min_lat: 38.5, max_lat: 38.51 };
  const b = { min_lon: -121.49, max_lon: -121.48, min_lat: 38.5, max_lat: 38.51 }; // shares an edge
  assert.equal(boundsIntersect(a, b), false);
});

test("size comes from ground metres / effective GSD — the real source pixel count", () => {
  // 260 m at 0.6 m/px ~= 433 genuine source pixels across.
  const s = corridorTextureSizing(around(260, 260), 0.6, 4);
  assert.equal(s.requestedWidthPx, 433);
  assert.equal(s.widthPx, 433, "no upscaling beyond the source density");
  assert.equal(s.heightPx, 433);
  assert.ok(s.sourceResolutionLimited, "the source density is the limit here");
  assert.equal(s.memoryCapped, false);
  assert.ok(s.widthPx < MAX_CORRIDOR_TEXTURE_PX, "3072 is a ceiling, not a target");
});

test("NEVER a fixed 512x512 result", () => {
  const a = corridorTextureSizing(around(260, 260), 0.6);
  const b = corridorTextureSizing(around(500, 140), 0.6);
  for (const s of [a, b]) {
    assert.ok(!(s.widthPx === 512 && s.heightPx === 512), "must not collapse to a fixed square");
  }
  assert.notDeepEqual([a.widthPx, a.heightPx], [b.widthPx, b.heightPx], "size follows the corridor");
});

test("geographic aspect ratio is preserved", () => {
  const s = corridorTextureSizing(around(500, 125), 0.6);
  const aspect = s.widthPx / s.heightPx;
  assert.ok(Math.abs(aspect - 4) < 0.06, `aspect ${aspect} should track 500:125`);
});

test("the 3072 cap applies to the longest side, aspect-preserving", () => {
  // A big corridor at fine GSD would want >3072 px.
  const s = corridorTextureSizing(around(4000, 2000), 0.6);
  assert.ok(s.requestedWidthPx > MAX_CORRIDOR_TEXTURE_PX);
  assert.equal(s.widthPx, MAX_CORRIDOR_TEXTURE_PX);
  assert.ok(Math.abs(s.widthPx / s.heightPx - 2) < 0.05, "aspect preserved under the cap");
  assert.equal(s.sourceResolutionLimited, false, "here the CAP, not the source, is the limit");
  assert.ok(s.outputMetersPerPixel > s.effectiveMetersPerPixel, "capping coarsens the output honestly");
});

test("coarse source density is never upscaled into fake detail", () => {
  // 260 m at 5 m/px -> only ~52 real pixels.
  const s = corridorTextureSizing(around(260, 260), 5.0);
  assert.equal(s.requestedWidthPx, 52);
  assert.equal(s.widthPx, 64, "clamped only to the minimum useful side");
  assert.ok(s.sourceResolutionLimited, "source-resolution limited must be reported");
});

test("memory budget shrinks the texture and reports it", () => {
  const s = corridorTextureSizing(around(4000, 4000), 0.6, 9, { memoryBudgetBytes: 4 * 1024 * 1024 });
  assert.equal(s.memoryCapped, true);
  assert.ok(s.estimatedRgbaBytes <= 4 * 1024 * 1024 * 1.05, `${s.estimatedRgbaBytes}`);
  assert.ok(s.widthPx < MAX_CORRIDOR_TEXTURE_PX);
});

test("memory estimates are exposed (RGBA + mip chain)", () => {
  const s = corridorTextureSizing(around(260, 260), 0.6, 4);
  assert.equal(s.estimatedRgbaBytes, s.widthPx * s.heightPx * 4);
  assert.ok(s.estimatedMipmappedBytes > s.estimatedRgbaBytes);
  assert.ok(s.estimatedMipmappedBytes < s.estimatedRgbaBytes * 1.4, "~4/3 for a full mip chain");
});

test("provenance summary is truthful and never overstates detail", () => {
  const s = corridorTextureSizing(around(260, 260), 0.6, 4);
  const line = imageryProvenanceSummary(s, "USGS/USDA NAIP");
  assert.match(line, /USGS\/USDA NAIP/);
  assert.match(line, /0\.60 m\/px effective/);
  assert.match(line, /4 tiles used/);
  assert.match(line, /433x433 local texture/);
  assert.match(line, /Source-resolution limited/);
  const capped = corridorTextureSizing(around(4000, 2000), 0.6, 12);
  assert.doesNotMatch(imageryProvenanceSummary(capped, null), /Source-resolution limited/);
});

test("degenerate GSD and bounds fail safe", () => {
  assert.doesNotThrow(() => corridorTextureSizing(around(260, 260), 0));
  assert.doesNotThrow(() => corridorTextureSizing(around(260, 260), Number.NaN));
  const s = corridorTextureSizing(around(0, 0), 0.6);
  assert.ok(s.widthPx >= 64 && s.heightPx >= 64, "clamped to a usable minimum");
});
