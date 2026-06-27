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
  type OfflineScenePackageMeta,
  type SceneAreaDescriptor,
} from "../arcgis/offlineScene";
import { openOfflineTerrainScene, supportsOfflineTerrainScene, type OpenOfflineSceneParams } from "../arcgis/ArcGISNative";

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

/**
 * Download (or re-download) the bounded offline scene package for a submission.
 * Bounded by the server descriptor's incident-radius area — never statewide.
 * Reports progress and is resumable (pause/retry). Persists metadata throughout.
 */
export async function downloadOfflineSceneArea(args: {
  descriptor: SceneAreaDescriptor;
  incidentId: number | null;
  onProgress?: (p: DownloadProgress) => void;
}): Promise<OfflineScenePackageMeta> {
  const { descriptor, incidentId, onProgress } = args;
  if (!descriptor.available || !descriptor.package?.download_url) {
    throw new Error(descriptor.reason ?? "No offline scene package is available for this area.");
  }
  await ensureDir();

  const initial = metaFromDescriptor(descriptor, incidentId, new Date().toISOString());
  if (!initial) throw new Error("Offline area descriptor is incomplete.");
  const dest = packagePath(descriptor.submission_id);

  let meta: OfflineScenePackageMeta = { ...initial, status: "DOWNLOADING", localPath: dest };
  await saveMeta(meta);

  const resumable = FileSystem.createDownloadResumable(
    descriptor.package.download_url,
    dest,
    {},
    (p) => {
      const total = p.totalBytesExpectedToWrite || 0;
      const written = p.totalBytesWritten || 0;
      onProgress?.({ totalBytes: total, writtenBytes: written, fraction: total > 0 ? written / total : 0 });
    },
  );
  _resumables.set(descriptor.submission_id, resumable);

  try {
    const result = await resumable.downloadAsync();
    _resumables.delete(descriptor.submission_id);
    if (!result?.uri) throw new Error("Download did not produce a file.");
    const info = await FileSystem.getInfoAsync(result.uri);
    const size = info.exists ? info.size : 0;
    meta = {
      ...meta,
      status: "READY",
      localPath: result.uri,
      sizeBytes: size,
      downloadedAt: new Date().toISOString(),
      error: null,
    };
    await saveMeta(meta);
    return meta;
  } catch (e: unknown) {
    _resumables.delete(descriptor.submission_id);
    meta = { ...meta, status: "FAILED", error: e instanceof Error ? e.message : String(e) };
    await saveMeta(meta);
    return meta;
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
  if (meta && meta.status === "DOWNLOADING") await saveMeta({ ...meta, status: "PAUSED" });
}

export async function resumeDownload(
  submissionId: number,
  onProgress?: (p: DownloadProgress) => void,
): Promise<OfflineScenePackageMeta | null> {
  const r = _resumables.get(submissionId);
  const meta = await getOfflineScenePackage(submissionId);
  if (!r || !meta) return meta;
  await saveMeta({ ...meta, status: "DOWNLOADING" });
  try {
    const result = await r.resumeAsync();
    _resumables.delete(submissionId);
    if (!result?.uri) throw new Error("Resume did not produce a file.");
    const info = await FileSystem.getInfoAsync(result.uri);
    const size = info.exists ? info.size : 0;
    const ready: OfflineScenePackageMeta = {
      ...meta,
      status: "READY",
      localPath: result.uri,
      sizeBytes: size,
      downloadedAt: new Date().toISOString(),
      error: null,
    };
    await saveMeta(ready);
    onProgress?.({ totalBytes: size, writtenBytes: size, fraction: 1 });
    return ready;
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
 * If the server's content signature changed since download, re-download. Returns
 * the (possibly refreshed) meta. No-ops offline or when the server has no package.
 */
export async function refreshIfNeeded(
  submissionId: number,
  serverDescriptor: SceneAreaDescriptor | null,
  incidentId: number | null,
  onProgress?: (p: DownloadProgress) => void,
): Promise<OfflineScenePackageMeta | null> {
  const local = await getOfflineScenePackage(submissionId);
  if (!local) return null;
  if (!needsRefresh(local, serverDescriptor)) return local;
  return downloadOfflineSceneArea({ descriptor: serverDescriptor as SceneAreaDescriptor, incidentId, onProgress });
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
