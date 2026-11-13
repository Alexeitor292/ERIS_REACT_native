import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.env.ERIS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ERIS_PLAYWRIGHT_MODULE).href : "playwright");
const base = process.env.ERIS_DEMO_URL || "https://eris.camposlabs.org";
const browser = await chromium.launch({ headless: true });
const anonymous = await browser.newContext();
const entry = (await readFile(new URL("../dist-demo/index.html", import.meta.url), "utf8")).match(/src="(\/demo\/assets\/[^\"]+\.js)"/)[1];
try {
  for (const url of ["/demo", "/demo/", "/demo/world/incidents", "/demo/healthz", entry]) {
    const response = await anonymous.request.get(base + url, { maxRedirects: 0 });
    assert.equal(response.status(), 303, `Anonymous access refused: ${url}`);
    assert.equal(response.headers().location, "/login?demo=1");
  }
  const spoof = await anonymous.request.get(base + entry, { maxRedirects: 0, headers: { Cookie: "__Host-eris_session=invalid", "X-Forwarded-User": "admin", "X-ERIS-Demo-Authorized": "1" } });
  assert.equal(spoof.status(), 303);
  const login = await anonymous.newPage(); await login.goto(base + "/login?demo=1");
  await login.getByText("For authorized ERIS users. Sign-in required; all demo records are fictional.", { exact: true }).waitFor();
  console.log("PASS: anonymous pages, deep links, assets, health and spoofed identity headers cannot open the demo.");
  if (process.env.ERIS_DEMO_AUTH_STATE) {
    const signedIn = await browser.newContext({ storageState: process.env.ERIS_DEMO_AUTH_STATE });
    const statuses = await Promise.all(Array.from({ length: 24 }, async () => (await signedIn.request.get(base + entry, { maxRedirects: 0 })).status()));
    assert.ok(statuses.every((status) => status === 200), `Authenticated parallel asset checks: ${statuses}`);
    const page = await signedIn.newPage();
    await page.addInitScript(() => {
      const original = window.setInterval;
      window.setInterval = (callback, delay, ...args) => { if (delay === 60000 && !window.demoAccessProbe) window.demoAccessProbe = callback; return original(callback, delay, ...args); };
    });
    await page.goto(base + "/demo/");
    await page.getByRole("button", { name: "Start guided web demo", exact: true }).click();
    await page.getByRole("button", { name: "Report an incident", exact: true }).waitFor();
    const health = await signedIn.request.get(base + "/demo/healthz", { maxRedirects: 0 });
    assert.equal(health.status(), 200); assert.equal((await health.text()).trim(), "ok");
    await signedIn.clearCookies();
    await page.evaluate(() => window.demoAccessProbe());
    await page.waitForURL("**/login?demo=1");
    await page.getByRole("heading", { name: "Sign in to ERIS", exact: true }).waitFor();
    assert.equal((await signedIn.request.get(base + entry, { maxRedirects: 0 })).status(), 303);
    await signedIn.close();
    console.log("PASS: valid ERIS sessions open the demo and assets, parallel checks succeed, and loss of the session closes an open demo.");
  }
} finally { await browser.close(); }
