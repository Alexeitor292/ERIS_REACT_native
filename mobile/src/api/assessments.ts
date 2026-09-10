import { apiFetch } from "./client";

// ---------------------------------------------------------------------------
// Assessment Routing & Authority Model — mobile API client
// ---------------------------------------------------------------------------

export type AssessmentState =
  | "PENDING_OFFICE_DELEGATION"
  | "PENDING_ENGINEER_ASSIGNMENT"
  | "DRAFT"
  | "SUBMITTED"
  | "REVISION_REQUESTED"
  | "APPROVED"
  | "FINALIZED";

export type TriageDisposition =
  | "ASSESSMENT_REQUIRED"
  | "NO_ASSESSMENT_REQUIRED"
  | "NEEDS_REPORTER_INFORMATION"
  | "DUPLICATE_OR_LINKED";

/** Which of the two routes an assessment took; null until the office chief chooses. */
export type AssessmentRoutingPath = "BRANCH" | "SENIOR_ENGINEER";

export type AssessmentQueue =
  | "office_chief"
  | "office_chief_review"
  | "branch_chief"
  | "branch_chief_review"
  | "assignee"
  | "engineer"
  | "reviewer";

export type Assessment = {
  id: number;
  assessment_uuid: string;
  incident_id: number;
  submission_id: number | null;
  district: string | null;
  office_code: string | null;
  office_override_reason: string | null;
  /**
   * The routing SNAPSHOT: the office and branch NAME as they read when this
   * assessment was routed. Render these and fall back to `office_code` only when
   * they are null (a row routed before the organization model). A later rename
   * or a retired branch therefore cannot rewrite what a historical record says.
   */
  routed_office_id: number | null;
  routed_office_name: string | null;
  routed_branch_id: number | null;
  routed_branch_name: string | null;
  routed_branch_letter: string | null;
  routing_path: AssessmentRoutingPath | null;
  branch_chief_user_id: number | null;
  /**
   * The assignee on BOTH routes: on a SENIOR_ENGINEER row this names a senior
   * engineer, not a Staff member. `assigned_user_kind` says which.
   */
  assigned_engineer_user_id: number | null;
  assigned_user_kind: "STAFF" | "SENIOR_ENGINEER" | null;
  /** Server-derived review authority for the caller. Never re-derive it from roles. */
  can_review: boolean;
  state: AssessmentState;
  triage_disposition: TriageDisposition | null;
  notes: string | null;
  created_by_user_id: number;
  office_delegated_at: string | null;
  engineer_assigned_at: string | null;
  submitted_at: string | null;
  review_requested_at: string | null;
  approved_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AssessmentAssignment = {
  id: number;
  user_id: number;
  // REVIEWER/APPROVER are historical only — they confer no authority in v2.
  assignment_role: "ENGINEER" | "SENIOR_ENGINEER" | "REVIEWER" | "APPROVER" | "CONSULTED";
  assigned_by_user_id: number;
  notes: string | null;
  email: string;
  full_name: string;
  created_at: string;
};

export type AssessmentEvent = {
  id: number;
  incident_id: number;
  actor_user_id: number;
  actor_name: string | null;
  event_type: string;
  disposition: TriageDisposition | null;
  from_state: string | null;
  to_state: string | null;
  notes: string | null;
  created_at: string;
};

export type AssessmentDetail = {
  assessment: Assessment;
  assignments: AssessmentAssignment[];
  events: AssessmentEvent[];
};

export type RoutingPreview = {
  district: string | null;
  office_code: string | null;
  office_name: string | null;
  source: "routing_table" | "legacy_fallback" | "none";
};

/**
 * One person in a picker, as all three option endpoints now return them: who
 * they are, where they sit, how much work they hold, and whether they are
 * around. Matching the web contract exactly (design §5).
 *
 * The two counts and `availability` are ANNOTATION, never ranking: nothing here
 * names a default and no client may sort, filter or hide on them — a person
 * marked `ROTATION_OUT` is rendered with their return date, not removed.
 */
export type RoutingUserOption = {
  id: number;
  email: string;
  full_name: string;
  /** Legacy three-key mirror, kept on the wire for one release. */
  metadata?: Record<string, unknown>;
  office_code: string | null;
  office_name: string | null;
  branch_id: number | null;
  branch_letter: string | null;
  branch_name: string | null;
  home_city: string | null;
  home_district: string | null;
  open_assessment_count: number;
  awaiting_action_count: number;
  /** AVAILABLE | ROTATION_OUT | ACTING_ELSEWHERE | UNAVAILABLE. */
  availability: string | null;
  available_from: string | null;
  available_until: string | null;
  /** Set so a person whose branch has since been retired still renders. */
  branch_is_active: boolean | null;
  /** The group this item belongs to; `groups[]` carries the heading. */
  group_key: string;
  /** Only the assignment directory returns these. */
  roles?: string[];
};

/** A picker heading: a branch, a location, or the trailing "not recorded" tail. */
export type RoutingUserGroup = {
  group_key: string;
  label: string;
  branch_id: number | null;
  branch_letter: string | null;
  branch_name: string | null;
  home_city?: string | null;
  home_district?: string | null;
  districts_covered?: string[];
  /** A branch that exists but takes no new work is returned, not omitted. */
  accepts_assignments?: boolean;
  is_active?: boolean;
  /** The Staff directory orders the caller's own branch first. */
  is_own_branch?: boolean;
};

export type RoutingOptions = {
  assessment_id: number;
  office_code: string | null;
  office?: {
    id: number;
    code: string;
    name: string | null;
    short_name?: string | null;
    unit_number?: string | null;
    home_city: string | null;
    home_district: string | null;
    is_active: boolean;
  } | null;
  groups: RoutingUserGroup[];
  items: RoutingUserOption[];
};

export function listAssessments(
  token: string,
  opts: { state?: AssessmentState; office_code?: string; queue?: AssessmentQueue } = {}
) {
  const q = new URLSearchParams();
  if (opts.state) q.set("state", opts.state);
  if (opts.office_code) q.set("office_code", opts.office_code);
  if (opts.queue) q.set("queue", opts.queue);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return apiFetch<{ items: Assessment[] }>(`/assessments${suffix}`, { token });
}

export function getAssessment(token: string, id: number) {
  return apiFetch<AssessmentDetail>(`/assessments/${id}`, { token });
}

export function getAssessmentForIncident(token: string, incidentId: number) {
  return apiFetch<AssessmentDetail>(`/incidents/${incidentId}/assessment`, { token });
}

export function routingPreview(token: string, district: string) {
  return apiFetch<RoutingPreview>(`/assessments/routing/preview?district=${encodeURIComponent(district)}`, { token });
}

export function triageIncident(
  token: string,
  incidentId: number,
  body: {
    disposition: TriageDisposition;
    notes?: string;
    office_code_override?: string;
    override_reason?: string;
    revision_fields?: string[];
    target_incident_id?: number;
    target_location_id?: number;
  }
) {
  return apiFetch(`/incidents/${incidentId}/triage`, { method: "POST", token, body });
}

/** The branch chiefs an office chief may hand this assessment to. */
export function getAssessmentBranchOptions(token: string, assessmentId: number) {
  return apiFetch<RoutingOptions>(`/assessments/${assessmentId}/branch-options`, { token });
}

/**
 * The Staff members the branch chief may assign, grouped own-branch-first by the
 * server. This replaces typing a raw user id: with branches in play, a number
 * typed by hand is the single most likely way to assign the wrong person.
 */
export function getAssessmentEngineerOptions(token: string, assessmentId: number) {
  return apiFetch<RoutingOptions & { kind: string }>(
    `/admin/assessment-assignment-options/${assessmentId}?kind=ENGINEER`,
    { token }
  );
}

export function delegateBranch(token: string, assessmentId: number, branchChiefUserId: number, notes?: string) {
  return apiFetch<{ assessment: Assessment }>(`/assessments/${assessmentId}/delegate-branch`, {
    method: "POST",
    token,
    body: { branch_chief_user_id: branchChiefUserId, notes },
  });
}

/**
 * Assign a Staff member; `assign-engineer` is the deployed endpoint name.
 *
 * The server refuses a Staff member from another OFFICE outright, and accepts
 * one from another BRANCH only with a reason — which is what `notes` carries.
 */
export function assignAssessmentEngineer(token: string, assessmentId: number, engineerUserId: number, notes?: string) {
  return apiFetch<{ assessment: Assessment }>(`/assessments/${assessmentId}/assign-engineer`, {
    method: "POST",
    token,
    body: { engineer_user_id: engineerUserId, notes },
  });
}

export function submitAssessment(token: string, assessmentId: number, notes?: string) {
  return apiFetch<{ assessment: Assessment }>(`/assessments/${assessmentId}/submit`, {
    method: "POST",
    token,
    body: { notes },
  });
}

export function reviewAssessment(
  token: string,
  assessmentId: number,
  action: "APPROVE" | "REQUEST_REVISION",
  notes?: string
) {
  return apiFetch<{ assessment: Assessment; state: AssessmentState }>(`/assessments/${assessmentId}/review`, {
    method: "POST",
    token,
    body: { action, notes },
  });
}
