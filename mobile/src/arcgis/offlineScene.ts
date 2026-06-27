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
  localPath: string | null; // verified final .mspk path, when READY
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
  content_signature: string;
};

export function partPathFor(finalPath: string): string {
  return `${finalPath}.part`;
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
    expectedSha256: pkg.sha256,
    expectedSizeBytes: pkg.size_bytes,
    elevationSource: pkg.elevation_source,
    elevationDataset: pkg.elevation.dataset,
    elevationResolution: pkg.elevation.resolution,
    basemapSource: pkg.basemap_or_imagery_source,
    status: "PENDING",
    sizeBytes: 0,
    localPath: null,
    partPath: null,
    resumeSnapshot: null,
    downloadedAt: null,
    requestedAt: nowISO,
    error: null,
  };
}
