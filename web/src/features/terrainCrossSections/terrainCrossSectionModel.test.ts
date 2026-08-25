import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptiveSampleSpacingMeters,
  controlPointDistances,
  demResolutionModeLabel,
  demResolutionQueryValue,
  formatDemResolution,
  formatElevation,
  formatHorizontalDistance,
  pathLengthMeters,
  profileFromPath,
  summarizeDemResolution,
} from "./terrainCrossSectionModel.ts";

test("adaptive sampling never imposes a path-length cap", () => {
  assert.equal(adaptiveSampleSpacingMeters(1000), 10);
  assert.equal(adaptiveSampleSpacingMeters(1000, { preferredSpacingM: 1 }), 1);
  assert.equal(adaptiveSampleSpacingMeters(1000, { preferredSpacingM: 2 }), 2);
  assert.equal(adaptiveSampleSpacingMeters(18_000), 15);
  assert.ok(adaptiveSampleSpacingMeters(500_000) > 10);
  assert.ok(adaptiveSampleSpacingMeters(2_000_000) > adaptiveSampleSpacingMeters(500_000));
});

test("DEM resolution modes map to ArcGIS elevation query values", () => {
  assert.equal(demResolutionQueryValue("best-available"), "finest-contiguous");
  assert.equal(demResolutionQueryValue("auto"), "auto");
  assert.equal(demResolutionQueryValue("target-1m"), 1);
  assert.equal(demResolutionQueryValue("target-3m"), 3);
  assert.equal(demResolutionQueryValue("target-10m"), 10);
  assert.equal(demResolutionModeLabel("best-available"), "Best available");
});

test("DEM resolution metadata truthfully reports actual ArcGIS sample resolution", () => {
  const uniform = summarizeDemResolution([
    { demResolution: 1 },
    { demResolution: 1 },
    { demResolution: -1 },
  ], "target-1m");
  assert.equal(uniform.requested_resolution_m, 1);
  assert.equal(uniform.actual_min_resolution_m, 1);
  assert.equal(uniform.actual_max_resolution_m, 1);
  assert.equal(uniform.resolution_sample_count, 2);
  assert.equal(uniform.mixed_resolution, false);
  assert.equal(formatDemResolution(uniform), "1.00 m");

  const mixed = summarizeDemResolution([
    { demResolution: 0.5 },
    { demResolution: 1 },
    { demResolution: 9.56 },
  ], "auto");
  assert.equal(mixed.actual_min_resolution_m, 0.5);
  assert.equal(mixed.actual_max_resolution_m, 9.56);
  assert.equal(mixed.mixed_resolution, true);
  assert.equal(formatDemResolution(mixed), "0.50 m–9.56 m");
});

test("control point distances accumulate along a multi-vertex path", () => {
  const points = [
    { longitude: -121.0, latitude: 38.0 },
    { longitude: -121.0, latitude: 38.01 },
    { longitude: -120.99, latitude: 38.01 },
  ];
  const distances = controlPointDistances(points);
  assert.equal(distances.length, 3);
  assert.equal(distances[0], 0);
  assert.ok(distances[1] > 1000);
  assert.ok(distances[2] > distances[1]);
  assert.equal(pathLengthMeters(points), distances[2]);
});

test("profile derives distance, gain, loss, grade, and elevation range", () => {
  const dem = summarizeDemResolution([{ demResolution: 1 }, { demResolution: 1 }, { demResolution: 1 }], "best-available");
  const profile = profileFromPath([
    [-121.0, 38.0, 100],
    [-121.0, 38.001, 125],
    [-121.0, 38.002, 115],
  ], null, dem);
  assert.ok(profile);
  assert.equal(profile.samples.length, 3);
  assert.equal(profile.stats.min_elevation_m, 100);
  assert.equal(profile.stats.max_elevation_m, 125);
  assert.equal(profile.stats.elevation_range_m, 25);
  assert.equal(profile.stats.elevation_gain_m, 25);
  assert.equal(profile.stats.elevation_loss_m, 10);
  assert.ok(profile.stats.total_distance_m > 200);
  assert.equal(profile.samples[0].grade_percent, null);
  assert.ok((profile.samples[1].grade_percent ?? 0) > 0);
  assert.ok((profile.samples[2].grade_percent ?? 0) < 0);
  assert.equal(profile.dem?.requested_mode, "best-available");
  assert.equal(profile.dem?.actual_min_resolution_m, 1);
});

test("profile discards no-data elevation vertices", () => {
  const profile = profileFromPath([
    [-121.0, 38.0, 10],
    [-121.0, 38.001, -9999],
    [-121.0, 38.002, 30],
  ], -9999);
  assert.ok(profile);
  assert.equal(profile.samples.length, 2);
  assert.equal(profile.stats.elevation_range_m, 20);
});

test("formatters support Caltrans customary and metric displays", () => {
  assert.match(formatHorizontalDistance(1609.344, false), /mi$/);
  assert.equal(formatHorizontalDistance(1500, true), "1.50 km");
  assert.match(formatElevation(100, false), /ft$/);
  assert.equal(formatElevation(100, true), "100.0 m");
});
