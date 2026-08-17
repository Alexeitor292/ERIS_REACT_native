import assert from "node:assert/strict";
import test from "node:test";

import { filterShareCandidates, shareUserLabel } from "./submissionAccessSharingModel.ts";

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
