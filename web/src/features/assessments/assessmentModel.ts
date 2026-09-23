import type { Assessment, AssessmentAssignment, AssessmentState, RoutingPath } from "../../api/assessments";
import type { Submission } from "../../api/types";

/**
 * Pure assessment-workflow helpers shared by My Work and the read-only
 * Assessments record view. No React, no network — unit tested with node --test.
 *
 * Routing v2: every assessment takes exactly one of two routes, recorded in
 * `routing_path`. The branch route runs office chief → branch chief → Staff
 * member → the same branch chief's approval; the Senior Specialist route runs
 * office chief → Senior Specialist → that office's chief approval. Approval is
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

/** Office chief assigns a Senior Specialist and approves the result personally. */
export const SENIOR_ENGINEER_PIPELINE: PipelineStep[] = [
  { key: "senior_engineer", label: "Senior Specialist assignment", owner: "Office Chief" },
  { key: "assessment", label: "Assessment", owner: "Senior Specialist" },
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

/**
 * How a client turns an office CODE into a name.
 *
 * The three-entry hard-coded map that used to live here is gone: offices are
 * admin-editable rows now, and a constant in a client file is a second answer
 * that wins silently when it disagrees (owner decision 8). Names come from the
 * assessment's own routing SNAPSHOT first — see `assessmentOfficeName` — and
 * through this lookup, backed by `/org/offices`, only when a record predates
 * the snapshot columns.
 */
export type OfficeNameLookup = (code: string | null | undefined) => string | null;

export function officeLabel(code: string | null | undefined, lookup?: OfficeNameLookup): string {
  if (!code) return "Office —";
  const name = (lookup?.(code) ?? "").trim();
  return name || `Office ${code}`;
}

export type SnapshotAssessment = Pick<
  Assessment,
  "office_code" | "routed_office_name" | "routed_branch_name" | "routed_branch_letter"
>;

/**
 * The office NAME this assessment was routed to, as it read at the time.
 *
 * The snapshot wins over the live record on purpose: renaming an office in
 * admin must not rewrite what a historical assessment says it was sent to
 * (org model design §3.5).
 */
export function assessmentOfficeName(assessment: SnapshotAssessment, lookup?: OfficeNameLookup): string {
  const snapshot = (assessment.routed_office_name ?? "").trim();
  if (snapshot) return snapshot;
  return officeLabel(assessment.office_code, lookup);
}

/** The branch NAME this assessment was handed to, or null on the Senior Specialist route. */
export function assessmentBranchName(assessment: SnapshotAssessment): string | null {
  const name = (assessment.routed_branch_name ?? "").trim();
  if (name) return name;
  const letter = (assessment.routed_branch_letter ?? "").trim();
  return letter ? `Branch ${letter}` : null;
}

/** "Office of Geotechnical Design West · Branch C" — the record's org line. */
export function assessmentOrgLine(assessment: SnapshotAssessment, lookup?: OfficeNameLookup): string {
  const branch = assessmentBranchName(assessment);
  const office = assessmentOfficeName(assessment, lookup);
  return branch ? `${office} · ${branch}` : office;
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
  SENIOR_ENGINEER: "Senior Specialist",
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
  SENIOR_ENGINEER_ASSIGNED: "Senior Specialist assigned",
};

export function assessmentEventLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? humanizeCode(eventType);
}

export type WaitingOn = { who: string; text: string } | null;

/**
 * The subject of `waitingOn`. The routing snapshot is optional so an event row
 * or a filter — neither of which carries a whole assessment — can still ask.
 */
export type WaitingAssessment = Pick<Assessment, "state" | "routing_path" | "office_code"> & Partial<SnapshotAssessment>;

/** Who the next step is waiting on, with the action the role performs. */
export function waitingOn(
  assessment: WaitingAssessment,
  assignments: AssessmentAssignment[],
  officeNames?: OfficeNameLookup,
): WaitingOn {
  const author = assignments.find(
    (assignment) => assignment.assignment_role === "ENGINEER" || assignment.assignment_role === "SENIOR_ENGINEER",
  );
  const seniorEngineerRoute = assessment.routing_path === "SENIOR_ENGINEER";
  const authorLabel = author
    ? `${assignmentRoleLabel(author.assignment_role)} · ${author.full_name}`
    : seniorEngineerRoute
      ? "Assigned Senior Specialist"
      : "Assigned Staff";
  switch (assessment.state) {
    case "PENDING_OFFICE_DELEGATION":
      return {
        who: "Office Chief",
        text: "Route this assessment: hand it off to a branch chief, or assign a Senior Specialist. You cannot assign Staff directly.",
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
        // The office is named in the SENTENCE rather than glued onto the role:
        // an office's full name ("Office of Geotechnical Design West") does not
        // survive being suffixed with " Chief", and the snapshot only carries
        // the full name.
        const office = assessmentOfficeName(
          {
            office_code: assessment.office_code,
            routed_office_name: assessment.routed_office_name ?? null,
            routed_branch_name: assessment.routed_branch_name ?? null,
            routed_branch_letter: assessment.routed_branch_letter ?? null,
          },
          officeNames,
        );
        return {
          who: "Office Chief",
          text: `An office chief of ${office} reads the technical form, then approves it or returns it for changes.`,
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

/**
 * Whether the step an assessment is waiting on is the caller's own, or one they
 * may only step in on.
 *
 *   MINE         — the step names them: the assignee of a draft, the office
 *                  chief of an unrouted assessment's office, the branch chief it
 *                  was handed to, the reviewer its route names.
 *   CAN_STEP_IN  — they hold a power over it without being who it waits on: an
 *                  administrator, or an office chief who could reassign a
 *                  Senior Specialist's draft.
 *   NONE         — nothing for them to do.
 *
 * "This step is yours" is said only for MINE; saying it to anyone who merely
 * could act sent administrators to a My Work queue the step was never in.
 */
export type StepOwnership = "MINE" | "CAN_STEP_IN" | "NONE";

export function stepOwnership(
  flags: RoleFlags,
  userId: number | null | undefined,
  officeCode: string | null | undefined,
  assessment: PermissionAssessment,
): StepOwnership {
  if (!isActionable(assessmentPermissions(flags, userId, officeCode, assessment))) return "NONE";
  const isAssignee = userId != null && assessment.assigned_engineer_user_id === userId;
  const isNamedBranchChief = userId != null && assessment.branch_chief_user_id === userId;
  const callerOffice = normalizeOfficeCode(officeCode);
  const assessmentOffice = normalizeOfficeCode(assessment.office_code);
  const officeMatches = !!callerOffice && !!assessmentOffice && callerOffice === assessmentOffice;
  const route = assessment.routing_path;
  switch (assessment.state) {
    case "DRAFT":
    case "REVISION_REQUESTED":
      return isAssignee ? "MINE" : "CAN_STEP_IN";
    case "PENDING_OFFICE_DELEGATION":
      return flags.officeChief && officeMatches ? "MINE" : "CAN_STEP_IN";
    case "PENDING_ENGINEER_ASSIGNMENT":
      return flags.branchChief && isNamedBranchChief ? "MINE" : "CAN_STEP_IN";
    case "SUBMITTED":
      return (route === "BRANCH" && flags.branchChief && isNamedBranchChief)
        || (route === "SENIOR_ENGINEER" && flags.officeChief && officeMatches)
        ? "MINE"
        : "CAN_STEP_IN";
    default:
      return "CAN_STEP_IN";
  }
}

/**
 * What the button on the assessment record says it will do in My Work — the
 * action itself, not "act on it". Most specific power first.
 */
export function workActionLabel(state: AssessmentState | string, permissions: AssessmentPermissions, hasSubmission: boolean): string {
  if (permissions.submit) return hasSubmission ? "Send it for review" : "Start the technical submission";
  if (permissions.review) return "Review it";
  if (permissions.assignEngineer) return state === "PENDING_ENGINEER_ASSIGNMENT" ? "Assign Staff" : "Reassign Staff";
  if (permissions.delegate || permissions.assignSeniorEngineer) return state === "PENDING_OFFICE_DELEGATION" ? "Route it" : "Change who has it";
  return "Open it";
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

export type SearchableAssessment = Pick<
  Assessment,
  "id" | "incident_id" | "district" | "office_code" | "state" | "routing_path"
> & Partial<SnapshotAssessment>;

/**
 * Search across the assessment and its attached technical submissions.
 *
 * The office NAME is searchable beside the code, because the name is what the
 * rows now show: a reader who types "West" is looking at "Office of
 * Geotechnical Design West", not at "WEST".
 */
export function assessmentSearchMatch(
  assessment: SearchableAssessment,
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
    assessment.routed_office_name,
    assessment.routed_branch_name,
    assessment.routed_branch_letter ? `Branch ${assessment.routed_branch_letter}` : null,
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
