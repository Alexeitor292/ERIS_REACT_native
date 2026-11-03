import assert from "node:assert/strict";
import { test } from "node:test";

import { actionLabel, dayLabel, formProblem, isOpen, periodLabel } from "./delegationModel.ts";

test("a date reads the same in every time zone", () => {
  assert.equal(dayLabel("2026-11-14"), "Nov 14, 2026");
  assert.equal(dayLabel("nonsense"), "nonsense");
});

test("a single day is one date, and a run says both", () => {
  assert.equal(periodLabel({ starts_on: "2026-11-14", ends_on: "2026-11-14" }), "Nov 14, 2026");
  assert.equal(periodLabel({ starts_on: "2026-11-10", ends_on: "2026-11-14" }), "Nov 10, 2026 to Nov 14, 2026");
});

test("only what has not ended can be cancelled", () => {
  assert.ok(isOpen({ status: "ACTIVE" }));
  assert.ok(isOpen({ status: "SCHEDULED" }));
  assert.ok(!isOpen({ status: "ENDED" }));
  assert.ok(!isOpen({ status: "CANCELLED" }));
});

test("the form says what is missing", () => {
  const today = "2026-11-02";
  assert.match(formProblem({ delegateId: null, startsOn: today, endsOn: today }, today) ?? "", /who/);
  assert.match(formProblem({ delegateId: 1, startsOn: "", endsOn: today }, today) ?? "", /first and last/);
  assert.match(formProblem({ delegateId: 1, startsOn: "2026-11-05", endsOn: "2026-11-04" }, today) ?? "", /before the first/);
  assert.match(formProblem({ delegateId: 1, startsOn: "2026-10-01", endsOn: "2026-10-05" }, today) ?? "", /already passed/);
  assert.equal(formProblem({ delegateId: 1, startsOn: today, endsOn: today }, today), null);
});

test("what was done under a delegation reads in words", () => {
  assert.equal(actionLabel("POST", "/assessments/5/review"), "Reviewed assessment #5");
  assert.equal(actionLabel("POST", "/assessments/5/assign-engineer"), "Changed assessment #5");
  assert.equal(actionLabel("POST", "/assessments/move"), "Moved assessments");
  assert.equal(actionLabel("POST", "/shares/3/reviews/4"), "Decided share #3");
  assert.equal(actionLabel("PATCH", "/submissions/501/gisa"), "Changed form #501");
  assert.equal(actionLabel("POST", "/notifications/read"), "POST /notifications/read");
});
