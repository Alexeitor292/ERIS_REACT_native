import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraDirectionEndpoint,
  headedPhotos,
  mappedPhotos,
  projectSearchMatch,
} from "./missionCenterGisModel.ts";
import type { ProjectSummary } from "../projects/projectTypes.ts";
import type { PhotoEvidence } from "../submissions/photoEvidenceApi.ts";

const project: ProjectSummary = {
  id: 42,
  project_uuid: "project-42",
  title: "US 50 Echo Summit",
  description: "Slope response project",
  status: "OPEN",
  anchor_location_id: null,
  anchor_latitude: 38.8,
  anchor_longitude: -120.0,
  centroid_latitude: 38.8,
  centroid_longitude: -120.0,
  district: "03",
  county: "ELD",
  route: "50",
  post_mile: "65.2",
  created_from_incident_id: 1,
  created_by_user_id: 1,
  source: "COORDINATOR_CREATED",
  incident_count: 2,
  open_incident_count: 1,
  latest_incident_activity_at: null,
  closed_at: null,
  closed_by_user_id: null,
  created_at: "2026-08-17T00:00:00",
  updated_at: "2026-08-17T00:00:00",
};

function photo(overrides: Partial<PhotoEvidence> = {}): PhotoEvidence {
  return {
    attachment_id: 1,
    file_name: "photo.jpg",
    mime_type: "image/jpeg",
    section_key: null,
    source_scope: "INCIDENT",
    captured_at: null,
    latitude: 38.8,
    longitude: -120.0,
    horizontal_accuracy_m: 3,
    altitude_m: null,
    camera_heading_deg: 90,
    heading_reference: "TRUE_NORTH",
    location_source: "DEVICE",
    heading_source: "DEVICE",
    correction: {
      has_history: false,
      location_overridden: false,
      heading_overridden: false,
      location_override: null,
      heading_override_deg: null,
      corrected_by_user_id: null,
      corrected_at: null,
    },
    download_url: "https://example.test/photo.jpg",
    ...overrides,
  };
}

test("cameraDirectionEndpoint moves north for zero-degree heading", () => {
  const end = cameraDirectionEndpoint(38, -121, 0, 100);
  assert.ok(end.latitude > 38);
  assert.ok(Math.abs(end.longitude + 121) < 0.0001);
});

test("cameraDirectionEndpoint moves east for ninety-degree heading", () => {
  const end = cameraDirectionEndpoint(38, -121, 90, 100);
  assert.ok(end.longitude > -121);
  assert.ok(Math.abs(end.latitude - 38) < 0.0001);
});

test("mappedPhotos excludes evidence without both coordinates", () => {
  const photos = [photo(), photo({ attachment_id: 2, latitude: null }), photo({ attachment_id: 3, longitude: null })];
  assert.deepEqual(mappedPhotos(photos).map((item) => item.attachment_id), [1]);
});

test("headedPhotos requires a mapped point and effective heading", () => {
  const photos = [photo(), photo({ attachment_id: 2, camera_heading_deg: null }), photo({ attachment_id: 3, latitude: null })];
  assert.deepEqual(headedPhotos(photos).map((item) => item.attachment_id), [1]);
});

test("projectSearchMatch searches operational project fields", () => {
  assert.equal(projectSearchMatch(project, "echo"), true);
  assert.equal(projectSearchMatch(project, "ELD"), true);
  assert.equal(projectSearchMatch(project, "65.2"), true);
  assert.equal(projectSearchMatch(project, "project that does not exist"), false);
});
