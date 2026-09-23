import assert from "node:assert/strict";
import test from "node:test";

import { areasFromGeoJson, areasSummary, formatArea, geoJsonFromAreas, polygonAreaSqM, ringAreaSqM, type Ring } from "./siteAreasModel.ts";

// A square 0.001° on a side near Sacramento (~111 m × ~87 m).
const SQUARE: Ring = [[-121.5, 38.5], [-121.499, 38.5], [-121.499, 38.501], [-121.5, 38.501], [-121.5, 38.5]];

test("a small square's geodesic area is right to within a fraction of a percent", () => {
  const expected = 111.32 * 0.001 * 1000 * (111.32 * 0.001 * 1000 * Math.cos((38.5005 * Math.PI) / 180));
  const actual = ringAreaSqM(SQUARE);
  assert.ok(Math.abs(actual - expected) / expected < 0.005, `${actual} vs ${expected}`);
  // Winding direction does not matter.
  assert.equal(Math.round(ringAreaSqM([...SQUARE].reverse())), Math.round(actual));
});

test("holes are subtracted", () => {
  const hole: Ring = [[-121.4998, 38.5002], [-121.4992, 38.5002], [-121.4992, 38.5008], [-121.4998, 38.5008], [-121.4998, 38.5002]];
  assert.ok(polygonAreaSqM([SQUARE, hole]) < ringAreaSqM(SQUARE));
});

test("stored geometry yields its polygons, and areas store back as Polygon or MultiPolygon", () => {
  assert.equal(areasFromGeoJson({ type: "Polygon", coordinates: [SQUARE] }).length, 1);
  assert.equal(areasFromGeoJson({ type: "MultiPolygon", coordinates: [[SQUARE], [SQUARE]] }).length, 2);
  assert.equal(areasFromGeoJson({ type: "GeometryCollection", geometries: [{ type: "Polygon", coordinates: [SQUARE] }, { type: "Point", coordinates: [0, 0] }] }).length, 1);
  assert.equal(areasFromGeoJson({ type: "LineString", coordinates: [[0, 0], [1, 1]] }).length, 0);
  assert.equal(areasFromGeoJson(null).length, 0);

  assert.equal(geoJsonFromAreas([]), null);
  assert.deepEqual(geoJsonFromAreas([[SQUARE]]), { type: "Polygon", coordinates: [SQUARE] });
  assert.equal(geoJsonFromAreas([[SQUARE], [SQUARE]])?.type, "MultiPolygon");
  // A degenerate ring (fewer than four positions) is not an area.
  assert.equal(geoJsonFromAreas([[[[0, 0], [1, 1], [0, 0]]]]), null);
});

test("areas read in the units a Caltrans engineer uses", () => {
  assert.equal(formatArea(5020), "5,020 m² · 1.24 ac");
  assert.equal(formatArea(650), "650 m² · 6,997 ft²");
  assert.equal(areasSummary([]), "No areas drawn");
  assert.match(areasSummary([[SQUARE], [SQUARE]]), /^2 areas · /);
});
