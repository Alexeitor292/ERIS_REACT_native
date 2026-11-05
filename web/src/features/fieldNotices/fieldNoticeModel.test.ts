import assert from "node:assert/strict";
import { test } from "node:test";

import { contactMissing, deliveryOutcome, deliveryProblem } from "./fieldNoticeModel.ts";

test("a delivery needs actions and a description", () => {
  assert.match(deliveryProblem([], "Rocks") ?? "", /immediate actions/);
  assert.match(deliveryProblem(["A"], "  ") ?? "", /what happened/);
  assert.equal(deliveryProblem(["A"], "Rocks"), null);
});

test("it says who heard", () => {
  assert.equal(deliveryOutcome({ supervisor_told: true, contact_told: true }), "Delivered to the supervisor and the District Contact.");
  assert.equal(deliveryOutcome({ supervisor_told: true, contact_told: false }), "Delivered to the supervisor.");
  assert.match(deliveryOutcome({}), /no supervisor or District Contact/);
});

test("a contact is needed only when someone could be named", () => {
  assert.equal(contactMissing([{ id: 1 }], null), true);
  assert.equal(contactMissing([{ id: 1 }], 1), false);
  assert.equal(contactMissing([], null), false);
  assert.equal(contactMissing(undefined, null), false);
});
