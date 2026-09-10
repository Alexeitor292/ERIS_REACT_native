import type { Assessment, AssessmentAssignment, AssessmentState, RoutingPath } from "../../api/assessments";
import type { Submission } from "../../api/types";

/**
 * Pure assessment-workflow helpers shared by My Work and the read-only
 * Assessments record view. No React, no network — unit tested with node --test.
 *
 * Routing v2: every assessment takes exactly one of two routes, recorded in
 * `routing_path`. The branch route runs office chief → branch chief → Staff
 * member → the same branch chief's approval; the senior engineer route runs
 * office chief → senior engineer → that office's chief approval. Approval is
 * terminal.
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

/** Approval ends the assessment; FINALIZED is unreachable legacy history. */
export function isTerminalState(state: AssessmentState | string): boolean {
  return state === "APPROVED" || state === "FINALIZED";
}

export type PipelineStep = { key: string; label: string; owner: string | null };

/** Office chief hands off; the branch chief assigns Staff and approves. */
export const BRANCH_PIPELINE: PipelineStep[] = [
  { key: "handoff", label: "Hand-off", owner: "Office Chief" },
  { key: "engineer", label: "Staff assignment", owner: "Branch Chief" },
  { key: "engineering", label: "Assessment", owner: "Assigned Staff" },
  { key: "review", label: "Review", owner: "Branch Chief" },
  { key: "approved", label: "Approved", owner: null },
];

/** Office chief assigns a senior engineer and approves the result personally. */
export const SENIOR_ENGINEER_PIPELINE: PipelineStep[] = [
  { key: "senior_engineer", label: "Senior engineer assignment", owner: "Office Chief" },
  { key: "assessment", label: "Assessment", owner: "Senior Engineer" },
  { key: "review", label: "Review", owner: "Office Chief" },
  { key: "approved", label: "Approved", owner: null },
];

/** No route chosen yet: one honest step rather than a ladder that may not apply. */
export const UNROUTED_PIPELINE: PipelineStep[] = [
  { key: "routing", label: "Awaiting routing", owner: "Office Chief" },
];

// Every state maps explicitly on every ladder, so no caller can land on a
// silent 0 fallback: FINALIZED sits on the last (complete) step, and the two
// states that belong to the other route resolve to that route's first step.
const BRANCH_INDEX: Record<AssessmentState, number> = {
  PENDING_OFFICE_DELEGATION: 0,
  PENDING_ENGINEER_ASSIGNMENT: 1,
  DRAFT: 2,
  REVISION_REQUESTED: 2,
  SUBMITTED: 3,
  APPROVED: 4,
  FINALIZED: 4,
};

const SENIOR_ENGINEER_INDEX: Record<AssessmentState, number> = {
  PENDING_OFFICE_DELEGATION: 0,
  PENDING_ENGINEER_ASSIGNMENT: 0,
  DRAFT: 1,
  REVISION_REQUESTED: 1,
  SUBMITTED: 2,
  APPROVED: 3,
  FINALIZED: 3,
};

export type RoutedAssessment = Pick<Assessment, "state" | "routing_path">;

/**
 * The ladder this assessment actually walks. A terminal assessment with no
 * recorded route still renders on the branch ladder: the one-step "Awaiting
 * routing" ladder cannot express completion, and a legacy FINALIZED row must
 * read as complete rather than as step 0.
 */
export function pipelineFor(assessment: RoutedAssessment): PipelineStep[] {
  if (assessment.routing_path === "SENIOR_ENGINEER") return SENIOR_ENGINEER_PIPELINE;
  if (assessment.routing_path === "BRANCH") return BRANCH_PIPELINE;
  return isTerminalState(assessment.state) ? BRANCH_PIPELINE : UNROUTED_PIPELINE;
}

export function pipelineIndex(assessment: RoutedAssessment): number {
  const steps = pipelineFor(assessment);
  if (steps === UNROUTED_PIPELINE) return 0;
  const table = steps === SENIOR_ENGINEER_PIPELINE ? SENIOR_ENGINEER_INDEX : BRANCH_INDEX;
  return table[assessment.state as AssessmentState] ?? steps.length - 1;
}

export type Tone = "neutral" | "good" | "bad" | "brand";

export function assessmentTone(state: AssessmentState | string): Tone {
  if (state === "APPROVED" || state === "FINALIZED") return "good";
  if (state === "REVISION_REQUESTED") return "bad";
  if (state === "SUBMITTED") return "brand";
  return "neutral";
}

/**
 * Human label for a state, route-aware where the route changes who is waiting.
 * `routingPath` is null on the record filter and on event history rows, which
 * carry a bare state code and no assessment.
 */
export function assessmentStateLabelFor(
  state: AssessmentState | string,
  routingPath: RoutingPath | null | undefined,
): string {
  if (state === "SUBMITTED") {
    if (routingPath === "BRANCH") return "Awaiting branch chief review";
    if (routingPath === "SENIOR_ENGINEER") return "Awaiting office chief review";
    return "Submitted for review";
  }
  return (
    {
      PENDING_OFFICE_DELEGATION: "Awaiting routing",
      PENDING_ENGINEER_ASSIGNMENT: "Awaiting Staff assignment",
      DRAFT: "Draft",
      REVISION_REQUESTED: "Revision requested",
      APPROVED: "Approved — complete",
      FINALIZED: "Signed off (legacy)",
    } as Record<string, string>
  )[state] ?? state;
}

/** Route-neutral label, for the state filter and event history rows. */
export function assessmentStateLabel(state: AssessmentState | string): string {
  return assessmentStateLabelFor(state, null);
}

const OFFICE_NAMES: Record<string, string> = {
  NORTH: "North GeoTech Office",
  WEST: "West GeoTech Office",
  SOUTH: "South GeoTech Office",
};

export function officeLabel(code: string | null | undefined): string {
  if (!code) return "Office —";
  return OFFICE_NAMES[code] ?? `Office ${code}`;
}

export function humanizeCode(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

/**
 * Office scoping, normalized the way the server does it
 * (`normalize_office_code`): trimmed, upper-cased, blank becomes null.
 */
export function normalizeOfficeCode(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.toUpperCase() : null;
}

/**
 * Assignment-role chips. The codes are the deployed contract — `ENGINEER` is
 * the Staff role's stored code and does not change — so only the label here
 * carries the role's name.
 */
const ASSIGNMENT_ROLE_LABELS: Record<string, string> = {
  ENGINEER: "Staff",
  SENIOR_ENGINEER: "Senior Engineer",
  CONSULTED: "Consulted",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
};

export function assignmentRoleLabel(role: string): string {
  return ASSIGNMENT_ROLE_LABELS[role] ?? humanizeCode(role);
}

/** Assessment history rows: same rule, for the event codes the server writes. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  ENGINEER_ASSIGNED: "Staff assigned",
  SENIOR_ENGINEER_ASSIGNED: "Senior engineer assigned",
};

export function assessmentEventLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? humanizeCode(eventType);
}

export type WaitingOn = { who: string; text: string } | null;

/** Who the next step is waiting on, with the action the role performs. */
export function waitingOn(
  assessment: Pick<Assessment, "state" | "routing_path" | "office_code">,
  assignments: AssessmentAssignment[],
): WaitingOn {
  const author = assignments.find(
    (assignment) => assignment.assignment_role === "ENGINEER" || assignment.assignment_role === "SENIOR_ENGINEER",
  );
  const seniorEngineerRoute = assessment.routing_path === "SENIOR_ENGINEER";
  const authorLabel = author
    ? `${assignmentRoleLabel(author.assignment_role)} · ${author.full_name}`
    : seniorEngineerRoute
      ? "Assigned Senior Engineer"
      : "Assigned Staff";
  switch (assessment.state) {
    case "PENDING_OFFICE_DELEGATION":
      return {
        who: "Office Chief",
        text: "Route this assessment: hand it off to a branch chief, or assign a senior engineer. You cannot assign Staff directly.",
      };
    case "PENDING_ENGINEER_ASSIGNMENT":
      return {
        who: "Branch Chief",
        text: "Assign a Staff member to perform the on-site assessment. You approve the finished assessment yourself.",
      };
    case "DRAFT":
      return { who: authorLabel, text: "Complete the technical submission, then send the assessment for review." };
    case "REVISION_REQUESTED":
      return { who: authorLabel, text: "Make the changes the reviewer asked for, update the submission, and resend it." };
    case "SUBMITTED":
      if (seniorEngineerRoute) {
        return {
          who: `${officeLabel(assessment.office_code)} Chief`,
          text: "An office chief of this GeoTech office reads the technical form, then approves it or returns it for changes.",
        };
      }
      if (assessment.routing_path === "BRANCH") {
        return {
          who: "Branch Chief",
          text: "The branch chief this assessment was handed to reads the technical form, then approves it or returns it for changes.",
        };
      }
      return {
        who: "The route's reviewer",
        text: "Read the technical form, then approve it or return it for changes.",
      };
    default:
      return null;
  }
}

export type RoleFlags = {
  admin: boolean;
  officeChief: boolean;
  branchChief: boolean;
  /** GEOTECH_ENGINEER, the Staff role's deployed code. */
  engineer: boolean;
  seniorEngineer: boolean;
};

export type AssessmentPermissions = {
  /** Hand off to a branch chief — also the repair path for a departed chief. */
  delegate: boolean;
  assignSeniorEngineer: boolean;
  assignEngineer: boolean;
  submit: boolean;
  addSubmission: boolean;
  review: boolean;
  /** CONSULTED is the only assignment role anyone may still add or remove. */
  manageConsulted: boolean;
};

export type PermissionAssessment = Pick<
  Assessment,
  "state" | "routing_path" | "branch_chief_user_id" | "assigned_engineer_user_id" | "office_code"
>;

/**
 * What the signed-in user may do on this assessment, mirroring the server
 * guards. Review authority is path-derived and nothing else grants it: no
 * assignment row confers any permission in routing v2.
 */
export function assessmentPermissions(
  flags: RoleFlags,
  userId: number | null | undefined,
  officeCode: string | null | undefined,
  assessment: PermissionAssessment,
): AssessmentPermissions {
  const terminal = isTerminalState(assessment.state);
  const route = assessment.routing_path;
  const isAssignee = userId != null && assessment.assigned_engineer_user_id === userId;
  const isNamedBranchChief = userId != null && assessment.branch_chief_user_id === userId;
  const engineeringStep = assessment.state === "DRAFT" || assessment.state === "REVISION_REQUESTED";
  const routingStep = assessment.state === "PENDING_OFFICE_DELEGATION";

  // The office chief may re-delegate from any non-terminal branch-route state,
  // so a departed branch chief never strands a submitted assessment.
  const delegate =
    (flags.officeChief || flags.admin) && !terminal && (route == null || route === "BRANCH");
  const assignSeniorEngineer =
    (flags.officeChief || flags.admin)
    && (routingStep || engineeringStep)
    && (route == null || route === "SENIOR_ENGINEER");

  // Identity-bound: only the branch chief this assessment was handed to.
  const assignEngineer =
    ((flags.branchChief && isNamedBranchChief) || flags.admin)
    && route === "BRANCH"
    && (assessment.state === "PENDING_ENGINEER_ASSIGNMENT" || engineeringStep);

  // Explicit falsy guard, not a chained "!== ''": a blank office normalizes to
  // null on both sides, and null === null would hand an office-less assessment
  // to any unscoped chief.
  const callerOffice = normalizeOfficeCode(officeCode);
  const assessmentOffice = normalizeOfficeCode(assessment.office_code);
  const officeMatches = !!callerOffice && !!assessmentOffice && callerOffice === assessmentOffice;
  const review =
    assessment.state === "SUBMITTED"
    && (flags.admin
      || (route === "BRANCH" && flags.branchChief && isNamedBranchChief)
      || (route === "SENIOR_ENGINEER" && flags.officeChief && officeMatches));

  return {
    delegate,
    assignSeniorEngineer,
    assignEngineer,
    submit: (isAssignee || flags.admin) && engineeringStep,
    addSubmission: ((isAssignee && (flags.engineer || flags.seniorEngineer)) || flags.admin) && engineeringStep,
    review,
    manageConsulted: (flags.officeChief || flags.branchChief || flags.admin) && !terminal,
  };
}

export function isActionable(permissions: AssessmentPermissions): boolean {
  return (
    permissions.delegate
    || permissions.assignSeniorEngineer
    || permissions.assignEngineer
    || permissions.submit
    || permissions.review
  );
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
    assessmentStateLabelFor(assessment.state, assessment.routing_path),
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
