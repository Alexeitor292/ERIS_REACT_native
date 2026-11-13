import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const { chromium } = await import(process.env.ERIS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ERIS_PLAYWRIGHT_MODULE).href : "playwright");
const base = process.env.ERIS_DEMO_URL || "https://eris.camposlabs.org";
const output = process.env.ERIS_DEMO_SCREENSHOTS;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, storageState: process.env.ERIS_DEMO_AUTH_STATE });
const tiles = [], liveRequests = [], errors = [];
const isTile = (url) => /\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png/.test(url);
page.on("response", (response) => {
  if (isTile(response.url())) tiles.push(response);
});
page.on("request", (request) => {
  if (/^\/(api|auth)\/|\/__mock_api__\//.test(new URL(request.url()).pathname)) liveRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(error.message));
try {
  const document = await page.goto(`${base}/demo/`);
  await page.getByRole("button", { name: "Start guided web demo", exact: true }).click();
  const firstTile = page.waitForResponse((response) => isTile(response.url()), { timeout: 30000 });
  await page.getByRole("button", { name: "Report an incident", exact: true }).click();
  await (await firstTile).finished();
  // Allow the initial viewport to paint; never pan, zoom, prefetch or bypass tile caches.
  await page.waitForTimeout(1500);
  const results = await Promise.all(tiles.map(async (response) => ({
    status: response.status(), referer: (await response.request().allHeaders()).referer ?? null,
    contentType: response.headers()["content-type"],
  })));
  console.log(JSON.stringify({ referrerPolicy: document.headers()["referrer-policy"], tiles: results }, null, 2));
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "incident-map.png"), fullPage: false });
  }
  if (!process.env.ERIS_MAP_DIAGNOSE) {
    assert.equal(document.headers()["referrer-policy"], "strict-origin-when-cross-origin");
    assert.ok(results.length > 0, "The visible map must load tiles");
    assert.ok(results.every((tile) => tile.status === 200), "No map tile may be blocked");
    assert.ok(results.every((tile) => tile.referer === `${new URL(base).origin}/`), "Map requests must identify this website without exposing its path");
    assert.deepEqual(liveRequests, []);
    assert.deepEqual(errors, []);
    console.log("PASS: map tiles render with origin-only identification and no live ERIS API requests.");
  }
} finally { await browser.close(); }
