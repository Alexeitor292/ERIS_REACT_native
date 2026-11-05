import assert from "node:assert/strict";
import test from "node:test";
import { currentPageLabel, documentTitle, prefersReducedMotion } from "./shellModel.ts";

test("the tab title names the page first, then ERIS", () => {
  assert.equal(documentTitle("Incidents"), "Incidents · ERIS");
  assert.equal(documentTitle("  My Work "), "My Work · ERIS");
  assert.equal(documentTitle(""), "ERIS");
  assert.equal(documentTitle(undefined), "ERIS");
  assert.equal(documentTitle("ERIS"), "ERIS");
});

test("reduced motion follows the system setting and never throws", () => {
  const media = (matches: boolean) => ({ matchMedia: () => ({ matches }) as MediaQueryList });
  assert.equal(prefersReducedMotion(media(true)), true);
  assert.equal(prefersReducedMotion(media(false)), false);
  assert.equal(prefersReducedMotion(null), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error("no"); } }), false);
});

test("the phone menu button names the page you are on", () => {
  const pages = [
    { to: "/incidents", label: "Incidents" },
    { to: "/incident-groups", label: "Incident Groups" },
    { to: "/assessments", label: "Assessments", alsoActive: ["/submissions"] },
    { to: "/my-work", label: "My Work" },
  ];
  assert.equal(currentPageLabel(pages, "/incidents"), "Incidents");
  assert.equal(currentPageLabel(pages, "/incidents/42"), "Incidents");
  assert.equal(currentPageLabel(pages, "/incident-groups/4"), "Incident Groups");
  assert.equal(currentPageLabel(pages, "/submissions/7"), "Assessments");
  assert.equal(currentPageLabel(pages, "/settings"), "Menu");
  assert.equal(currentPageLabel(pages, "/my-workspace"), "Menu");
});
