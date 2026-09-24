import assert from "node:assert/strict";
import test from "node:test";

import { badgeText, routeFor } from "./notificationRoutes.ts";

test("each notice opens the screen that does the same job here", () => {
  assert.equal(routeFor("/my-work", "INCIDENT_COORDINATOR_REVIEW"), "/(tabs)/incidents/track");
  assert.deepEqual(routeFor("/incidents/42", "ASSESSMENT_APPROVED_COORDINATOR"), { pathname: "/(tabs)/incidents/[id]", params: { id: "42" } });
  assert.equal(routeFor("/submissions/7", "SHARE_RECEIVED"), "/(tabs)/submissions/7");
  assert.equal(routeFor("/my-work?assessment=9", "ASSESSMENT_STAFF_ASSIGNMENT"), "/(tabs)/assessments");
  assert.equal(routeFor("/assessments/9", "ASSESSMENT_APPROVED_AUTHOR"), "/(tabs)/assessments");
});

test("steps done on the web stay in the list", () => {
  assert.equal(routeFor("/my-work", "SHARE_APPROVAL"), null);
  assert.equal(routeFor(null, "SHARE_ENDED"), null);
});

test("the badge is quiet at zero and caps at 9+", () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(4), "4");
  assert.equal(badgeText(40), "9+");
});
