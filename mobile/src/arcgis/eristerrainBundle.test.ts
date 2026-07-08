// Tests for the eristerrain bundle parser/validator/decoder.
// Run: node --test src/arcgis/eristerrainBundle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contextLayerAvailable,
  contextLayerReason,
  crc32,
  decodeHeightGrid,
  extractAndValidateBundle,
  gridCellToLonLat,
  imageryIsTiled,
  imageryMode,
  imageryTiles,
  isUnsafeEntryName,
  lonLatToGridCell,
  parseZipEntries,
  roadCrossSectionAvailable,
  summarizeContextLayers,
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
const SHA64 = "a".repeat(64); // 64-hex placeholder (grid SHA-256 is verified natively post-extract)
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
  sha256: SHA64,
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

// Build a manifest whose terrain is TERRAIN with one field overridden, and assert
// validateBundleManifest rejects it for the expected reason.
function expectTerrainRejected(patch: Partial<TerrainMeta>, reasonRe: RegExp) {
  const m = goodManifest();
  m.terrain = { ...TERRAIN, ...patch } as TerrainMeta;
  const r = validateBundleManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", reasonRe);
}

test("terrain byte_order must be little", () => {
  expectTerrainRejected({ byte_order: "big" }, /byte_order/);
});

test("terrain vertical_units must be meters", () => {
  expectTerrainRejected({ vertical_units: "feet" }, /vertical_units/);
});

test("terrain sha256 must be present and 64 hex chars", () => {
  expectTerrainRejected({ sha256: undefined }, /sha256/);
  expectTerrainRejected({ sha256: "abc" }, /sha256/);
  expectTerrainRejected({ sha256: "z".repeat(64) }, /sha256/); // non-hex
});

test("non-finite bounds / elevations are rejected", () => {
  expectTerrainRejected({ bounds: { ...BOUNDS, max_lat: Number.NaN } }, /bounds/);
  expectTerrainRejected({ min_elevation_m: 9, max_elevation_m: 1 }, /min\/max elevation/);
  expectTerrainRejected({ no_data_value: Number.POSITIVE_INFINITY }, /no_data_value/);
});

test("local_transform sign + consistency with bounds/dimensions is enforced", () => {
  // lon_per_col must be positive, lat_per_row must be negative.
  expectTerrainRejected(
    { local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: -0.02, lat_per_row: -0.02 } },
    /lon_per_col must be positive/,
  );
  expectTerrainRejected(
    { local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: 0.02 } },
    /lat_per_row must be negative/,
  );
  // A transform that does not match the declared bounds + grid dimensions.
  expectTerrainRejected(
    { local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.04, lat_per_row: -0.02 } },
    /inconsistent with bounds/,
  );
  // Wrong origin (must be the NW corner = min_lon / max_lat).
  expectTerrainRejected(
    { local_transform: { origin_lon: -120.0, origin_lat: 38.52, lon_per_col: 0.02, lat_per_row: -0.02 } },
    /inconsistent with bounds/,
  );
});

// Corrupt a STORED entry's first data byte in place (header CRC unchanged -> CRC mismatch).
function corruptEntryData(bundle: Uint8Array, name: string): Uint8Array {
  const entry = parseZipEntries(bundle).find((e) => e.name === name);
  assert.ok(entry, `entry ${name} not found`);
  const d = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const nameLen = d.getUint16(entry!.localOffset + 26, true);
  const extraLen = d.getUint16(entry!.localOffset + 28, true);
  const dataStart = entry!.localOffset + 30 + nameLen + extraLen;
  bundle[dataStart] ^= 0xff;
  return bundle;
}

test("a corrupted OPTIONAL hillshade.png rejects the bundle (not silently ignored)", () => {
  const grid = f32le([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const manifest = new TextEncoder().encode(JSON.stringify(goodManifest()));
  const hillshade = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // fake PNG bytes
  const bundle = makeStoredZip([
    ["manifest.json", manifest],
    ["elevation-grid.bin", grid],
    ["hillshade.png", hillshade],
  ]);
  corruptEntryData(bundle, "hillshade.png");
  assert.throws(() => extractAndValidateBundle(bundle), /hillshade\.png checksum mismatch/);
});

test("a corrupted OPTIONAL overlays.json rejects the bundle (not silently ignored)", () => {
  const bundle = goodBundle();
  corruptEntryData(bundle, "overlays.json");
  assert.throws(() => extractAndValidateBundle(bundle), /overlays\.json checksum mismatch/);
});

test("missing height grid is rejected", () => {
  const noGrid = makeStoredZip([["manifest.json", new TextEncoder().encode(JSON.stringify(goodManifest()))]]);
  assert.throws(() => extractAndValidateBundle(noGrid), /missing terrain grid/);
});

test("height grid size mismatch is rejected", () => {
  const m = goodManifest();
  // Declare 4x4 (with a transform consistent with 4x4) but provide only 3x3 bytes,
  // isolating the byte-length check from the transform-consistency check.
  m.terrain = {
    ...TERRAIN,
    rows: 4,
    columns: 4,
    local_transform: { origin_lon: -121.52, origin_lat: 38.52, lon_per_col: 0.04 / 3, lat_per_row: -0.04 / 3 },
  };
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

// ---- context layers (roads / imagery / overview) ---------------------------

const enc = (s: string) => new TextEncoder().encode(s);
const ROADS = enc('{"type":"FeatureCollection","features":[]}');

function manifestWithRoads(overrides: Record<string, unknown> = {}) {
  const m = goodManifest() as Record<string, unknown>;
  m.context_layers = {
    roads: {
      available: true, file: "roads.geojson", sha256: "b".repeat(64), bytes: ROADS.length,
      feature_count: 1, road_kinds: ["road_bearing"], ...overrides,
    },
    imagery: { available: false, reason: "not_configured" },
    overview: { available: false, reason: "disabled" },
  };
  m.files = { manifest: "manifest.json", terrain: "elevation-grid.bin", roads: "roads.geojson", hillshade: "hillshade.png" };
  return m;
}

function bundleWith(manifestObj: unknown, entries: [string, Uint8Array][]): Uint8Array {
  return makeStoredZip([
    ["manifest.json", enc(JSON.stringify(manifestObj))],
    ["elevation-grid.bin", f32le([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ...entries,
  ]);
}

test("legacy bundle without context_layers still opens (unavailable, not corrupt)", () => {
  const { manifest } = extractAndValidateBundle(goodBundle());
  assert.equal(contextLayerAvailable(manifest, "roads"), false);
  assert.equal(contextLayerAvailable(manifest, "imagery"), false);
  const s = summarizeContextLayers(manifest);
  assert.equal(s.roads, false);
  assert.equal(s.imagery, false);
});

test("declared-available roads asset is validated + extracted", () => {
  const bundle = bundleWith(manifestWithRoads(), [["roads.geojson", ROADS]]);
  const { manifest, files } = extractAndValidateBundle(bundle);
  assert.ok(files["roads.geojson"]);
  assert.equal(contextLayerAvailable(manifest, "roads"), true);
  assert.equal(contextLayerAvailable(manifest, "imagery"), false);
  assert.equal(contextLayerReason(manifest, "imagery"), "not_configured");
});

test("declared-available context asset that is MISSING fails closed", () => {
  const bundle = bundleWith(manifestWithRoads(), []); // roads declared but not packaged
  assert.throws(() => extractAndValidateBundle(bundle), /missing context asset roads\.geojson/);
});

test("declared-available context asset with a CORRUPT body fails closed", () => {
  const bundle = bundleWith(manifestWithRoads(), [["roads.geojson", ROADS]]);
  const entries = parseZipEntries(bundle);
  const e = entries.find((x) => x.name === "roads.geojson")!;
  const d = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const nameLen = d.getUint16(e.localOffset + 26, true);
  const extraLen = d.getUint16(e.localOffset + 28, true);
  bundle[e.localOffset + 30 + nameLen + extraLen] ^= 0xff;
  assert.throws(() => extractAndValidateBundle(bundle), /roads\.geojson checksum mismatch/);
});

test("declared-available context asset with wrong byte count fails closed", () => {
  const bundle = bundleWith(manifestWithRoads({ bytes: ROADS.length + 5 }), [["roads.geojson", ROADS]]);
  assert.throws(() => extractAndValidateBundle(bundle), /roads\.geojson size mismatch/);
});

test("available:false layer is ignored even if a stray file exists", () => {
  const m = manifestWithRoads();
  (m.context_layers as Record<string, unknown>).roads = { available: false, reason: "no_data" };
  const bundle = bundleWith(m, [["roads.geojson", ROADS]]); // present but not declared available
  const { manifest } = extractAndValidateBundle(bundle);
  assert.equal(contextLayerAvailable(manifest, "roads"), false);
  assert.equal(contextLayerReason(manifest, "roads"), "no_data");
});

test("summarizeContextLayers reflects hillshade + roads + imagery", () => {
  const m = manifestWithRoads();
  (m.context_layers as Record<string, unknown>).imagery = {
    available: true, file: "imagery.png", sha256: "c".repeat(64), bytes: 3,
    source: { provider: "usgs_naip", attribution: "USDA NAIP via USGS" },
  };
  m.files = { ...(m.files as object), imagery: "imagery.png" };
  const s = summarizeContextLayers(m as never);
  assert.equal(s.hillshade, true); // files.hillshade present
  assert.equal(s.roads, true);
  assert.equal(s.imagery, true);
  assert.equal(s.imagerySource, "USDA NAIP via USGS");
  assert.ok((s.attribution ?? []).includes("USDA NAIP via USGS"));
  // Truthful road context from the packaged feature kinds + count.
  assert.equal(s.roadContext, "Road bearing context");
  assert.equal(s.roadFeatureCount, 1);
});

test("summarizeContextLayers road context: inventory vs feature-service vs none", () => {
  const inv = manifestWithRoads({ road_kinds: ["road_bearing", "road_inventory"], feature_count: 3 });
  assert.equal(summarizeContextLayers(inv as never).roadContext, "Road inventory geometry");
  const net = manifestWithRoads({ road_kinds: ["road_centerline"], feature_count: 42 });
  const ns = summarizeContextLayers(net as never);
  assert.equal(ns.roadContext, "Feature service road network");
  assert.equal(ns.roadFeatureCount, 42);
  // No roads packaged.
  const legacy = summarizeContextLayers(goodManifest() as never);
  assert.equal(legacy.roadContext, "No road context packaged");
});

// ---- TILED aerial imagery --------------------------------------------------

const TILE0 = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]); // JPEG magic + body
const TILE1 = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7, 6, 5, 4]);
const TILE_BOUNDS_L = { min_lat: 38.48, min_lon: -121.52, max_lat: 38.52, max_lon: -121.5 };
const TILE_BOUNDS_R = { min_lat: 38.48, min_lon: -121.5, max_lat: 38.52, max_lon: -121.48 };

function manifestWithTiledImagery(overrides: Record<string, unknown> = {}) {
  const m = goodManifest() as Record<string, unknown>;
  m.context_layers = {
    roads: { available: false, reason: "disabled" },
    overview: { available: false, reason: "disabled" },
    imagery: {
      available: true,
      format: "tiled",
      tile_size_px: 1024,
      columns: 2,
      rows: 1,
      tile_count: 2,
      target_meters_per_pixel: 0.6,
      effective_meters_per_pixel: 0.58,
      bytes: TILE0.length + TILE1.length,
      bounds: BOUNDS,
      source: { provider: "usgs_naip", attribution: "USDA NAIP via USGS" },
      tiles: [
        { row: 0, column: 0, file: "imagery/0/0.jpg", bounds: TILE_BOUNDS_L, sha256: "d".repeat(64), bytes: TILE0.length },
        { row: 0, column: 1, file: "imagery/0/1.jpg", bounds: TILE_BOUNDS_R, sha256: "e".repeat(64), bytes: TILE1.length },
      ],
      ...overrides,
    },
  };
  m.files = { manifest: "manifest.json", terrain: "elevation-grid.bin", hillshade: "hillshade.png" };
  return m;
}

function tiledBundle(manifestObj: unknown, tiles: [string, Uint8Array][] = [["imagery/0/0.jpg", TILE0], ["imagery/0/1.jpg", TILE1]]) {
  return bundleWith(manifestObj, tiles);
}

test("tiled imagery: manifest parses, is available, and every tile is extracted", () => {
  const { manifest, files } = extractAndValidateBundle(tiledBundle(manifestWithTiledImagery()));
  assert.equal(contextLayerAvailable(manifest, "imagery"), true);
  assert.equal(imageryMode(manifest), "tiled");
  assert.equal(imageryIsTiled(manifest.context_layers?.imagery), true);
  const tiles = imageryTiles(manifest);
  assert.equal(tiles.length, 2);
  assert.ok(files["imagery/0/0.jpg"] && files["imagery/0/1.jpg"]);
  // tile file paths + bounds preserved for the renderer's per-tile terrain patches.
  assert.equal(tiles[0].file, "imagery/0/0.jpg");
  assert.deepEqual(tiles[1].bounds, TILE_BOUNDS_R);
});

test("tiled imagery: summary reports mode, tile count, effective resolution, source", () => {
  const s = summarizeContextLayers(manifestWithTiledImagery() as never);
  assert.equal(s.imagery, true);
  assert.equal(s.imageryMode, "tiled");
  assert.equal(s.imageryTileCount, 2);
  assert.equal(s.imageryEffectiveMpp, 0.58);
  assert.equal(s.imagerySource, "USDA NAIP via USGS");
});

test("legacy single-image imagery is still recognised (backward compatible)", () => {
  const m = goodManifest() as Record<string, unknown>;
  m.context_layers = {
    imagery: { available: true, file: "imagery.png", sha256: "c".repeat(64), bytes: 3, source: { provider: "usgs_naip" } },
  };
  m.files = { imagery: "imagery.png" };
  assert.equal(imageryMode(m as never), "single");
  assert.equal(imageryIsTiled((m.context_layers as Record<string, never>).imagery), false);
  assert.equal(contextLayerAvailable(m as never, "imagery"), true);
  assert.equal(summarizeContextLayers(m as never).imageryMode, "single");
});

test("tiled imagery: a manifest-declared tile that is MISSING fails closed", () => {
  // Declare 2 tiles but package only the first one.
  const bundle = tiledBundle(manifestWithTiledImagery(), [["imagery/0/0.jpg", TILE0]]);
  assert.throws(() => extractAndValidateBundle(bundle), /missing context asset imagery\/0\/1\.jpg/);
});

test("tiled imagery: a CORRUPT tile body fails closed", () => {
  const bundle = tiledBundle(manifestWithTiledImagery());
  corruptEntryData(bundle, "imagery/0/1.jpg");
  assert.throws(() => extractAndValidateBundle(bundle), /imagery\/0\/1\.jpg checksum mismatch/);
});

test("tiled imagery: a tile with the wrong byte count fails closed", () => {
  const m = manifestWithTiledImagery();
  (m.context_layers as { imagery: { tiles: { bytes: number }[] } }).imagery.tiles[0].bytes = TILE0.length + 3;
  assert.throws(() => extractAndValidateBundle(tiledBundle(m)), /imagery\/0\/0\.jpg size mismatch/);
});

test("tiled imagery: tile count not matching columns*rows fails closed", () => {
  const m = manifestWithTiledImagery({ columns: 3, rows: 1 }); // says 3 tiles, only 2 declared
  assert.throws(() => extractAndValidateBundle(tiledBundle(m)), /tile count does not match/);
});

// ---- road cross-section context (road_cross_section.json) -------------------

const RXS = enc(JSON.stringify({
  attributes: { lt_lane_count: 1, rt_lane_count: 1, median_category: "NONE", total_width_ft: 32, source: "ROAD_INVENTORY" },
  route_name: "SR-17", county_code: "SCL", begin_pm: 5, end_pm: 6,
  upstation_bearing_deg: 42, postmile_increases_upstation: true, source: "ROAD_INVENTORY",
}));

function manifestWithRoadXsec(overrides: Record<string, unknown> = {}) {
  const m = goodManifest() as Record<string, unknown>;
  m.context_layers = {
    roads: { available: false, reason: "no_data" },
    imagery: { available: false, reason: "not_configured" },
    overview: { available: false, reason: "disabled" },
    road_cross_section: {
      available: true, file: "road_cross_section.json", sha256: "f".repeat(64), bytes: RXS.length,
      source: { provider: "eris_road_inventory", attribution: "ERIS Road Inventory" }, ...overrides,
    },
  };
  m.files = { manifest: "manifest.json", terrain: "elevation-grid.bin", road_cross_section: "road_cross_section.json" };
  return m;
}

test("road_cross_section context is validated + extracted + reported available", () => {
  const { manifest, files } = extractAndValidateBundle(bundleWith(manifestWithRoadXsec(), [["road_cross_section.json", RXS]]));
  assert.equal(roadCrossSectionAvailable(manifest), true);
  assert.ok(files["road_cross_section.json"]);
  const parsed = JSON.parse(new TextDecoder().decode(files["road_cross_section.json"]));
  assert.equal(parsed.attributes.source, "ROAD_INVENTORY");
  assert.equal(parsed.route_name, "SR-17");
});

test("legacy package without road_cross_section still opens (unavailable, not corrupt)", () => {
  const { manifest } = extractAndValidateBundle(goodBundle());
  assert.equal(roadCrossSectionAvailable(manifest), false);
  assert.equal(contextLayerReason(manifest, "road_cross_section"), "unavailable");
});

test("declared-available road_cross_section that is MISSING fails closed", () => {
  assert.throws(() => extractAndValidateBundle(bundleWith(manifestWithRoadXsec(), [])), /missing context asset road_cross_section\.json/);
});

test("declared-available road_cross_section with wrong byte count fails closed", () => {
  const bundle = bundleWith(manifestWithRoadXsec({ bytes: RXS.length + 9 }), [["road_cross_section.json", RXS]]);
  assert.throws(() => extractAndValidateBundle(bundle), /road_cross_section\.json size mismatch/);
});
