import assert from "node:assert/strict";
import test from "node:test";

import { badgeText, doneText, internalLink, whenLabel } from "./notificationModel.ts";

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

test("a step somebody took says who did what, and when", () => {
  const now = new Date("2026-09-28T17:30:00");
  const at = "2026-09-28T17:25:00";
  assert.equal(doneText({ at, by: "John", by_you: true, action: "OFFICE_DELEGATED" }, now), "You handed it to a branch chief · 5 min ago");
  assert.equal(doneText({ at, by: "Maria", by_you: false, action: "ENGINEER_ASSIGNED" }, now), "Maria assigned a Staff member · 5 min ago");
  assert.equal(doneText({ at, by: "Martin", by_you: false, action: "NO_ASSESSMENT_REQUIRED" }, now), "Martin closed it: no assessment needed · 5 min ago");
  assert.equal(doneText({ at: null, by: null, by_you: false, action: "SOMETHING_NEW" }, now), "Someone took this step");
  assert.equal(doneText({ at: null, by: null, by_you: false, action: null }, now), "Already handled");
});
