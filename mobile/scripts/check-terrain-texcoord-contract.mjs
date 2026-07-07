#!/usr/bin/env node
// Static source-contract regression guard for the SceneKit terrain texcoord buffer
// in ErisTerrainSceneViewController.m.
//
// Bug it prevents: storing UVs in a `CGPoint *uvs` array (two CGFloat/double, 16
// bytes on 64-bit iOS) while the SCNGeometrySource declares floatComponents:YES /
// bytesPerComponent:sizeof(float) / dataStride:sizeof(CGPoint). SceneKit then reads
// partial double bytes as float UVs -> corrupt sampling -> diagonal stripe artifact
// (most visible with the aerial imagery in Hybrid mode).
//
// Contract enforced (against comment-stripped code):
//   * NO `CGPoint *uvs` and NO `sizeof(CGPoint)` anywhere in the source.
//   * a packed two-float texcoord struct `ErisTerrainTexCoord { float u; float v; }`.
//   * the texcoord source uses floatComponents:YES and sizeof(ErisTerrainTexCoord)
//     for its data length + stride.
//
// Fast, deterministic, no macOS needed. The macOS CI ios-native job is the full
// compile validation.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "plugins", "arcgis-ios", "ErisTerrainSceneViewController.m");

// Strip block + line comments (CRLF-normalized so `.` matches before \r) so
// documentation that MENTIONS CGPoint doesn't trip the guard — only real code.
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

// --- forbidden (the bug) ---
if (/\bCGPoint\s*\*\s*uvs\b/.test(code)) {
  errors.push("texcoords must NOT be stored in a `CGPoint *uvs` array (CGPoint is two doubles on 64-bit).");
}
if (/sizeof\(\s*CGPoint\s*\)/.test(code)) {
  errors.push("texcoord data length/stride must NOT use `sizeof(CGPoint)` — use a packed two-float struct.");
}

// --- required (the fix) ---
if (!/typedef\s+struct\s*\{[^}]*\bfloat\s+u\s*;[^}]*\bfloat\s+v\s*;[^}]*\}\s*ErisTerrainTexCoord\s*;/.test(code)) {
  errors.push("missing packed two-float texcoord struct `typedef struct { float u; float v; } ErisTerrainTexCoord;`.");
}
if (!/floatComponents:YES/.test(code)) {
  errors.push("texcoord source must declare `floatComponents:YES`.");
}
if (!/sizeof\(\s*ErisTerrainTexCoord\s*\)/.test(code)) {
  errors.push("texcoord source must use `sizeof(ErisTerrainTexCoord)` for its data length + stride.");
}

if (errors.length > 0) {
  console.error("Terrain texcoord source-contract FAILED (ErisTerrainSceneViewController.m):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Terrain texcoord source-contract OK — packed float32 UVs, no CGPoint stride.");
