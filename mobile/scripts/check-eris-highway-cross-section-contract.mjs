#!/usr/bin/env node
// Static source-contract guard for the HIGHWAY-FIRST IMMERSIVE CROSS-SECTION milestone.
// Deterministic, comment-aware, no macOS needed (the macOS CI ios-native job is the full
// compile). Pins the native invariants across the four SceneKit controllers so the batch
// milestone cannot silently regress:
//   * physical draping is metre-derived (no worldSize-percentage physical lifts);
//   * the incident marker is a small ground ring, not a giant sphere;
//   * road snap features carry the ERIS road_class + display metadata;
//   * roads render class-aware (width/opacity) with a Road Display filter;
//   * selection is highway-first (per-class tolerances, priority ranking, bounded set);
//   * a candidate confirmation card precedes any inspection (no immediate modal);
//   * a saved/animated/restored map->inspection camera transition exists;
//   * inspection is an Immersive|Technical container sharing one slice model, immersive
//     is perspective, technical stays orthographic;
//   * orientation/default-layout limitations stay truthful; everything stays offline.

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

const NET = /NSURLSession|NSURLConnection|dataWithContentsOfURL:|URLWithString:|WKWebView|UIWebView|CFNetwork|https?:\/\//;
const WRITES = /writeToFile:|writeToURL:|createFileAtPath:|removeItemAtPath:|removeItemAtURL:/;
const errors = [];
const load = (name) => stripComments(readFileSync(P(name), "utf8"));
const checker = (tag, code) => ({
  req: (re, msg) => { if (!re.test(code)) errors.push(`[${tag}] ${msg}`); },
  forbid: (re, msg) => { if (re.test(code)) errors.push(`[${tag}] ${msg}`); },
});

// ---- Terrain VC: scale, classes, snapping, confirmation, transition ---------
{
  const code = load("ErisTerrainSceneViewController.m");
  const { req, forbid } = checker("terrain-vc", code);

  // Part 1: metre-derived physical scale; the old worldSize-percentage physical lifts gone.
  req(/sceneUnitsForMeters:/, "must expose the metre->scene-unit helper (sceneUnitsForMeters:).");
  req(/drapeLiftForLayer:/, "draped overlays must use the metre-derived drapeLiftForLayer:.");
  req(/kErisRoadDrapeLiftM\s*=\s*0\.30/, "road drape lift must be the 0.30 m constant.");
  forbid(/worldSize\s*\*\s*0\.018/, "the old ~27 m road lift (worldSize * 0.018) must be gone.");
  forbid(/worldSize\s*\*\s*0\.03(?!\d)/, "the old incident lift (worldSize * 0.03) must be gone.");
  forbid(/worldSize\s*\*\s*0\.025/, "the old incident radius (worldSize * 0.025) must be gone.");
  forbid(/sphereWithRadius:\s*self\.worldSize/, "markers must be metre-derived, not worldSize spheres.");

  // Part 2: restrained incident marker (ground ring, not a 75 m sphere).
  req(/kErisIncidentRingDiameterM/, "incident marker must use the metre-derived ground ring diameter.");
  req(/SCNTorus/, "incident marker must draw a ground ring (SCNTorus).");
  req(/Incident location/, "incident marker must carry an accessible identification.");

  // Part 3: road metadata preserved on every snap primitive.
  req(/snapFeatureForProps:/, "snap parser must build metadata-carrying primitives.");
  req(/road_class_label/, "snap metadata must include road_class_label.");
  req(/source_layer_id/, "snap metadata must include source_layer_id (display only).");
  req(/roadClass/, "snap metadata must carry roadClass.");

  // Part 4: class-aware rendering + Road Display control.
  req(/ErisRoadStyleForClass/, "roads must render with a per-class style (width/opacity).");
  req(/roadRibbonNodeFromCoords:/, "roads must render as width-bearing ribbons, not 1px lines only.");
  req(/@"Highways"/, "Road Display control must offer Highways.");
  req(/@"All roads"/, "Road Display control must offer All roads.");
  req(/applyRoadDisplayFilter/, "Road Display filter must gate class visibility.");

  // Part 5: highway-first candidate search.
  req(/gatherCandidatesAtLat:/, "selection must gather a bounded candidate set (gatherCandidatesAtLat:).");
  req(/kErisSnapMaxPrimaryM\s*=\s*90/, "primary snap tolerance must be 90 m.");
  req(/kErisSnapMaxSecondaryM\s*=\s*65/, "secondary snap tolerance must be 65 m.");
  req(/kErisSnapMaxLocalM\s*=\s*45/, "local snap tolerance must be 45 m.");
  req(/kErisMaxCandidates/, "candidate set must be bounded (kErisMaxCandidates).");
  req(/priority.*NSOrderedAscending.*NSOrderedDescending/s, "ranking must order by class priority first.");
  req(/roadClassSelectable:/, "must never snap to a class the filter excludes.");

  // Part 6: confirmation card precedes inspection; candidate highlighted first.
  req(/presentCandidateConfirmation/, "a confirmation card must precede inspection.");
  req(/createCrossSectionAtLat[\s\S]{0,700}presentCandidateConfirmation/,
      "the tap path must present the confirmation card, not inspect immediately.");
  req(/@"Inspect"/, "the card must offer Inspect.");
  req(/Choose another road/, "the card must let the user choose another road.");
  req(/@"Cancel"/, "the card must offer Cancel.");
  req(/highlightCandidate:/, "the selected candidate must be highlighted before Inspect.");

  // Part 7: saved/animated/restored camera transition; no immediate modal in the tap path.
  req(/saveMapCameraState/, "must save the map camera before the flight.");
  req(/animateMapToInspectionAtLat:/, "must animate the camera toward the snapped station.");
  req(/restoreMapCameraAfterInspection/, "must restore the prior map camera when inspection closes.");
  req(/SCNTransaction/, "the camera flight must be an explicit animation (SCNTransaction).");
  req(/ErisInspectionViewController/, "inspection must open the Immersive/Technical container.");
  forbid(/\[\s*ErisRoadSliceSceneViewController\s+alloc\s*\]/,
      "the tap path must NOT present the orthographic slice directly (no uncoordinated modal).");

  // Part 10: truthful orientation + default-layout warnings in the card.
  req(/upstation is NOT verified/, "must warn when orientation is only geometry-derived.");
  req(/not real highway dimensions/, "a primary highway on DEFAULT layout must not be shown as real geometry.");

  // Fully offline; read-only grid.
  forbid(NET, "terrain VC must not perform networking.");
  forbid(WRITES, "terrain VC must not write package files.");
}

// ---- Immersive corridor VC (perspective, offline, honest) -------------------
{
  const code = load("ErisImmersiveCorridorViewController.m");
  const { req, forbid } = checker("immersive-vc", code);
  req(/initWithSlice:[\s\S]{0,80}corridor:/, "immersive VC must consume the shared slice + corridor.");
  req(/SCNCamera/, "immersive VC must set up a camera.");
  req(/fieldOfView/, "immersive camera must be PERSPECTIVE (fieldOfView set).");
  forbid(/usesOrthographicProjection/, "the immersive camera must NOT be orthographic.");
  req(/resetCameraFraming/, "immersive VC must support Reset framing.");
  req(/Not street-level photography/, "must state it is an offline aerial-terrain inspection, not street view.");
  req(/upstation is not verified|packaged upstation bearing/, "must state the orientation provenance.");
  req(/Default roadway assumptions/, "must warn on DEFAULT roadway layout.");
  forbid(NET, "immersive VC must not perform networking (packaged data only).");
  forbid(WRITES, "immersive VC must not write files.");
}

// ---- Inspection container (Immersive | Technical, shared slice) -------------
{
  const code = load("ErisInspectionViewController.m");
  const { req, forbid } = checker("inspection-vc", code);
  req(/UISegmentedControl/, "must expose an Immersive|Technical segmented control.");
  req(/@"Immersive"/, "must offer the Immersive mode.");
  req(/@"Technical"/, "must offer the Technical mode.");
  req(/ErisImmersiveCorridorViewController/, "must host the immersive corridor child.");
  req(/ErisRoadSliceSceneViewController/, "must host the technical orthographic child.");
  req(/initWithSlice:self\.slice/, "both children must share the same slice model.");
  req(/Default roadway assumptions/, "must require acknowledgment of DEFAULT roadway assumptions.");
  req(/Acknowledge/, "the default-layout warning must be acknowledgeable.");
  forbid(NET, "inspection container must not perform networking.");
  forbid(WRITES, "inspection container must not write files.");
}

// ---- Technical slice VC still orthographic + honest -------------------------
{
  const code = load("ErisRoadSliceSceneViewController.m");
  const { req } = checker("slice-vc", code);
  req(/usesOrthographicProjection/, "the Technical cutaway must stay orthographic.");
  req(/resetCameraFraming/, "must expose resetCameraFraming for the container Reset.");
  req(/upstation is not verified/, "must warn when orientation is only geometry-derived.");
}

if (errors.length > 0) {
  console.error("Highway-cross-section source-contract FAILED:\n  - " + errors.join("\n  - "));
  process.exit(1);
}
console.log(
  "Highway immersive cross-section source-contract OK — metre-derived draping, restrained incident marker, " +
    "class-aware roads + Road Display, highway-first bounded selection, confirmation card, animated camera transition, " +
    "Immersive|Technical shared-slice inspection, truthful orientation/default-layout warnings, fully offline.",
);
