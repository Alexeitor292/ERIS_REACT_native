#!/usr/bin/env node
// Regression guard: prevent reintroducing ArcGIS Runtime API that does NOT exist
// in the pinned SDK (100.15.6) and broke the iOS EAS build.
//
// In 100.15 the immutable multipart geometries are constructed with the geometry
// BUILDER classes (AGSPolylineBuilder / AGSPolygonBuilder, base AGSMultipartBuilder:
// -initWithSpatialReference:, -addPointWithX:y:, -addPoint:, -toGeometry). These
// selectors do NOT exist and must never come back in tracked native source:
//   * AGSPointCollection / AGSMutablePointCollection (read-only; used to build here)
//   * -initWithPoints:  on AGSPolyline / AGSPolygon
//
// This runs on every push (fast, no macOS) so the exact EAS failure cannot recur;
// the macos iOS-native compile job is the full validation.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(HERE, "..", "plugins", "arcgis-ios");

// Forbidden tokens (checked against comment-stripped code only).
const FORBIDDEN = [
  { re: /\bAGSPointCollection\b/, why: "AGSPointCollection is read-only in 100.15; build with AGSPolyline/PolygonBuilder" },
  { re: /\bAGSMutablePointCollection\b/, why: "use AGSPolylineBuilder/AGSPolygonBuilder (addPointWithX:y:) to build geometries" },
  { re: /\binitWithPoints:/, why: "AGSPolyline/AGSPolygon have no -initWithPoints: in 100.15; use a builder + -toGeometry" },
];

/** Remove // line comments and block comments so documentation mentioning these
 *  names doesn't trip the guard — only real code is checked. */
function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n") // normalize CRLF (else `.` won't match before \r)
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "")) // line comments
    .join("\n");
}

function objcFiles(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(objcFiles(p));
    else if (name.endsWith(".m") || name.endsWith(".h")) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of objcFiles(NATIVE_DIR)) {
  const stripped = stripComments(readFileSync(file, "utf8"));
  stripped.split("\n").forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) violations.push({ file, line: i + 1, text: line.trim(), why });
    }
  });
}

if (violations.length > 0) {
  console.error("ArcGIS native selector guard FAILED — unsupported 100.15 API in native source:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}\n    -> ${v.why}`);
  }
  process.exit(1);
}
console.log("ArcGIS native selector guard OK — no unsupported 100.15 geometry API in native source.");
