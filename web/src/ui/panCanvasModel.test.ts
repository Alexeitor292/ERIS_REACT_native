import assert from "node:assert/strict";
import test from "node:test";

import { clampView, fitView, MAX_SCALE, MIN_SCALE, openingView, zoomAt } from "./panCanvasModel.ts";

const viewport = { width: 1000, height: 600 };
const wide = { width: 3000, height: 900 };

test("a wide tree opens at actual size, centred, from the top", () => {
  assert.deepEqual(openingView(viewport, wide), { scale: 1, x: -1000, y: 16 });
});

test("a small tree opens in the middle", () => {
  assert.deepEqual(openingView(viewport, { width: 400, height: 200 }), { scale: 1, x: 300, y: 200 });
});

test("it cannot be dragged away and lost", () => {
  assert.equal(clampView({ x: 5000, y: 0, scale: 1 }, viewport, wide).x, 920, "off to the right");
  assert.equal(clampView({ x: -5000, y: 0, scale: 1 }, viewport, wide).x, -2920, "off to the left");
  assert.equal(clampView({ x: 0, y: 5000, scale: 1 }, viewport, wide).y, 520, "off the bottom");
  assert.equal(clampView({ x: 0, y: -5000, scale: 1 }, viewport, wide).y, -820, "off the top");
  assert.deepEqual(clampView({ x: -500, y: 10, scale: 1 }, viewport, wide), { x: -500, y: 10, scale: 1 }, "in view stays put");
});

test("how far it can go follows the zoom", () => {
  assert.equal(clampView({ x: -5000, y: 0, scale: 0.5 }, viewport, wide).x, 80 - 1500);
});

test("fit shows everything and never enlarges", () => {
  const fitted = fitView(viewport, wide);
  assert.ok(wide.width * fitted.scale <= viewport.width);
  assert.ok(wide.height * fitted.scale <= viewport.height);
  assert.equal(fitted.x, (viewport.width - wide.width * fitted.scale) / 2);
  assert.equal(fitView(viewport, { width: 200, height: 100 }).scale, 1);
  assert.equal(fitView(viewport, { width: 90000, height: 100 }).scale, MIN_SCALE, "goes no smaller");
  assert.deepEqual(fitView(viewport, { width: 0, height: 0 }), { x: 0, y: 0, scale: 1 });
});

test("zooming keeps the spot under the pointer in place", () => {
  const view = { x: -100, y: 50, scale: 1 };
  const point = { x: 400, y: 300 };
  const next = zoomAt(view, 1.25, point);
  const before = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
  assert.ok(Math.abs((point.x - next.x) / next.scale - before.x) < 1e-9);
  assert.ok(Math.abs((point.y - next.y) / next.scale - before.y) < 1e-9);
});

test("zoom has limits", () => {
  const point = { x: 0, y: 0 };
  assert.equal(zoomAt({ x: 0, y: 0, scale: 1 }, 100, point).scale, MAX_SCALE);
  assert.equal(zoomAt({ x: 0, y: 0, scale: 1 }, 0.01, point).scale, MIN_SCALE);
});
