// Pure, dependency-free logic for offline 3D scene packages.
//
// Deliberately free of react-native / expo imports so it can be unit-tested with
// Node's built-in runner (node --test). The native viewer and the package
// manager consume these helpers; the actual SceneView + file I/O live elsewhere.

export type OfflineSceneStatus =
  | "PENDING"
  | "DOWNLOADING"
  | "PAUSED"
  | "READY"
  | "FAILED";

/** Locally persisted metadata for one downloaded offline scene area. */
export type OfflineScenePackageMeta = {
  submissionId: number;
  incidentId: number | null;
  // Bounded area (never statewide).
  center: { lat: number; lon: number };
  radiusM: number;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  // Package identity + integrity (from the catalog).
  contentSignature: string; // server content version at download time
  packageVersion: string;
  packageFormat: string; // "eristerrain" (auto USGS-3DEP bundle) or "mspk"
  expectedSha256: string; // catalog sha256 — verified before READY
  expectedSizeBytes: number; // catalog size — verified before READY
  // Source attribution (what the field user is actually viewing).
  elevationSource: string | null;
  elevationDataset: string | null;
  elevationResolution: string | null;
  basemapSource: string | null;
  // Lifecycle.
  status: OfflineSceneStatus;
  sizeBytes: number; // actual bytes on disk once READY
  localPath: string | null; // verified final package path, when READY
  extractedDir: string | null; // extracted eristerrain dir (manifest+grid+hillshade)
  partPath: string | null; // temporary .part path while downloading
  resumeSnapshot: unknown | null; // FileSystem resumable savable() for resume-after-restart
  downloadedAt: string | null;
  requestedAt: string;
  error: string | null;
};

/** Server descriptor (mirrors GET /submissions/{id}/gisa/offline-scene-package). */
export type SceneAreaDescriptor = {
  submission_id: number;
  available: boolean;
  reason: string | null;
  area: {
    center: { lat: number; lon: number };
    radius_m: number;
    bounds: { min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  } | null;
  package: {
    format: string;
    version: string;
    size_bytes: number;
    sha256: string;
    elevation_source: string | null;
    elevation: { dataset: string | null; version: string | null; resolution: string | null };
    basemap_or_imagery_source: string | null;
    created_at: string | null;
    uploaded_at: string | null;
    // Protected ERIS download path (NOT a raw MinIO URL).
    download_path: string | null;
  } | null;
  content_signature: string | null;
};

/** Protected download response (mirrors the .../download endpoint). */
export type SceneDownloadGrant = {
  submission_id: number;
  url: string; // short-lived presigned URL
  expires_in_seconds: number;
  object_key: string;
  sha256: string;
  size_bytes: number;
  package_version: string;
  package_format: string;
  content_signature: string;
};

export function partPathFor(finalPath: string): string {
  return `${finalPath}.part`;
}

// ---- Format-aware local package paths --------------------------------------
// eristerrain bundles are stored as `<id>.eristerrain`; real Esri packages as
// `<id>.mspk`. Older builds always wrote `<id>.mspk` regardless of the real
// format — see needsLegacyPathMigration for the one-time migration.

/** Canonical file extension for a package format (default: eristerrain). */
export function packageExt(format: string | null | undefined): string {
  return (format || "eristerrain") === "mspk" ? "mspk" : "eristerrain";
}

/** Format-aware local filename for a package (`<id>.<ext>`). */
export function packageFileName(submissionId: number, format: string | null | undefined): string {
  return `${submissionId}.${packageExt(format)}`;
}

/** The legacy always-".mspk" filename older builds wrote regardless of format. */
export function legacyPackageFileName(submissionId: number): string {
  return `${submissionId}.mspk`;
}

/**
 * A READY package whose on-disk file uses the legacy ".mspk" name but whose real
 * format is eristerrain should be migrated to the ".eristerrain" name. Pure so it
 * is unit-testable; the manager performs the actual rename + registry update.
 */
export function needsLegacyPathMigration(
  meta: Pick<OfflineScenePackageMeta, "status" | "packageFormat" | "localPath">,
): boolean {
  if (meta.status !== "READY" || !meta.localPath) return false;
  if (packageExt(meta.packageFormat) === "mspk") return false; // real mspk keeps .mspk
  return meta.localPath.endsWith(".mspk");
}

/** Whether a downloaded package is opened via the native ArcGIS Runtime .mspk
 *  path (true) or the native eristerrain renderer (false). An eristerrain bundle
 *  must NEVER be opened as an AGSMobileScenePackage. */
export function usesMspkRuntime(format: string | null | undefined): boolean {
  return packageExt(format) === "mspk";
}

// ---- Automatic generation job states (server-side pipeline) ----------------

export type OfflineSceneJobStatus =
  | "QUEUED"
  | "FETCHING_USGS_3DEP"
  | "BUILDING_TERRAIN"
  | "BUILDING_BASEMAP"
  | "PACKAGING"
  | "VERIFYING"
  | "UPLOADING"
  | "REGISTERING"
  | "READY"
  | "FAILED"
  | "CANCELLED";

export type OfflineSceneJob = {
  id: number;
  submission_id: number;
  status: OfflineSceneJobStatus;
  progress_pct: number;
  status_message: string | null;
  retry_count: number;
  error_details: string | null;
  result_package_version: string | null;
  area: {
    center: { lat: number; lon: number };
    radius_m: number;
    bounds: { min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  } | null;
  created_at: string | null;
  updated_at: string | null;
};

const JOB_TERMINAL: ReadonlySet<OfflineSceneJobStatus> = new Set(["READY", "FAILED", "CANCELLED"]);

export function jobIsTerminal(status: OfflineSceneJobStatus | null | undefined): boolean {
  return !!status && JOB_TERMINAL.has(status);
}

/** Active = a generation job is running and the UI should keep polling. */
export function jobIsActive(status: OfflineSceneJobStatus | null | undefined): boolean {
  return !!status && !JOB_TERMINAL.has(status);
}

/** Human progress line for the generation pipeline (drives the mobile UX copy). */
export function jobStatusLine(job: Pick<OfflineSceneJob, "status" | "progress_pct" | "error_details"> | null | undefined): string {
  if (!job) return "Prepare offline 3D area";
  const p = Math.max(0, Math.min(100, job.progress_pct ?? 0));
  switch (job.status) {
    case "QUEUED":
      return "Queued — preparing terrain…";
    case "FETCHING_USGS_3DEP":
      return `Preparing terrain: ${p}% — downloading USGS 3DEP`;
    case "BUILDING_TERRAIN":
      return `Preparing terrain: ${p}% — building terrain relief`;
    case "BUILDING_BASEMAP":
    case "PACKAGING":
      return `Building offline terrain package: ${p}%`;
    case "VERIFYING":
      return `Verifying package: ${p}%`;
    case "UPLOADING":
      return `Uploading package: ${p}%`;
    case "REGISTERING":
      return `Finalizing: ${p}%`;
    case "READY":
      return "Ready to download";
    case "CANCELLED":
      return "Preparation cancelled";
    case "FAILED":
      return job.error_details ? `Failed — ${job.error_details}` : "Preparation failed";
    default:
      return "Preparing offline 3D area…";
  }
}

// ---- Durable registry serialization + atomic recovery (pure) ---------------

/** A minimal in-process serial mutex: runExclusive callbacks run one-at-a-time,
 *  in call order, even when each awaits. Used to serialize registry
 *  read-modify-write so concurrent saves never lose each other's records. */
export type SerialMutex = { runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T> };

export function createSerialMutex(): SerialMutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => fn());
      // Keep the chain alive regardless of outcome, without unhandled rejections.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export type RegistryShape = { version: number; items: unknown[] };

/** True when a parsed value is a well-formed registry at the expected version. */
export function isValidRegistry(parsed: unknown, version: number): parsed is RegistryShape {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    (parsed as RegistryShape).version === version &&
    Array.isArray((parsed as RegistryShape).items)
  );
}

/**
 * Decide which registry file to trust after a crash. Writes go temp -> rename, so:
 *  - a valid main is authoritative (any leftover temp is stale -> clean up);
 *  - main missing/corrupt but a valid temp means a crash mid-rename -> recover temp;
 *  - neither valid -> start empty (clean up any garbage temp).
 */
export function chooseRegistrySource(s: {
  mainValid: boolean;
  tmpValid: boolean;
}): { use: "main" | "tmp" | "empty"; cleanupTmp: boolean } {
  if (s.mainValid) return { use: "main", cleanupTmp: true };
  if (s.tmpValid) return { use: "tmp", cleanupTmp: false };
  return { use: "empty", cleanupTmp: true };
}

// ---- Durable download state machine (pure) --------------------------------

export type ReconcileContext = {
  finalExists: boolean; // verified .mspk on disk
  partExists: boolean; // temporary .part on disk
  hasResumeData: boolean; // a usable persisted resumable snapshot
  hasActiveTask: boolean; // an in-memory download task exists THIS session
};

/**
 * Reconcile one persisted record against on-disk reality (run on app startup and
 * when the panel loads). Recovers records left mid-flight by a crash/OS kill:
 *  - READY needs its final file, else FAILED;
 *  - DOWNLOADING with no live task -> PAUSED if it can resume, else FAILED;
 *  - PAUSED that can't resume -> FAILED.
 */
export function reconcileRecord(
  status: OfflineSceneStatus,
  ctx: ReconcileContext,
): { status: OfflineSceneStatus; error: string | null } {
  switch (status) {
    case "READY":
      return ctx.finalExists
        ? { status: "READY", error: null }
        : { status: "FAILED", error: "Downloaded package file is missing; re-download required." };
    case "DOWNLOADING":
      if (ctx.hasActiveTask) return { status: "DOWNLOADING", error: null };
      if (ctx.partExists && ctx.hasResumeData) return { status: "PAUSED", error: null };
      return { status: "FAILED", error: "Download interrupted; retry required." };
    case "PAUSED":
      if (ctx.partExists && ctx.hasResumeData) return { status: "PAUSED", error: null };
      return { status: "FAILED", error: "Download cannot be resumed; retry required." };
    default:
      return { status, error: null }; // PENDING / FAILED unchanged
  }
}

/**
 * Only the worker whose generation matches the record's current generation may
 * promote READY / mark FAILED / delete the .part. A paused or superseded worker
 * (older generation) must do nothing — this guarantees a single authoritative
 * completion path per download generation.
 */
export function shouldApplyWorkerResult(currentGen: number, workerGen: number): boolean {
  return currentGen === workerGen;
}

/** Whether a record can be resumed in place, or must restart from scratch. */
export function resumeDecision(
  meta: Pick<OfflineScenePackageMeta, "resumeSnapshot">,
  partExists: boolean,
): "resume" | "restart" {
  const snap = meta.resumeSnapshot as { url?: string; fileUri?: string } | null;
  return partExists && !!snap && !!snap.url && !!snap.fileUri ? "resume" : "restart";
}

/** Files to remove when deleting a package (final + temporary). */
export function cleanupTargets(finalPath: string | null, partPath: string | null): string[] {
  const out: string[] = [];
  if (finalPath) out.push(finalPath);
  if (partPath && partPath !== finalPath) out.push(partPath);
  return out;
}

export function sizeMatches(expected: number, actual: number): boolean {
  return Number.isFinite(expected) && Number.isFinite(actual) && expected > 0 && expected === actual;
}

export function shaMatches(expected: string | null | undefined, actual: string | null | undefined): boolean {
  if (!expected || !actual) return false;
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatPackageAge(downloadedAtISO: string | null, nowMs = Date.now()): string {
  if (!downloadedAtISO) return "not downloaded";
  const t = Date.parse(downloadedAtISO);
  if (Number.isNaN(t)) return "unknown";
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days <= 0) {
    const hours = Math.floor((nowMs - t) / 3_600_000);
    if (hours <= 0) return "just now";
    return `${hours}h ago`;
  }
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/**
 * A downloaded package needs refreshing when the server's content signature no
 * longer matches the one stored at download time (incident geometry/bearing/area
 * changed server-side), or when the package is no longer marked available.
 */
export function needsRefresh(
  local: Pick<OfflineScenePackageMeta, "contentSignature" | "status"> | null | undefined,
  server: Pick<SceneAreaDescriptor, "available" | "content_signature"> | null | undefined,
): boolean {
  if (!local || local.status !== "READY") return false; // not downloaded => not "stale", just absent
  if (!server) return false; // can't tell offline; keep what we have
  if (!server.available) return false; // server can't offer one now; keep the local copy
  if (!server.content_signature) return false;
  return local.contentSignature !== server.content_signature;
}

export function isStale(
  meta: Pick<OfflineScenePackageMeta, "downloadedAt" | "status">,
  maxAgeDays: number,
  nowMs = Date.now(),
): boolean {
  if (meta.status !== "READY" || !meta.downloadedAt) return false;
  const t = Date.parse(meta.downloadedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t > maxAgeDays * 86_400_000;
}

export function summarizeStorage(metas: OfflineScenePackageMeta[]): {
  count: number;
  readyCount: number;
  totalBytes: number;
} {
  let totalBytes = 0;
  let readyCount = 0;
  for (const m of metas) {
    totalBytes += Number.isFinite(m.sizeBytes) ? m.sizeBytes : 0;
    if (m.status === "READY") readyCount += 1;
  }
  return { count: metas.length, readyCount, totalBytes };
}

/**
 * Human description of the prepared package, for the pre-download prompt. Shows
 * the REAL catalog size (not an estimate) and the elevation source.
 */
export function describeScope(descriptor: SceneAreaDescriptor | null | undefined): string {
  if (!descriptor || !descriptor.area || !descriptor.package) return "No package prepared";
  const km = (descriptor.area.radius_m / 1000).toFixed(descriptor.area.radius_m < 1000 ? 2 : 1);
  const size = formatBytes(descriptor.package.size_bytes);
  const elev = descriptor.package.elevation_source ?? "elevation";
  return `${km} km radius · ${size} · ${elev}`;
}

/** Build the initial local metadata record from a server descriptor at request time. */
export function metaFromDescriptor(
  descriptor: SceneAreaDescriptor,
  incidentId: number | null,
  nowISO: string,
): OfflineScenePackageMeta | null {
  if (!descriptor.available || !descriptor.area || !descriptor.package) return null;
  const pkg = descriptor.package;
  return {
    submissionId: descriptor.submission_id,
    incidentId,
    center: descriptor.area.center,
    radiusM: descriptor.area.radius_m,
    bounds: {
      minLat: descriptor.area.bounds.min_lat,
      minLon: descriptor.area.bounds.min_lon,
      maxLat: descriptor.area.bounds.max_lat,
      maxLon: descriptor.area.bounds.max_lon,
    },
    contentSignature: descriptor.content_signature ?? pkg.version,
    packageVersion: pkg.version,
    packageFormat: pkg.format || "eristerrain",
    expectedSha256: pkg.sha256,
    expectedSizeBytes: pkg.size_bytes,
    elevationSource: pkg.elevation_source,
    elevationDataset: pkg.elevation.dataset,
    elevationResolution: pkg.elevation.resolution,
    basemapSource: pkg.basemap_or_imagery_source,
    status: "PENDING",
    sizeBytes: 0,
    localPath: null,
    extractedDir: null,
    partPath: null,
    resumeSnapshot: null,
    downloadedAt: null,
    requestedAt: nowISO,
    error: null,
  };
}
