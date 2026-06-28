// Tests for the eristerrain bundle parser/validator/decoder.
// Run: node --test src/arcgis/eristerrainBundle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crc32,
  decodeHeightGrid,
  extractAndValidateBundle,
  gridCellToLonLat,
  isUnsafeEntryName,
  lonLatToGridCell,
  parseZipEntries,
  validateBundleManifest,
  type TerrainMeta,
} from "./eristerrainBundle.ts";

// --- minimal STORED-zip writer (matches the worker's ZIP_STORED output) ---
function f32le(vals: number[]): Uint8Array {
  const u = new Uint8Array(vals.length * 4);
  const d = new DataView(u.buffer);
  vals.forEach((v, i) => d.setFloat32(i * 4, v, true));
  return u;
}

function makeStoredZip(files: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length);
    const ld = new DataView(lh.buffer);
    ld.setUint32(0, 0x04034b50, true);
    ld.setUint16(4, 20, true);
    ld.setUint16(8, 0, true); // STORED
    ld.setUint32(14, crc, true);
    ld.setUint32(18, data.length, true);
    ld.setUint32(22, data.length, true);
    ld.setUint16(26, nb.length, true);
    lh.set(nb, 30);
    locals.push(lh, data);

    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    centrals.push(cd);
    offset += lh.length + data.length;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const BOUNDS = { min_lat: 38.48, min_lon: -121.52, max_lat: 38.52, max_lon: -121.48 };
const TERRAIN: TerrainMeta = {
  file: "elevation-grid.bin",
  rows: 3,
  columns: 3,
  encoding: "float32",
  byte_order: "little",
  no_data_value: -9999,
  min_elevation_m: 1,
  max_elevation_m: 9,
  vertical_units: "meters",
  bounds: BOUNDS,
  local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: -0.02 },
};

function goodManifest() {
  return {
    format: "eristerrain",
    format_version: 2,
    elevation: { source: "USGS_3DEP", dataset: "USGS 3DEP", version: "2026-06-27", resolution: "10 m/px" },
    terrain: TERRAIN,
    overlays: { incident: { lat: 38.5, lon: -121.5 } },
  };
}

function goodBundle(): Uint8Array {
  const grid = f32le([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const manifest = new TextEncoder().encode(JSON.stringify(goodManifest()));
  const overlays = new TextEncoder().encode(JSON.stringify({ incident: { lat: 38.5, lon: -121.5 } }));
  return makeStoredZip([
    ["manifest.json", manifest],
    ["elevation-grid.bin", grid],
    ["overlays.json", overlays],
  ]);
}

test("valid eristerrain bundle extracts + decodes the height grid", () => {
  const { manifest, files } = extractAndValidateBundle(goodBundle());
  assert.equal(manifest.format, "eristerrain");
  assert.ok(files["elevation-grid.bin"]);
  const grid = decodeHeightGrid(files["elevation-grid.bin"], 3, 3);
  assert.deepEqual(Array.from(grid), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("path-traversal / unsafe entry names are rejected", () => {
  assert.equal(isUnsafeEntryName("../evil"), true);
  assert.equal(isUnsafeEntryName("/etc/passwd"), true);
  assert.equal(isUnsafeEntryName("C:\\x"), true);
  assert.equal(isUnsafeEntryName("a/../b"), true);
  assert.equal(isUnsafeEntryName("manifest.json"), false);
  // A bundle containing a traversal entry must be rejected on extract.
  const evil = makeStoredZip([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(goodManifest()))],
    ["../escape.bin", f32le([1])],
  ]);
  assert.throws(() => extractAndValidateBundle(evil), /unsafe archive entry/);
});

test("invalid manifest (wrong format / source) is rejected", () => {
  assert.equal(validateBundleManifest({ format: "mspk" }).ok, false);
  assert.equal(validateBundleManifest({ format: "eristerrain", format_version: 1 }).ok, false);
  assert.equal(
    validateBundleManifest({ format: "eristerrain", format_version: 2, elevation: { source: "SRTM" }, terrain: TERRAIN }).ok,
    false,
  );
  assert.equal(validateBundleManifest(goodManifest()).ok, true);
});

test("missing height grid is rejected", () => {
  const noGrid = makeStoredZip([["manifest.json", new TextEncoder().encode(JSON.stringify(goodManifest()))]]);
  assert.throws(() => extractAndValidateBundle(noGrid), /missing terrain grid/);
});

test("height grid size mismatch is rejected", () => {
  const m = goodManifest();
  m.terrain = { ...TERRAIN, rows: 4, columns: 4 }; // declare 4x4 but provide 3x3 bytes
  const bundle = makeStoredZip([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(m))],
    ["elevation-grid.bin", f32le([1, 2, 3, 4, 5, 6, 7, 8, 9])],
  ]);
  assert.throws(() => extractAndValidateBundle(bundle), /byte length/);
});

test("corrupted grid bytes fail CRC-32 verification", () => {
  const bundle = goodBundle();
  // Find and corrupt a grid data byte: parse, locate the grid local data start.
  const entries = parseZipEntries(bundle);
  const grid = entries.find((e) => e.name === "elevation-grid.bin")!;
  const d = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const nameLen = d.getUint16(grid.localOffset + 26, true);
  const extraLen = d.getUint16(grid.localOffset + 28, true);
  const dataStart = grid.localOffset + 30 + nameLen + extraLen;
  bundle[dataStart] ^= 0xff; // flip a byte; CRC in headers is unchanged
  assert.throws(() => extractAndValidateBundle(bundle), /checksum mismatch/);
});

test("local coordinate mapping: incident lon/lat -> grid cell and back", () => {
  // Center of the 3x3 grid maps to the middle cell (1,1).
  const cell = lonLatToGridCell(TERRAIN, -121.5, 38.5);
  assert.deepEqual(cell, { col: 1, row: 1 });
  const [lon, lat] = gridCellToLonLat(TERRAIN, 1, 1);
  assert.ok(Math.abs(lon - -121.5) < 1e-9 && Math.abs(lat - 38.5) < 1e-9);
  // Top-left cell maps to (min_lon, max_lat).
  assert.deepEqual(gridCellToLonLat(TERRAIN, 0, 0), [-121.52, 38.52]);
});

test("not-a-zip input is rejected", () => {
  assert.throws(() => extractAndValidateBundle(new Uint8Array([1, 2, 3, 4])), /not a valid package archive/);
});
