// Pure parsing/validation/decoding for the ERIS offline terrain bundle
// ('eristerrain') — a STORED (uncompressed) ZIP produced by the worker:
//   manifest.json, elevation-grid.bin (float32 LE height grid), hillshade.png?, overlays.json
//
// No react-native/expo imports (so it unit-tests under node --test), and no
// decompression dependency (entries are STORED). The native renderer consumes
// the extracted files; this module validates structure, rejects path traversal,
// verifies per-entry CRC-32, validates the manifest + terrain metadata, and
// decodes the height grid + coordinate transform.

export type ZipEntry = {
  name: string;
  method: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
};

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function utf8Decode(bytes: Uint8Array): string {
  // Minimal UTF-8 decoder (filenames + JSON are ASCII/UTF-8).
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xc0 && b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b >= 0xe0 && b < 0xf0)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reject path-traversal / absolute / drive-letter entry names. */
export function isUnsafeEntryName(name: string): boolean {
  if (!name || name.length > 255) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[\\/]/).some((p) => p === ".." || p === "");
}

export function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const d = dv(bytes);
  let eocd = -1;
  const minScan = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= minScan; i--) {
    if (d.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid package archive (no EOCD)");
  const total = d.getUint16(eocd + 10, true);
  let off = d.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (off + 46 > bytes.length || d.getUint32(off, true) !== SIG_CEN) throw new Error("corrupt central directory");
    const method = d.getUint16(off + 10, true);
    const crc = d.getUint32(off + 16, true);
    const compSize = d.getUint32(off + 20, true);
    const uncompSize = d.getUint32(off + 24, true);
    const nameLen = d.getUint16(off + 28, true);
    const extraLen = d.getUint16(off + 30, true);
    const cmtLen = d.getUint16(off + 32, true);
    const localOffset = d.getUint32(off + 42, true);
    const name = utf8Decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, crc32: crc >>> 0, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/** Read a STORED (method 0) entry's raw bytes. */
export function readStoredEntry(bytes: Uint8Array, e: ZipEntry): Uint8Array {
  if (e.method !== 0) throw new Error(`unsupported compression method ${e.method} (expected STORED)`);
  const d = dv(bytes);
  if (d.getUint32(e.localOffset, true) !== SIG_LOC) throw new Error("corrupt local file header");
  const nameLen = d.getUint16(e.localOffset + 26, true);
  const extraLen = d.getUint16(e.localOffset + 28, true);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const end = start + e.uncompSize;
  if (end > bytes.length) throw new Error("entry extends past archive");
  return bytes.subarray(start, end);
}

export type TerrainMeta = {
  file: string;
  rows: number;
  columns: number;
  encoding: string;
  byte_order: string;
  no_data_value: number;
  min_elevation_m: number;
  max_elevation_m: number;
  vertical_units: string;
  bounds: { min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  local_transform: { origin_lon: number; origin_lat: number; lon_per_col: number; lat_per_row: number };
  sha256?: string;
};

export type ContextLayerSource = {
  provider?: string;
  dataset?: string;
  retrieved_at?: string;
  attribution?: string;
  resolution?: string;
  service?: string;
};

export type ContextLayerMeta = {
  available: boolean;
  file?: string;
  sha256?: string;
  bytes?: number;
  reason?: string;
  width?: number;
  height?: number;
  source?: ContextLayerSource;
  [k: string]: unknown;
};

export type ContextLayers = {
  roads?: ContextLayerMeta;
  imagery?: ContextLayerMeta;
  overview?: ContextLayerMeta;
  [k: string]: ContextLayerMeta | undefined;
};

export type EristerrainManifest = {
  format: string;
  format_version: number;
  terrain: TerrainMeta;
  elevation: { source: string; dataset?: string; version?: string; resolution?: string };
  overlays?: unknown;
  context_layers?: ContextLayers;
  [k: string]: unknown;
};

/** Named optional context layers that may be packaged inside a bundle. */
export const CONTEXT_LAYER_NAMES = ["roads", "imagery", "overview"] as const;
export type ContextLayerName = (typeof CONTEXT_LAYER_NAMES)[number];

/** Whether a named context layer is present + declared available in a manifest.
 *  Absent block / absent layer => false (unavailable, NEVER treated as corrupt). */
export function contextLayerAvailable(
  manifest: Pick<EristerrainManifest, "context_layers"> | null | undefined,
  name: ContextLayerName,
): boolean {
  const layer = manifest?.context_layers?.[name];
  return !!layer && layer.available === true && typeof layer.file === "string" && !!layer.file;
}

/** Reason a layer is unavailable (for the UI), or null when it IS available. */
export function contextLayerReason(
  manifest: Pick<EristerrainManifest, "context_layers"> | null | undefined,
  name: ContextLayerName,
): string | null {
  if (contextLayerAvailable(manifest, name)) return null;
  const layer = manifest?.context_layers?.[name];
  return (layer && typeof layer.reason === "string" && layer.reason) || "unavailable";
}

function layerSourceLabel(layer: ContextLayerMeta | undefined): string | null {
  const s = layer?.source;
  if (!s) return null;
  return s.attribution || s.dataset || s.provider || null;
}

/**
 * Compact, UI-ready summary of a package's base surface + overlays, derived from
 * the manifest. `hasHillshade` comes from the presence of a hillshade.png entry
 * (the manifest `files.hillshade`), which the caller can pass; if omitted we infer
 * it from manifest.files. Distinguishes hillshade relief from real aerial imagery.
 */
export function summarizeContextLayers(
  manifest: EristerrainManifest | null | undefined,
): import("./offlineScene").ContextLayersSummary {
  const cl = (manifest?.context_layers ?? {}) as ContextLayers;
  const files = (manifest?.files ?? {}) as Record<string, unknown>;
  const hillshade = typeof files.hillshade === "string" && !!files.hillshade;
  const roads = contextLayerAvailable(manifest, "roads");
  const imagery = contextLayerAvailable(manifest, "imagery");
  const overview = contextLayerAvailable(manifest, "overview");
  const attribution: string[] = [];
  for (const name of CONTEXT_LAYER_NAMES) {
    const a = cl[name]?.source?.attribution;
    if (a && !attribution.includes(a)) attribution.push(a);
  }
  return {
    hillshade,
    roads,
    imagery,
    overview,
    roadsReason: contextLayerReason(manifest, "roads"),
    imageryReason: contextLayerReason(manifest, "imagery"),
    elevationSource: manifest?.elevation?.source ?? null,
    imagerySource: layerSourceLabel(cl.imagery),
    roadSource: layerSourceLabel(cl.roads),
    attribution,
  };
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateTerrainMeta(t: unknown): { ok: boolean; reason?: string } {
  if (!t || typeof t !== "object") return { ok: false, reason: "missing terrain metadata" };
  const m = t as Partial<TerrainMeta>;
  const rows = Number(m.rows);
  const cols = Number(m.columns);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || rows > 4096 || cols > 4096) {
    return { ok: false, reason: "invalid terrain dimensions" };
  }
  if (m.encoding !== "float32") return { ok: false, reason: "unsupported terrain encoding" };
  if (m.byte_order !== "little") return { ok: false, reason: "terrain byte_order must be little" };
  if (m.vertical_units !== "meters") return { ok: false, reason: "terrain vertical_units must be meters" };
  if (!isFiniteNum(m.no_data_value)) return { ok: false, reason: "invalid no_data_value" };
  if (!isFiniteNum(m.min_elevation_m) || !isFiniteNum(m.max_elevation_m) || m.min_elevation_m > m.max_elevation_m) {
    return { ok: false, reason: "invalid min/max elevation" };
  }
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) {
    return { ok: false, reason: "missing or malformed terrain sha256" };
  }
  const b = m.bounds;
  if (
    !b ||
    !isFiniteNum(b.min_lat) ||
    !isFiniteNum(b.min_lon) ||
    !isFiniteNum(b.max_lat) ||
    !isFiniteNum(b.max_lon) ||
    b.min_lat >= b.max_lat ||
    b.min_lon >= b.max_lon
  ) {
    return { ok: false, reason: "invalid terrain bounds" };
  }
  const lt = m.local_transform;
  if (
    !lt ||
    !isFiniteNum(lt.origin_lon) ||
    !isFiniteNum(lt.origin_lat) ||
    !isFiniteNum(lt.lon_per_col) ||
    !isFiniteNum(lt.lat_per_row)
  ) {
    return { ok: false, reason: "invalid local_transform" };
  }
  if (!(lt.lon_per_col > 0)) return { ok: false, reason: "local_transform lon_per_col must be positive" };
  if (!(lt.lat_per_row < 0)) return { ok: false, reason: "local_transform lat_per_row must be negative" };
  // The transform must correspond to the declared bounds + grid dimensions: row 0
  // is the north edge (origin = NW corner), columns step east, rows step south.
  const expLonPerCol = (b.max_lon - b.min_lon) / (cols - 1);
  const expLatPerRow = -(b.max_lat - b.min_lat) / (rows - 1);
  const tol = (v: number) => Math.abs(v) * 1e-3 + 1e-9;
  if (
    Math.abs(lt.origin_lon - b.min_lon) > tol(b.max_lon - b.min_lon) ||
    Math.abs(lt.origin_lat - b.max_lat) > tol(b.max_lat - b.min_lat) ||
    Math.abs(lt.lon_per_col - expLonPerCol) > tol(expLonPerCol) ||
    Math.abs(lt.lat_per_row - expLatPerRow) > tol(expLatPerRow)
  ) {
    return { ok: false, reason: "local_transform inconsistent with bounds/dimensions" };
  }
  return { ok: true };
}

export function validateBundleManifest(m: unknown): { ok: boolean; reason?: string } {
  if (!m || typeof m !== "object") return { ok: false, reason: "missing manifest" };
  const man = m as Partial<EristerrainManifest>;
  if (man.format !== "eristerrain") return { ok: false, reason: "not an eristerrain bundle" };
  if (Number(man.format_version ?? 0) < 2) return { ok: false, reason: "unsupported manifest format_version" };
  if ((man.elevation as { source?: string } | undefined)?.source !== "USGS_3DEP") {
    return { ok: false, reason: "elevation source is not USGS_3DEP" };
  }
  return validateTerrainMeta(man.terrain);
}

export type ExtractedBundle = { manifest: EristerrainManifest; files: Record<string, Uint8Array> };

/**
 * Validate + extract the bundle: reject unsafe names, verify CRC-32 of each
 * required entry, validate the manifest + terrain metadata, and confirm the
 * height grid byte length matches the declared dimensions. Throws on any failure.
 */
export function extractAndValidateBundle(bytes: Uint8Array): ExtractedBundle {
  const entries = parseZipEntries(bytes);
  for (const e of entries) {
    if (isUnsafeEntryName(e.name)) throw new Error(`unsafe archive entry: ${e.name}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));

  const manEntry = byName.get("manifest.json");
  if (!manEntry) throw new Error("missing manifest.json");
  const manBytes = readStoredEntry(bytes, manEntry);
  if (crc32(manBytes) !== (manEntry.crc32 >>> 0)) throw new Error("manifest checksum mismatch");
  let manifest: EristerrainManifest;
  try {
    manifest = JSON.parse(utf8Decode(manBytes));
  } catch {
    throw new Error("malformed manifest.json");
  }
  const v = validateBundleManifest(manifest);
  if (!v.ok) throw new Error(v.reason ?? "invalid manifest");

  const gridName = manifest.terrain.file || "elevation-grid.bin";
  const gridEntry = byName.get(gridName);
  if (!gridEntry) throw new Error(`missing terrain grid ${gridName}`);
  const gridBytes = readStoredEntry(bytes, gridEntry);
  const expected = manifest.terrain.rows * manifest.terrain.columns * 4;
  if (gridBytes.byteLength !== expected) throw new Error("terrain grid byte length does not match dimensions");
  if (crc32(gridBytes) !== (gridEntry.crc32 >>> 0)) throw new Error("terrain grid checksum mismatch");

  const files: Record<string, Uint8Array> = { "manifest.json": manBytes, [gridName]: gridBytes };
  // Optional entries must still pass CRC if present — a corrupt hillshade/overlays
  // rejects the whole bundle rather than being silently dropped.
  for (const opt of ["hillshade.png", "overlays.json"]) {
    const e = byName.get(opt);
    if (e) {
      const b = readStoredEntry(bytes, e);
      if (crc32(b) !== (e.crc32 >>> 0)) throw new Error(`${opt} checksum mismatch`);
      files[opt] = b;
    }
  }

  // Context layers: every DECLARED-available asset must be present + pass CRC + its
  // declared byte count. An absent block / layer is unavailable (NOT corrupt); a
  // declared-available-but-missing/corrupt asset fails the bundle closed. (The whole
  // package SHA-256 is already verified before extraction, so per-entry CRC + byte
  // count gives strong integrity for these assets.)
  const ctxLayers = (manifest.context_layers ?? {}) as ContextLayers;
  for (const name of CONTEXT_LAYER_NAMES) {
    const layer = ctxLayers[name];
    if (!layer || layer.available !== true) continue;
    const fname = layer.file;
    if (typeof fname !== "string" || !fname) throw new Error(`context layer ${name} available but has no file`);
    const e = byName.get(fname);
    if (!e) throw new Error(`missing context asset ${fname}`);
    const b = readStoredEntry(bytes, e);
    if (crc32(b) !== (e.crc32 >>> 0)) throw new Error(`context asset ${fname} checksum mismatch`);
    if (typeof layer.bytes === "number" && b.byteLength !== layer.bytes) {
      throw new Error(`context asset ${fname} size mismatch`);
    }
    files[fname] = b;
  }
  return { manifest, files };
}

/** Decode the float32 LE height grid into a Float32Array (no-data preserved). */
export function decodeHeightGrid(data: Uint8Array, rows: number, cols: number): Float32Array {
  if (data.byteLength !== rows * cols * 4) throw new Error("height grid size mismatch");
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = d.getFloat32(i * 4, true);
  return out;
}

/** Grid (col,row) -> [lon, lat] via the manifest local transform. */
export function gridCellToLonLat(t: TerrainMeta, col: number, row: number): [number, number] {
  const lt = t.local_transform;
  return [lt.origin_lon + col * lt.lon_per_col, lt.origin_lat + row * lt.lat_per_row];
}

/** Incident lon/lat -> nearest grid (col,row). */
export function lonLatToGridCell(t: TerrainMeta, lon: number, lat: number): { col: number; row: number } {
  const lt = t.local_transform;
  return {
    col: Math.round((lon - lt.origin_lon) / lt.lon_per_col),
    row: Math.round((lat - lt.origin_lat) / lt.lat_per_row),
  };
}
