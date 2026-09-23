import assert from "node:assert/strict";
import test from "node:test";

import { bearingLabel, buildSamplePlan, fitPlane, localFrame, measureSiteArea, measurementFieldValues, type Ring, type Sample } from "./siteTerrainModel.ts";

// A 40 m (east-west) x 60 m (north-south) rectangle near Muir Beach.
const LON0 = -122.58;
const LAT0 = 37.86;
const frame = localFrame(LON0, LAT0);
const rect = (w: number, h: number): Ring => {
  const corners: Array<[number, number]> = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]];
  return corners.map((p) => frame.toLonLat(p));
};
const OUTLINE = rect(40, 60);

/** A synthetic DEM: a plane rising `slopeDeg` toward the bearing `upBearing`. */
function dem(slopeDeg: number, upBearing: number) {
  const g = Math.tan((slopeDeg * Math.PI) / 180);
  const b = (upBearing * Math.PI) / 180;
  return ([lon, lat]: [number, number]): Sample => {
    const [x, y] = frame.toXY([lon, lat]);
    return { lon, lat, z: 100 + g * (x * Math.sin(b) + y * Math.cos(b)) };
  };
}

test("a plane is recovered exactly", () => {
  const plane = fitPlane([
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 3 },
    { x: 0, y: 1, z: 4 },
    { x: 1, y: 1, z: 6 },
  ]);
  assert.ok(plane);
  assert.ok(Math.abs(plane.a - 2) < 1e-9 && Math.abs(plane.b - 3) < 1e-9 && Math.abs(plane.c - 1) < 1e-9);
});

test("the sample plan fills the outline and a band around it", () => {
  const plan = buildSamplePlan([OUTLINE]);
  assert.ok(plan.inside.length > 300 && plan.inside.length < 900, String(plan.inside.length));
  assert.ok(plan.around.length > 100);
  assert.ok(plan.bufferM >= 15 && plan.bufferM <= 60);
});

test("a 30° slope facing south: slope, fall line, length along the slope, width", () => {
  const plan = buildSamplePlan([OUTLINE]);
  const sample = dem(30, 0); // rises to the north, so it faces south
  const m = measureSiteArea([OUTLINE], plan.inside.map(sample), plan.around.map(sample));
  assert.ok(m);
  assert.ok(Math.abs(m.landslideSlopeDeg - 30) < 0.1, String(m.landslideSlopeDeg));
  assert.ok(Math.abs(m.originalSlopeDeg! - 30) < 0.1);
  assert.equal(bearingLabel(m.downslopeBearingDeg), "180° (S)");
  assert.ok(Math.abs(m.horizontalLengthM - 60) < 0.5, String(m.horizontalLengthM));
  assert.ok(Math.abs(m.widthM - 40) < 0.5, String(m.widthM));
  assert.ok(Math.abs(m.slopeLengthM - 60 / Math.cos(Math.PI / 6)) < 0.5, String(m.slopeLengthM));
  // Relief of the outline plus its band: roughly (60 + 2 * band) * tan 30°.
  assert.ok(m.slopeHeightM > 60 * Math.tan(Math.PI / 6));

  const fields = measurementFieldValues(m);
  assert.equal(fields.measure_landslide_slope_deg, "30.0");
  assert.equal(fields.measure_landslide_width_ft, String(Math.round(40 * 3.2808)));
});

test("the slide can be steeper than the ground around it", () => {
  const plan = buildSamplePlan([OUTLINE]);
  const steep = dem(38, 90);
  const gentle = dem(22, 90);
  const m = measureSiteArea([OUTLINE], plan.inside.map(steep), plan.around.map(gentle));
  assert.ok(m);
  assert.ok(Math.abs(m.landslideSlopeDeg - 38) < 0.1 && Math.abs(m.originalSlopeDeg! - 22) < 0.1);
  assert.equal(bearingLabel(m.downslopeBearingDeg), "270° (W)");
  // Facing west, the fall line runs east-west: length is the 40 m side.
  assert.ok(Math.abs(m.horizontalLengthM - 40) < 0.5 && Math.abs(m.widthM - 60) < 0.5);
});

test("on flat ground the length follows the outline's long axis", () => {
  const plan = buildSamplePlan([OUTLINE]);
  const flat = dem(0, 0);
  const m = measureSiteArea([OUTLINE], plan.inside.map(flat), plan.around.map(flat));
  assert.ok(m && m.directionFromOutline);
  assert.ok(Math.abs(m.horizontalLengthM - 60) < 0.5 && Math.abs(m.widthM - 40) < 0.5);
});

test("too few samples measure nothing", () => {
  assert.equal(measureSiteArea([OUTLINE], [], []), null);
});
