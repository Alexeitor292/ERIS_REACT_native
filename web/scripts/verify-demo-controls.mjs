import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const { chromium } = await import(process.env.ERIS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ERIS_PLAYWRIGHT_MODULE).href : "playwright");
const base = process.env.ERIS_DEMO_URL || "http://127.0.0.1:5174";
const output = process.env.ERIS_DEMO_SCREENSHOTS;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, storageState: process.env.ERIS_DEMO_AUTH_STATE });
page.setDefaultTimeout(10000);
const errors = [], liveRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (new URL(request.url()).pathname.startsWith("/api/")) liveRequests.push(request.url());
});
async function waitEnabled(name) { await page.waitForFunction((label) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === label && !b.disabled), name); }
try {
  if (process.env.ERIS_VERIFY_LOGIN === "1") {
    await page.goto(`${base}/login`);
    const link = page.getByRole("link", { name: /^Guided Demo/ });
    await link.waitFor(); assert.equal(await link.getAttribute("href"), "/demo/");
    await link.click();
    liveRequests.length = 0;
  } else await page.goto(`${base}/demo/`);
  await page.getByRole("button", { name: "Start guided web demo", exact: true }).click();
  await page.getByRole("button", { name: "Report an incident", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Step 2 of 16 · Actual ERIS web pages", { exact: true }).waitFor();
  await page.getByLabel("What was seen", { exact: true }).fill("Demo test report");
  await page.locator('input[type="datetime-local"]').first().fill("2026-11-09T16:16");
  assert.equal(await page.getByRole("button", { name: "Send report", exact: true }).isDisabled(), true);
  // One click from Map must select Coordinates, fill the React inputs, and resolve the location.
  await page.getByRole("button", { name: "Fill the sample coordinates", exact: true }).click();
  await page.locator('[data-location-resolved="true"]').waitFor();
  assert.equal(await page.getByLabel("Latitude", { exact: true }).inputValue(), "38.450100");
  assert.equal(await page.getByLabel("Longitude", { exact: true }).inputValue(), "-122.900100");
  await waitEnabled("Send report"); await waitEnabled("Continue");
  assert.equal(await page.getByLabel(/^What was seen/).inputValue(), "Demo test report");
  // Editing either coordinate must invalidate the confirmed location; the helper must repair it.
  await page.getByLabel("Longitude", { exact: true }).fill("-122.8");
  assert.equal(await page.getByRole("button", { name: "Send report", exact: true }).isDisabled(), true);
  await page.getByRole("radio", { name: "Route & post mile", exact: true }).click();
  await page.getByRole("button", { name: "Fill the sample coordinates", exact: true }).click();
  await page.locator('[data-location-resolved="true"]').waitFor(); await waitEnabled("Send report");
  const guide = page.getByRole("complementary", { name: "Guided demo" });
  const before = await guide.boundingBox();
  const handle = page.getByRole("button", { name: "Move walkthrough", exact: true });
  const start = await handle.boundingBox();
  await page.mouse.move(start.x + 30, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(110, 110, { steps: 12 }); await page.mouse.up();
  const moved = await guide.boundingBox(); assert.ok(before.x - moved.x > 200 && before.y - moved.y > 100);
  await handle.focus(); await page.keyboard.press("ArrowRight");
  const keyboardMoved = await guide.boundingBox(); assert.equal(Math.round(keyboardMoved.x - moved.x), 20);
  await page.getByRole("button", { name: "Minimize guide" }).click();
  await page.getByRole("button", { name: "Expand guide" }).click();
  assert.equal(Math.round((await guide.boundingBox()).x), Math.round(keyboardMoved.x));
  // The guide remains reachable after resizing and its highlight stays inside each control.
  await page.setViewportSize({ width: 800, height: 800 });
  await page.waitForFunction(() => { const r = document.querySelector('.eris-demo-guide').getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight; });
  await page.getByRole("button", { name: "Show control", exact: true }).click();
  assert.equal(await page.locator(".eris-demo-highlight").evaluate((el) => getComputedStyle(el).outlineOffset), "-3px");
  await page.setViewportSize({ width: 1600, height: 1050 });
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, "demo-controls.png"), fullPage: false }); }
  // Sending early must not strand the guide on the now-closed form.
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.getByRole("heading", { name: "Report sent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Step 5 of 16 · Actual ERIS web pages", { exact: true }).waitFor();
  await page.getByRole("radio", { name: "Complete review and continue", exact: true }).waitFor();
  await page.getByRole("button", { name: "Exit and clear demo", exact: true }).click();
  await page.getByRole("button", { name: "Start guided web demo", exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(liveRequests, []);
  console.log("PASS: sample location from Map/Route modes, validation, report sending, early submission, pointer/keyboard dragging, minimize/resize, and inset highlights.");
} catch (error) {
  console.error({ errors, liveRequests, body: (await page.locator("body").innerText()).slice(-9000) });
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, "demo-controls-failure.png"), fullPage: false }); }
  throw error;
} finally { await browser.close(); }
