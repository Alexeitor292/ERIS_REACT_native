// Offline 3D scene-package manager.
//
// Downloads, stores, and tracks bounded offline terrain packages for the native
// 3D viewer. Two formats: the auto-generated `eristerrain` bundle (default,
// stored `<id>.eristerrain`, rendered by the native SceneKit terrain viewer) and
// optional Esri `.mspk` (stored `<id>.mspk`, opened via ArcGIS Runtime). An
// eristerrain bundle is NEVER opened as an AGSMobileScenePackage. The download +
// file management is pure JS via expo-file-system (resumable download =>
// pause/retry; getInfoAsync => size). Only the final render is native.
//
// Package metadata is persisted in a JSON registry alongside the package files
// in the app's document directory. Incident edits/photos/forms are unaffected —
// they keep using the existing offline queue (src/offline/queue.ts).

import * as FileSystem from "expo-file-system/legacy";

import {
  cleanupTargets,
  createSerialMutex,
  downloadHttpError,
  isValidRegistry,
  metaFromDescriptor,
  needsLegacyPathMigration,
  needsRefresh,
  packageFileName,
  partPathFor,
  reconcileRecord,
  shaMatches,
  shouldApplyWorkerResult,
  sizeMatches,
  usesMspkRuntime,
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
import { extractAndValidateBundle } from "../arcgis/eristerrainBundle";

const DIR_NAME = "offline-scenes";
const REGISTRY_VERSION = 1;
const DEFAULT_STALE_DAYS = 60;

type Registry = { version: 1; items: OfflineScenePackageMeta[] };

function baseDir(): string {
  const root = FileSystem.documentDirectory ?? "";
  return `${root.replace(/\/+$/, "")}/${DIR_NAME}`;
}

// Format-aware final package path. eristerrain -> `<id>.eristerrain`, mspk ->
// `<id>.mspk`. Callers pass the meta/descriptor format; when a READY record
// already has a localPath (incl. a legacy `<id>.mspk` eristerrain file), prefer
// that stored path so existing downloads keep working.
function packagePath(submissionId: number, format: string | null | undefined): string {
  return `${baseDir()}/${packageFileName(submissionId, format)}`;
}

function finalPathForMeta(meta: OfflineScenePackageMeta): string {
  return meta.localPath ?? packagePath(meta.submissionId, meta.packageFormat);
}

function registryPath(): string {
  return `${baseDir()}/registry.json`;
}

function registryTmpPath(): string {
  return `${registryPath()}.tmp`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(baseDir());
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(baseDir(), { intermediates: true });
  }
}

// A single module-level mutex serializes every registry read-modify-write so
// concurrent downloads / progress snapshots / pauses / deletes / reconciliation
// never race and lose each other's records.
const _registryMutex = createSerialMutex();

async function parseRegistryFile(path: string): Promise<Registry | null> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed = JSON.parse(raw);
    return isValidRegistry(parsed, REGISTRY_VERSION) ? (parsed as Registry) : null;
  } catch {
    return null;
  }
}

// Read the authoritative registry: a valid main file wins; if it is missing or
// corrupt (e.g. a crash mid-rename), recover from the temp file; else empty.
async function readRegistryRaw(): Promise<Registry> {
  const main = await parseRegistryFile(registryPath());
  if (main) return main;
  const tmp = await parseRegistryFile(registryTmpPath());
  if (tmp) return tmp;
  return { version: REGISTRY_VERSION, items: [] };
}

// Atomic write: serialize to a temp file, then rename over the main file. A crash
// between the two leaves a valid temp that readRegistryRaw recovers from.
async function writeRegistryAtomic(reg: Registry): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(registryTmpPath(), JSON.stringify(reg));
  await FileSystem.deleteAsync(registryPath(), { idempotent: true });
  await FileSystem.moveAsync({ from: registryTmpPath(), to: registryPath() });
}

// Serialized read-modify-write: a FRESH read + atomic write under the mutex, so
// two concurrent mutations never lose each other's records.
async function mutateRegistry(fn: (reg: Registry) => Registry): Promise<Registry> {
  return _registryMutex.runExclusive(async () => {
    const reg = await readRegistryRaw();
    const next = fn(reg);
    await writeRegistryAtomic(next);
    return next;
  });
}

async function readRegistry(): Promise<Registry> {
  return _registryMutex.runExclusive(readRegistryRaw);
}

function upsert(items: OfflineScenePackageMeta[], next: OfflineScenePackageMeta): OfflineScenePackageMeta[] {
  const idx = items.findIndex((x) => x.submissionId === next.submissionId);
  if (idx < 0) return [next, ...items];
  const copy = [...items];
  copy[idx] = next;
  return copy;
}

async function saveMeta(meta: OfflineScenePackageMeta): Promise<void> {
  await mutateRegistry((reg) => ({ ...reg, items: upsert(reg.items, meta) }));
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
// Per-submission download generation. Each download/resume start bumps it; Pause
// and Delete also bump it to SUPERSEDE any running worker. A worker only applies
// its result if its generation is still current — the single authoritative
// completion path per generation. Survives only within a session (after a restart
// reconcile recovers persisted records).
const _gen = new Map<number, number>();

function nextGen(id: number): number {
  const g = (_gen.get(id) ?? 0) + 1;
  _gen.set(id, g);
  return g;
}
function isCurrentGen(id: number, gen: number): boolean {
  return shouldApplyWorkerResult(_gen.get(id) ?? 0, gen);
}

export type DownloadProgress = { totalBytes: number; writtenBytes: number; fraction: number };

function toNativePath(uri: string): string {
  return decodeURI(uri.replace(/^file:\/\//, ""));
}

const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = _B64.indexOf(clean[i]);
    const b = _B64.indexOf(clean[i + 1]);
    const c = _B64.indexOf(clean[i + 2]);
    const d = _B64.indexOf(clean[i + 3]);
    if (p < len) out[p++] = (a << 2) | (b >> 4);
    if (p < len && c >= 0) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < len && d >= 0) out[p++] = ((c & 3) << 6) | d;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += _B64[a >> 2] + _B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? _B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? _B64[c & 63] : "=";
  }
  return out;
}

function utf8FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
  }
  return s;
}

function extractedDirFor(submissionId: number): string {
  return `${baseDir()}/${submissionId}-extracted`;
}

/**
 * Validate + extract an eristerrain bundle next to its package: reject path
 * traversal, verify CRC + manifest + terrain dimensions, write the manifest /
 * height grid / hillshade / overlays into a per-package directory, and verify the
 * grid's manifest SHA-256 natively. Returns the extracted directory.
 */
async function validateAndExtractEristerrain(partUri: string, submissionId: number): Promise<string> {
  const b64 = await FileSystem.readAsStringAsync(partUri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = base64ToBytes(b64);
  const { manifest, files } = extractAndValidateBundle(bytes); // throws on any invalidity

  const dir = extractedDirFor(submissionId);
  try {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {
    /* ignore */
  }
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  const gridName = manifest.terrain.file || "elevation-grid.bin";
  await FileSystem.writeAsStringAsync(`${dir}/manifest.json`, utf8FromBytes(files["manifest.json"]));
  await FileSystem.writeAsStringAsync(`${dir}/${gridName}`, bytesToBase64(files[gridName]), {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (files["hillshade.png"]) {
    await FileSystem.writeAsStringAsync(`${dir}/hillshade.png`, bytesToBase64(files["hillshade.png"]), {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  if (files["overlays.json"]) {
    await FileSystem.writeAsStringAsync(`${dir}/overlays.json`, utf8FromBytes(files["overlays.json"]));
  }
  // Context-layer assets (present only when the manifest declared them available
  // and they passed CRC + byte-count validation above). roads is text; the PNGs
  // are binary. The native renderer reads whichever exist; absent = layer off.
  if (files["roads.geojson"]) {
    await FileSystem.writeAsStringAsync(`${dir}/roads.geojson`, utf8FromBytes(files["roads.geojson"]));
  }
  for (const png of ["imagery.png", "overview.png"]) {
    if (files[png]) {
      await FileSystem.writeAsStringAsync(`${dir}/${png}`, bytesToBase64(files[png]), {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
  }
  // Tiled aerial imagery: imagery/{row}/{col}.jpg (nested — create parent dirs).
  // Present only when the manifest declared tiled imagery available and every tile
  // passed CRC + byte-count validation above. The native renderer reads whichever
  // tiles exist; a missing tile would already have failed extraction closed.
  const madeDirs = new Set<string>();
  for (const name of Object.keys(files)) {
    if (!/^imagery\/\d+\/\d+\.(jpg|jpeg|png)$/i.test(name)) continue;
    const parent = name.slice(0, name.lastIndexOf("/"));
    if (!madeDirs.has(parent)) {
      await FileSystem.makeDirectoryAsync(`${dir}/${parent}`, { intermediates: true });
      madeDirs.add(parent);
    }
    await FileSystem.writeAsStringAsync(`${dir}/${name}`, bytesToBase64(files[name]), {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  // Verify the manifest's grid SHA-256 natively against the extracted grid file.
  const declaredSha = manifest.terrain.sha256;
  if (declaredSha) {
    const gridSha = await sha256OfFile(toNativePath(`${dir}/${gridName}`));
    if (!shaMatches(declaredSha, gridSha)) {
      throw new Error("Extracted terrain grid failed SHA-256 verification.");
    }
  }
  return dir;
}

/** Persist only the resumable snapshot (for crash/restart resume) without racing
 *  the rest of the record. No-op if the record changed generation meanwhile. */
async function persistSnapshot(id: number, gen: number, snapshot: unknown): Promise<void> {
  if (!isCurrentGen(id, gen)) return;
  const meta = await getOfflineScenePackage(id);
  if (!meta || meta.status !== "DOWNLOADING") return;
  await saveMeta({ ...meta, resumeSnapshot: snapshot });
}

/**
 * Reconcile one persisted record against on-disk reality. Run on app startup and
 * panel load so a record left DOWNLOADING/PAUSED by a crash is recovered to a
 * truthful status (PAUSED w/ Resume, or FAILED w/ Retry) instead of a stuck
 * spinner with a dead Pause button.
 */
export async function reconcilePackage(submissionId: number): Promise<OfflineScenePackageMeta | null> {
  let meta = await getOfflineScenePackage(submissionId);
  if (!meta) return null;
  // One-time legacy migration: a READY eristerrain package saved under the old
  // always-".mspk" filename is renamed to the canonical ".eristerrain" name.
  meta = await migrateLegacyPackagePath(meta);
  // Prefer the stored localPath (handles legacy names); else the format path.
  const finalUri = finalPathForMeta(meta);
  const partUri = meta.partPath ?? partPathFor(packagePath(submissionId, meta.packageFormat));
  const [finalInfo, partInfo] = await Promise.all([
    FileSystem.getInfoAsync(finalUri),
    FileSystem.getInfoAsync(partUri),
  ]);
  const snap = meta.resumeSnapshot as { url?: string; fileUri?: string } | null;
  const next = reconcileRecord(meta.status, {
    finalExists: finalInfo.exists,
    partExists: partInfo.exists,
    hasResumeData: !!snap && !!snap.url && !!snap.fileUri,
    hasActiveTask: _resumables.has(submissionId),
  });
  if (next.status === meta.status && next.error === (meta.error ?? null)) return meta;
  const reconciled: OfflineScenePackageMeta = {
    ...meta,
    status: next.status,
    error: next.error,
    localPath: next.status === "READY" ? finalUri : meta.status === "READY" ? null : meta.localPath,
  };
  await saveMeta(reconciled);
  return reconciled;
}

/**
 * Rename a legacy `<id>.mspk` file that actually holds an eristerrain package to
 * the canonical `<id>.eristerrain` path, and update the registry. No-op unless a
 * migration is needed and the legacy file is present. Best-effort: on any FS error
 * the original record is returned unchanged (reconcile will still work off it).
 */
async function migrateLegacyPackagePath(meta: OfflineScenePackageMeta): Promise<OfflineScenePackageMeta> {
  if (!needsLegacyPathMigration(meta) || !meta.localPath) return meta;
  const canonical = packagePath(meta.submissionId, meta.packageFormat);
  if (canonical === meta.localPath) return meta;
  try {
    const [legacyInfo, canonicalInfo] = await Promise.all([
      FileSystem.getInfoAsync(meta.localPath),
      FileSystem.getInfoAsync(canonical),
    ]);
    if (!legacyInfo.exists) return meta; // nothing to migrate
    if (!canonicalInfo.exists) {
      await FileSystem.moveAsync({ from: meta.localPath, to: canonical });
    } else {
      // Canonical already exists — drop the stale legacy file.
      await FileSystem.deleteAsync(meta.localPath, { idempotent: true });
    }
    const migrated = { ...meta, localPath: canonical };
    await saveMeta(migrated);
    return migrated;
  } catch {
    return meta;
  }
}

/** Reconcile every persisted record (call once on app startup). */
export async function reconcileAllPackages(): Promise<void> {
  const reg = await readRegistry();
  for (const m of reg.items) await reconcilePackage(m.submissionId);
}

/**
 * Verify a finished .part download and atomically promote it to the format-aware
 * final path (`<id>.eristerrain` or `<id>.mspk`). NEVER marks READY merely because
 * a file exists:
 *   1) exact byte size, 2) SHA-256 (native), 3) declared-format validation —
 *   eristerrain: validate + extract the bundle (grid SHA-256 verified natively);
 *   mspk: it actually loads as an AGSMobileScenePackage (native) — then
 *   4) atomic rename .part -> final. An eristerrain bundle is never loaded as
 *   an Esri .mspk. Throws on any failure so the caller records FAILED + cleans up.
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

  // Format-aware validation. NEVER mark READY until the package validates as its
  // declared format — an eristerrain bundle is never loaded as an Esri .mspk.
  let extractedDir: string | null = null;
  if (usesMspkRuntime(meta.packageFormat)) {
    const loads = await validateScenePackage(toNativePath(partUri));
    if (!loads) throw new Error("The downloaded file is not a valid .mspk scene package.");
  } else {
    // eristerrain (default): validate + extract the bundle (throws on invalidity).
    extractedDir = await validateAndExtractEristerrain(partUri, meta.submissionId);
  }

  const finalUri = packagePath(meta.submissionId, meta.packageFormat);
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
    extractedDir,
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
  const partUri = partPathFor(packagePath(descriptor.submission_id, initial.packageFormat));

  const meta: OfflineScenePackageMeta = {
    ...initial,
    expectedSha256: grant.sha256,
    expectedSizeBytes: grant.size_bytes,
    status: "DOWNLOADING",
    localPath: null,
    partPath: partUri,
    resumeSnapshot: null,
  };
  await saveMeta(meta);

  // Fresh start: clear any stale .part from a previous interrupted attempt.
  try {
    await FileSystem.deleteAsync(partUri, { idempotent: true });
  } catch {
    /* ignore */
  }

  const myGen = nextGen(descriptor.submission_id);
  let lastBucket = -1;
  const resumable = FileSystem.createDownloadResumable(grant.url, partUri, {}, (p) => {
    const total = p.totalBytesExpectedToWrite || 0;
    const written = p.totalBytesWritten || 0;
    const fraction = total > 0 ? written / total : 0;
    onProgress?.({ totalBytes: total, writtenBytes: written, fraction });
    // Throttled snapshot persistence (~every 10%) so a crash mid-download can resume.
    const bucket = Math.floor(fraction * 10);
    if (bucket > lastBucket) {
      lastBucket = bucket;
      try {
        void persistSnapshot(descriptor.submission_id, myGen, resumable.savable());
      } catch {
        /* ignore */
      }
    }
  });
  _resumables.set(descriptor.submission_id, resumable);

  try {
    const result = await resumable.downloadAsync();
    // Superseded by Pause/Delete/another start -> do NOTHING (no promote, no delete).
    if (!isCurrentGen(descriptor.submission_id, myGen)) return meta;
    _resumables.delete(descriptor.submission_id);
    if (!result?.uri) throw new Error("Download did not produce a file.");
    // A non-2xx response body is an error page (e.g. presigned-URL 403), NOT a
    // package — surface the real HTTP cause and never size/SHA-validate the body.
    const httpErr = downloadHttpError(result.status);
    if (httpErr) throw new Error(httpErr);
    return await verifyAndPromote(meta, result.uri, onProgress);
  } catch (e: unknown) {
    if (!isCurrentGen(descriptor.submission_id, myGen)) return meta; // superseded: leave .part/state alone
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
  const meta = await getOfflineScenePackage(submissionId);
  // Immediately reflect PAUSED so the UI never shows a dead spinner.
  if (meta && (meta.status === "DOWNLOADING" || meta.status === "PENDING")) {
    // Bump generation FIRST so the running worker's completion becomes a no-op.
    nextGen(submissionId);
    let snapshot: unknown | null = meta.resumeSnapshot ?? null;
    if (r) {
      try {
        await r.pauseAsync();
      } catch {
        /* ignore */
      }
      try {
        snapshot = r.savable();
      } catch {
        /* keep last snapshot */
      }
    }
    _resumables.delete(submissionId);
    await saveMeta({ ...meta, status: "PAUSED", resumeSnapshot: snapshot });
  }
}

/** Result of a resume attempt. `resumed:false` => caller should restart from a
 *  fresh grant (e.g. presigned URL expired or no usable resume state). */
export type ResumeResult = { meta: OfflineScenePackageMeta; resumed: boolean };

export async function resumeDownload(
  submissionId: number,
  onProgress?: (p: DownloadProgress) => void,
): Promise<ResumeResult | null> {
  const meta = await getOfflineScenePackage(submissionId);
  if (!meta) return null;
  if (!supportsScenePackageIntegrity()) {
    const failed: OfflineScenePackageMeta = { ...meta, status: "FAILED", error: "Integrity bridge missing; rebuild the app." };
    await saveMeta(failed);
    return { meta: failed, resumed: true };
  }

  // Reconstruct from the persisted snapshot (resume after app restart).
  const snap = meta.resumeSnapshot as
    | { url?: string; fileUri?: string; options?: FileSystem.DownloadOptions; resumeData?: string }
    | null;
  if (!snap?.url || !snap?.fileUri) {
    // No usable resume state -> caller restarts from a fresh grant.
    await saveMeta({ ...meta, status: "PAUSED" });
    return { meta, resumed: false };
  }

  const myGen = nextGen(submissionId);
  const r = FileSystem.createDownloadResumable(
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
  _resumables.set(submissionId, r);
  await saveMeta({ ...meta, status: "DOWNLOADING" });
  try {
    const result = await r.resumeAsync();
    if (!isCurrentGen(submissionId, myGen)) return { meta, resumed: true }; // superseded
    _resumables.delete(submissionId);
    if (!result?.uri) throw new Error("Resume did not produce a file.");
    const httpErr = downloadHttpError(result.status);
    if (httpErr) throw new Error(httpErr);
    const promoted = await verifyAndPromote(meta, result.uri, onProgress);
    return { meta: promoted, resumed: true };
  } catch (e: unknown) {
    if (!isCurrentGen(submissionId, myGen)) return { meta, resumed: true };
    _resumables.delete(submissionId);
    const failed: OfflineScenePackageMeta = { ...meta, status: "FAILED", error: e instanceof Error ? e.message : String(e) };
    await saveMeta(failed);
    // An expired URL surfaces as a failed resume -> let the caller restart fresh.
    return { meta: failed, resumed: false };
  }
}

export async function deleteOfflineScenePackage(submissionId: number): Promise<void> {
  // Supersede any in-flight worker so it can't recreate files/registry after us.
  nextGen(submissionId);
  _resumables.delete(submissionId);
  const meta = await getOfflineScenePackage(submissionId);
  const fmt = meta?.packageFormat;
  const finalUri = meta?.localPath ?? packagePath(submissionId, fmt);
  const partUri = meta?.partPath ?? partPathFor(packagePath(submissionId, fmt));
  // Also remove a possible legacy `<id>.mspk` file for a now-`.eristerrain` record.
  const legacyUri = packagePath(submissionId, "mspk");
  for (const target of [...cleanupTargets(finalUri, partUri), legacyUri]) {
    try {
      await FileSystem.deleteAsync(target, { idempotent: true });
    } catch {
      /* ignore file errors */
    }
  }
  // Remove the extracted eristerrain directory too.
  try {
    await FileSystem.deleteAsync(meta?.extractedDir ?? extractedDirFor(submissionId), { idempotent: true });
  } catch {
    /* ignore */
  }
  await mutateRegistry((reg) => ({ ...reg, items: reg.items.filter((x) => x.submissionId !== submissionId) }));
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
  // eristerrain renders from the extracted directory; mspk opens the file directly.
  if (!usesMspkRuntime(meta.packageFormat) && !meta.extractedDir) {
    throw new Error("The terrain bundle was not extracted. Delete and re-download the area.");
  }
  await openOfflineTerrainScene({
    ...overlay,
    packagePath: meta.localPath,
    packageFormat: meta.packageFormat,
    extractedDir: meta.extractedDir,
    packageVersion: meta.packageVersion,
    downloadedAt: meta.downloadedAt,
    sizeBytes: meta.sizeBytes,
  });
}
