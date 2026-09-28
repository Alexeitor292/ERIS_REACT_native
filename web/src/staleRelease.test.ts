import { test } from "node:test";
import assert from "node:assert/strict";

import { isStaleReleaseError, reloadForNewRelease } from "./staleRelease.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

let reloads = 0;
(globalThis as { window?: unknown }).window = { location: { reload: () => { reloads += 1; } } };

test("a missing file of the running release is recognised in each browser's words", () => {
  assert.ok(isStaleReleaseError(new TypeError("Failed to fetch dynamically imported module: https://eris.example/assets/Page-a1b2.js")));
  assert.ok(isStaleReleaseError(new TypeError("error loading dynamically imported module: https://eris.example/assets/Page-a1b2.js")));
  assert.ok(isStaleReleaseError(new TypeError("Importing a module script failed.")));
  assert.ok(isStaleReleaseError(new Error("Unable to preload CSS for /assets/Page-a1b2.css")));
  assert.ok(!isStaleReleaseError(new TypeError("Cannot read properties of undefined (reading 'roles')")));
  assert.ok(!isStaleReleaseError(null));
});

test("the page reloads once, not again within 30 seconds", () => {
  reloads = 0;
  const storage = memoryStorage();
  assert.equal(reloadForNewRelease(1_000_000, storage), true);
  assert.equal(reloadForNewRelease(1_010_000, storage), false);
  assert.equal(reloads, 1);
  assert.equal(reloadForNewRelease(1_031_000, storage), true);
  assert.equal(reloads, 2);
});

test("without session storage it never reloads, so it cannot loop", () => {
  reloads = 0;
  assert.equal(reloadForNewRelease(1_000_000, null), false);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
  assert.equal(reloadForNewRelease(1_000_000, broken), false);
  assert.equal(reloads, 0);
});
