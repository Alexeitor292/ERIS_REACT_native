// Deterministic tests for corridor station placement + per-segment road clipping.
// These prove BEHAVIOR (not just string presence) for the immersive corridor.
// Run: node --test src/arcgis/corridorModel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCorridorParts,
  clipPolylineToRect,
  insertStationIntoParts,
  metersBetween,
  toLocalMeters,
  type LonLat,
  type Rect,
} from "./corridorModel.ts";

// A small corridor rect near lat 38.5.
const RECT: Rect = { minLon: -121.51, minLat: 38.49, maxLon: -121.49, maxLat: 38.51 };
const inside = (r: Rect, c: LonLat, eps = 1e-9) => c[0] >= r.minLon - eps && c[0] <= r.maxLon + eps && c[1] >= r.minLat - eps && c[1] <= r.maxLat + eps;

// ---- Part 1: station is fixed (never the clipped-patch midpoint) ------------

test("station at corridor centre -> zero local offset", () => {
  const c = buildCorridorParts([], RECT, -121.5, 38.5, -121.5, 38.5);
  assert.ok(Math.hypot(c.stationLocal[0], c.stationLocal[1]) < 1e-6);
});

test("station near each AOI edge maps to the correct signed local offset", () => {
  // Patch centre 38.5/-121.5; station pushed east + north.
  const east = buildCorridorParts([], RECT, -121.5, 38.5, -121.492, 38.5).stationLocal;
  assert.ok(east[0] > 300, "east offset is positive (~+700 m)");
  assert.ok(Math.abs(east[1]) < 1e-6);
  const north = buildCorridorParts([], RECT, -121.5, 38.5, -121.5, 38.508).stationLocal;
  assert.ok(north[1] < -300, "north is negative south-offset (row 0 = north)");
});

test("clipped corridor: station is NOT the patch midpoint and is preserved exactly", () => {
  // Simulate an edge package: the patch centre is offset from the station by construction.
  const stationLon = -121.4955;
  const stationLat = 38.5045;
  const centerLon = -121.5; // patch centre differs from the station (edge clip)
  const centerLat = 38.5;
  const c = buildCorridorParts([[stationLon, stationLat], [stationLon + 0.001, stationLat]], RECT, centerLon, centerLat, stationLon, stationLat);
  const expected = toLocalMeters(stationLon, stationLat, centerLon, centerLat);
  assert.deepEqual(c.stationLocal, expected);
  assert.ok(Math.hypot(c.stationLocal[0], c.stationLocal[1]) > 100, "station is well away from the patch centre");
});

// ---- Part 2: real per-segment clipping (multi-part) ------------------------

test("outside-to-outside crossing segment is retained", () => {
  const parts = clipPolylineToRect([[-121.55, 38.5], [-121.45, 38.5]], RECT); // spans the whole rect
  assert.equal(parts.length, 1);
  assert.equal(parts[0].length, 2);
  for (const c of parts[0]) assert.ok(inside(RECT, c));
  assert.ok(Math.abs(parts[0][0][0] - RECT.minLon) < 1e-9 && Math.abs(parts[0][1][0] - RECT.maxLon) < 1e-9, "clipped to both edges");
});

test("partially inside segment is clipped at the boundary", () => {
  const parts = clipPolylineToRect([[-121.5, 38.5], [-121.45, 38.5]], RECT); // starts inside, exits east
  assert.equal(parts.length, 1);
  assert.ok(Math.abs(parts[0][0][0] - -121.5) < 1e-9, "keeps the inside start");
  assert.ok(Math.abs(parts[0][1][0] - RECT.maxLon) < 1e-9, "clips at the east edge");
});

test("completely-outside, non-intersecting segment yields nothing", () => {
  assert.deepEqual(clipPolylineToRect([[-121.55, 38.6], [-121.45, 38.6]], RECT), []);
});

test("leave and re-enter produces SEPARATE parts (no false chord)", () => {
  // in -> out (east) -> back in: a zig-zag that exits and re-enters the rect.
  const road: LonLat[] = [
    [-121.5, 38.5], // inside
    [-121.45, 38.5], // exits east
    [-121.45, 38.505], // stays outside (east)
    [-121.5, 38.505], // re-enters
  ];
  const parts = clipPolylineToRect(road, RECT);
  assert.equal(parts.length, 2, "two disconnected parts");
  for (const part of parts) for (const c of part) assert.ok(inside(RECT, c));
  // The two parts must NOT be joined: their nearest endpoints are ~1 rect-width apart.
  const gap = metersBetween(parts[0][parts[0].length - 1][0], parts[0][parts[0].length - 1][1], parts[1][0][0], parts[1][0][1]);
  assert.ok(gap > 500, "parts are genuinely disconnected, not chorded together");
});

test("sparse highway segment crossing the station is retained and carries the station", () => {
  // A generalized 2-vertex highway whose vertices are both OUTSIDE, but crosses the station.
  const stationLon = -121.5;
  const stationLat = 38.5;
  const road: LonLat[] = [[-121.56, 38.5], [-121.44, 38.5]]; // both endpoints outside, crosses centre
  const c = buildCorridorParts(road, RECT, -121.5, 38.5, stationLon, stationLat);
  assert.equal(c.roadPartsXsZs.length, 1, "the crossing segment survives");
  // The station (local 0,0 here) is an explicit vertex of the retained part.
  const hasStation = c.roadPartsXsZs[0].some((p) => Math.hypot(p[0], p[1]) < 1e-6);
  assert.ok(hasStation, "the projected snap point is included in the retained part");
});

test("every output coordinate lies inside the corridor bounds", () => {
  const road: LonLat[] = [
    [-121.6, 38.4], [-121.5, 38.5], [-121.495, 38.505], [-121.4, 38.6], [-121.505, 38.495], [-121.3, 38.3],
  ];
  const parts = clipPolylineToRect(road, RECT);
  assert.ok(parts.length >= 1);
  for (const part of parts) {
    assert.ok(part.length >= 2);
    for (const c of part) assert.ok(inside(RECT, c), `${c} inside rect`);
  }
});

test("insertStationIntoParts is a no-op when the station is off every road part", () => {
  const parts: LonLat[][] = [[[-121.5, 38.5], [-121.495, 38.5]]];
  const before = JSON.stringify(parts);
  insertStationIntoParts(parts, [-121.5, 38.6]); // far from the road
  assert.equal(JSON.stringify(parts), before);
});
