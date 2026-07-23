#!/usr/bin/env node
// Static source-contract guard for TRUE-SCALE, truthful cross-sections (DEFECT D).
// Deterministic, comment-aware, no macOS needed (the macOS ios-native job is the full compile).
//
// Enforces (against comment-stripped code) for the immersive + technical cross-section views:
//   * No hardcoded 1.5x / 2.0x vertical exaggeration DEFAULT remains.
//   * Both views default the vertical exaggeration to 1.0x (true scale) and apply it as a
//     display-only render factor (never mutating packaged elevations).
//   * Each view shows a VISIBLE vertical-scale label ("1.0×" / "true scale").
//   * Provenance states the drawn ground is bare-earth terrain UNDER THE CENTERLINE and NOT
//     the road pavement grade (never claims the DEM is pavement).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IOS = join(HERE, "..", "plugins", "arcgis-ios");
const IMMERSIVE = join(IOS, "ErisImmersiveCorridorViewController.m");
const TECHNICAL = join(IOS, "ErisRoadSliceSceneViewController.m");

function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const errors = [];
const immersive = stripComments(readFileSync(IMMERSIVE, "utf8"));
const technical = stripComments(readFileSync(TECHNICAL, "utf8"));
const req = (code, re, msg) => { if (!re.test(code)) errors.push(msg); };
const forbid = (code, re, msg) => { if (re.test(code)) errors.push(msg); };

// 1. No hardcoded 1.5x / 2.0x exaggeration DEFAULT remains.
forbid(immersive, /kCorridorVExag\s*=\s*1\.5/,
  "IMMERSIVE: the hardcoded 1.5x exaggeration default must be removed (kCorridorVExag = 1.5).");
forbid(technical, /\bkVExag\s*=\s*2\.0/,
  "TECHNICAL: the hardcoded 2.0x exaggeration default must be removed (kVExag = 2.0).");

// 2. Both default to 1.0x true scale, applied as a display-only property.
req(immersive, /kCorridorVExagDefault\s*=\s*1\.0/,
  "IMMERSIVE: vertical exaggeration must default to 1.0x true scale (kCorridorVExagDefault = 1.0).");
req(technical, /kVExagDefault\s*=\s*1\.0/,
  "TECHNICAL: vertical exaggeration must default to 1.0x true scale (kVExagDefault = 1.0).");
req(immersive, /self\.verticalExaggeration/,
  "IMMERSIVE: exaggeration must be a display-only property applied at render (self.verticalExaggeration).");
req(technical, /self\.verticalExaggeration/,
  "TECHNICAL: exaggeration must be a display-only property applied at render (self.verticalExaggeration).");

// 3. A visible vertical-scale label exists in each view.
req(immersive, /verticalScaleLabelText/,
  "IMMERSIVE: must show a visible vertical-scale label (verticalScaleLabelText).");
req(technical, /verticalScaleLabelText/,
  "TECHNICAL: must show a visible vertical-scale label (verticalScaleLabelText).");
for (const [name, code] of [["IMMERSIVE", immersive], ["TECHNICAL", technical]]) {
  req(code, /1\.0.{0,4}(true scale)/i,
    `${name}: the scale label must state "1.0x true scale".`);
}

// 4. Truthful terrain language: bare-earth DEM UNDER THE CENTERLINE, never pavement grade.
for (const [name, code] of [["IMMERSIVE", immersive], ["TECHNICAL", technical]]) {
  req(code, /not the road pavement grade|not pavement grade/i,
    `${name}: must state the drawn ground is NOT the road pavement grade.`);
  req(code, /bare-earth/i,
    `${name}: must describe the surface as the bare-earth terrain/DEM.`);
}

// 5. No fabricated roadway facts asserted as measured on the immersive scene: pavement edges
//    and physical median width must remain declared UNAVAILABLE (never drawn as fact).
req(immersive, /Pavement edges and physical median width are unavailable/,
  "IMMERSIVE: must keep the pavement-edge / median-width UNAVAILABLE disclosure.");

if (errors.length > 0) {
  console.error("Cross-section true-scale source-contract FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Cross-section true-scale source-contract OK — 1.0x default, display-only exaggeration, visible scale label, bare-earth-not-pavement provenance.");
