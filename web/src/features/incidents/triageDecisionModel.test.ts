import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateDistanceLabel,
  confirmLabel,
  duplicateCandidates,
  needsEventGroup,
  newTriageDraft,
  TRIAGE_OPTIONS,
  triageBlocker,
  triageOutcomeMessage,
  triageRequestBody,
  type TriageDraft,
} from "./triageDecisionModel.ts";

function draft(overrides: Partial<TriageDraft> = {}): TriageDraft {
  return { ...newTriageDraft(42), ...overrides };
}

test("a new draft has nothing chosen and cannot be recorded", () => {
  const fresh = newTriageDraft(42);
  assert.equal(fresh.disposition, null);
  assert.equal(triageBlocker(fresh), "Choose what happens to this report.");
  assert.equal(triageRequestBody(fresh), null);
});

test("only an assessment asks for an Event Group", () => {
  assert.equal(needsEventGroup("ASSESSMENT_REQUIRED"), true);
  for (const option of TRIAGE_OPTIONS.filter((o) => o.value !== "ASSESSMENT_REQUIRED")) {
    assert.equal(needsEventGroup(option.value), false, option.value);
  }
  assert.equal(needsEventGroup(null), false);
});

test("an assessment waits for its Event Group, then sends it with the decision", () => {
  const pending = draft({ disposition: "ASSESSMENT_REQUIRED" });
  assert.equal(triageBlocker(pending), "Choose its Event Group, or start a new one.");

  assert.deepEqual(
    triageRequestBody({ ...pending, eventGroup: { mode: "EXISTING", eventGroupId: 7 }, notes: "  Slope failing.  " }),
    { disposition: "ASSESSMENT_REQUIRED", notes: "Slope failing.", event_group: { mode: "EXISTING", event_group_id: 7 } },
  );
  assert.deepEqual(
    triageRequestBody({ ...pending, eventGroup: { mode: "CREATE_NEW", title: " Slide at PM 84 ", description: "" } }),
    { disposition: "ASSESSMENT_REQUIRED", event_group: { mode: "CREATE_NEW", title: "Slide at PM 84" } },
  );
});

test("a group chosen before switching to another decision is never sent", () => {
  const switched = draft({ disposition: "NO_ASSESSMENT_REQUIRED", eventGroup: { mode: "EXISTING", eventGroupId: 7 } });
  assert.equal(triageBlocker(switched), null);
  assert.deepEqual(triageRequestBody(switched), { disposition: "NO_ASSESSMENT_REQUIRED" });
});

test("sending a report back needs something for the reporter to fix", () => {
  const empty = draft({ disposition: "NEEDS_REPORTER_INFORMATION" });
  assert.equal(triageBlocker(empty), "Say what the reporter should correct.");
  assert.equal(triageBlocker({ ...empty, notes: "The post mile marker is wrong." }), null);
  assert.deepEqual(
    triageRequestBody({ ...empty, revisionFields: ["post_mile", "route"] }),
    { disposition: "NEEDS_REPORTER_INFORMATION", revision_fields: ["post_mile", "route"] },
  );
});

test("a duplicate names the report it repeats", () => {
  const unnamed = draft({ disposition: "DUPLICATE_OR_LINKED" });
  assert.equal(triageBlocker(unnamed), "Choose the report it repeats.");
  assert.deepEqual(triageRequestBody({ ...unnamed, duplicateOfIncidentId: 9 }), { disposition: "DUPLICATE_OR_LINKED", target_incident_id: 9 });
});

test("the confirm button and the outcome say what happened", () => {
  assert.equal(confirmLabel(null), "Record decision");
  assert.equal(confirmLabel("ASSESSMENT_REQUIRED"), "Accept and open assessment");
  assert.match(triageOutcomeMessage(draft({ disposition: "ASSESSMENT_REQUIRED" }), { assessment: { id: 5 } }), /Assessment #5 is open/);
  assert.equal(
    triageOutcomeMessage(draft({ disposition: "DUPLICATE_OR_LINKED", duplicateOfIncidentId: 9 }), {}),
    "Report #42 closed as a duplicate of report #9.",
  );
});

test("duplicate candidates are other nearby reports, nearest first", () => {
  const pin = { id: 42, latitude: 40.6, longitude: -124.1 };
  const reports = [
    { id: 42, title: "Itself", latitude: 40.6, longitude: -124.1, status: "NEW", created_at: null },
    { id: 10, title: "About 1.1 km north", latitude: 40.61, longitude: -124.1, status: "NEW", created_at: null },
    { id: 11, title: "About 110 m north", latitude: 40.601, longitude: -124.1, status: "IN_PROGRESS", created_at: null },
    { id: 12, title: "Far away", latitude: 38.0, longitude: -122.5, status: "NEW", created_at: null },
  ];
  const candidates = duplicateCandidates(pin, reports);
  assert.deepEqual(candidates.map((c) => c.id), [11, 10]);
  assert.ok(candidates[0].distanceM > 100 && candidates[0].distanceM < 120);
  assert.equal(duplicateCandidates(pin, reports, { limit: 1 }).length, 1);
});

test("a candidate's distance reads as words", () => {
  assert.equal(candidateDistanceLabel(0), "At the same spot");
  assert.equal(candidateDistanceLabel(112.4), "112 m away");
  assert.equal(candidateDistanceLabel(3218.7), "2.0 mi away");
});
