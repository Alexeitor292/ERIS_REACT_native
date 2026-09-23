import assert from "node:assert/strict";
import test from "node:test";

import { comfortableExtent, geoJsonPositions } from "./mapFit.ts";

const METRES_PER_DEGREE_LAT = 111_320;

function spanMetres(extent: { xmin: number; ymin: number; xmax: number; ymax: number }) {
  const midLat = (extent.ymin + extent.ymax) / 2;
  return {
    across: (extent.xmax - extent.xmin) * METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180),
    tall: (extent.ymax - extent.ymin) * METRES_PER_DEGREE_LAT,
  };
}

test("nothing to show gives no extent, so the map stays where it is", () => {
  assert.equal(comfortableExtent([]), null);
  assert.equal(comfortableExtent([{ longitude: Number.NaN, latitude: 38 }]), null);
});

test("a single pin opens on its surroundings, not on a zoom-level-zero point", () => {
  const extent = comfortableExtent([{ longitude: -124.134, latitude: 40.605 }], { minSpanM: 1000 })!;
  const span = spanMetres(extent);
  assert.ok(Math.abs(span.across - 1000) < 1, `across ${span.across}`);
  assert.ok(Math.abs(span.tall - 1000) < 1, `tall ${span.tall}`);
  assert.ok(extent.xmin < -124.134 && extent.xmax > -124.134);
});

test("reports at the same spot fit like a single pin", () => {
  const same = { longitude: -122.5, latitude: 38 };
  assert.deepEqual(comfortableExtent([same, same, same], { minSpanM: 600 }), comfortableExtent([same], { minSpanM: 600 }));
});

test("spread-out points all fit, with room on every side", () => {
  const points = [
    { longitude: -122.0, latitude: 38.0 },
    { longitude: -121.0, latitude: 39.0 },
  ];
  const extent = comfortableExtent(points, { padding: 0.25 })!;
  // A quarter of the span is added beyond each outermost point.
  assert.ok(Math.abs(extent.xmin - -122.25) < 1e-9);
  assert.ok(Math.abs(extent.xmax - -120.75) < 1e-9);
  assert.ok(Math.abs(extent.ymin - 37.75) < 1e-9);
  assert.ok(Math.abs(extent.ymax - 39.25) < 1e-9);
});

test("a bad position is ignored instead of stretching the view across the world", () => {
  const extent = comfortableExtent([{ longitude: -122.5, latitude: 38 }, { longitude: 500, latitude: 38 }], { minSpanM: 300 })!;
  assert.ok(spanMetres(extent).across < 301);
});

test("every GeoJSON position is found, and Web Mercator metres are converted", () => {
  assert.deepEqual(geoJsonPositions({ type: "Point", coordinates: [-122.5, 38] }), [{ longitude: -122.5, latitude: 38 }]);
  assert.equal(geoJsonPositions({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }).length, 4);
  assert.equal(
    geoJsonPositions({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }, { type: "LineString", coordinates: [[3, 4], [5, 6]] }] }).length,
    3,
  );
  const [mercator] = geoJsonPositions({ type: "Point", coordinates: [-13636637.62, 4579425.81] });
  assert.ok(Math.abs(mercator.longitude - -122.5) < 1e-4);
  assert.ok(Math.abs(mercator.latitude - 38) < 1e-4);
  assert.deepEqual(geoJsonPositions(null), []);
});
