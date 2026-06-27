// Offline 3D scene-package manager.
//
// Downloads, stores, and tracks bounded Mobile Scene Packages (.mspk) for the
// native 3D terrain viewer. The download + file management is pure JS via
// expo-file-system (resumable download => pause/retry; getInfoAsync => size).
// Only the final SceneView render is native (openOfflineTerrainScene).
//
// Package metadata is persisted in a JSON registry alongside the package files
// in the app's document directory. Incident edits/photos/forms are unaffected —
// they keep using the existing offline queue (src/offline/queue.ts).

import * as FileSystem from "expo-file-system/legacy";

import {
  metaFromDescriptor,
  needsRefresh,
  partPathFor,
  shaMatches,
  sizeMatches,
  type OfflineScenePackageMeta,
  type SceneAreaDescriptor,
  type SceneDownloadGrant,
} from "../arcgis/offlineScene";
import {
  openOfflineTerrainScene,
  sha256OfFile,
  supportsOfflineTerrainScene,
  supportsScenePackageIntegrity,
  validateScenePackage,
  type OpenOfflineSceneParams,
} from "../arcgis/ArcGISNative";

const DIR_NAME = "offline-scenes";
const REGISTRY_VERSION = 1;
const DEFAULT_STALE_DAYS = 60;

type Registry = { version: 1; items: OfflineScenePackageMeta[] };

function baseDir(): string {
  const root = FileSystem.documentDirectory ?? "";
  return `${root.replace(/\/+$/, "")}/${DIR_NAME}`;
}

function packagePath(submissionId: number): string {
  return `${baseDir()}/${submissionId}.mspk`;
}

function registryPath(): string {
  return `${baseDir()}/registry.json`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(baseDir());
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(baseDir(), { intermediates: true });
  }
}

async function readRegistry(): Promise<Registry> {
  try {
    const info = await FileSystem.getInfoAsync(registryPath());
    if (!info.exists) return { version: REGISTRY_VERSION, items: [] };
    const raw = await FileSystem.readAsStringAsync(registryPath());
    const parsed = JSON.parse(raw);
    if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed?.items)) {
      return { version: REGISTRY_VERSION, items: [] };
    }
    return parsed as Registry;
  } catch {
    return { version: REGISTRY_VERSION, items: [] };
  }
}

async function writeRegistry(reg: Registry): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(registryPath(), JSON.stringify(reg));
}

function upsert(items: OfflineScenePackageMeta[], next: OfflineScenePackageMeta): OfflineScenePackageMeta[] {
  const idx = items.findIndex((x) => x.submissionId === next.submissionId);
  if (idx < 0) return [next, ...items];
  const copy = [...items];
  copy[idx] = next;
  return copy;
}

async function saveMeta(meta: OfflineScenePackageMeta): Promise<void> {
  const reg = await readRegistry();
  await writeRegistry({ ...reg, items: upsert(reg.items, meta) });
}

export async function listOfflineScenePackages(): Promise<OfflineScenePackageMeta[]> {
  return (await readRegistry()).items;
}

export async function getOfflineScenePackage(submissionId: number): Promise<OfflineScenePackageMeta | null> {
  const reg = await readRegistry();
  return reg.items.find((x) => x.submissionId === submissionId) ?? null;
}

// In-memory resumable downloads, so pause/resume works within a session.
const _resumables = new Map<number, FileSystem.DownloadResumable>();

export type DownloadProgress = { totalBytes: number; writtenBytes: number; fraction: number };

function toNativePath(uri: string): string {
  return decodeURI(uri.replace(/^file:\/\//, ""));
}

/**
 * Verify a finished .part download and atomically promote it to the final path.
 * NEVER marks READY merely because a file exists:
 *   1) exact byte size, 2) SHA-256 (native), 3) the .mspk actually loads as an
 *   AGSMobileScenePackage (native), then 4) atomic rename .part -> final.
 * Throws on any failure so the caller records FAILED + cleans up.
 */
async function verifyAndPromote(
  meta: OfflineScenePackageMeta,
  partUri: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<OfflineScenePackageMeta> {
  const info = await FileSystem.getInfoAsync(partUri);
  const actualSize = info.exists ? info.size : 0;
  if (!sizeMatches(meta.expectedSizeBytes, actualSize)) {
    throw new Error(`Size mismatch: got ${actualSize} bytes, expected ${meta.expectedSizeBytes}.`);
  }
  const actualSha = await sha256OfFile(toNativePath(partUri));
  if (!shaMatches(meta.expectedSha256, actualSha)) {
    throw new Error("SHA-256 mismatch — the download is corrupted.");
  }
  const loads = await validateScenePackage(toNativePath(partUri));
  if (!loads) {
    throw new Error("The downloaded file is not a valid 3D scene package.");
  }
  const finalUri = packagePath(meta.submissionId);
  try {
    await FileSystem.deleteAsync(finalUri, { idempotent: true });
  } catch {
    /* ignore */
  }
  await FileSystem.moveAsync({ from: partUri, to: finalUri });
  const ready: OfflineScenePackageMeta = {
    ...meta,
    status: "READY",
    localPath: finalUri,
    partPath: null,
    resumeSnapshot: null,
    sizeBytes: actualSize,
    downloadedAt: new Date().toISOString(),
    error: null,
  };
  await saveMeta(ready);
  onProgress?.({ totalBytes: actualSize, writtenBytes: actualSize, fraction: 1 });
  return ready;
}

/**
 * Download a bounded offline scene package to a temporary .part file, then verify
 * (size + SHA-256 + real package load) and atomically promote to READY. Requires
 * the native integrity bridge (EAS dev build). The `grant` carries the short-lived
 * presigned URL and the authoritative size/sha for THIS download.
 */
export async function downloadOfflineSceneArea(args: {
  descriptor: SceneAreaDescriptor;
  grant: SceneDownloadGrant;
  incidentId: number | null;
  onProgress?: (p: DownloadProgress) => void;
}): Promise<OfflineScenePackageMeta> {
  const { descriptor, grant, incidentId, onProgress } = args;
  if (!descriptor.available || !descriptor.package) {
    throw new Error(descriptor.reason ?? "No offline scene package is available for this area.");
  }
  if (!supportsScenePackageIntegrity()) {
    throw new Error(
      "This app build cannot verify offline packages. Install an EAS development build to enable the native 3D viewer + integrity checks.",
    );
  }
  await ensureDir();

  const initial = metaFromDescriptor(descriptor, incidentId, new Date().toISOString());
  if (!initial) throw new Error("Offline area descriptor is incomplete.");
  const partUri = partPathFor(packagePath(descriptor.submission_id));

  const meta: OfflineScenePackageMeta = {
    ...initial,
    expectedSha256: grant.sha256,
    expectedSizeBytes: grant.size_bytes,
    status: "DOWNLOADING",
    localPath: null,
    partPath: partUri,
  };
  await saveMeta(meta);

  const resumable = FileSystem.createDownloadResumable(grant.url, partUri, {}, (p) => {
    const total = p.totalBytesExpectedToWrite || 0;
    const written = p.totalBytesWritten || 0;
    onProgress?.({ totalBytes: total, writtenBytes: written, fraction: total > 0 ? written / total : 0 });
  });
  _resumables.set(descriptor.submission_id, resumable);

  try {
    const result = await resumable.downloadAsync();
    _resumables.delete(descriptor.submission_id);
    if (!result?.uri) throw new Error("Download did not produce a file.");
    return await verifyAndPromote(meta, result.uri, onProgress);
  } catch (e: unknown) {
    _resumables.delete(descriptor.submission_id);
    try {
      await FileSystem.deleteAsync(partUri, { idempotent: true });
    } catch {
      /* ignore */
    }
    const failed: OfflineScenePackageMeta = {
      ...meta,
      status: "FAILED",
      partPath: null,
      resumeSnapshot: null,
      error: e instanceof Error ? e.message : String(e),
    };
    await saveMeta(failed);
    return failed;
  }
}

export async function pauseDownload(submissionId: number): Promise<void> {
  const r = _resumables.get(submissionId);
  if (!r) return;
  try {
    await r.pauseAsync();
  } catch {
    /* ignore */
  }
  const meta = await getOfflineScenePackage(submissionId);
  if (meta && (meta.status === "DOWNLOADING" || meta.status === "PENDING")) {
    // Persist the resumable snapshot so the download can resume after an app restart.
    let snapshot: unknown | null = null;
    try {
      snapshot = r.savable();
    } catch {
      snapshot = null;
    }
    await saveMeta({ ...meta, status: "PAUSED", resumeSnapshot: snapshot });
  }
}

export async function resumeDownload(
  submissionId: number,
  onProgress?: (p: DownloadProgress) => void,
): Promise<OfflineScenePackageMeta | null> {
  const meta = await getOfflineScenePackage(submissionId);
  if (!meta) return null;
  if (!supportsScenePackageIntegrity()) {
    const failed: OfflineScenePackageMeta = { ...meta, status: "FAILED", error: "Integrity bridge missing; rebuild the app." };
    await saveMeta(failed);
    return failed;
  }

  let r = _resumables.get(submissionId);
  if (!r) {
    // Reconstruct from the persisted snapshot (resume after app restart).
    const snap = meta.resumeSnapshot as
      | { url?: string; fileUri?: string; options?: FileSystem.DownloadOptions; resumeData?: string }
      | null;
    if (snap?.url && snap?.fileUri) {
      r = FileSystem.createDownloadResumable(
        snap.url,
        snap.fileUri,
        snap.options ?? {},
        (p) => {
          const total = p.totalBytesExpectedToWrite || 0;
          const written = p.totalBytesWritten || 0;
          onProgress?.({ totalBytes: total, writtenBytes: written, fraction: total > 0 ? written / total : 0 });
        },
        snap.resumeData,
      );
    }
  }
  if (!r) {
    // No resumable (e.g. URL expired). Caller should refresh the descriptor/grant
    // and restart the download; keep PAUSED so the UI shows Resume/Retry.
    await saveMeta({ ...meta, status: "PAUSED" });
    return meta;
  }

  await saveMeta({ ...meta, status: "DOWNLOADING" });
  try {
    const result = await r.resumeAsync();
    _resumables.delete(submissionId);
    if (!result?.uri) throw new Error("Resume did not produce a file.");
    return await verifyAndPromote(meta, result.uri, onProgress);
  } catch (e: unknown) {
    _resumables.delete(submissionId);
    const failed: OfflineScenePackageMeta = { ...meta, status: "FAILED", error: e instanceof Error ? e.message : String(e) };
    await saveMeta(failed);
    return failed;
  }
}

export async function deleteOfflineScenePackage(submissionId: number): Promise<void> {
  const meta = await getOfflineScenePackage(submissionId);
  const path = meta?.localPath ?? packagePath(submissionId);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    /* ignore file errors */
  }
  const reg = await readRegistry();
  await writeRegistry({ ...reg, items: reg.items.filter((x) => x.submissionId !== submissionId) });
}

/** Delete READY packages older than maxAgeDays. Returns deleted submission IDs. */
export async function clearStalePackages(maxAgeDays = DEFAULT_STALE_DAYS): Promise<number[]> {
  const reg = await readRegistry();
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const deleted: number[] = [];
  for (const m of reg.items) {
    if (m.status === "READY" && m.downloadedAt && Date.parse(m.downloadedAt) < cutoff) {
      await deleteOfflineScenePackage(m.submissionId);
      deleted.push(m.submissionId);
    }
  }
  return deleted;
}

/**
 * Whether the downloaded package is stale versus the server's newest READY one
 * (content signature changed). The UI fetches a fresh grant and re-downloads when
 * this is true; offline or with no server package, the local copy is kept.
 */
export async function isRefreshNeeded(
  submissionId: number,
  serverDescriptor: SceneAreaDescriptor | null,
): Promise<boolean> {
  const local = await getOfflineScenePackage(submissionId);
  return needsRefresh(local, serverDescriptor);
}

/**
 * Open the native 3D terrain SceneView for a downloaded package, drawing the
 * live ERIS overlays (incident, uploaded geometry, road bearing, sample extent).
 * Overlays are passed at open time (not baked into the package) so they stay
 * truthful and update with ERIS data.
 */
export async function openDownloadedScene(
  submissionId: number,
  overlay: Omit<OpenOfflineSceneParams, "packagePath" | "incident"> & { incident: { lat: number; lon: number } },
): Promise<void> {
  if (!supportsOfflineTerrainScene()) {
    throw new Error(
      "Native 3D terrain viewer is not in this build. Rebuild the app with an EAS dev build to enable it.",
    );
  }
  const meta = await getOfflineScenePackage(submissionId);
  if (!meta || meta.status !== "READY" || !meta.localPath) {
    throw new Error("No downloaded offline 3D area for this submission. Download it first.");
  }
  const info = await FileSystem.getInfoAsync(meta.localPath);
  if (!info.exists) {
    throw new Error("The offline package file is missing. Delete and re-download the area.");
  }
  await openOfflineTerrainScene({
    ...overlay,
    packagePath: meta.localPath,
    packageVersion: meta.packageVersion,
    downloadedAt: meta.downloadedAt,
    sizeBytes: meta.sizeBytes,
  });
}
