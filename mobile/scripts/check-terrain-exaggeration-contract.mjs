#!/usr/bin/env node
// Static source-contract guard for the vertical-exaggeration feature in
// ErisTerrainSceneViewController.m. Deterministic, comment-aware, no macOS needed;
// the macOS CI ios-native job is the full compile validation.
//
// Enforces (against comment-stripped code):
//   * NO return to the old fixed visual mapping (worldSize * 0.35).
//   * a physically-derived scale is used (sceneUnitsPerMeter).
//   * the packed float2 texcoord fix is retained (sizeof(ErisTerrainTexCoord) +
//     floatComponents:YES) — no UV regression.
//   * the renderer does NOT mutate gridData (single assignment, at load) and does
//     NOT write any package file (no write/create/remove file APIs).
//   * the UI exposes Vertical exaggeration SEPARATELY from Hillshade intensity
//     (and the old "Terrain relief intensity" label is gone).
//   * the exaggeration slider is bounded 0.5x .. 3.0x.

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

const requireMatch = (re, msg) => {
  if (!re.test(code)) errors.push(msg);
};
const forbidMatch = (re, msg) => {
  if (re.test(code)) errors.push(msg);
};

// 1. No old fixed visual mapping.
forbidMatch(/worldSize\s*\*\s*0\.35/, "must NOT reintroduce the fixed visual mapping `worldSize * 0.35`.");

// 2. Physically-derived scale.
requireMatch(/\bsceneUnitsPerMeter\b/, "must derive a physical scene-units-per-metre (sceneUnitsPerMeter).");

// 3. Packed float2 texcoord retained (no UV regression).
requireMatch(/sizeof\(\s*ErisTerrainTexCoord\s*\)/, "must retain the packed float2 texcoord (sizeof(ErisTerrainTexCoord)).");
requireMatch(/floatComponents:YES/, "texcoord source must keep floatComponents:YES.");
forbidMatch(/sizeof\(\s*CGPoint\s*\)/, "must NOT use sizeof(CGPoint) for the texcoord stride.");

// 4. gridData is read-only (single assignment, at load) and no package-file writes.
// Assignment `=` only — exclude the comparison `==`.
const gridAssignments = (code.match(/self\.gridData\s*=(?!=)/g) || []).length;
if (gridAssignments !== 1) {
  errors.push(`self.gridData must be assigned exactly once (at load); found ${gridAssignments}.`);
}
forbidMatch(/writeToFile:|writeToURL:|createFileAtPath:|removeItemAtPath:|removeItemAtURL:/,
  "the terrain view controller must NOT write/remove any package file.");

// 5. Vertical exaggeration is exposed SEPARATELY from hillshade intensity.
requireMatch(/@"Vertical exaggeration"/, 'UI must expose a "Vertical exaggeration" control.');
requireMatch(/@"Hillshade intensity"/, 'the hillshade slider must be labelled "Hillshade intensity".');
forbidMatch(/@"Terrain relief intensity"/, 'the old "Terrain relief intensity" label must be renamed to "Hillshade intensity".');

// 6. Exaggeration slider bounded 0.5x .. 3.0x.
requireMatch(/kErisVertExagMin\s*=\s*0\.5/, "vertical-exaggeration minimum must be 0.5x.");
requireMatch(/kErisVertExagMax\s*=\s*3\.0/, "vertical-exaggeration maximum must be 3.0x.");

if (errors.length > 0) {
  console.error("Terrain vertical-exaggeration source-contract FAILED (ErisTerrainSceneViewController.m):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Terrain vertical-exaggeration source-contract OK — physical true-scale, packed float2 intact, gridData read-only, exag separate from hillshade, slider 0.5..3.0.");
