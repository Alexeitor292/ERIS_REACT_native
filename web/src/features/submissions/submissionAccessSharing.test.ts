import assert from "node:assert/strict";
import test from "node:test";

import { filterShareCandidates, shareReviewLine, shareRouteSummary, shareUserLabel } from "./submissionAccessSharingModel.ts";

const available = [
  { id: 4, full_name: "Zoe Field", email: "zoe@example.test" },
  { id: 2, full_name: "Alex Engineer", email: "alex@example.test" },
  { id: 3, full_name: "Alex Reviewer", email: "reviewer@example.test" },
];

const shared = [
  { user_id: 3, full_name: "Alex Reviewer", email: "reviewer@example.test" },
];

test("empty sharing query does not dump the user directory", () => {
  assert.deepEqual(filterShareCandidates(available, "", shared), []);
  assert.deepEqual(filterShareCandidates(available, "   ", shared), []);
});

test("sharing search matches name or email and excludes existing grants", () => {
  assert.deepEqual(
    filterShareCandidates(available, "alex", shared).map((user) => user.id),
    [2],
  );
  assert.deepEqual(
    filterShareCandidates(available, "zoe@", shared).map((user) => user.id),
    [4],
  );
});

test("sharing search is deterministic and respects the display limit", () => {
  assert.deepEqual(
    filterShareCandidates(available, "example", [], 2).map((user) => user.id),
    [2, 3],
  );
});

test("sharing labels fall back to email when a name is blank", () => {
  assert.equal(shareUserLabel({ full_name: "", email: "person@example.test" }), "person@example.test");
});

test("what sharing would take reads as one line", () => {
  assert.equal(shareRouteSummary({ immediate: true, approvals: [], notices: [] }), "Shared at once");
  assert.equal(shareRouteSummary({ immediate: true, approvals: [], notices: ["West › Branch A"] }), "Shared at once · the chief of West › Branch A is told");
  assert.equal(
    shareRouteSummary({ immediate: false, approvals: ["West › Branch A", "North › Branch C"], notices: ["West", "North"] }),
    "Needs approval from the chiefs of West › Branch A and North › Branch C · the chiefs of West and North are told",
  );
});

test("each branch or office on a share says where it stands", () => {
  const review = { unit_label: "West › Branch A", kind: "APPROVAL", decision: "PENDING", decided_by: null };
  assert.equal(shareReviewLine(review), "West › Branch A — waiting for approval");
  assert.equal(shareReviewLine({ ...review, decision: "APPROVED", decided_by: "Maria" }), "West › Branch A — approved by Maria");
  assert.equal(shareReviewLine({ ...review, decision: "REJECTED", decided_by: "Maria" }), "West › Branch A — rejected by Maria");
  const notice = { unit_label: "West", kind: "NOTICE", decision: "PENDING", decided_by: null };
  assert.equal(shareReviewLine(notice), "West — told");
  assert.equal(shareReviewLine({ ...notice, decision: "ACKNOWLEDGED", decided_by: "John" }), "West — told, seen by John");
  assert.equal(shareReviewLine({ ...notice, decision: "REJECTED", decided_by: "John" }), "West — stopped by John");
});
