import assert from "node:assert/strict";
import test from "node:test";

import { headingWedgeRing, parseCssColor, withAlpha } from "./photoEvidenceGraphics.ts";

test("heading wedge opens toward the camera heading and closes on the photo point", () => {
  const ring = headingWedgeRing(38.5, -121.5, 90, 45, 16, 4);
  assert.deepEqual(ring[0], [-121.5, 38.5]);
  assert.deepEqual(ring[ring.length - 1], [-121.5, 38.5]);
  assert.equal(ring.length, 7);
  // Heading 90° = due east: every arc point sits east of the origin with tiny latitude change.
  for (const [lon, lat] of ring.slice(1, -1)) {
    assert.ok(lon > -121.5, "arc point should be east of the photo");
    assert.ok(Math.abs(lat - 38.5) < 0.0002, "arc should stay within ±16° of due east");
  }
  const [midLon] = ring[3];
  const eastMeters = (midLon + 121.5) * 111_320 * Math.cos((38.5 * Math.PI) / 180);
  assert.ok(Math.abs(eastMeters - 45) < 0.5, `wedge radius should be ~45 m, got ${eastMeters}`);
});

test("wedge toward north increases latitude only", () => {
  const ring = headingWedgeRing(38.5, -121.5, 0, 45, 16, 2);
  const apex = ring[2];
  assert.ok(Math.abs(apex[0] + 121.5) < 1e-9);
  assert.ok(apex[1] > 38.5);
});

test("css colors parse from hex and rgb forms", () => {
  assert.deepEqual(parseCssColor("#17b4ad"), [23, 180, 173]);
  assert.deepEqual(parseCssColor(" #fff "), [255, 255, 255]);
  assert.deepEqual(parseCssColor("rgb(31, 155, 209)"), [31, 155, 209]);
  assert.deepEqual(parseCssColor("rgba(1 2 3 / 0.5)"), [1, 2, 3]);
  assert.equal(parseCssColor("oklab(0.5 0 0)"), null);
  assert.equal(parseCssColor(""), null);
  assert.deepEqual(withAlpha([1, 2, 3], 0.28), [1, 2, 3, 0.28]);
});
