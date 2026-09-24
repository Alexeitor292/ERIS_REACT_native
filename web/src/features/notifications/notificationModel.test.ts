import assert from "node:assert/strict";
import test from "node:test";

import { badgeText, internalLink, whenLabel } from "./notificationModel.ts";

test("the badge is quiet at zero and caps at 9+", () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(-1), null);
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(12), "9+");
});

test("times read the way people say them", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.equal(whenLabel("2026-09-30T11:59:40Z", now), "just now");
  assert.equal(whenLabel("2026-09-30T11:55:00Z", now), "5 min ago");
  assert.equal(whenLabel("2026-09-30T09:00:00Z", now), "3 h ago");
  assert.equal(whenLabel("2026-09-29T09:00:00Z", now), "yesterday");
  assert.equal(whenLabel(null, now), "");
});

test("only the app's own paths are followed", () => {
  assert.equal(internalLink("/my-work"), "/my-work");
  assert.equal(internalLink("https://example.com"), null);
  assert.equal(internalLink("//example.com"), null);
  assert.equal(internalLink(null), null);
});
