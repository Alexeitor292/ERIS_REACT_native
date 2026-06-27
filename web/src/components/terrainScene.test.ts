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
  deriveSceneHealth,
  evaluateLayerHealth,
  extractRenderableGeometries,
  geoJsonRenderable,
  gridBoundingRing,
  incidentSummaryLine,
  initialViewpointFor,
  isArcgisAccessError,
  isElementFullscreen,
  isValidIncidentLocation,
  nextFullscreen,
  overlayAvailability,
  sceneAnchorKey,
  sceneContainerClass,
  supportsFullscreenApi,
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

test("scene anchor key is stable across separate object instances with equal coords", () => {
  const a = { latitude: 38.5816, longitude: -121.4944 };
  const b = { latitude: 38.5816, longitude: -121.4944 }; // distinct object, same values
  assert.notStrictEqual(a, b, "must be different object instances");
  // Equal coordinates -> identical anchor key (so the SceneView is NOT recreated).
  assert.equal(sceneAnchorKey(a), sceneAnchorKey(b));
  assert.deepEqual(initialViewpointFor(a), initialViewpointFor(b));
  // Changing a coordinate changes the key (SceneView SHOULD recreate).
  assert.notEqual(sceneAnchorKey(a), sceneAnchorKey({ latitude: 38.6, longitude: -121.4944 }));
  assert.notEqual(sceneAnchorKey(a), sceneAnchorKey({ latitude: 38.5816, longitude: -121.5 }));
  // Invalid coordinates -> null (safe empty state, no anchor).
  assert.equal(sceneAnchorKey(null), null);
  assert.equal(sceneAnchorKey({ latitude: 0, longitude: 0 }), null);
  assert.equal(sceneAnchorKey({ latitude: null, longitude: -121.5 }), null);
});

test("imagery/terrain mode toggle maps to truthful Esri basemaps", () => {
  assert.equal(basemapIdFor("satellite"), "hybrid");
  assert.equal(basemapIdFor("topographic"), "topo-vector");
});

test("full-screen control toggles and pins the container to the viewport", () => {
  assert.equal(nextFullscreen(false), true);
  assert.equal(nextFullscreen(true), false);
  // CSS fallback pins to the viewport; native fullscreen lets the browser size it.
  assert.match(sceneContainerClass(true), /fixed inset-0/);
  assert.match(sceneContainerClass(true, false), /fixed inset-0/);
  assert.doesNotMatch(sceneContainerClass(true, true), /fixed inset-0/);
  assert.match(sceneContainerClass(true, true), /bg-black/);
  assert.doesNotMatch(sceneContainerClass(false), /fixed inset-0/);
});

test("Fullscreen API support detection + element matching (drives Esc sync)", () => {
  assert.equal(supportsFullscreenApi({ fullscreenEnabled: true }), true);
  assert.equal(supportsFullscreenApi({ fullscreenEnabled: false }), false);
  assert.equal(supportsFullscreenApi(null), false);
  // An element without requestFullscreen means the API can't be used on it.
  assert.equal(supportsFullscreenApi({ fullscreenEnabled: true }, {}), false);
  assert.equal(supportsFullscreenApi({ fullscreenEnabled: true }, { requestFullscreen: () => {} }), true);
  const el = {} as unknown as Element;
  assert.equal(isElementFullscreen({ fullscreenElement: el }, el), true);
  assert.equal(isElementFullscreen({ fullscreenElement: null }, el), false);
  assert.equal(isElementFullscreen(null, el), false);
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

test("GeoJSON: raw geometry, Feature, FeatureCollection, GeometryCollection all extract", () => {
  // raw geometry
  assert.equal(extractRenderableGeometries({ type: "Point", coordinates: [-121, 38] }).length, 1);
  // Feature
  assert.equal(
    extractRenderableGeometries({ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }).length,
    1,
  );
  // FeatureCollection (Point + Polygon)
  const fc = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    ],
  };
  const fcGeoms = extractRenderableGeometries(fc);
  assert.deepEqual(fcGeoms.map((g) => g.type), ["Point", "Polygon"]);
  // GeometryCollection (Point + MultiPoint)
  const gc = {
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [0, 0] },
      { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] },
    ],
  };
  assert.equal(extractRenderableGeometries(gc).length, 2);
});

test("GeoJSON validation rejects malformed geometry and disables the overlay", () => {
  assert.equal(geoJsonRenderable(null), false);
  assert.equal(geoJsonRenderable({}), false);
  assert.equal(geoJsonRenderable({ type: "Point", coordinates: [] }), false);
  assert.equal(geoJsonRenderable({ type: "Point", coordinates: ["x", "y"] }), false);
  assert.equal(geoJsonRenderable({ type: "LineString", coordinates: [[0, 0]] }), false); // < 2 points
  assert.equal(geoJsonRenderable({ type: "Polygon", coordinates: [[[0, 0], [1, 0]]] }), false); // ring < 3
  assert.equal(geoJsonRenderable({ type: "FeatureCollection", features: [] }), false);
  assert.equal(
    geoJsonRenderable({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1] }] }),
    false,
  );
  assert.equal(geoJsonRenderable({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }), true);

  // Overlay availability must follow renderability, not mere presence.
  const malformed = overlayAvailability({
    location: { latitude: 38.5, longitude: -121.5 },
    terrain: null,
    geometryJson: { type: "LineString", coordinates: [[0, 0]] },
  });
  assert.equal(malformed.uploadedGeometry, false);
});

test("layer health uses loadStatus (not counts); access errors are detected", () => {
  assert.deepEqual(evaluateLayerHealth([]), { failed: false, access: false });
  assert.deepEqual(evaluateLayerHealth([{ loadStatus: "loaded" }]), { failed: false, access: false });
  assert.deepEqual(
    evaluateLayerHealth([{ loadStatus: "failed", loadError: new Error("network down") }]),
    { failed: true, access: false },
  );
  assert.deepEqual(
    evaluateLayerHealth([{ loadStatus: "failed", loadError: { message: "Token Required" } }]),
    { failed: true, access: true },
  );
  assert.equal(isArcgisAccessError({ details: { httpStatus: 403 } }), true);
  assert.equal(isArcgisAccessError({ message: "Invalid API Key" }), true);
  assert.equal(isArcgisAccessError(new Error("timeout")), false);
  assert.equal(isArcgisAccessError(null), false);
});

test("scene health: both failed blocks; one failed warns; access surfaces", () => {
  const ok = { failed: false, access: false };
  assert.deepEqual(deriveSceneHealth(ok, ok), { blocking: null, warning: null });
  assert.deepEqual(deriveSceneHealth({ failed: true, access: false }, ok), {
    blocking: null,
    warning: { kind: "imagery" },
  });
  assert.deepEqual(deriveSceneHealth(ok, { failed: true, access: false }), {
    blocking: null,
    warning: { kind: "elevation" },
  });
  assert.deepEqual(deriveSceneHealth({ failed: true, access: false }, { failed: true, access: false }), {
    blocking: "both",
    warning: null,
  });
  assert.deepEqual(deriveSceneHealth({ failed: true, access: true }, { failed: true, access: false }), {
    blocking: "access",
    warning: null,
  });
  assert.deepEqual(deriveSceneHealth({ failed: true, access: true }, ok), {
    blocking: null,
    warning: { kind: "access" },
  });
});

test("error message covers the ArcGIS access-rejected case", () => {
  assert.match(terrainSceneErrorMessage("access"), /api key|access|authoriz/i);
});
