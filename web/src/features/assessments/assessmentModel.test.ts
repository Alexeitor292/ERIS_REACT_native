import assert from "node:assert/strict";
import test from "node:test";

import {
  BRANCH_PIPELINE,
  SENIOR_ENGINEER_PIPELINE,
  UNROUTED_PIPELINE,
  assessmentBranchName,
  assessmentEventLabel,
  assessmentOfficeName,
  assessmentOrgLine,
  officeLabel,
  assessmentPermissions,
  assessmentSearchMatch,
  assessmentStateLabel,
  assessmentStateLabelFor,
  assessmentTone,
  assignmentRoleLabel,
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
  assigned_user_kind: "STAFF" as const,
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

const seniorEngineerAssessment = {
  ...baseAssessment,
  routing_path: "SENIOR_ENGINEER" as const,
  branch_chief_user_id: null,
  assigned_user_kind: "SENIOR_ENGINEER" as const,
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

const noRoles = { admin: false, officeChief: false, branchChief: false, engineer: false, seniorEngineer: false };

test("each route has its own ladder and an unrouted assessment has one step", () => {
  assert.equal(pipelineFor(baseAssessment), BRANCH_PIPELINE);
  assert.equal(pipelineFor(seniorEngineerAssessment), SENIOR_ENGINEER_PIPELINE);
  assert.equal(pipelineFor({ state: "PENDING_OFFICE_DELEGATION", routing_path: null }), UNROUTED_PIPELINE);
  assert.equal(BRANCH_PIPELINE.length, 5);
  assert.equal(SENIOR_ENGINEER_PIPELINE.length, 4);
  assert.equal(BRANCH_PIPELINE[3].owner, "Branch Chief");
  assert.equal(SENIOR_ENGINEER_PIPELINE[2].owner, "Office Chief");
});

test("ladder step names carry the role names, never \"engineer\" for Staff", () => {
  assert.equal(BRANCH_PIPELINE[1].label, "Staff assignment");
  assert.equal(BRANCH_PIPELINE[2].owner, "Assigned Staff");
  assert.equal(SENIOR_ENGINEER_PIPELINE[0].label, "Senior engineer assignment");
  assert.equal(SENIOR_ENGINEER_PIPELINE[1].owner, "Senior Engineer");
  // The senior engineer is the only "engineer" either ladder may name.
  for (const step of [...BRANCH_PIPELINE, ...SENIOR_ENGINEER_PIPELINE]) {
    for (const text of [step.label, step.owner ?? ""]) {
      if (/engineer/i.test(text)) assert.match(text, /senior engineer/i, `"${text}" calls the Staff role an engineer`);
    }
  }
});

test("every state resolves to a real step on every ladder", () => {
  for (const state of ALL_STATES) {
    for (const routing_path of ["BRANCH", "SENIOR_ENGINEER", null] as const) {
      const index = pipelineIndex({ state, routing_path });
      const steps = pipelineFor({ state, routing_path });
      assert.ok(index >= 0 && index < steps.length, `${state}/${routing_path} landed outside the ladder`);
    }
  }
});

test("a legacy FINALIZED assessment renders complete, never step 0", () => {
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: "BRANCH" }), BRANCH_PIPELINE.length - 1);
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: "SENIOR_ENGINEER" }), SENIOR_ENGINEER_PIPELINE.length - 1);
  // Terminal with no recorded route still reads as complete on the branch ladder.
  assert.equal(pipelineFor({ state: "FINALIZED", routing_path: null }), BRANCH_PIPELINE);
  assert.equal(pipelineIndex({ state: "FINALIZED", routing_path: null }), BRANCH_PIPELINE.length - 1);
  assert.equal(pipelineIndex({ state: "APPROVED", routing_path: null }), BRANCH_PIPELINE.length - 1);
});

test("pipeline index and tone follow the assessment state", () => {
  assert.equal(pipelineIndex({ state: "PENDING_OFFICE_DELEGATION", routing_path: "BRANCH" }), 0);
  assert.equal(pipelineIndex({ state: "REVISION_REQUESTED", routing_path: "BRANCH" }), 2);
  assert.equal(pipelineIndex({ state: "REVISION_REQUESTED", routing_path: "SENIOR_ENGINEER" }), 1);
  assert.equal(assessmentTone("APPROVED"), "good");
  assert.equal(assessmentTone("REVISION_REQUESTED"), "bad");
  assert.equal(assessmentTone("SUBMITTED"), "brand");
  assert.equal(assessmentTone("DRAFT"), "neutral");
});

test("state labels are route-aware and never print a raw code", () => {
  assert.equal(assessmentStateLabelFor("SUBMITTED", "BRANCH"), "Awaiting branch chief review");
  assert.equal(assessmentStateLabelFor("SUBMITTED", "SENIOR_ENGINEER"), "Awaiting office chief review");
  assert.equal(assessmentStateLabelFor("SUBMITTED", null), "Submitted for review");
  assert.equal(assessmentStateLabelFor("APPROVED", "BRANCH"), "Approved — complete");
  assert.equal(assessmentStateLabelFor("FINALIZED", "BRANCH"), "Signed off (legacy)");
  assert.equal(assessmentStateLabelFor("PENDING_OFFICE_DELEGATION", null), "Awaiting routing");
  // The state code keeps its deployed name; the label does not repeat it.
  assert.equal(assessmentStateLabelFor("PENDING_ENGINEER_ASSIGNMENT", "BRANCH"), "Awaiting Staff assignment");
  for (const state of ALL_STATES) {
    assert.notEqual(assessmentStateLabel(state), state, `${state} printed as a raw code`);
  }
});

test("office and branch render from the routing snapshot, not from a hard-coded map", () => {
  const snapshot = {
    office_code: "WEST",
    routed_office_name: "Office of Geotechnical Design West",
    routed_branch_name: "Branch C",
    routed_branch_letter: "C",
  };
  assert.equal(assessmentOfficeName(snapshot), "Office of Geotechnical Design West");
  assert.equal(assessmentBranchName(snapshot), "Branch C");
  assert.equal(assessmentOrgLine(snapshot), "Office of Geotechnical Design West · Branch C");

  // A rename in admin cannot rewrite history: the snapshot wins over the lookup.
  const renamed = () => "Office of Geotechnical Design Bay Area";
  assert.equal(assessmentOfficeName(snapshot, renamed), "Office of Geotechnical Design West");

  // A row routed before the org model has no snapshot, so the live directory answers…
  const legacy = { office_code: "WEST", routed_office_name: null, routed_branch_name: null, routed_branch_letter: null };
  assert.equal(assessmentOfficeName(legacy, renamed), "Office of Geotechnical Design Bay Area");
  // …and with no directory either, the code is shown rather than a wrong name.
  assert.equal(assessmentOfficeName(legacy), "Office WEST");
  assert.equal(assessmentBranchName(legacy), null);
  assert.equal(assessmentOrgLine(legacy), "Office WEST");

  // A branch with a letter but no printed name still reads as a branch.
  assert.equal(assessmentBranchName({ ...legacy, routed_branch_letter: "F" }), "Branch F");
  assert.equal(officeLabel(null), "Office —");
  assert.equal(officeLabel("SOUTH", () => null), "Office SOUTH");
  assert.equal(officeLabel("SOUTH", () => "  "), "Office SOUTH");
});

test("assignment-role and event labels rename the role, not the code", () => {
  assert.equal(assignmentRoleLabel("ENGINEER"), "Staff");
  assert.equal(assignmentRoleLabel("SENIOR_ENGINEER"), "Senior Engineer");
  assert.equal(assignmentRoleLabel("CONSULTED"), "Consulted");
  // Anything the server adds later still renders readably.
  assert.equal(assignmentRoleLabel("SOMETHING_NEW"), "Something New");
  assert.equal(assessmentEventLabel("ENGINEER_ASSIGNED"), "Staff assigned");
  assert.equal(assessmentEventLabel("SENIOR_ENGINEER_ASSIGNED"), "Senior engineer assigned");
  assert.equal(assessmentEventLabel("OFFICE_DELEGATED"), "Office Delegated");
});

test("waiting-on names the route's reviewer and the assignee, and is null only when complete", () => {
  const routing = waitingOn({ state: "PENDING_OFFICE_DELEGATION", routing_path: null, office_code: "NORTH" }, []);
  assert.equal(routing?.who, "Office Chief");
  assert.match(routing?.text ?? "", /hand it off to a branch chief, or assign a senior engineer/);
  assert.doesNotMatch(routing?.text ?? "", /assign the engineer directly/);

  assert.equal(waitingOn(baseAssessment, [])?.who, "Branch Chief");
  // The office is named in the sentence, from the routing SNAPSHOT when there is
  // one — never from a hard-coded office map, which no longer exists.
  const seniorEngineerWait = waitingOn(seniorEngineerAssessment, []);
  assert.equal(seniorEngineerWait?.who, "Office Chief");
  assert.match(seniorEngineerWait?.text ?? "", /Office NORTH/);
  const snapshotWait = waitingOn(
    { ...seniorEngineerAssessment, routed_office_name: "Office of Geotechnical Design North" },
    [],
  );
  assert.match(snapshotWait?.text ?? "", /Office of Geotechnical Design North/);
  const lookupWait = waitingOn(seniorEngineerAssessment, [], (code) => (code === "NORTH" ? "North GeoTech Office" : null));
  assert.match(lookupWait?.text ?? "", /North GeoTech Office/);

  const staff = { ...historicalReviewer, id: 1, user_id: 5, assignment_role: "ENGINEER" as const, full_name: "J. Ramos" };
  assert.equal(waitingOn({ ...baseAssessment, state: "DRAFT" }, [staff])?.who, "Staff · J. Ramos");
  const seniorEngineer = { ...staff, assignment_role: "SENIOR_ENGINEER" as const, full_name: "S. Ruiz" };
  assert.equal(
    waitingOn({ ...seniorEngineerAssessment, state: "DRAFT" }, [seniorEngineer])?.who,
    "Senior Engineer · S. Ruiz",
  );
  // Nobody assigned yet: the placeholder names the role of the route.
  assert.equal(waitingOn({ ...baseAssessment, state: "DRAFT" }, [])?.who, "Assigned Staff");
  assert.equal(waitingOn({ ...seniorEngineerAssessment, state: "DRAFT" }, [])?.who, "Assigned Senior Engineer");
  assert.match(
    waitingOn({ ...baseAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" }, [])?.text ?? "",
    /Assign a Staff member/,
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

test("senior engineer review is office bound with an explicit falsy guard", () => {
  const chief = assessmentPermissions({ ...noRoles, officeChief: true }, 3, "north", seniorEngineerAssessment);
  assert.equal(chief.review, true);
  const wrongOffice = assessmentPermissions({ ...noRoles, officeChief: true }, 3, "WEST", seniorEngineerAssessment);
  assert.equal(wrongOffice.review, false);
  const unscopedChief = assessmentPermissions({ ...noRoles, officeChief: true }, 3, null, seniorEngineerAssessment);
  assert.equal(unscopedChief.review, false);
  // Neither side has an office: null === null must NOT grant review.
  const officeless = { ...seniorEngineerAssessment, office_code: "  " };
  assert.equal(assessmentPermissions({ ...noRoles, officeChief: true }, 3, "", officeless).review, false);
  // The named branch chief of a senior-engineer-route assessment reviews nothing.
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", seniorEngineerAssessment).review, false);
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
    { ...noRoles, seniorEngineer: true },
    { ...noRoles, admin: true },
  ]) {
    const perms = assessmentPermissions(flags, 8, "NORTH", approved);
    assert.equal(isActionable(perms), false);
    assert.equal(perms.manageConsulted, false);
  }
});

test("assessment-step permissions accept the assignee on either route", () => {
  const draft = { ...baseAssessment, state: "DRAFT" as const };
  const assigned = assessmentPermissions({ ...noRoles, engineer: true }, 5, "NORTH", draft);
  assert.equal(assigned.submit, true);
  assert.equal(assigned.addSubmission, true);
  const seniorEngineerDraft = { ...seniorEngineerAssessment, state: "DRAFT" as const };
  const seniorEngineer = assessmentPermissions({ ...noRoles, seniorEngineer: true }, 5, "NORTH", seniorEngineerDraft);
  assert.equal(seniorEngineer.submit, true);
  assert.equal(seniorEngineer.addSubmission, true);
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
  assert.equal(both.assignSeniorEngineer, true);

  const branchTaken = assessmentPermissions(chief, 3, "NORTH", { ...unrouted, routing_path: "BRANCH" });
  assert.equal(branchTaken.delegate, true, "re-delegation is the repair path");
  assert.equal(branchTaken.assignSeniorEngineer, false);

  const seniorEngineerTaken = assessmentPermissions(chief, 3, "NORTH", { ...unrouted, routing_path: "SENIOR_ENGINEER" });
  assert.equal(seniorEngineerTaken.delegate, false);
  assert.equal(seniorEngineerTaken.assignSeniorEngineer, true);

  // Re-delegation still works from SUBMITTED; the senior engineer route is closed there.
  const submitted = assessmentPermissions(chief, 3, "NORTH", baseAssessment);
  assert.equal(submitted.delegate, true);
  assert.equal(submitted.assignSeniorEngineer, false);
  // A branch chief never routes.
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", unrouted).delegate, false);
});

test("assign-engineer belongs to the named branch chief on the branch route only", () => {
  const pending = { ...baseAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" as const };
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", pending).assignEngineer, true);
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 9, "NORTH", pending).assignEngineer, false);
  const seniorEngineerPending = { ...seniorEngineerAssessment, state: "PENDING_ENGINEER_ASSIGNMENT" as const, branch_chief_user_id: 8 };
  assert.equal(assessmentPermissions({ ...noRoles, branchChief: true }, 8, "NORTH", seniorEngineerPending).assignEngineer, false);
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
