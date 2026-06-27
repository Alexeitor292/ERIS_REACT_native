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
  // Package identity + lifecycle.
  contentSignature: string; // server content version at download time
  packageVersion: string;
  status: OfflineSceneStatus;
  sizeBytes: number;
  estimatedSizeMb: number | null;
  localPath: string | null; // native file path to the .mspk, when READY
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
    estimated_size_mb: number;
    download_url: string | null;
    source: string | null;
  } | null;
  content_signature: string | null;
};

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

/** Human description of the bounded download scope, for the pre-download prompt. */
export function describeScope(descriptor: SceneAreaDescriptor | null | undefined): string {
  if (!descriptor || !descriptor.area) return "Area unavailable";
  const km = (descriptor.area.radius_m / 1000).toFixed(descriptor.area.radius_m < 1000 ? 2 : 1);
  const size = descriptor.package ? `~${descriptor.package.estimated_size_mb} MB` : "size unknown";
  return `${km} km radius around the incident · ${size}`;
}

/** Build the initial local metadata record from a server descriptor at request time. */
export function metaFromDescriptor(
  descriptor: SceneAreaDescriptor,
  incidentId: number | null,
  nowISO: string,
): OfflineScenePackageMeta | null {
  if (!descriptor.available || !descriptor.area || !descriptor.package) return null;
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
    contentSignature: descriptor.content_signature ?? descriptor.package.version,
    packageVersion: descriptor.package.version,
    status: "PENDING",
    sizeBytes: 0,
    estimatedSizeMb: descriptor.package.estimated_size_mb,
    localPath: null,
    downloadedAt: null,
    requestedAt: nowISO,
    error: null,
  };
}
