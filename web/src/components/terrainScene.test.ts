// Targeted unit tests for the interactive 3D terrain scene logic.
//
// Run with Node's built-in runner (no extra dependency):
//   node --test src/components/terrainScene.test.ts
// Node strips the TypeScript types at load time. These cover the decision logic
// the SceneView relies on; the WebGL SceneView itself is exercised manually
// (see the ADR's manual test path) since it cannot render headless.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  basemapIdFor,
  bearingLineEndpoints,
  gridBoundingRing,
  incidentSummaryLine,
  initialViewpointFor,
  isValidIncidentLocation,
  nextFullscreen,
  overlayAvailability,
  sceneContainerClass,
  terrainSceneErrorMessage,
  DEFAULT_SCENE_TILT,
} from "./terrainScene.ts";

test("viewer opens centered on the incident location with an oblique camera", () => {
  const vp = initialViewpointFor({ latitude: 38.5816, longitude: -121.4944 });
  assert.ok(vp, "viewpoint should be produced for a valid incident");
  assert.deepEqual(vp!.target, [-121.4944, 38.5816], "target is the incident lon/lat");
  // Oblique: tilted, but neither straight down (0) nor flat (90).
  assert.equal(vp!.tilt, DEFAULT_SCENE_TILT);
  assert.ok(vp!.tilt > 0 && vp!.tilt < 90, "tilt is a slightly-tilted oblique angle");
  assert.ok(vp!.zoom >= 14 && vp!.zoom <= 18, "framed close enough to read terrain");
});

test("missing / invalid incident coordinates are handled safely (no camera fly-to)", () => {
  assert.equal(initialViewpointFor(null), null);
  assert.equal(initialViewpointFor({ latitude: null, longitude: null }), null);
  assert.equal(initialViewpointFor({ latitude: 0, longitude: 0 }), null, "null-island rejected");
  assert.equal(initialViewpointFor({ latitude: 200, longitude: -121 }), null, "out-of-range rejected");
  assert.equal(initialViewpointFor({ latitude: NaN, longitude: -121 }), null);
  assert.equal(isValidIncidentLocation({ latitude: 38.5, longitude: -121.5 }), true);
});

test("imagery/terrain mode toggle maps to truthful Esri basemaps", () => {
  assert.equal(basemapIdFor("satellite"), "hybrid");
  assert.equal(basemapIdFor("topographic"), "topo-vector");
});

test("full-screen control toggles and pins the container to the viewport", () => {
  assert.equal(nextFullscreen(false), true);
  assert.equal(nextFullscreen(true), false);
  assert.match(sceneContainerClass(true), /fixed inset-0/);
  assert.doesNotMatch(sceneContainerClass(false), /fixed inset-0/);
});

test("no road bearing / no geometry => no fake road or geometry overlays", () => {
  // Valid incident but terrain has NO resolved bearing and NO uploaded geometry.
  const a = overlayAvailability({
    location: { latitude: 38.5, longitude: -121.5 },
    terrain: { road_bearing_deg_used: null, grid: { points: [] } },
    geometryJson: null,
  });
  assert.equal(a.incidentMarker, true);
  assert.equal(a.roadBearing, false, "must NOT offer a road overlay without a bearing");
  assert.equal(a.terrainExtent, false, "no sampled points => no extent overlay");
  assert.equal(a.uploadedGeometry, false, "no geometry_json => no geometry overlay");

  // With a real bearing, real grid points, and real geometry, overlays unlock.
  const b = overlayAvailability({
    location: { latitude: 38.5, longitude: -121.5 },
    terrain: { road_bearing_deg_used: 245, grid: { points: [{ lat: 38.5, lon: -121.5 }] } },
    geometryJson: { type: "Point", coordinates: [-121.5, 38.5] },
  });
  assert.deepEqual(b, {
    incidentMarker: true,
    roadBearing: true,
    terrainExtent: true,
    uploadedGeometry: true,
  });
});

test("overlay availability is false when the incident itself is invalid", () => {
  const a = overlayAvailability({
    location: { latitude: null, longitude: null },
    terrain: { road_bearing_deg_used: 90, grid: { points: [{ lat: 1, lon: 2 }] } },
    geometryJson: null,
  });
  assert.equal(a.incidentMarker, false);
  assert.equal(a.roadBearing, false, "bearing overlay requires a valid incident anchor");
  // Terrain extent is independent of the incident anchor (it has its own points).
  assert.equal(a.terrainExtent, true);
});

test("terrain service failure produces a useful, non-blaming message", () => {
  for (const kind of ["elevation", "imagery", "both", "unknown"] as const) {
    const msg = terrainSceneErrorMessage(kind);
    assert.ok(msg.length > 20, "message should be descriptive");
    assert.doesNotMatch(msg, /you (did|caused)/i, "should not blame the user");
  }
  assert.match(terrainSceneErrorMessage("elevation"), /elevation/i);
  assert.match(terrainSceneErrorMessage("imagery"), /imagery|topographic/i);
});

test("bearing line is symmetric about the incident and follows the bearing", () => {
  // Due east (90°): endpoints differ in longitude, ~equal latitude.
  const [a, b] = bearingLineEndpoints(38.5, -121.5, 90, 120);
  assert.ok(b[0] > a[0], "east bearing increases longitude toward the +end");
  assert.ok(Math.abs(b[1] - a[1]) < 1e-4, "due-east keeps latitude ~constant");
  // Midpoint is the incident.
  assert.ok(Math.abs((a[0] + b[0]) / 2 - -121.5) < 1e-9);
  assert.ok(Math.abs((a[1] + b[1]) / 2 - 38.5) < 1e-9);
});

test("grid bounding ring is a closed rectangle around the sampled points", () => {
  const ring = gridBoundingRing([
    { lat: 38.4, lon: -121.6 },
    { lat: 38.6, lon: -121.4 },
    { lat: 38.5, lon: -121.5 },
  ]);
  assert.ok(ring);
  assert.equal(ring!.length, 5, "closed ring (first == last)");
  assert.deepEqual(ring![0], ring![4]);
  assert.deepEqual(ring![0], [-121.6, 38.4]);
  assert.deepEqual(ring![2], [-121.4, 38.6]);
  assert.equal(gridBoundingRing([]), null);
  assert.equal(gridBoundingRing(null), null);
});

test("incident summary line is safe with partial data", () => {
  assert.equal(
    incidentSummaryLine({ route: "080", postMile: "5.0", county: "ALA", latitude: 38.5, longitude: -121.5 }),
    "Rte 080  ·  PM 5.0  ·  ALA  ·  38.50000, -121.50000",
  );
  assert.equal(incidentSummaryLine({}), "Location unavailable");
});
