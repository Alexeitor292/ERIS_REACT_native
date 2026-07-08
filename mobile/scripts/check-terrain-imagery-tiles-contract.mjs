#!/usr/bin/env node
// Static source-contract guard for TILED offline aerial imagery in
// ErisTerrainSceneViewController.m. Deterministic, comment-aware, no macOS needed;
// the macOS CI ios-native job is the full compile validation.
//
// Enforces (against comment-stripped code):
//   * Tiled imagery is rendered as per-tile terrain PATCHES (imageryTilesNode +
//     buildImageryPatch) so each tile maps ONLY onto its correct geographic area.
//   * Patches keep the packed float2 texcoord (sizeof(ErisTerrainTexCoord) +
//     floatComponents:YES) — no diagonal-stripe UV regression.
//   * Patch textures CLAMP (no tiling / edge bleed / repeated edges).
//   * BOTH Satellite and Hybrid drive the tiled path (applyTiledImageryHybrid),
//     and the legacy single-image path is retained as a fallback (imageryImage).
//   * The terrain view controller does NO networking (offline-only) and NEVER
//     mutates the read-only source-derived elevation grid (gridData single-assign).
//   * Vertical exaggeration stays a display-only container Y-scale (exagNode).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "plugins", "arcgis-ios", "ErisTerrainSceneViewController.m");

function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const code = stripComments(readFileSync(FILE, "utf8"));
const errors = [];
const requireMatch = (re, msg) => { if (!re.test(code)) errors.push(msg); };
const forbidMatch = (re, msg) => { if (re.test(code)) errors.push(msg); };

// 1. Tiled imagery renders as per-tile terrain patches.
requireMatch(/\bimageryTilesNode\b/, "tiled imagery must render into a dedicated imageryTilesNode (per-tile patches).");
requireMatch(/buildImageryPatch\s*:/, "must build a terrain PATCH per imagery tile (buildImageryPatch:).");
requireMatch(/\bimageryTiled\b/, "must track tiled-vs-single imagery (imageryTiled).");

// 2. Patches keep the packed float2 texcoord (protect the UV fix in the new mesh).
requireMatch(/sizeof\(\s*ErisTerrainTexCoord\s*\)/, "patch texcoord must stay packed float2 (sizeof(ErisTerrainTexCoord)).");
requireMatch(/floatComponents:YES/, "patch texcoord source must keep floatComponents:YES.");
forbidMatch(/sizeof\(\s*CGPoint\s*\)/, "must NOT use sizeof(CGPoint) for any texcoord stride.");

// 3. Patch textures clamp — never tile/repeat (no seams / edge bleed / repeats).
forbidMatch(/SCNWrapModeRepeat|SCNWrapModeMirror/, "imagery/terrain textures must CLAMP, never Repeat/Mirror (no tiling/bleed).");

// 4. Satellite AND Hybrid both use the tiled path; legacy single-image is retained.
requireMatch(/applyTiledImageryHybrid\s*:/, "Hybrid over tiled imagery must slice hillshade per tile (applyTiledImageryHybrid:).");
requireMatch(/multiply\.contentsTransform/, "Hybrid must slice the whole-AOI hillshade per tile via a multiply contentsTransform.");
requireMatch(/\bimageryImage\b/, "legacy single-image imagery rendering must be retained as a fallback (imageryImage).");

// 5. No networking in the terrain viewer (fully offline after download).
forbidMatch(/NSURLSession|NSURLConnection|dataWithContentsOfURL:|URLWithString:|WKWebView|UIWebView|CFNetwork|https?:\/\//,
  "the terrain view controller must NOT perform any networking (fully offline).");

// 6. Elevation grid stays read-only; no package-file writes.
const gridAssignments = (code.match(/self\.gridData\s*=(?!=)/g) || []).length;
if (gridAssignments !== 1) {
  errors.push(`self.gridData must be assigned exactly once (at load); found ${gridAssignments}.`);
}
forbidMatch(/writeToFile:|writeToURL:|createFileAtPath:|removeItemAtPath:|removeItemAtURL:/,
  "the terrain view controller must NOT write/remove any package file.");

// 7. Vertical exaggeration remains a display-only container Y-scale.
requireMatch(/\bexagNode\b/, "vertical exaggeration must stay a display-only container Y-scale (exagNode).");

// 8. DRAPE, not REPLACE (regression fix). The authoritative base terrain mesh must
//    NEVER be hidden to show tiled imagery — imagery is an overlay draped above it.
forbidMatch(/terrainNode\.hidden\s*=\s*useTiles/,
  "REGRESSION: must NOT hide the base terrain for tiled imagery (terrainNode.hidden = useTiles). Drape imagery above the mesh instead.");
requireMatch(/self\.terrainNode\.hidden\s*=\s*NO/, "the base terrain mesh must stay visible (drape overlay): self.terrainNode.hidden = NO.");
requireMatch(/imageryDrapeLift/, "imagery patches must drape slightly ABOVE the mesh (imageryDrapeLift) to avoid z-fighting.");

// 9. Runtime safety fallback: never show a broken/partial tiled surface.
requireMatch(/disableTiledImagery\s*:/, "must have a runtime safety fallback that disables tiled imagery (disableTiledImagery:).");
requireMatch(/validateTileBounds/, "must validate tile bounds (no overlap/invalid) before building patches (validateTileBounds).");

if (errors.length > 0) {
  console.error("Tiled-imagery SceneKit source-contract FAILED (ErisTerrainSceneViewController.m):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Tiled-imagery SceneKit source-contract OK — per-tile patches, packed float2 UVs, clamp (no bleed), Satellite+Hybrid tiled, offline-only, gridData read-only.");
