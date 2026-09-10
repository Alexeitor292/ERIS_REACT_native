import assert from "node:assert/strict";
import test from "node:test";

import {
  BRANCH_PIPELINE,
  SPECIALIST_PIPELINE,
  UNROUTED_PIPELINE,
  assessmentPermissions,
  assessmentSearchMatch,
  assessmentStateLabel,
  assessmentStateLabelFor,
  assessmentTone,
  isActionable,
  latestSubmissionId,
  pipelineFor,
  pipelineIndex,
  submissionIdsOf,
  waitingOn,
} from "./assessmentModel.ts";

const ALL_STATES = [
  "PENDING_OFFICE_DELEGATION",
  "PENDING_ENGINEER_ASSIGNMENT",
  "DRAFT",
  "SUBMITTED",
  "REVISION_REQUESTED",
  "APPROVED",
  "FINALIZED",
] as const;

const baseAssessment = {
  id: 512,
  assessment_uuid: "as-512",
  incident_id: 1039,
  submission_id: 213,
  submission_ids: [213, 215],
  district: "03",
  office_code: "NORTH",
  office_override_reason: null,
  routing_path: "BRANCH" as const,
  branch_chief_user_id: 8,
  assigned_engineer_user_id: 5,
  assigned_user_id: 5,
  assigned_user_kind: "ENGINEER" as const,
  can_review: false,
  review_owner: { kind: "BRANCH_CHIEF" as const, user_id: 8, office_code: "NORTH" },
  state: "SUBMITTED" as const,
  triage_disposition: "ASSESSMENT_REQUIRED" as const,
  notes: null,
  created_by_user_id: 7,
  office_delegated_at: null,
  engineer_assigned_at: null,
  submitted_at: null,
  review_requested_at: null,
  approved_at: null,
  finalized_at: null,
  created_at: "2026-08-01T08:00:00",
  updated_at: "2026-08-30T16:50:00",
};

const specialistAssessment = {
  ...baseAssessment,
  routing_path: "SENIOR_SPECIALIST" as const,
  branch_chief_user_id: null,
  assigned_user_kind: "SENIOR_SPECIALIST" as const,
  review_owner: { kind: "OFFICE_CHIEF" as const, user_id: null, office_code: "NORTH" },
};

/** A retired reviewer row: history in v2, and it must grant nothing. */
const historicalReviewer = {
  id: 2,
  user_id: 7,
  assignment_role: "REVIEWER" as const,
  assigned_by_user_id: 9,
  notes: null,
  email: "l.novak@dot.ca.gov",
  full_name: "L. Novak",
  is_authority: false,
  created_at: "2026-08-20T09:00:00",
};

const noRoles = { admin: false, officeChief: false, branchChief: false, engineer: false, seniorSpecialist: false };

test("each route has its own ladder and an unrouted assessment has one step", () => {
  assert.equal(pipelineFor(baseAssessment), BRANCH_PIPELINE);
  assert.equal(pipelineFor(specialistAssessment), SPECIALIST_PIPELINE);
  assert.equal(pipelineFor({ state: "PENDING_OFFICE_DELEGATION", routing_path: null }), UNROUTED_PIPELINE);
  assert.equal(BRANCH_PIPELINE.length, 5);
  assert.equal(SPECIALIST_PIPELINE.length, 4);
  assert.equal(BRANCH_PIPELINE[3].owner, "Branch Chief");
  assert.equal(SPECIALIST_PIPELINE[2].owner, "Office Chief");
});

test("every state resolves to a real step on every ladder", () => {
  for (const state of ALL_STATES) {
    for (const routing_path of ["BRANCH", "SENIOR_SPECIALIST", null] as const) {
      const index = pipelineIndex({ state, routing_path });
      const steps = pipelineFor({ state, routing_path });
      assert.ok(index >= 0 && index < steps.length, `${state}/${routing_path} landed outside the ladder`);
    }
  }
});

test("a legacy FINALIZED assessment renders complete, never step 0", () => {
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: "BRANCH" }), BRANCH_PIPELINE.length - 1);
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: "SENIOR_SPECIALIST" }), SPECIALIST_PIPELINE.length - 1);
  // Terminal with no recorded route still reads as complete on the branch ladder.
  assert.equal(pipelineFor({ state: "FINALIZED", routing_path: null }), BRANCH_PIPELINE);
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: null }), BRANCH_PIPELINE.length - 1);
  assert.equal(pipelineIndex({ state: "APPROVED", routing_path: null }), BRANCH_PIPELINE.length - 1);
});

test("pipeline index and tone follow the assessment state", () => {
  assert.equal(pipelineIndex({ state: "PENDING_OFFICE_DELEGATION", routing_path: "BRANCH" }), 0);
  assert.equal(pipelineIndex({ state: "REVISION_REQUESTED", routing_path: "BRANCH" }), 2);
  assert.equal(pipelineIndex({ state: "REVISION_REQUESTED", routing_path: "SENIOR_SPECIALIST" }), 1);
  assert.equal(assessmentTone("APPROVED"), "good");
  assert.equal(assessmentTone("REVISION_REQUESTED"), "bad");
  assert.equal(assessmentTone("SUBMITTED"), "brand");
  assert.equal(assessmentTone("DRAFT"), "neutral");
});

test("state labels are route-aware and never print a raw code", () => {
  assert.equal(assessmentStateLabelFor("SUBMITTED", "BRANCH"), "Awaiting branch chief review");
  assert.equal(assessmentStateLabelFor("SUBMITTED", "SENIOR_SPECIALIST"), "Awaiting office chief review");
  assert.equal(assessmentStateLabelFor("SUBMITTED", null), "Submitted for review");
  assert.equal(assessmentStateLabelFor("APPROVED", "BRANCH"), "Approved — complete");
  assert.equal(assessmentStateLabelFor("FINALIZED", "BRANCH"), "Signed off (legacy)");
  assert.equal(assessmentStateLabelFor("PENDING_OFFICE_DELEGATION", null), "Awaiting routing");
  for (const state of ALL_STATES) {
    assert.notEqual(assessmentStateLabel(state), state, `${state} printed as a raw code`);
  }
});

test("waiting-on names the route's reviewer and the assignee, and is null only when complete", () => {
  const routing = waitingOn({ state: "PENDING_OFFICE_DELEGATION", routing_path: null, office_code: "NORTH" }, []);
  assert.equal(routing?.who, "Office Chief");
  assert.match(routing?.text ?? "", /hand it off to a branch chief, or assign a senior specialist/);
  assert.doesNotMatch(routing?.text ?? "", /assign the engineer directly/);

  assert.equal(waitingOn(baseAssessment, [])?.who, "Branch Chief");
  assert.equal(waitingOn(specialistAssessment, [])?.who, "North GeoTech Office Chief");

  const engineer = { ...historicalReviewer, id: 1, user_id: 5, assignment_role: "ENGINEER" as const, full_name: "J. Ramos" };
  assert.equal(waitingOn({ ...baseAssessment, state: "DRAFT" }, [engineer])?.who, "Engineer · J. Ramos");
  const specialist = { ...engineer, assignment_role: "SENIOR_SPECIALIST" as const, full_name: "S. Ruiz" };
  assert.equal(
    waitingOn({ ...specialistAssessment, state: "DRAFT" }, [specialist])?.who,
    "Senior Specialist · S. Ruiz",
  );

  for (const state of ALL_STATES) {
    const result = waitingOn({ state, routing_path: "BRANCH", office_code: "NORTH" }, []);
    if (state === "APPROVED" || state === "FINALIZED") assert.equal(result, null);
    else assert.notEqual(result, null, `${state} should still be waiting on somebody`);
  }
});

test("branch review authority is identity bound to the named branch chief", () => {
  const named = assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", baseAssessment);
  assert.equal(named.review, true);
  assert.equal(isActionable(named), true);
  const otherChief = assessmentPermissions({ ...noRoles, branchChief: true }, 9, "NORTH", baseAssessment);
  assert.equal(otherChief.review, false);
  assert.equal(otherChief.assignEngineer, false);
  // An office chief of the same office cannot review a branch-route assessment.
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 3, "NORTH", baseAssessment).review, false);
  assert.equal(assessmentPermissions({ ...noRoles, admin: true }, 99, "", baseAssessment).review, true);
});

test("specialist review is office bound with an explicit falsy guard", () => {
  const chief = assessmentPermissions({ ...noRoles, officeChief: true }, 3, "north", specialistAssessment);
  assert.equal(chief.review, true);
  const wrongOffice = assessmentPermissions({ ...noRoles, officeChief: true }, 3, "WEST", specialistAssessment);
  assert.equal(wrongOffice.review, false);
  const unscopedChief = assessmentPermissions({ ...noRoles, officeChief: true }, 3, null, specialistAssessment);
  assert.equal(unscopedChief.review, false);
  // Neither side has an office: null === null must NOT grant review.
  const officeless = { ...specialistAssessment, office_code: "  " };
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 3, "", officeless).review, false);
  // The named branch chief of a specialist-route assessment reviews nothing.
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", specialistAssessment).review, false);
});

test("no permission comes from an assignment row", () => {
  // The retired REVIEWER row belongs to user 7; permissions ignore assignments entirely.
  const perms = assessmentPermissions(noRoles, historicalReviewer.user_id, "NORTH", baseAssessment);
  assert.equal(perms.review, false);
  assert.equal(isActionable(perms), false);
});

test("an approved assessment offers nothing to anybody", () => {
  const approved = { ...baseAssessment, state: "APPROVED" as const };
  for (const flags of [
    { ...noRoles, officeChief: true },
    { ...noRoles, branchChief: true },
    { ...noRoles, engineer: true },
    { ...noRoles, seniorSpecialist: true },
    { ...noRoles, admin: true },
  ]) {
    const perms = assessmentPermissions(flags, 8, "NORTH", approved);
    assert.equal(isActionable(perms), false);
    assert.equal(perms.manageConsulted, false);
  }
});

test("engineering-step permissions accept the assignee on either route", () => {
  const draft = { ...baseAssessment, state: "DRAFT" as const };
  const assigned = assessmentPermissions({ ...noRoles, engineer: true }, 5, "NORTH", draft);
  assert.equal(assigned.submit, true);
  assert.equal(assigned.addSubmission, true);
  const specialistDraft = { ...specialistAssessment, state: "DRAFT" as const };
  const specialist = assessmentPermissions({ ...noRoles, seniorSpecialist: true }, 5, "NORTH", specialistDraft);
  assert.equal(specialist.submit, true);
  assert.equal(specialist.addSubmission, true);
  const other = assessmentPermissions({ ...noRoles, engineer: true }, 6, "NORTH", draft);
  assert.equal(other.submit, false);
  assert.equal(other.addSubmission, false);
  assert.equal(assessmentPermissions({ ...noRoles, admin: true }, 99, "", draft).submit, true);
});

test("the office chief has exactly two routing choices, and each closes the other", () => {
  const chief = { ...noRoles, officeChief: true };
  const unrouted = { ...baseAssessment, state: "PENDING_OFFICE_DELEGATION" as const, routing_path: null, branch_chief_user_id: null };
  const both = assessmentPermissions(chief, 3, "NORTH", unrouted);
  assert.equal(both.delegate, true);
  assert.equal(both.assignSpecialist, true);

  const branchTaken = assessmentPermissions(chief, 3, "NORTH", { ...unrouted, routing_path: "BRANCH" });
  assert.equal(branchTaken.delegate, true, "re-delegation is the repair path");
  assert.equal(branchTaken.assignSpecialist, false);

  const specialistTaken = assessmentPermissions(chief, 3, "NORTH", { ...unrouted, routing_path: "SENIOR_SPECIALIST" });
  assert.equal(specialistTaken.delegate, false);
  assert.equal(specialistTaken.assignSpecialist, true);

  // Re-delegation still works from SUBMITTED; the specialist route is closed there.
  const submitted = assessmentPermissions(chief, 3, "NORTH", baseAssessment);
  assert.equal(submitted.delegate, true);
  assert.equal(submitted.assignSpecialist, false);
  // A branch chief never routes.
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", unrouted).delegate, false);
});

test("assign-engineer belongs to the named branch chief on the branch route only", () => {
  const pending = { ...baseAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" as const };
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", pending).assignEngineer, true);
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 9, "NORTH", pending).assignEngineer, false);
  const specialistPending = { ...specialistAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" as const, branch_chief_user_id: 8 };
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", specialistPending).assignEngineer, false);
});

test("search covers the assessment and its attached submissions", () => {
  const descriptor = (submission: { id: number }) => `03-PLA-080-158.7 (#${submission.id})`;
  const subs = [{ id: 213, district: "03", county: "PLA", route: "080", post_mile: "158.7", status: "SUBMITTED" }];
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "#512", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "1039", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "PLA-080", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "north", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "awaiting branch chief", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "submitted for review", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "nowhere", descriptor), false);
});

test("submission id helpers prefer the join list and fall back to the legacy id", () => {
  assert.deepEqual(submissionIdsOf(baseAssessment), [213, 215]);
  assert.equal(latestSubmissionId(baseAssessment), 215);
  const legacy = { submission_id: 42, submission_ids: [] as number[] };
  assert.deepEqual(submissionIdsOf(legacy), [42]);
  assert.equal(latestSubmissionId(legacy), 42);
  assert.equal(latestSubmissionId({ submission_id: null, submission_ids: [] }), null);
});
