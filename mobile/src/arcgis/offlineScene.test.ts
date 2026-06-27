// Unit tests for the pure offline-scene logic (no react-native/expo).
// Run: node --test src/arcgis/offlineScene.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeScope,
  formatBytes,
  formatPackageAge,
  isStale,
  metaFromDescriptor,
  needsRefresh,
  partPathFor,
  shaMatches,
  sizeMatches,
  summarizeStorage,
  type OfflineScenePackageMeta,
  type SceneAreaDescriptor,
} from "./offlineScene.ts";

function descriptor(overrides: Partial<SceneAreaDescriptor> = {}): SceneAreaDescriptor {
  return {
    submission_id: 7,
    available: true,
    reason: null,
    area: {
      center: { lat: 38.5, lon: -121.5 },
      radius_m: 1500,
      bounds: { min_lat: 38.48, min_lon: -121.52, max_lat: 38.52, max_lon: -121.48 },
    },
    package: {
      format: "mspk",
      version: "abc123",
      size_bytes: 42 * 1024 * 1024,
      sha256: "a".repeat(64),
      elevation_source: "USGS_3DEP",
      elevation: { dataset: "3DEP 1m", version: "2024", resolution: "1m" },
      basemap_or_imagery_source: "Caltrans imagery",
      created_at: "2026-06-27T00:00:00",
      uploaded_at: "2026-06-27T01:00:00",
      download_path: "/submissions/7/gisa/offline-scene-package/download",
    },
    content_signature: "abc123",
    ...overrides,
  };
}

test("formatBytes is human readable", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(null), "0 MB");
  assert.equal(formatBytes(500 * 1024), "500 KB");
  assert.equal(formatBytes(42 * 1024 * 1024), "42 MB");
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), "2.50 GB");
});

test("formatPackageAge handles absent/recent/old", () => {
  assert.equal(formatPackageAge(null), "not downloaded");
  const now = Date.parse("2026-06-26T12:00:00Z");
  assert.equal(formatPackageAge("2026-06-26T11:30:00Z", now), "just now");
  assert.equal(formatPackageAge("2026-06-26T09:00:00Z", now), "3h ago");
  assert.equal(formatPackageAge("2026-06-25T12:00:00Z", now), "1 day ago");
  assert.equal(formatPackageAge("2026-06-20T12:00:00Z", now), "6 days ago");
});

test("needsRefresh: only when READY local signature differs from an available server one", () => {
  const ready = { contentSignature: "abc123", status: "READY" as const };
  // same signature -> no refresh
  assert.equal(needsRefresh(ready, { available: true, content_signature: "abc123" }), false);
  // changed signature -> refresh
  assert.equal(needsRefresh(ready, { available: true, content_signature: "zzz999" }), true);
  // server can't offer a package now -> keep local, no refresh churn
  assert.equal(needsRefresh(ready, { available: false, content_signature: null }), false);
  // offline (no server descriptor) -> keep local
  assert.equal(needsRefresh(ready, null), false);
  // not downloaded -> not "stale"
  assert.equal(needsRefresh({ contentSignature: "abc123", status: "PENDING" }, { available: true, content_signature: "zzz" }), false);
});

test("isStale uses downloadedAt + max age", () => {
  const now = Date.parse("2026-06-26T00:00:00Z");
  const old = { downloadedAt: "2026-05-01T00:00:00Z", status: "READY" as const };
  const fresh = { downloadedAt: "2026-06-25T00:00:00Z", status: "READY" as const };
  assert.equal(isStale(old, 30, now), true);
  assert.equal(isStale(fresh, 30, now), false);
  // non-ready / missing date is never "stale"
  assert.equal(isStale({ downloadedAt: null, status: "READY" }, 30, now), false);
  assert.equal(isStale({ downloadedAt: "2020-01-01T00:00:00Z", status: "FAILED" }, 30, now), false);
});

test("summarizeStorage totals bytes and counts ready packages", () => {
  const metas = [
    { sizeBytes: 10 * 1024 * 1024, status: "READY" },
    { sizeBytes: 5 * 1024 * 1024, status: "READY" },
    { sizeBytes: 0, status: "FAILED" },
  ] as OfflineScenePackageMeta[];
  const s = summarizeStorage(metas);
  assert.equal(s.count, 3);
  assert.equal(s.readyCount, 2);
  assert.equal(s.totalBytes, 15 * 1024 * 1024);
});

test("describeScope shows bounded radius + REAL catalog size + elevation source", () => {
  assert.match(describeScope(descriptor()), /1\.5 km radius · 42 MB · USGS_3DEP/);
  assert.equal(describeScope({ ...descriptor(), area: null }), "No package prepared");
});

test("metaFromDescriptor maps an available descriptor incl. integrity + attribution", () => {
  const m = metaFromDescriptor(descriptor(), 99, "2026-06-26T00:00:00Z");
  assert.ok(m);
  assert.equal(m!.submissionId, 7);
  assert.equal(m!.status, "PENDING");
  assert.equal(m!.expectedSha256, "a".repeat(64));
  assert.equal(m!.expectedSizeBytes, 42 * 1024 * 1024);
  assert.equal(m!.elevationSource, "USGS_3DEP");
  assert.equal(m!.elevationResolution, "1m");
  assert.equal(m!.basemapSource, "Caltrans imagery");
  assert.equal(m!.localPath, null);
  // unavailable -> null (no package to track)
  assert.equal(metaFromDescriptor({ ...descriptor(), available: false, package: null, area: null }, 99, "2026-06-26T00:00:00Z"), null);
});

test("integrity helpers: part path, size + sha matching", () => {
  assert.equal(partPathFor("/docs/offline-scenes/7.mspk"), "/docs/offline-scenes/7.mspk.part");
  assert.equal(sizeMatches(500, 500), true);
  assert.equal(sizeMatches(500, 499), false);
  assert.equal(sizeMatches(0, 0), false); // zero is never a valid match
  assert.equal(shaMatches("ABCdef", "abcdef"), true); // case-insensitive
  assert.equal(shaMatches("abc", "abd"), false);
  assert.equal(shaMatches(null, "abc"), false);
});
