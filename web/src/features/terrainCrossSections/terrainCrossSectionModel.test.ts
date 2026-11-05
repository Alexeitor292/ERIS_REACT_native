import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptiveSampleSpacingMeters,
  controlPointDistances,
  formatDemResolution,
  formatElevation,
  formatHorizontalDistance,
  pathLengthMeters,
  profileFromPath,
  usgsProfileMetadata,
} from "./terrainCrossSectionModel.ts";
import { demQualityNote } from "./demResolutionCoverageModel.ts";

test("adaptive sampling never imposes a path-length cap", () => {
  assert.equal(adaptiveSampleSpacingMeters(1000), 10);
  assert.equal(adaptiveSampleSpacingMeters(1000, { preferredSpacingM: 1 }), 1);
  assert.equal(adaptiveSampleSpacingMeters(1000, { preferredSpacingM: 2 }), 2);
  assert.equal(adaptiveSampleSpacingMeters(18_000), 15);
  assert.ok(adaptiveSampleSpacingMeters(500_000) > 10);
  assert.ok(adaptiveSampleSpacingMeters(2_000_000) > adaptiveSampleSpacingMeters(500_000));
});

const coverage = (datasets: Array<[number, number]>) => {
  const sizes = datasets.map(([size]) => size);
  const count = datasets.reduce((sum, [, samples]) => sum + samples, 0);
  return {
    min_pixel_size_m: Math.min(...sizes),
    max_pixel_size_m: Math.max(...sizes),
    covered_sample_count: count,
    total_sample_count: count,
    mixed_resolution: Math.max(...sizes) - Math.min(...sizes) > 0.01,
    datasets: datasets.map(([pixel_size_m, sample_count]) => ({ pixel_size_m, source: "USGS 3DEP", product_name: "x", dataset_id: null, sample_count })),
  };
};

test("a path on 1 m lidar says so", () => {
  const metadata = usgsProfileMetadata(coverage([[1, 900]]));
  assert.equal(formatDemResolution(metadata), "1 m");
  assert.match(demQualityNote(metadata), /All of this path is on USGS 1 m lidar/);
});

test("a path that crosses onto a coarser source says how much of each", () => {
  const metadata = usgsProfileMetadata(coverage([[1, 750], [10.308, 250]]));
  assert.equal(formatDemResolution(metadata), "1 m–10 m");
  assert.match(demQualityNote(metadata), /75% 1 m lidar, 25% about 10 m/);
  assert.match(demQualityNote(metadata), /finest USGS has/);
});

test("when USGS cannot say what lies under a path, the screen does not pretend", () => {
  const metadata = usgsProfileMetadata();
  assert.equal(formatDemResolution(metadata), "Unavailable");
  assert.match(demQualityNote(metadata), /could not say/);
  assert.equal(formatDemResolution(null), "Unavailable");
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
  const dem = usgsProfileMetadata();
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
  assert.equal(profile.dem?.source, "USGS_3DEP");
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

test("customary terrain display remains in feet while metric helpers remain available", () => {
  assert.equal(formatHorizontalDistance(1609.344, false), "5,280 ft");
  assert.equal(formatHorizontalDistance(1500, true), "1.50 km");
  assert.match(formatElevation(100, false), /ft$/);
  assert.equal(formatElevation(100, true), "100.0 m");
});
