import assert from "node:assert/strict";
import test from "node:test";

import { bearingLabel, buildSamplePlan, compareSurfaces, comparisonFieldValues, fitPlane, localFrame, measureSiteArea, measurementFieldValues, pointsAlong, profileLine, type Ring, type Sample } from "./siteTerrainModel.ts";

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

test("before and after: slopes, heights and the ground lost and gained", () => {
  // A 40 m square on a 30° slope facing south; the drone survey shows the upper
  // half dropped 2 m (a slump) and the lower half raised 1 m (the debris).
  const [lon0, lat0] = [-122.5, 37.8];
  const frame = localFrame(lon0, lat0);
  const ring = ([[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]] as Array<[number, number]>).map(frame.toLonLat);
  const plan = buildSamplePlan([ring], 400, 1.5);
  const slope = Math.tan((30 * Math.PI) / 180);
  const before = (lon: number, lat: number) => 100 + frame.toXY([lon, lat])[1] * slope;
  const points = [...plan.inside, ...plan.around];
  const historical = points.map(([lon, lat]) => before(lon, lat));
  const actual = points.map(([lon, lat], i) => {
    if (i >= plan.inside.length) return before(lon, lat);
    return before(lon, lat) + (frame.toXY([lon, lat])[1] > 0 ? -2 : 1);
  });
  const result = compareSurfaces([ring], plan, historical, actual)!;
  assert.ok(Math.abs(result.original.landslideSlopeDeg - 30) < 0.5);
  assert.ok(result.updated.landslideSlopeDeg < result.original.landslideSlopeDeg);
  assert.equal(result.coverage, 1);
  assert.ok(Math.abs(result.maxLossM - 2) < 1e-9 && Math.abs(result.maxGainM - 1) < 1e-9);
  // Half of 1600 m² lost 2 m, half gained 1 m (to within the sampling grid).
  assert.ok(Math.abs(result.lossVolumeM3 - 1600) < 160, `loss ${result.lossVolumeM3}`);
  assert.ok(Math.abs(result.gainVolumeM3 - 800) < 80, `gain ${result.gainVolumeM3}`);
  assert.ok(result.netVolumeM3 < 0);
});

test("without the drone surface under the outline there is nothing to compare", () => {
  const frame = localFrame(-122.5, 37.8);
  const ring = ([[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]] as Array<[number, number]>).map(frame.toLonLat);
  const plan = buildSamplePlan([ring], 200, 1.5);
  const points = [...plan.inside, ...plan.around];
  assert.equal(compareSurfaces([ring], plan, points.map(() => 100), points.map(() => null)), null);
});

test("the cross-section runs down the fall line, past the outline", () => {
  const frame = localFrame(-122.5, 37.8);
  const ring = ([[-20, -30], [20, -30], [20, 30], [-20, 30], [-20, -30]] as Array<[number, number]>).map(frame.toLonLat);
  const [top, bottom] = profileLine([ring], 180, 10); // facing south
  const [tx, ty] = frame.toXY(top);
  const [bx, by] = frame.toXY(bottom);
  assert.ok(Math.abs(tx) < 0.01 && Math.abs(bx) < 0.01);
  assert.ok(Math.abs(ty - 40) < 0.05 && Math.abs(by + 40) < 0.05);
  const along = pointsAlong(top, bottom, 5);
  assert.equal(along.length, 5);
  assert.ok(Math.abs(along[4].distanceM - 80) < 0.1 && along[0].distanceM === 0);
});

test("a before/after fills α and H from the original ground, β and the size from the ground now", () => {
  const measurement = (slope: number, height: number, length: number, width: number) =>
    ({ landslideSlopeDeg: slope, slopeHeightM: height, slopeLengthM: length, widthM: width }) as unknown as import("./siteTerrainModel.ts").SiteMeasurement;
  const values = comparisonFieldValues({
    original: measurement(34.2, 20, 50, 30),
    updated: measurement(28.66, 18, 55, 31),
  } as import("./siteTerrainModel.ts").SurfaceComparison);
  assert.deepEqual(values, {
    measure_slope_height_ft: "66",
    measure_original_slope_deg: "34.2",
    measure_landslide_slope_deg: "28.7",
    measure_landslide_length_ft: "180",
    measure_landslide_width_ft: "102",
  });
});
