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
  // REGRESSION FIX: the snap parser must accept EVERY line-like geometry the renderer
  // draws (reuse primitivesFromGeometry), not just bare LineString — so tapping near a
  // visible road line snaps.
  req(/parseRoadSnapFeatures\s*\{[\s\S]{0,900}primitivesFromGeometry/,
      "the snap parser must reuse primitivesFromGeometry (all line-like geometries), not only LineString.");
  // Clearly-labelled bearing fallback with honest provenance when only bearing exists.
  req(/bearing_fallback/, "must support a labelled bearing fallback (roadContextSource=bearing_fallback).");
  req(/No road context packaged for this area/, "must give the honest no-context message when no geometry and no bearing exist.");
  req(/inPackageBoundsLat:/, "bearing fallback must be gated to taps within the package bounds (inPackageBoundsLat:).");
  // TRUTHFUL USABILITY GATING: the Cross Section button must distinguish fully-usable
  // from layout-only, and NEVER tell the user to enable road context when it is enabled.
  req(/crossSectionFullyUsable/, "the Cross Section button must gate on computed usability (crossSectionFullyUsable).");
  req(/no road snap geometry or upstation bearing is available/,
      "must show the layout-packaged-but-not-usable message (no snap geometry or upstation bearing).");
  req(/no road geometry was found for this package area/,
      "must show the enabled-but-no-data message (never say 'enable' when road context is already enabled).");
  req(/Cross Section usable:/, "Package Details must state whether the Cross Section tool is usable (Cross Section usable: yes/no).");
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

  // Orientation labels must DEPEND on orientationAuthoritative (PR #51 review): no
  // unconditional "Looking upstation" / LT / RT contradicted only by a footer.
  req(/orientationAuthoritative/, "orientation labels must branch on orientationAuthoritative.");
  req(/orientAuth\s*\?/, "LT/RT/upstation label text must be SELECTED from orientationAuthoritative (ternary).");
  req(/Looking upstation/, "the authoritative branch keeps 'Looking upstation'.");
  req(/Looking along packaged centerline/, "the geometry-derived branch labels 'Looking along packaged centerline'.");
  req(/Display left/, "the geometry-derived branch labels LT as 'Display left'.");
  req(/Display right/, "the geometry-derived branch labels RT as 'Display right'.");
  req(/Upstation and LT\/RT are not verified/, "geometry-derived must prominently show 'Upstation and LT/RT are not verified.'");
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
