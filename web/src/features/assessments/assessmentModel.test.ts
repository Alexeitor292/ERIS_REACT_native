import assert from "node:assert/strict";
import test from "node:test";

import {
  assessmentPermissions,
  assessmentSearchMatch,
  assessmentTone,
  isActionable,
  latestSubmissionId,
  pipelineIndex,
  submissionIdsOf,
  waitingOn,
} from "./assessmentModel.ts";

const baseAssessment = {
  id: 512,
  assessment_uuid: "as-512",
  incident_id: 1039,
  submission_id: 213,
  submission_ids: [213, 215],
  district: "03",
  office_code: "NORTH",
  office_override_reason: null,
  branch_chief_user_id: 8,
  assigned_engineer_user_id: 5,
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

const reviewerAssignment = {
  id: 2,
  user_id: 7,
  assignment_role: "REVIEWER" as const,
  assigned_by_user_id: 9,
  notes: null,
  email: "l.novak@dot.ca.gov",
  full_name: "L. Novak",
  created_at: "2026-08-20T09:00:00",
};

const noRoles = { admin: false, officeChief: false, branchChief: false, engineer: false };

test("pipeline index and tone follow the assessment state", () => {
  assert.equal(pipelineIndex("PENDING_OFFICE_DELEGATION"), 0);
  assert.equal(pipelineIndex("REVISION_REQUESTED"), 2);
  assert.equal(pipelineIndex("FINALIZED"), 5);
  assert.equal(assessmentTone("APPROVED"), "good");
  assert.equal(assessmentTone("REVISION_REQUESTED"), "bad");
  assert.equal(assessmentTone("SUBMITTED"), "brand");
  assert.equal(assessmentTone("DRAFT"), "neutral");
});

test("waiting-on names the responsible role and the assigned engineer", () => {
  assert.equal(waitingOn({ state: "PENDING_OFFICE_DELEGATION" }, [])?.who, "Office Chief");
  assert.equal(waitingOn({ state: "SUBMITTED" }, [])?.who, "Reviewer");
  assert.equal(waitingOn({ state: "FINALIZED" }, []), null);
  const engineer = { ...reviewerAssignment, id: 1, user_id: 5, assignment_role: "ENGINEER" as const, full_name: "J. Ramos" };
  assert.equal(waitingOn({ state: "DRAFT" }, [engineer])?.who, "Engineer · J. Ramos");
});

test("review authority comes from an assessment-level assignment, not a role", () => {
  const perms = assessmentPermissions(noRoles, 7, baseAssessment, [reviewerAssignment]);
  assert.equal(perms.review, true);
  assert.equal(isActionable(perms), true);
  const stranger = assessmentPermissions(noRoles, 99, baseAssessment, [reviewerAssignment]);
  assert.equal(stranger.review, false);
  assert.equal(isActionable(stranger), false);
});

test("engineering step permissions require the assigned engineer", () => {
  const draft = { ...baseAssessment, state: "DRAFT" as const };
  const assigned = assessmentPermissions({ ...noRoles, engineer: true }, 5, draft, []);
  assert.equal(assigned.submit, true);
  assert.equal(assigned.addSubmission, true);
  const other = assessmentPermissions({ ...noRoles, engineer: true }, 6, draft, []);
  assert.equal(other.submit, false);
  assert.equal(other.addSubmission, false);
  const admin = assessmentPermissions({ ...noRoles, admin: true }, 99, draft, []);
  assert.equal(admin.submit, true);
});

test("routing steps are role gated by state", () => {
  const pending = { ...baseAssessment, state: "PENDING_OFFICE_DELEGATION" as const };
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 9, pending, []).delegate, true);
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, pending, []).delegate, false);
  const branch = { ...baseAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" as const };
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, branch, []).assignEngineer, true);
  const approved = { ...baseAssessment, state: "APPROVED" as const };
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 9, approved, []).finalize, true);
  const finalized = { ...baseAssessment, state: "FINALIZED" as const };
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 9, finalized, []).addReviewer, false);
});

test("search covers the assessment and its attached submissions", () => {
  const descriptor = (submission: { id: number }) => `03-PLA-080-158.7 (#${submission.id})`;
  const subs = [{ id: 213, district: "03", county: "PLA", route: "080", post_mile: "158.7", status: "SUBMITTED" }];
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "#512", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "1039", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "PLA-080", descriptor), true);
  assert.equal(assessmentSearchMatch(baseAssessment, subs, "north", descriptor), true);
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
