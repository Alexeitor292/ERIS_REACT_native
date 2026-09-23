import assert from "node:assert/strict";
import test from "node:test";

import {
  dispositionLabel,
  dispositionMeaning,
  incidentNumberLabel,
  isAwaitingTriage,
  isClosedAtTriage,
  isWaitingOnReporter,
  recordStanding,
  revisionRequest,
  workflowPositionLabel,
  workflowPositionTone,
  type DetailIncident,
} from "./incidentDetailModel.ts";

function incident(overrides: Partial<DetailIncident> = {}): DetailIncident {
  return { current_stage: "COORDINATOR_REVIEW", status: "NEW", incident_key: null, location_match_status: null, location_match_metadata: null, triage_disposition: null, ...overrides };
}

test("every stage reads as words, never as a code", () => {
  const stages = ["COORDINATOR_REVIEW", "OFFICE_CHIEF_REVIEW", "BRANCH_CHIEF_REVIEW", "ENGINEER_ASSIGNED", "RESOLVED"];
  for (const stage of stages) {
    const label = workflowPositionLabel(incident({ current_stage: stage, status: stage === "RESOLVED" ? "RESOLVED" : "IN_PROGRESS" }));
    assert.doesNotMatch(label, /_/, `${stage} leaked a code: ${label}`);
    assert.ok(label.length > 3);
  }
});

test("a report sent back to the reporter says so instead of reading as new", () => {
  const waiting = incident({ location_match_status: "NEEDS_REVISION" });
  assert.equal(workflowPositionLabel(waiting), "Waiting on the reporter");
  assert.equal(workflowPositionTone(waiting), "attention");
  assert.equal(isWaitingOnReporter(waiting), true);
  assert.equal(isAwaitingTriage(waiting), false, "the coordinator cannot triage what is back with the reporter");
});

test("triage is offered only for a fresh report awaiting the coordinator", () => {
  assert.equal(isAwaitingTriage(incident()), true);
  assert.equal(isAwaitingTriage(incident({ incident_key: "24-0417" })), false);
  assert.equal(isAwaitingTriage(incident({ current_stage: "OFFICE_CHIEF_REVIEW", status: "IN_PROGRESS" })), false);
  assert.equal(isAwaitingTriage(incident({ status: "RESOLVED", current_stage: "RESOLVED" })), false);
});

test("a closed report names why it was closed", () => {
  assert.equal(
    workflowPositionLabel(incident({ status: "RESOLVED", current_stage: "RESOLVED", triage_disposition: "NO_ASSESSMENT_REQUIRED" })),
    "Closed at triage — no assessment needed",
  );
  assert.equal(
    workflowPositionLabel(incident({ status: "RESOLVED", current_stage: "RESOLVED", triage_disposition: "DUPLICATE_OR_LINKED" })),
    "Closed at triage — duplicate",
  );
  assert.equal(workflowPositionTone(incident({ status: "RESOLVED", current_stage: "RESOLVED" })), "done");
});

test("dispositions have a label and a meaning, and an undecided report says so", () => {
  for (const code of ["ASSESSMENT_REQUIRED", "NO_ASSESSMENT_REQUIRED", "NEEDS_REPORTER_INFORMATION", "DUPLICATE_OR_LINKED"]) {
    assert.doesNotMatch(dispositionLabel(code), /_/);
    assert.ok(dispositionMeaning(code));
  }
  assert.equal(dispositionLabel(null), "Not decided yet");
  assert.equal(dispositionMeaning(null), null);
  assert.equal(dispositionLabel("SOMETHING_NEW"), "Something New");
});

test("the fields the coordinator asked for come back as words with the comment", () => {
  const request = revisionRequest(incident({
    location_match_status: "NEEDS_REVISION",
    location_match_metadata: { revision_fields: ["post_mile", "route", "first_observed_at"], comment: "Marker was damaged." },
  }));
  assert.deepEqual(request, { fields: ["Post mile", "Route", "When it was first seen"], comment: "Marker was damaged." });
});

test("there is no revision request unless the report is actually waiting on the reporter", () => {
  assert.equal(revisionRequest(incident({ location_match_metadata: { revision_fields: ["route"] } })), null);
  assert.deepEqual(
    revisionRequest(incident({ location_match_status: "NEEDS_REVISION", location_match_metadata: null })),
    { fields: [], comment: null },
  );
});

test("the report's number is its ERIS number once accepted, and says it has none before", () => {
  assert.equal(incidentNumberLabel(incident({ incident_key: "24-0417", current_stage: "OFFICE_CHIEF_REVIEW", status: "IN_PROGRESS", triage_disposition: "ASSESSMENT_REQUIRED" }), 9), "ERIS no. 24-0417");
  assert.match(incidentNumberLabel(incident(), 9), /^Field report #9 — not yet accepted/);
});

test("only a report sent for assessment is in the incident record", () => {
  const accepted = incident({ incident_key: "k", current_stage: "ENGINEER_ASSIGNED", status: "IN_PROGRESS", triage_disposition: "ASSESSMENT_REQUIRED" });
  const finished = incident({ incident_key: "k", current_stage: "RESOLVED", status: "RESOLVED", triage_disposition: "ASSESSMENT_REQUIRED" });
  const noAssessment = incident({ current_stage: "RESOLVED", status: "RESOLVED", triage_disposition: "NO_ASSESSMENT_REQUIRED" });
  const duplicate = incident({ current_stage: "RESOLVED", status: "RESOLVED", triage_disposition: "DUPLICATE_OR_LINKED" });
  const waiting = incident({ location_match_status: "NEEDS_REVISION", triage_disposition: "NEEDS_REPORTER_INFORMATION" });

  assert.equal(recordStanding(accepted), "RECORD");
  assert.equal(recordStanding(finished), "RECORD", "a finished assessment stays in the record");
  assert.equal(recordStanding(noAssessment), "CLOSED_AT_TRIAGE");
  assert.equal(recordStanding(duplicate), "CLOSED_AT_TRIAGE");
  assert.equal(recordStanding(waiting), "FIELD_REPORT", "waiting on the reporter is temporary, not in the record");
  assert.equal(recordStanding(incident()), "FIELD_REPORT");
  assert.equal(isClosedAtTriage(waiting), false);
});

test("a report closed before this rule keeps its stored number out of sight", () => {
  const legacy = incident({ incident_key: "4f63-legacy", current_stage: "RESOLVED", status: "RESOLVED", triage_disposition: "NO_ASSESSMENT_REQUIRED" });
  assert.equal(incidentNumberLabel(legacy, 12), "Field report #12 — closed at triage, not entered into ERIS");
  assert.doesNotMatch(incidentNumberLabel(legacy, 12), /4f63/);
});
