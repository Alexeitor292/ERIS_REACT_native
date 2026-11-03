import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkGroup } from "../../api/assessments";
import { groupKey, holderLine, moveOutcome, pickerLabel, withoutHolder } from "./moveWorkModel.ts";

const group = (over: Partial<WorkGroup> = {}): WorkGroup => ({
  kind: "STAFF",
  holder: { id: 4, full_name: "Lee Left", placement: null },
  left: true,
  items: [],
  ...over,
});

test("who holds the work, and whether they moved on", () => {
  assert.equal(holderLine(group()), "Lee Left · Staff · has moved on");
  assert.equal(holderLine(group({ left: false, kind: "BRANCH_CHIEF" })), "Lee Left · Branch chief");
  assert.equal(holderLine(group({ holder: { id: null, full_name: null, placement: null } })), "Nobody · Staff · has moved on");
});

test("the same person under two kinds of work stays two groups", () => {
  assert.notEqual(groupKey(group({ kind: "STAFF" })), groupKey(group({ kind: "SENIOR_SPECIALIST" })));
  assert.equal(groupKey(group({ holder: { id: null, full_name: null, placement: null } })), "STAFF:none");
});

test("work cannot move to the person it is moving from", () => {
  assert.deepEqual(withoutHolder([{ id: 4 }, { id: 5 }], 4), [{ id: 5 }]);
  assert.deepEqual(withoutHolder([{ id: 4 }], null), [{ id: 4 }]);
});

test("the picker asks for the right person", () => {
  assert.equal(pickerLabel("BRANCH_CHIEF"), "New branch chief");
  assert.equal(pickerLabel("STAFF"), "New Staff member");
  assert.equal(pickerLabel("SENIOR_SPECIALIST"), "New Senior Specialist");
});

test("the outcome says what moved and why anything did not", () => {
  assert.equal(moveOutcome({ moved: [1], failed: [] }, "Sam"), "Moved 1 assessment to Sam. Their work stayed with them.");
  assert.equal(moveOutcome({ moved: [1, 2], failed: [] }, "Sam"), "Moved 2 assessments to Sam. Their work stayed with them.");
  assert.equal(
    moveOutcome({ moved: [], failed: [{ id: 3, detail: "This Staff member is in another branch." }] }, "Sam"),
    "Nothing moved. Not moved: #3 (This Staff member is in another branch.)",
  );
});
