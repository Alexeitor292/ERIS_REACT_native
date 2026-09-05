import type { Assessment, AssessmentAssignment, AssessmentState } from "../../api/assessments";
import type { Submission } from "../../api/types";

/**
 * Pure assessment-workflow helpers shared by My Work and the read-only
 * Assessments record view. No React, no network — unit tested with node --test.
 */

export const ASSESSMENT_STATES: AssessmentState[] = [
  "PENDING_OFFICE_DELEGATION",
  "PENDING_ENGINEER_ASSIGNMENT",
  "DRAFT",
  "SUBMITTED",
  "REVISION_REQUESTED",
  "APPROVED",
  "FINALIZED",
];

export const ASSESSMENT_PIPELINE = [
  { key: "office", label: "Office delegation", owner: "Office Chief" },
  { key: "branch", label: "Branch assignment", owner: "Branch Chief" },
  { key: "engineering", label: "Engineering", owner: "Assigned Engineer" },
  { key: "review", label: "Review", owner: "Reviewer" },
  { key: "approval", label: "Approval", owner: "Office Chief" },
  { key: "finalized", label: "Finalized", owner: null },
] as const;

const PIPELINE_INDEX: Record<AssessmentState, number> = {
  PENDING_OFFICE_DELEGATION: 0,
  PENDING_ENGINEER_ASSIGNMENT: 1,
  DRAFT: 2,
  REVISION_REQUESTED: 2,
  SUBMITTED: 3,
  APPROVED: 4,
  FINALIZED: 5,
};

export function pipelineIndex(state: AssessmentState | string): number {
  return PIPELINE_INDEX[state as AssessmentState] ?? 0;
}

export type Tone = "neutral" | "good" | "bad" | "brand";

export function assessmentTone(state: AssessmentState | string): Tone {
  if (state === "APPROVED" || state === "FINALIZED") return "good";
  if (state === "REVISION_REQUESTED") return "bad";
  if (state === "SUBMITTED") return "brand";
  return "neutral";
}

export function assessmentStateLabel(state: AssessmentState | string): string {
  return (
    {
      PENDING_OFFICE_DELEGATION: "Pending office delegation",
      PENDING_ENGINEER_ASSIGNMENT: "Pending engineer assignment",
      DRAFT: "Draft",
      SUBMITTED: "Submitted for review",
      REVISION_REQUESTED: "Revision requested",
      APPROVED: "Approved",
      FINALIZED: "Finalized",
    } as Record<string, string>
  )[state] ?? state;
}

export function humanizeCode(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

export type WaitingOn = { who: string; text: string } | null;

/** Who the next step is waiting on, with the action the role performs. */
export function waitingOn(assessment: Pick<Assessment, "state">, assignments: AssessmentAssignment[]): WaitingOn {
  const engineer = assignments.find((assignment) => assignment.assignment_role === "ENGINEER");
  const engineerLabel = engineer ? `Engineer · ${engineer.full_name}` : "Assigned Engineer";
  switch (assessment.state) {
    case "PENDING_OFFICE_DELEGATION":
      return { who: "Office Chief", text: "Delegate this assessment to a branch chief — or assign the engineer directly." };
    case "PENDING_ENGINEER_ASSIGNMENT":
      return { who: "Branch Chief", text: "Assign an engineer to perform the on-site assessment." };
    case "DRAFT":
      return { who: engineerLabel, text: "Complete the technical submission, then submit the assessment for review." };
    case "REVISION_REQUESTED":
      return { who: engineerLabel, text: "Address the reviewer's comments, update the submission, and resubmit." };
    case "SUBMITTED":
      return { who: "Reviewer", text: "Review the technical submission — approve it or request revision." };
    case "APPROVED":
      return { who: "Office Chief", text: "Finalize the assessment to close out the workflow." };
    default:
      return null;
  }
}

export type RoleFlags = {
  admin: boolean;
  officeChief: boolean;
  branchChief: boolean;
  engineer: boolean;
};

export type AssessmentPermissions = {
  delegate: boolean;
  assignEngineer: boolean;
  submit: boolean;
  addSubmission: boolean;
  review: boolean;
  finalize: boolean;
  addReviewer: boolean;
};

/**
 * What the signed-in user may do on this assessment, mirroring the server
 * guards (roles for routing steps; assessment-level assignment for review).
 */
export function assessmentPermissions(
  flags: RoleFlags,
  userId: number | null | undefined,
  assessment: Pick<Assessment, "state" | "assigned_engineer_user_id">,
  assignments: AssessmentAssignment[],
): AssessmentPermissions {
  const isAssignedEngineer = userId != null && assessment.assigned_engineer_user_id === userId;
  const isAssignedReviewer = userId != null && assignments.some(
    (assignment) => assignment.user_id === userId && (assignment.assignment_role === "REVIEWER" || assignment.assignment_role === "APPROVER"),
  );
  const engineeringStep = assessment.state === "DRAFT" || assessment.state === "REVISION_REQUESTED";
  return {
    delegate: (flags.officeChief || flags.admin) && assessment.state === "PENDING_OFFICE_DELEGATION",
    assignEngineer: (flags.branchChief || flags.admin) && assessment.state === "PENDING_ENGINEER_ASSIGNMENT",
    submit: (isAssignedEngineer || flags.admin) && engineeringStep,
    addSubmission: ((isAssignedEngineer && flags.engineer) || flags.admin) && engineeringStep,
    review: (isAssignedReviewer || flags.admin) && assessment.state === "SUBMITTED",
    finalize: (flags.officeChief || flags.admin) && assessment.state === "APPROVED",
    addReviewer: (flags.officeChief || flags.branchChief || flags.admin) && assessment.state !== "FINALIZED",
  };
}

export function isActionable(permissions: AssessmentPermissions): boolean {
  return permissions.delegate || permissions.assignEngineer || permissions.submit || permissions.review || permissions.finalize;
}

/** Search across the assessment and its attached technical submissions. */
export function assessmentSearchMatch(
  assessment: Assessment,
  linkedSubmissions: Array<Pick<Submission, "id" | "district" | "county" | "route" | "post_mile" | "status">>,
  query: string,
  descriptor: (submission: Pick<Submission, "id" | "district" | "county" | "route" | "post_mile">) => string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    `#${assessment.id}`,
    String(assessment.id),
    `incident #${assessment.incident_id}`,
    String(assessment.incident_id),
    assessment.district,
    assessment.office_code,
    assessmentStateLabel(assessment.state),
    assessment.state,
  ];
  for (const submission of linkedSubmissions) {
    haystack.push(`#${submission.id}`, String(submission.id), descriptor(submission), submission.status);
  }
  return haystack
    .filter((value) => value != null && value !== "")
    .some((value) => String(value).toLowerCase().includes(needle));
}

export function latestSubmissionId(assessment: Pick<Assessment, "submission_id" | "submission_ids">): number | null {
  const ids = assessment.submission_ids ?? [];
  if (ids.length > 0) return ids[ids.length - 1];
  return assessment.submission_id ?? null;
}

export function submissionIdsOf(assessment: Pick<Assessment, "submission_id" | "submission_ids">): number[] {
  const ids = [...(assessment.submission_ids ?? [])];
  if (assessment.submission_id != null && !ids.includes(assessment.submission_id)) ids.push(assessment.submission_id);
  return ids;
}
