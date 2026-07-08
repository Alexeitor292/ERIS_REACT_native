// Locks the mobile road cross-section derivation to the shared parity fixture that
// the backend Python port (backend/app/services/road_cross_section_build.py) also
// asserts against. If this test fails after a derivation change, regenerate the
// fixture and BOTH the mobile + backend parity suites move together.
// Run: node --test src/measurements/roadCrossSectionParity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildRoadSectionFromInventory } from "./buildRoadSectionFromInventory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "__fixtures__", "roadCrossSectionParity.json"), "utf8")) as {
  name: string;
  snapshot: Record<string, unknown> | null;
  fallback: number | null;
  expected: Record<string, unknown>;
}[];

test("mobile derivation matches the shared parity fixture (kept in lockstep with backend)", () => {
  assert.ok(fixture.length >= 5, "fixture should cover multiple road types");
  for (const c of fixture) {
    // JSON-normalize (drop `undefined`-valued keys) — this is exactly how the layout
    // is serialized into the packaged road_cross_section.json, and how the backend
    // Python port emits it.
    const got = JSON.parse(JSON.stringify(buildRoadSectionFromInventory(c.snapshot, c.fallback)));
    assert.deepEqual(got, c.expected, `parity mismatch for ${c.name}`);
  }
});
