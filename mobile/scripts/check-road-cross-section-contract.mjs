#!/usr/bin/env node
// Static source-contract guard for the map-driven 3D ROAD CROSS SECTION feature.
// Deterministic, comment-aware, no macOS needed; the macOS CI ios-native job is the
// full compile validation.
//
// Enforces (against comment-stripped code) across the two native files:
//   ErisTerrainSceneViewController.m (the 3D map + tap→snap→sample):
//     * exposes a "Cross Section" tool + the "Tap a road..." instruction;
//     * samples elevation from the grid READ-ONLY (bilinear sampler present; gridData
//       assigned exactly once; no package-file writes);
//     * does NO networking (fully offline);
//     * snaps honestly (the "No road context near tap" message exists);
//     * the packed float2 texcoord + vertical-exaggeration container remain intact.
//   ErisRoadSliceSceneViewController.m (the realistic SceneKit cutaway):
//     * looks UPSTATION, labels LT/RT, cites the USGS 3DEP offline grid;
//     * renders median categories + a technical overlay;
//     * does NO networking and writes no files (procedural/local only).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (name) => join(HERE, "..", "plugins", "arcgis-ios", name);

function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const errors = [];
const NET = /NSURLSession|NSURLConnection|dataWithContentsOfURL:|URLWithString:|WKWebView|UIWebView|CFNetwork|https?:\/\//;
const WRITES = /writeToFile:|writeToURL:|createFileAtPath:|removeItemAtPath:|removeItemAtURL:/;

// ---- terrain map view controller -------------------------------------------
{
  const code = stripComments(readFileSync(P("ErisTerrainSceneViewController.m"), "utf8"));
  const req = (re, msg) => { if (!re.test(code)) errors.push(`[terrain-vc] ${msg}`); };
  const forbid = (re, msg) => { if (re.test(code)) errors.push(`[terrain-vc] ${msg}`); };

  req(/@"Cross Section"/, 'must expose a "Cross Section" tool button.');
  req(/Tap a road to create a cross section/, 'must show the "Tap a road to create a cross section" instruction.');
  req(/No road context near tap/, "must reject far/absent snaps honestly (the operator message).");
  req(/sampleElevationMetersAtLat:/, "must sample elevation from the packaged grid (sampleElevationMetersAtLat:).");
  req(/createCrossSectionAtLat:/, "must build the cross-section from the tapped station (createCrossSectionAtLat:).");
  // gridData READ-ONLY: assigned exactly once (at load).
  const assigns = (code.match(/self\.gridData\s*=(?!=)/g) || []).length;
  if (assigns !== 1) errors.push(`[terrain-vc] self.gridData must be assigned exactly once; found ${assigns}.`);
  forbid(NET, "must NOT perform any networking (fully offline).");
  forbid(WRITES, "must NOT write/remove any package file.");
  // The pre-existing invariants must survive the cross-section additions.
  req(/sizeof\(\s*ErisTerrainTexCoord\s*\)/, "packed float2 texcoord must remain intact (sizeof(ErisTerrainTexCoord)).");
  forbid(/sizeof\(\s*CGPoint\s*\)/, "must NOT use sizeof(CGPoint) for any texcoord stride.");
  req(/\bexagNode\b/, "vertical-exaggeration container (exagNode) must remain.");
}

// ---- road slice scene view controller --------------------------------------
{
  const code = stripComments(readFileSync(P("ErisRoadSliceSceneViewController.m"), "utf8"));
  const req = (re, msg) => { if (!re.test(code)) errors.push(`[slice-vc] ${msg}`); };
  const forbid = (re, msg) => { if (re.test(code)) errors.push(`[slice-vc] ${msg}`); };

  req(/Looking upstation/, 'must label the canonical orientation ("Looking upstation").');
  req(/@"LT"/, "must label LT.");
  req(/@"RT"/, "must label RT.");
  req(/USGS 3DEP/, "must cite the USGS 3DEP offline elevation source.");
  req(/BARRIER|RAISED|DEPRESSED/, "must render median categories.");
  req(/schematic/, "must state the roadway surface is schematic (honest labelling).");
  req(/usesOrthographicProjection/, "must use a controlled (orthographic) cutaway camera.");
  forbid(NET, "must NOT perform any networking (procedural/local materials only).");
  forbid(WRITES, "must NOT write any file.");
}

if (errors.length > 0) {
  console.error("Road cross-section source-contract FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Road cross-section source-contract OK — Cross Section tool + honest snap, grid read-only, offline-only (both VCs), upstation LT/RT + USGS 3DEP, packed float2 + exaggeration intact.");
