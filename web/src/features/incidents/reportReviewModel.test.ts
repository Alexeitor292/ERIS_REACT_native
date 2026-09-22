import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_DISTANCE_WARNING_M,
  distanceLabel,
  formatFileSize,
  isViewableImage,
  metresBetween,
  readinessChecks,
  reportingDelayHours,
  reportingDelayLabel,
  roadSummaryEntries,
  summarizeEvidence,
  type ReviewAttachment,
  type ReviewIncident,
} from "./reportReviewModel.ts";

function attachment(overrides: Partial<ReviewAttachment> = {}): ReviewAttachment {
  return {
    attachment_id: 1,
    kind: "PHOTO",
    file_name: "slide.jpg",
    mime_type: "image/jpeg",
    file_size_bytes: 2048,
    captured_at: "2026-09-02T10:00:00",
    latitude: null,
    longitude: null,
    horizontal_accuracy_m: null,
    camera_heading_deg: null,
    download_url: "https://example.invalid/slide.jpg",
    ...overrides,
  };
}

function incident(overrides: Partial<ReviewIncident> = {}): ReviewIncident {
  return {
    id: 7,
    title: "Slope failure above northbound lanes",
    incident_type: "LANDSLIDE",
    description: "Fresh scarp on the cut slope above the northbound lanes, soil reaching the shoulder.",
    latitude: 40.605,
    longitude: -124.134,
    district: "01",
    county: "HUM",
    route: "101",
    post_mile: "84.20",
    first_observed_at: "2026-09-02T08:00:00",
    first_occurred_at: null,
    created_at: "2026-09-02T09:00:00",
    reporter_user_id: 2,
    reporter_name: "J. Rivera",
    road_inventory_context: { snapshot: { route_name: "101", left_lanes: 2 }, match_method: "POSTMILE" },
    ...overrides,
  };
}

test("images are recognised by kind or mime type, other files are not", () => {
  assert.equal(isViewableImage({ kind: "PHOTO", mime_type: "image/jpeg" }), true);
  assert.equal(isViewableImage({ kind: "SKETCH", mime_type: "application/pdf" }), true);
  assert.equal(isViewableImage({ kind: "DOC", mime_type: "image/png" }), true);
  assert.equal(isViewableImage({ kind: "VIDEO", mime_type: "video/mp4" }), false);
  assert.equal(isViewableImage({ kind: "DOC", mime_type: "application/pdf" }), false);
});

test("evidence is counted by kind, and located photos are counted separately", () => {
  const summary = summarizeEvidence([
    attachment({ attachment_id: 1, latitude: 40.6, longitude: -124.1 }),
    attachment({ attachment_id: 2 }),
    attachment({ attachment_id: 3, kind: "VIDEO", mime_type: "video/mp4" }),
    attachment({ attachment_id: 4, kind: "DOC", mime_type: "application/pdf" }),
  ]);
  assert.deepEqual(summary, { total: 4, photos: 2, videos: 1, documents: 1, located: 1 });
});

test("an empty report summarises to zeroes rather than throwing", () => {
  assert.deepEqual(summarizeEvidence([]), { total: 0, photos: 0, videos: 0, documents: 0, located: 0 });
});

test("file sizes read in the unit a person expects, and a missing size is blank", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2 KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatFileSize(null), "");
  assert.equal(formatFileSize(-1), "");
});

test("distance between two points is metres, and the label switches to miles above a kilometre", () => {
  const here = { latitude: 40.605, longitude: -124.134 };
  assert.equal(Math.round(metresBetween(here, here)), 0);
  // ~0.01 degrees of latitude is roughly 1.1 km.
  const north = { latitude: 40.615, longitude: -124.134 };
  const metres = metresBetween(here, north);
  assert.ok(metres > 1000 && metres < 1200, `expected ~1.1 km, got ${metres}`);
  assert.match(distanceLabel(250), /^250 m from the reported pin$/);
  assert.match(distanceLabel(metres), /mi from the reported pin$/);
});

test("checks report evidence, description, location, photo distance and road match as facts", () => {
  const checks = readinessChecks(incident(), [attachment({ latitude: 40.6051, longitude: -124.1341 })]);
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));
  assert.equal(byKey.evidence.status, "ok");
  assert.equal(byKey.description.status, "ok");
  assert.equal(byKey.location.status, "ok");
  assert.equal(byKey["photo-distance"].status, "ok");
  assert.equal(byKey.road.status, "ok");
});

test("a report with nothing attached says so instead of showing an empty panel", () => {
  const checks = readinessChecks(incident(), []);
  const evidence = checks.find((check) => check.key === "evidence");
  assert.equal(evidence?.status, "attention");
  assert.match(evidence?.detail ?? "", /No photos or files/);
  // With no located photo there is nothing to say about photo positions.
  assert.equal(checks.some((check) => check.key === "photo-distance"), false);
});

test("a photo taken far from the reported pin is surfaced, not hidden", () => {
  const far = attachment({ latitude: 40.7, longitude: -124.134 });
  const checks = readinessChecks(incident(), [far]);
  const distance = checks.find((check) => check.key === "photo-distance");
  assert.equal(distance?.status, "attention");
  assert.match(distance?.detail ?? "", /more than 500 m/);
  assert.ok(metresBetween(incident(), { latitude: far.latitude!, longitude: far.longitude! }) > PHOTO_DISTANCE_WARNING_M);
});

test("a thin description and a missing post mile are each called out", () => {
  const checks = readinessChecks(incident({ description: "slide", post_mile: null }), []);
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));
  assert.equal(byKey.description.status, "attention");
  assert.equal(byKey.location.status, "attention");
});

test("no check ever recommends a disposition", () => {
  const checks = readinessChecks(incident({ description: null, post_mile: null, road_inventory_context: null }), []);
  for (const check of checks) {
    assert.doesNotMatch(check.detail, /assessment required|no assessment|duplicate|recommend/i);
  }
});

test("road summary keeps chart order, drops blanks, and never shows terrain twice", () => {
  const entries = roadSummaryEntries({
    adt: 12400,
    route_name: "101",
    left_lanes: 2,
    median_type: "",
    terrain_code: "M",
    THY_TERRAIN_CODE: "M",
    unrelated_field: "ignored",
  });
  assert.deepEqual(entries.map((entry) => entry.key), ["route_name", "left_lanes", "terrain_code", "adt"]);
});

test("road summary of a report with no match is empty", () => {
  assert.deepEqual(roadSummaryEntries(null), []);
  assert.deepEqual(roadSummaryEntries(undefined), []);
});

test("a late filing is stated in hours, then in days, and a prompt one is not mentioned", () => {
  // The fixture is filed an hour after it was seen: ordinary, so nothing is said.
  assert.equal(reportingDelayHours(incident()), 1);
  assert.equal(reportingDelayLabel(reportingDelayHours(incident())), null);
  const late = incident({ first_observed_at: "2026-09-01T08:00:00", created_at: "2026-09-02T08:00:00" });
  assert.equal(reportingDelayLabel(reportingDelayHours(late)), "Filed 24 h after it was first seen");
  const veryLate = incident({ first_observed_at: "2026-08-25T08:00:00", created_at: "2026-09-02T08:00:00" });
  assert.equal(reportingDelayLabel(reportingDelayHours(veryLate)), "Filed 8 days after it was first seen");
  assert.equal(reportingDelayHours({ first_observed_at: "not a date", created_at: "also not" }), null);
});
