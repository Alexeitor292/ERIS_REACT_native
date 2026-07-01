// Tests for overlay geometry normalization + terrain-mesh coordinate mapping.
// Run: node --test src/arcgis/terrainOverlays.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TerrainMeta } from "./eristerrainBundle.ts";
import {
  clipToBounds,
  colRowToMeshXZ,
  isLonLatInBounds,
  lonLatToColRow,
  lonLatToMeshXZ,
  normalizeOverlayGeometry,
  sampleExtentRing,
  toLonLat,
  type OverlayPrimitive,
} from "./terrainOverlays.ts";

// A 3x3 grid over a 0.04deg x 0.04deg AOI; NW corner = (min_lon, max_lat).
const TERRAIN: TerrainMeta = {
  file: "elevation-grid.bin",
  rows: 3,
  columns: 3,
  encoding: "float32",
  byte_order: "little",
  no_data_value: -9999,
  min_elevation_m: 1,
  max_elevation_m: 9,
  vertical_units: "meters",
  bounds: { min_lat: 38.48, min_lon: -121.52, max_lat: 38.52, max_lon: -121.48 },
  local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: -0.02 },
  sha256: "a".repeat(64),
};
const WS = 100; // world half-extent

function near(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}
function kinds(prims: OverlayPrimitive[]) {
  return prims.map((p) => p.kind);
}

test("point coordinate maps to the terrain mesh (center + corners)", () => {
  // Incident centre -> mesh origin.
  const c = lonLatToMeshXZ(TERRAIN, -121.5, 38.5, WS);
  assert.ok(near(c.x, 0) && near(c.z, 0));
  // NW corner (min_lon, max_lat) -> (-WS, -WS); SE corner -> (+WS, +WS).
  const nw = lonLatToMeshXZ(TERRAIN, -121.52, 38.52, WS);
  assert.ok(near(nw.x, -WS) && near(nw.z, -WS));
  const se = lonLatToMeshXZ(TERRAIN, -121.48, 38.48, WS);
  assert.ok(near(se.x, WS) && near(se.z, WS));
});

test("a GeoJSON Point normalizes + maps onto the mesh", () => {
  const prims = normalizeOverlayGeometry({ type: "Point", coordinates: [-121.5, 38.5] });
  assert.deepEqual(kinds(prims), ["point"]);
  const [lon, lat] = prims[0].coords[0];
  const xz = lonLatToMeshXZ(TERRAIN, lon, lat, WS);
  assert.ok(near(xz.x, 0) && near(xz.z, 0));
});

test("a line (LineString) maps each vertex to the mesh", () => {
  const prims = normalizeOverlayGeometry({
    type: "LineString",
    coordinates: [
      [-121.52, 38.52], // NW
      [-121.5, 38.5], // centre
      [-121.48, 38.48], // SE
    ],
  });
  assert.deepEqual(kinds(prims), ["line"]);
  const pts = prims[0].coords.map(([lon, lat]) => lonLatToMeshXZ(TERRAIN, lon, lat, WS));
  assert.ok(near(pts[0].x, -WS) && near(pts[0].z, -WS));
  assert.ok(near(pts[1].x, 0) && near(pts[1].z, 0));
  assert.ok(near(pts[2].x, WS) && near(pts[2].z, WS));
});

test("a polygon (ring) maps its corners to the mesh", () => {
  const prims = normalizeOverlayGeometry({
    type: "Polygon",
    coordinates: [
      [
        [-121.52, 38.52],
        [-121.48, 38.52],
        [-121.48, 38.48],
        [-121.52, 38.48],
        [-121.52, 38.52],
      ],
    ],
  });
  assert.deepEqual(kinds(prims), ["polygon"]);
  const pts = prims[0].coords.map(([lon, lat]) => lonLatToMeshXZ(TERRAIN, lon, lat, WS));
  // NW, NE, SE, SW corners of the mesh.
  assert.ok(near(pts[0].x, -WS) && near(pts[0].z, -WS));
  assert.ok(near(pts[1].x, WS) && near(pts[1].z, -WS));
  assert.ok(near(pts[2].x, WS) && near(pts[2].z, WS));
  assert.ok(near(pts[3].x, -WS) && near(pts[3].z, WS));
});

test("sample extent ring maps to the four mesh corners", () => {
  const ring = sampleExtentRing({ minLat: 38.48, minLon: -121.52, maxLat: 38.52, maxLon: -121.48 });
  assert.equal(ring.length, 5); // closed rectangle
  const pts = ring.map(([lon, lat]) => lonLatToMeshXZ(TERRAIN, lon, lat, WS));
  assert.ok(near(pts[0].x, -WS) && near(pts[0].z, WS)); // SW (minLon,minLat)
  assert.ok(near(pts[1].x, WS) && near(pts[1].z, WS)); // SE
  assert.ok(near(pts[2].x, WS) && near(pts[2].z, -WS)); // NE
  assert.ok(near(pts[3].x, -WS) && near(pts[3].z, -WS)); // NW
  assert.deepEqual(pts[0], pts[4]); // closed
});

test("colRow + mesh mapping compose consistently", () => {
  const { col, row } = lonLatToColRow(TERRAIN, -121.5, 38.5);
  assert.ok(near(col, 1) && near(row, 1));
  const xz = colRowToMeshXZ(TERRAIN.rows, TERRAIN.columns, col, row, WS);
  assert.ok(near(xz.x, 0) && near(xz.z, 0));
});

test("normalizeOverlayGeometry handles Feature / FeatureCollection / GeometryCollection", () => {
  assert.deepEqual(
    kinds(normalizeOverlayGeometry({ type: "Feature", geometry: { type: "Point", coordinates: [-121.5, 38.5] } })),
    ["point"],
  );
  assert.deepEqual(
    kinds(
      normalizeOverlayGeometry({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [-121.5, 38.5] } },
          { type: "Feature", geometry: { type: "LineString", coordinates: [[-121.52, 38.52], [-121.48, 38.48]] } },
        ],
      }),
    ),
    ["point", "line"],
  );
  assert.deepEqual(
    kinds(
      normalizeOverlayGeometry({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [-121.5, 38.5] },
          { type: "Polygon", coordinates: [[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]] },
        ],
      }),
    ),
    ["point", "polygon"],
  );
});

test("normalizeOverlayGeometry handles multi-geometries + Esri JSON", () => {
  assert.deepEqual(kinds(normalizeOverlayGeometry({ type: "MultiPoint", coordinates: [[-121.5, 38.5], [-121.49, 38.49]] })), [
    "point",
    "point",
  ]);
  assert.deepEqual(
    kinds(normalizeOverlayGeometry({ type: "MultiLineString", coordinates: [[[-121.52, 38.52], [-121.5, 38.5]]] })),
    ["line"],
  );
  assert.deepEqual(
    kinds(normalizeOverlayGeometry({ type: "MultiPolygon", coordinates: [[[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]]] })),
    ["polygon"],
  );
  // Esri JSON shapes.
  assert.deepEqual(kinds(normalizeOverlayGeometry({ x: -121.5, y: 38.5 })), ["point"]);
  assert.deepEqual(kinds(normalizeOverlayGeometry({ points: [[-121.5, 38.5], [-121.49, 38.49]] })), ["point", "point"]);
  assert.deepEqual(kinds(normalizeOverlayGeometry({ paths: [[[-121.52, 38.52], [-121.5, 38.5]]] })), ["line"]);
  assert.deepEqual(kinds(normalizeOverlayGeometry({ rings: [[[-121.52, 38.52], [-121.48, 38.52], [-121.48, 38.48], [-121.52, 38.52]]] })), [
    "polygon",
  ]);
});

test("Web Mercator coordinates are coerced to lon/lat (not invented)", () => {
  // -121.5, 38.5 in EPSG:3857 metres.
  const xMerc = (-121.5 / 180) * 20037508.34;
  const latRad = (38.5 * Math.PI) / 180;
  const yMerc = (20037508.34 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const ll = toLonLat([xMerc, yMerc]);
  assert.ok(ll);
  assert.ok(near(ll![0], -121.5, 1e-4) && near(ll![1], 38.5, 1e-4));
  // A WGS84 pair is returned unchanged.
  assert.deepEqual(toLonLat([-121.5, 38.5]), [-121.5, 38.5]);
  assert.equal(toLonLat([Number.NaN, 1]), null);
});

test("in-bounds detection + clipping drop out-of-bounds vertices (no invented coords)", () => {
  assert.equal(isLonLatInBounds(TERRAIN, -121.5, 38.5), true); // centre
  assert.equal(isLonLatInBounds(TERRAIN, -121.52, 38.52), true); // NW corner
  assert.equal(isLonLatInBounds(TERRAIN, -120.0, 38.5), false); // far east of AOI
  assert.equal(isLonLatInBounds(TERRAIN, -121.5, 39.0), false); // north of AOI
  const clipped = clipToBounds(TERRAIN, [
    [-121.5, 38.5], // in
    [-120.0, 38.5], // out (east)
    [-121.49, 38.49], // in
  ]);
  assert.deepEqual(clipped, [
    [-121.5, 38.5],
    [-121.49, 38.49],
  ]);
});
