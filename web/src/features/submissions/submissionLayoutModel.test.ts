import assert from "node:assert/strict";
import test from "node:test";

import {
  autoFitColumnCount,
  buildDefaultCanvasLayout,
  CANVAS_CARD_IDS,
  cardsOverlap,
  canvasContentBounds,
  DASHBOARD_LAYOUT_V2_KEY,
  flowDashboardCards,
  normalizeCanvasLayout,
  orderFromPositions,
  readStoredCanvasLayout,
} from "./submissionLayoutModel.ts";

test("auto-fit column count follows max(1, floor((width - 12) / 532))", () => {
  assert.equal(autoFitColumnCount(0), 1);
  assert.equal(autoFitColumnCount(400), 1);
  assert.equal(autoFitColumnCount(543), 1);
  assert.equal(autoFitColumnCount(1076), 2);
  assert.equal(autoFitColumnCount(1608), 3);
  assert.equal(autoFitColumnCount(1607), 2);
});

test("the location card no longer lives on the canvas", () => {
  assert.equal(CANVAS_CARD_IDS.includes("location"), false);
  assert.equal(CANVAS_CARD_IDS[0], "report_header");
});

test("auto-flow spans the report header across two columns and never overlaps cards", () => {
  const layout = buildDefaultCanvasLayout();
  const flowed = flowDashboardCards(layout.order, layout.sizes, 1700);
  assert.equal(flowed.columns, 3);
  assert.equal(flowed.sizes.report_header.width, 1052);
  assert.deepEqual(flowed.positions.report_header, { x: 12, y: 12 });
  assert.equal(flowed.sizes.distribution.width, 520);

  const ids = layout.order;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = { ...flowed.positions[ids[i]], ...flowed.sizes[ids[i]] };
      const b = { ...flowed.positions[ids[j]], ...flowed.sizes[ids[j]] };
      assert.equal(cardsOverlap(a, b), false, `${ids[i]} overlaps ${ids[j]}`);
    }
  }
  const bounds = canvasContentBounds(ids, flowed.positions, flowed.sizes);
  assert.equal(flowed.height, bounds.height);
});

test("single column flow stacks every card full width in order", () => {
  const layout = buildDefaultCanvasLayout();
  const flowed = flowDashboardCards(layout.order, layout.sizes, 700);
  assert.equal(flowed.columns, 1);
  assert.equal(flowed.sizes.report_header.width, 520);
  let expectedY = 12;
  for (const id of layout.order) {
    assert.deepEqual(flowed.positions[id], { x: 12, y: expectedY });
    expectedY += flowed.sizes[id].height + 12;
  }
});

test("reading order is derived from positions top-to-bottom then left-to-right", () => {
  const order = orderFromPositions(["material", "distribution", "report_header"], {
    material: { x: 544, y: 300 },
    distribution: { x: 12, y: 300 },
    report_header: { x: 12, y: 12 },
  });
  assert.deepEqual(order, ["report_header", "distribution", "material"]);
});

test("stored layouts are normalized and custom mode requires complete positions", () => {
  const partial = normalizeCanvasLayout({ custom: true, positions: { report_header: { x: 1, y: 2 } } });
  assert.equal(partial.custom, false);
  assert.deepEqual(partial.positions, {});

  const positions = Object.fromEntries(CANVAS_CARD_IDS.map((id, index) => [id, { x: index * 10, y: index * 20 }]));
  const full = normalizeCanvasLayout({ custom: true, positions, sizes: { material: { width: 9999, height: 1 } }, order: ["material", "location"] });
  assert.equal(full.custom, true);
  assert.equal(full.sizes.material.width, 1600);
  assert.equal(full.sizes.material.height, 150);
  assert.equal(full.order[0], "material");
  assert.equal(full.order.includes("location" as never), false);
  assert.equal(full.order.length, CANVAS_CARD_IDS.length);
});

test("reading storage ignores malformed or legacy values", () => {
  const stored = new Map<string, string>([["eris_submission_layout_v1", "{\"custom\":true}"]]);
  const storage = { getItem: (key: string) => stored.get(key) ?? null };
  assert.equal(readStoredCanvasLayout(storage).custom, false);
  stored.set(DASHBOARD_LAYOUT_V2_KEY, "not json");
  assert.equal(readStoredCanvasLayout(storage).custom, false);
});
