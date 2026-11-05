import assert from "node:assert/strict";
import test from "node:test";

import { buildGuides, GUIDE_GROUND, viewAfterToggle, visibleGuides, type GuideKey } from "./measurementGuides.ts";
import type { SiteMeasurement } from "../siteTerrainModel.ts";

const slope = { top: [-122, 37.001, 110] as [number, number, number], bottom: [-122, 37, 60] as [number, number, number] };
const band = { top: [-122.1, 37.001, 200] as [number, number, number], bottom: [-122.1, 37, 150] as [number, number, number] };
const measurement = (bandGuide: typeof band | null) =>
  ({
    guides: {
      slope,
      band: bandGuide,
      width: [[-122.001, 37.0005], [-121.999, 37.0005]],
      low: [-122, 37, 50],
      high: [-122, 37.001, 100],
    },
  }) as unknown as SiteMeasurement;

const TEXT = { H: "H 50 ft", A: "α 30°", W: "Wd 100 ft", L: "Ld 200 ft", B: "β 28°", S: "Hs 12 ft" };
const scarp = { heightM: 4, point: [-122, 37.0008] as [number, number], beforeM: 95, nowM: 91 };
const keys = (list: Array<{ key: GuideKey }>) => list.map((g) => g.key);

test("each value is drawn, the scarp only when a survey suggests one", () => {
  const withScarp = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  assert.deepEqual(keys(withScarp), ["H", "A", "W", "L", "B", "S"]);
  const noScarp = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: false, scarp: null, text: TEXT });
  assert.deepEqual(keys(noScarp), ["H", "A", "W", "L", "B"]);
});

test("the slope height runs straight up from the low spot to the height of the high spot", () => {
  const [h] = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  assert.deepEqual(h.lines[0].path, [[-122, 37, 50], [-122, 37, 100]]);
  assert.deepEqual(h.lines[1].path, [[-122, 37, 100], [-122, 37.001, 100]]);
});

test("an angle is drawn as a triangle: the slope, and level and plumb lines to read it against", () => {
  const guides = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  const beta = guides.find((g) => g.key === "B")!;
  assert.deepEqual(beta.lines[0].path, [slope.top, slope.bottom]);
  assert.deepEqual(beta.lines[1].path, [slope.top, [-122, 37, 110], slope.bottom]);
});

test("the original slope comes from the band around the outline only without a survey", () => {
  const alpha = (hasDrone: boolean) =>
    buildGuides({ before: measurement(band), now: measurement(band), hasDrone, scarp: null, text: TEXT }).find((g) => g.key === "A")!;
  assert.deepEqual(alpha(false).lines[0].path, [band.top, band.bottom]);
  assert.deepEqual(alpha(true).lines[0].path, [slope.top, slope.bottom]);
  const none = buildGuides({ before: measurement(null), now: measurement(null), hasDrone: false, scarp: null, text: TEXT });
  assert.ok(!none.some((g) => g.key === "A"), "too few samples around it");
});

test("length and width follow the ground; the scarp stands between the ground before and now", () => {
  const guides = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  assert.equal(guides.find((g) => g.key === "L")!.lines[0].draped, true);
  assert.equal(guides.find((g) => g.key === "W")!.lines[0].draped, true);
  assert.deepEqual(guides.find((g) => g.key === "S")!.lines[0].path, [[-122, 37.0008, 91], [-122, 37.0008, 95]]);
});

test("with a survey, a value shows only on the ground it was measured on", () => {
  const guides = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  const all = new Set<GuideKey>(["H", "A", "W", "L", "B", "S"]);
  assert.deepEqual(keys(visibleGuides(guides, all, "before", true)), ["H", "A"]);
  assert.deepEqual(keys(visibleGuides(guides, all, "now", true)), ["W", "L", "B", "S"]);
  assert.deepEqual(keys(visibleGuides(guides, new Set<GuideKey>(["L"]), "now", true)), ["L"]);
});

test("without a survey there is one ground, so everything switched on shows", () => {
  const guides = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: false, scarp: null, text: TEXT });
  assert.deepEqual(keys(visibleGuides(guides, new Set<GuideKey>(["H", "L"]), "now", false)), ["H", "L"]);
});

test("switching a value on goes to its ground; switching off stays put", () => {
  assert.equal(GUIDE_GROUND.L, "now");
  assert.equal(viewAfterToggle("L", true, "before", true), "now");
  assert.equal(viewAfterToggle("H", true, "now", true), "before");
  assert.equal(viewAfterToggle("H", false, "now", true), "now");
  assert.equal(viewAfterToggle("H", true, "now", false), "now");
});

test("labels on lines that run together do not land on the same spot", () => {
  const guides = buildGuides({ before: measurement(band), now: measurement(band), hasDrone: true, scarp, text: TEXT });
  const spots = guides.map((g) => `${g.label.at[0].toFixed(6)},${g.label.at[1].toFixed(6)}`);
  assert.equal(new Set(spots).size, spots.length);
});
