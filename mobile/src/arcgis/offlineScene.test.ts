// Unit tests for the pure offline-scene logic (no react-native/expo).
// Run: node --test src/arcgis/offlineScene.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  availableBaseSurfaces,
  baseSurfaceAvailable,
  chooseRegistrySource,
  cleanupTargets,
  createSerialMutex,
  describePackagedLayers,
  describeRoadContext,
  describeScope,
  downloadHttpError,
  layerAvailabilityLabel,
  formatBytes,
  formatPackageAge,
  isStale,
  isValidRegistry,
  jobIsActive,
  jobIsTerminal,
  jobStatusLine,
  legacyPackageFileName,
  metaFromDescriptor,
  needsLegacyPathMigration,
  needsRefresh,
  packageExt,
  packageFileName,
  partPathFor,
  reconcileRecord,
  resumeDecision,
  shaMatches,
  shouldApplyWorkerResult,
  sizeMatches,
  summarizeStorage,
  usesMspkRuntime,
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

test("state machine: app restart during DOWNLOADING reconciles safely", () => {
  // No in-memory task after restart, no resume data, no .part -> FAILED retry.
  assert.deepEqual(
    reconcileRecord("DOWNLOADING", { finalExists: false, partExists: false, hasResumeData: false, hasActiveTask: false }),
    { status: "FAILED", error: "Download interrupted; retry required." },
  );
  // Crash mid-download but a .part + persisted resume data exist -> PAUSED (Resume).
  assert.deepEqual(
    reconcileRecord("DOWNLOADING", { finalExists: false, partExists: true, hasResumeData: true, hasActiveTask: false }),
    { status: "PAUSED", error: null },
  );
  // Still actively downloading this session -> stays DOWNLOADING.
  assert.deepEqual(
    reconcileRecord("DOWNLOADING", { finalExists: false, partExists: true, hasResumeData: true, hasActiveTask: true }),
    { status: "DOWNLOADING", error: null },
  );
});

test("state machine: explicit Pause yields a resumable PAUSED record", () => {
  // After Pause the record is PAUSED with .part + resume data; reconcile keeps it PAUSED.
  assert.deepEqual(
    reconcileRecord("PAUSED", { finalExists: false, partExists: true, hasResumeData: true, hasActiveTask: false }),
    { status: "PAUSED", error: null },
  );
  // PAUSED that can no longer resume -> FAILED retry.
  assert.deepEqual(
    reconcileRecord("PAUSED", { finalExists: false, partExists: false, hasResumeData: false, hasActiveTask: false }),
    { status: "FAILED", error: "Download cannot be resumed; retry required." },
  );
});

test("state machine: READY without its file fails to a clear recovery state", () => {
  assert.deepEqual(
    reconcileRecord("READY", { finalExists: true, partExists: false, hasResumeData: false, hasActiveTask: false }),
    { status: "READY", error: null },
  );
  assert.deepEqual(
    reconcileRecord("READY", { finalExists: false, partExists: false, hasResumeData: false, hasActiveTask: false }),
    { status: "FAILED", error: "Downloaded package file is missing; re-download required." },
  );
});

test("resume-after-restart decision: resume vs restart (expired grant)", () => {
  const withSnap = { resumeSnapshot: { url: "https://x/y?sig=1", fileUri: "file:///p.part" } } as OfflineScenePackageMeta;
  assert.equal(resumeDecision(withSnap, true), "resume"); // usable state + .part
  assert.equal(resumeDecision(withSnap, false), "restart"); // .part gone
  // No usable snapshot (e.g. expired/cleared) -> restart from a fresh grant.
  assert.equal(resumeDecision({ resumeSnapshot: null } as OfflineScenePackageMeta, true), "restart");
});

test("delete while PAUSED removes both final and .part", () => {
  assert.deepEqual(cleanupTargets("/p/7.mspk", "/p/7.mspk.part"), ["/p/7.mspk", "/p/7.mspk.part"]);
  assert.deepEqual(cleanupTargets("/p/7.mspk", null), ["/p/7.mspk"]);
  assert.deepEqual(cleanupTargets(null, "/p/7.mspk.part"), ["/p/7.mspk.part"]);
});

test("single authoritative completion path: only current generation applies", () => {
  assert.equal(shouldApplyWorkerResult(3, 3), true); // current worker
  assert.equal(shouldApplyWorkerResult(4, 3), false); // superseded by Pause/Delete/new start
  assert.equal(shouldApplyWorkerResult(3, 2), false); // older generation never promotes/fails
});

test("generation job state: active/terminal classification", () => {
  assert.equal(jobIsActive("QUEUED"), true);
  assert.equal(jobIsActive("FETCHING_USGS_3DEP"), true);
  assert.equal(jobIsActive("READY"), false);
  assert.equal(jobIsActive("FAILED"), false);
  assert.equal(jobIsActive(null), false);
  assert.equal(jobIsTerminal("READY"), true);
  assert.equal(jobIsTerminal("CANCELLED"), true);
  assert.equal(jobIsTerminal("PACKAGING"), false);
});

test("generation job status lines drive the mobile UX copy", () => {
  assert.equal(jobStatusLine(null), "Prepare offline 3D area");
  assert.match(jobStatusLine({ status: "FETCHING_USGS_3DEP", progress_pct: 35, error_details: null }), /Preparing terrain: 35% — downloading USGS 3DEP/);
  assert.match(jobStatusLine({ status: "PACKAGING", progress_pct: 70, error_details: null }), /Building offline terrain package/);
  assert.equal(jobStatusLine({ status: "READY", progress_pct: 100, error_details: null }), "Ready to download");
  assert.match(jobStatusLine({ status: "FAILED", progress_pct: 0, error_details: "USGS 3DEP coverage unavailable" }), /Failed — USGS 3DEP coverage unavailable/);
});

test("packaging surfaces the live per-tile imagery progress line verbatim", () => {
  // The worker streams a durable "Packaging aerial imagery: 7 of 16 tiles" message;
  // the mobile status line shows it verbatim so field users see real progress.
  assert.equal(
    jobStatusLine({ status: "PACKAGING", progress_pct: 72, error_details: null, status_message: "Packaging aerial imagery: 7 of 16 tiles" }),
    "Packaging aerial imagery: 7 of 16 tiles",
  );
  // A non-tile packaging message falls back to the generic percentage copy.
  assert.match(
    jobStatusLine({ status: "PACKAGING", progress_pct: 70, error_details: null, status_message: "Assembling offline terrain package" }),
    /Building offline terrain package: 70%/,
  );
});

test("download HTTP status is inspected before size/SHA (403 != 'size mismatch')", () => {
  // The real-device failure: a presigned-URL 403 wrote a 535-byte error body that
  // was then reported as "size mismatch". Now a non-2xx status is a clear HTTP error.
  assert.equal(downloadHttpError(403), "Offline terrain download failed: HTTP 403");
  assert.equal(downloadHttpError(401), "Offline terrain download failed: HTTP 401");
  assert.equal(downloadHttpError(404), "Offline terrain download failed: HTTP 404");
  assert.equal(downloadHttpError(500), "Offline terrain download failed: HTTP 500");
  // Success statuses (and an absent status) pass through to size + SHA validation.
  assert.equal(downloadHttpError(200), null);
  assert.equal(downloadHttpError(206), null);
  assert.equal(downloadHttpError(null), null);
  assert.equal(downloadHttpError(undefined), null);
});

test("format-aware package paths: eristerrain vs mspk (never .mspk for a bundle)", () => {
  assert.equal(packageExt("eristerrain"), "eristerrain");
  assert.equal(packageExt("mspk"), "mspk");
  assert.equal(packageExt(undefined), "eristerrain"); // default
  assert.equal(packageExt("weird"), "eristerrain"); // unknown -> safe default
  assert.equal(packageFileName(7, "eristerrain"), "7.eristerrain");
  assert.equal(packageFileName(7, "mspk"), "7.mspk");
  assert.equal(packageFileName(7, null), "7.eristerrain");
  assert.equal(legacyPackageFileName(7), "7.mspk");
});

test("open routing: eristerrain uses the native renderer, mspk uses ArcGIS Runtime", () => {
  assert.equal(usesMspkRuntime("mspk"), true);
  assert.equal(usesMspkRuntime("eristerrain"), false);
  assert.equal(usesMspkRuntime(undefined), false); // default bundle never loads as AGSMobileScenePackage
});

test("legacy path migration: a READY .mspk-named eristerrain package is migrated", () => {
  const base = {
    status: "READY" as const,
    localPath: "/docs/offline-scenes/7.mspk",
  };
  // eristerrain package saved under the legacy `.mspk` name -> migrate.
  assert.equal(needsLegacyPathMigration({ ...base, packageFormat: "eristerrain" }), true);
  // A real mspk package keeps `.mspk` -> no migration.
  assert.equal(needsLegacyPathMigration({ ...base, packageFormat: "mspk" }), false);
  // Already on the canonical name -> no migration.
  assert.equal(
    needsLegacyPathMigration({ status: "READY", packageFormat: "eristerrain", localPath: "/docs/offline-scenes/7.eristerrain" }),
    false,
  );
  // Not READY / no localPath -> never migrate mid-flight.
  assert.equal(needsLegacyPathMigration({ status: "DOWNLOADING", packageFormat: "eristerrain", localPath: "/docs/7.mspk" }), false);
  assert.equal(needsLegacyPathMigration({ status: "READY", packageFormat: "eristerrain", localPath: null }), false);
});

test("cleanupTargets works for both formats", () => {
  assert.deepEqual(cleanupTargets("/p/7.eristerrain", "/p/7.eristerrain.part"), [
    "/p/7.eristerrain",
    "/p/7.eristerrain.part",
  ]);
});

// ---- Phase 2C: durable registry serialization + recovery -------------------

const _delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("serial mutex: concurrent read-modify-write never loses records", async () => {
  const mutex = createSerialMutex();
  // Simulate the racy registry pattern: read snapshot -> await -> write back.
  // Without the mutex the later writers would clobber earlier ones (lost update).
  let store: { items: number[] } = { items: [] };
  const addRecord = (id: number) =>
    mutex.runExclusive(async () => {
      const snapshot = store; // read
      await _delay(5); // yield (would cause interleaving without the lock)
      store = { items: [...snapshot.items, id] }; // modify + write
    });
  await Promise.all([addRecord(1), addRecord(2), addRecord(3), addRecord(4)]);
  assert.deepEqual([...store.items].sort((a, b) => a - b), [1, 2, 3, 4]); // all present
});

test("serial mutex runs operations in call order (pause during progress persist)", async () => {
  const mutex = createSerialMutex();
  const order: number[] = [];
  // A slow "progress snapshot" started first, then a fast "pause": pause must wait.
  const progress = mutex.runExclusive(async () => {
    await _delay(15);
    order.push(1);
  });
  const pause = mutex.runExclusive(async () => {
    await _delay(1);
    order.push(2);
  });
  await Promise.all([progress, pause]);
  assert.deepEqual(order, [1, 2]);
});

test("serial mutex isolates a rejecting op (delete-while-completing keeps the chain alive)", async () => {
  const mutex = createSerialMutex();
  const done: string[] = [];
  const failing = mutex.runExclusive(async () => {
    throw new Error("completion superseded");
  });
  await assert.rejects(failing, /superseded/);
  await mutex.runExclusive(async () => {
    done.push("delete-applied");
  });
  assert.deepEqual(done, ["delete-applied"]);
});

test("registry validity + crash-recovery source selection", () => {
  assert.equal(isValidRegistry({ version: 1, items: [] }, 1), true);
  assert.equal(isValidRegistry({ version: 2, items: [] }, 1), false); // wrong version
  assert.equal(isValidRegistry({ version: 1, items: "nope" }, 1), false); // items not array
  assert.equal(isValidRegistry(null, 1), false);
  assert.equal(isValidRegistry("garbage", 1), false);
  // main valid -> use main, clean up any stale temp.
  assert.deepEqual(chooseRegistrySource({ mainValid: true, tmpValid: true }), { use: "main", cleanupTmp: true });
  // main corrupt but temp valid -> recover temp (crash mid-rename).
  assert.deepEqual(chooseRegistrySource({ mainValid: false, tmpValid: true }), { use: "tmp", cleanupTmp: false });
  // neither -> empty, clean up garbage temp.
  assert.deepEqual(chooseRegistrySource({ mainValid: false, tmpValid: false }), { use: "empty", cleanupTmp: true });
});

// ---- context-layer display strings + availability (Phase: context layers) ---

test("describeRoadContext is truthful (never claims 'roads' for a bearing line)", () => {
  assert.equal(describeRoadContext(null), "No road context packaged");
  assert.equal(describeRoadContext({ available: false }), "No road context packaged");
  assert.equal(describeRoadContext({ available: true, road_kinds: ["road_bearing"] }), "Road bearing context");
  assert.equal(
    describeRoadContext({ available: true, road_kinds: ["road_bearing", "road_inventory"] }),
    "Road inventory geometry",
  );
  assert.equal(
    describeRoadContext({ available: true, road_kinds: ["road_bearing", "road_inventory", "road_centerline"] }),
    "Feature service road network",
  );
  assert.equal(describeRoadContext({ available: true, road_kinds: [] }), "Road context packaged");
});

test("describePackagedLayers distinguishes hillshade relief from aerial imagery + truthful road context", () => {
  // Imagery present -> "Aerial imagery"; roads described truthfully (bearing-only).
  assert.equal(
    describePackagedLayers({
      hillshade: true, roads: true, roadContext: "Road bearing context", imagery: true, overview: true, elevationSource: "USGS_3DEP",
    }),
    "USGS_3DEP elevation · Road bearing context · Aerial imagery",
  );
  // Only hillshade -> "Hillshade relief", NOT imagery; road inventory geometry.
  assert.equal(
    describePackagedLayers({
      hillshade: true, roads: true, roadContext: "Road inventory geometry", imagery: false, overview: true, elevationSource: "USGS_3DEP",
    }),
    "USGS_3DEP elevation · Road inventory geometry · Hillshade relief",
  );
  // No roads, no imagery, no hillshade -> just elevation.
  assert.equal(
    describePackagedLayers({ hillshade: false, roads: false, imagery: false, overview: false }),
    "USGS 3DEP elevation",
  );
});

test("base-surface availability is imagery-gated (Satellite/Hybrid need imagery)", () => {
  assert.deepEqual(availableBaseSurfaces({ imagery: false }), ["terrain"]);
  assert.deepEqual(availableBaseSurfaces({ imagery: true }), ["terrain", "satellite", "hybrid"]);
  assert.equal(baseSurfaceAvailable({ imagery: false }, "terrain"), true);
  assert.equal(baseSurfaceAvailable({ imagery: false }, "satellite"), false);
  assert.equal(baseSurfaceAvailable({ imagery: false }, "hybrid"), false);
  assert.equal(baseSurfaceAvailable({ imagery: true }, "satellite"), true);
});

test("layerAvailabilityLabel maps reasons to clear copy", () => {
  assert.equal(layerAvailabilityLabel(true), "Included");
  assert.match(layerAvailabilityLabel(false, "not_configured"), /not configured/);
  assert.match(layerAvailabilityLabel(false, "too_large"), /size limit/);
  assert.match(layerAvailabilityLabel(false, "source_error"), /source error/);
  assert.equal(layerAvailabilityLabel(false), "Not available");
});
