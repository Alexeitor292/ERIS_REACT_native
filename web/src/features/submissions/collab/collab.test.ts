import assert from "node:assert/strict";
import test from "node:test";

import { changedKeys, mergeFresh, rebase, sameValue } from "./formMerge.ts";
import { colorFor, fieldLabel, initialsOf, memoWriters, othersIn, presenceSentence, type PresenceOther } from "./presenceModel.ts";

test("a save sends only what this person changed", () => {
  const base = { ea: "0A1", crack_length_ft: "3", notes: "", list: ["A"] };
  assert.deepEqual(changedKeys(base, { ...base, crack_length_ft: "5", notes: null }), ["crack_length_ft"]);
  assert.ok(sameValue(undefined, ""));
  assert.ok(!sameValue(["A"], ["A", "B"]));
});

test("others' saves land where this person has not typed; both changed is theirs to decide", () => {
  const base = { ea: "0A1", crack: "3", slope: "40", memo: "<p>a</p>" };
  const mine = { ...base, crack: "7", slope: "42" };
  const fresh = { ...base, ea: "0B2", crack: "5", slope: "42" };
  const result = mergeFresh(base, mine, fresh);
  assert.deepEqual(result.theirs, ["ea"]);
  assert.deepEqual(result.conflicts, ["crack"]); // slope: both made it 42, nothing to decide
  assert.equal(result.merged.ea, "0B2");
  assert.equal(result.merged.crack, "7");
  // Caught up with what is saved, except the conflict, which still starts from before.
  assert.deepEqual(rebase(base, fresh, result.conflicts), { ...fresh, crack: "3" });
});

test("who is where, in circles with their initials", () => {
  assert.equal(initialsOf("Maria Garcia"), "MG");
  assert.equal(initialsOf("Juan Alejandro Campos"), "JC");
  assert.equal(initialsOf("maria.garcia@dot.ca.gov"), "MG");
  assert.equal(initialsOf("Kevin"), "KE");
  assert.equal(colorFor(7), colorFor(7));
  assert.notEqual(colorFor(1), colorFor(2));

  const others: PresenceOther[] = [
    { session_id: "a", user_id: 1, name: "Maria Garcia", area: "card:report-header", field: "EA", memos: [] },
    { session_id: "b", user_id: 1, name: "Maria Garcia", area: "card:report-header", field: null, memos: [] },
    { session_id: "c", user_id: 2, name: "John Lee", area: "memo:recommendations_notes", field: null, memos: ["recommendations_notes"] },
  ];
  assert.equal(othersIn(others, "card:report-header").length, 1);
  assert.equal(memoWriters(others).recommendations_notes.name, "John Lee");
  assert.equal(presenceSentence(others), "Maria Garcia and John Lee are also in this form");
  assert.equal(fieldLabel("crack_length_ft"), "Crack length (ft)");
  assert.equal(fieldLabel("est_soil_pct"), "Estimated soil (%)");
  assert.equal(fieldLabel("memo:recommendations_notes"), "Recommendations");
});
