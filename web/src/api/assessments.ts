import { api } from "./client";

// ---------------------------------------------------------------------------
// Assessment Routing & Authority Model — web API client
// ---------------------------------------------------------------------------

export type AssessmentState =
  | "PENDING_OFFICE_DELEGATION"
  | "PENDING_ENGINEER_ASSIGNMENT"
  | "DRAFT"
  | "SUBMITTED"
  | "REVISION_REQUESTED"
  | "APPROVED"
  | "FINALIZED";

/**
 * Which of the office chief's two mutually exclusive routes this assessment
 * took. `null` means the chief has not chosen yet; the choice is not
 * reversible, so each route endpoint refuses once the other one was taken.
 */
export type RoutingPath = "BRANCH" | "SENIOR_ENGINEER";

/**
 * Who may approve or return THIS assessment. `BRANCH` names one person;
 * `SENIOR_ENGINEER` names an office function — any active office chief of
 * that office — so its `user_id` is null by design.
 */
export type ReviewOwner = {
  kind: "BRANCH_CHIEF" | "OFFICE_CHIEF";
  user_id: number | null;
  office_code: string | null;
};

export type TriageDisposition =
  | "ASSESSMENT_REQUIRED"
  | "NO_ASSESSMENT_REQUIRED"
  | "NEEDS_REPORTER_INFORMATION"
  | "DUPLICATE_OR_LINKED";

export type Assessment = {
  id: number;
  assessment_uuid: string;
  incident_id: number;
  /** Latest / primary technical submission (kept for compatibility). */
  submission_id: number | null;
  /** Every technical submission attached to this assessment, oldest first. */
  submission_ids: number[];
  district: string | null;
  office_code: string | null;
  office_override_reason: string | null;
  routing_path: RoutingPath | null;
  branch_chief_user_id: number | null;
  /** Both routes store the assignee here; `assigned_user_kind` says which kind. */
  assigned_engineer_user_id: number | null;
  /** Route-neutral alias of `assigned_engineer_user_id`. */
  assigned_user_id: number | null;
  assigned_user_kind: "STAFF" | "SENIOR_ENGINEER" | null;
  /** Server-computed: may the signed-in caller decide this assessment now? */
  can_review: boolean;
  review_owner: ReviewOwner | null;
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
  /**
   * REVIEWER / APPROVER are history: routing v2 retired them and no new row can
   * be written with either. They keep rendering, muted, with `is_authority`
   * false. CONSULTED is the only writable assignment role.
   */
  assignment_role: "ENGINEER" | "SENIOR_ENGINEER" | "REVIEWER" | "APPROVER" | "CONSULTED";
  assigned_by_user_id: number;
  notes: string | null;
  email: string;
  full_name: string;
  /** Always false in routing v2 — review authority follows the routing path. */
  is_authority: boolean;
  created_at: string;
};

export type AssessmentEvent = {
  id: number;
  assessment_id: number | null;
  incident_id: number;
  actor_user_id: number;
  actor_name: string | null;
  actor_email: string | null;
  event_type: string;
  disposition: TriageDisposition | null;
  from_state: string | null;
  to_state: string | null;
  notes: string | null;
  target_incident_id: number | null;
  target_location_id: number | null;
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

export type RoutingUserOption = {
  id: number;
  email: string;
  full_name: string;
  metadata: Record<string, unknown>;
};

export type AssignmentUserOption = RoutingUserOption & {
  roles: string[];
};

export type AssessmentQueue =
  | "office_chief"
  | "office_chief_review"
  | "branch_chief"
  | "branch_chief_review"
  | "assignee"
  /** Permanent alias of `assignee`. */
  | "engineer"
  /** Permanent per-path alias, resolved server-side against the routing path. */
  | "reviewer";

export function listAssessments(params: {
  state?: AssessmentState;
  office_code?: string;
  queue?: AssessmentQueue;
  limit?: number;
} = {}): Promise<{ items: Assessment[] }> {
  const q = new URLSearchParams();
  if (params.state) q.set("state", params.state);
  if (params.office_code) q.set("office_code", params.office_code);
  if (params.queue) q.set("queue", params.queue);
  if (params.limit) q.set("limit", String(params.limit));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<{ items: Assessment[] }>(`/assessments${suffix}`);
}

export function getAssessment(id: number): Promise<AssessmentDetail> {
  return api<AssessmentDetail>(`/assessments/${id}`);
}

export function getAssessmentForIncident(incidentId: number): Promise<AssessmentDetail> {
  return api<AssessmentDetail>(`/incidents/${incidentId}/assessment`);
}

export function routingPreview(district: string): Promise<RoutingPreview> {
  return api<RoutingPreview>(`/assessments/routing/preview?district=${encodeURIComponent(district)}`);
}

export function assessmentAssignmentOptions(
  assessmentId: number,
  kind: "ENGINEER" | "SENIOR_ENGINEER" | "CONSULTED"
): Promise<{ assessment_id: number; kind: string; office_code: string | null; items: AssignmentUserOption[] }> {
  return api(`/admin/assessment-assignment-options/${assessmentId}?kind=${encodeURIComponent(kind)}`);
}

export function triageIncident(
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
): Promise<unknown> {
  return api(`/incidents/${incidentId}/triage`, { method: "POST", body: JSON.stringify(body) });
}

export function branchOptions(
  assessmentId: number
): Promise<{ assessment_id: number; office_code: string | null; items: RoutingUserOption[] }> {
  return api(`/assessments/${assessmentId}/branch-options`);
}

/** The senior engineers of this assessment's office (the second route's picker). */
export function seniorEngineerOptions(
  assessmentId: number
): Promise<{ assessment_id: number; office_code: string | null; items: RoutingUserOption[] }> {
  return api(`/assessments/${assessmentId}/senior-engineer-options`);
}

/**
 * Hand the assessment off to a branch chief. The direct-to-Staff shortcut was
 * retired: the office chief's two choices are this and `assignSeniorEngineer`,
 * and the server rejects an `engineer_user_id` with a 400.
 */
export function delegateBranch(
  assessmentId: number,
  branch_chief_user_id: number,
  notes?: string
): Promise<{ assessment: Assessment }> {
  return api(`/assessments/${assessmentId}/delegate-branch`, {
    method: "POST",
    body: JSON.stringify({ branch_chief_user_id, notes }),
  });
}

/** Assign a GeoTech senior engineer directly; the assessment returns to the office chief. */
export function assignSeniorEngineer(
  assessmentId: number,
  senior_engineer_user_id: number,
  notes?: string
): Promise<{ assessment: Assessment; submission_id: number | null }> {
  return api(`/assessments/${assessmentId}/assign-senior-engineer`, {
    method: "POST",
    body: JSON.stringify({ senior_engineer_user_id, notes }),
  });
}

/** The assignee: add a supplemental DRAFT technical submission pre-filled from the incident. */
export function createAssessmentSubmission(
  assessmentId: number,
  notes?: string
): Promise<{ assessment: Assessment; submission_id: number }> {
  return api(`/assessments/${assessmentId}/submissions`, { method: "POST", body: JSON.stringify({ notes }) });
}

export function assignEngineer(
  assessmentId: number,
  engineer_user_id: number,
  notes?: string
): Promise<{ assessment: Assessment }> {
  return api(`/assessments/${assessmentId}/assign-engineer`, {
    method: "POST",
    body: JSON.stringify({ engineer_user_id, notes }),
  });
}

/**
 * CONSULTED is the only writable assignment role: review authority follows the
 * assessment's routing path, so no client can construct a reviewer assignment.
 */
export function addAssignment(
  assessmentId: number,
  body: { user_id: number; assignment_role: "CONSULTED"; notes?: string }
): Promise<{ assessment_id: number; assignments: AssessmentAssignment[] }> {
  return api(`/assessments/${assessmentId}/assignments`, { method: "POST", body: JSON.stringify(body) });
}

export function removeAssignment(
  assessmentId: number,
  assignmentId: number
): Promise<{ assessment_id: number; assignments: AssessmentAssignment[] }> {
  return api(`/assessments/${assessmentId}/assignments/${assignmentId}`, { method: "DELETE" });
}

export function submitAssessment(
  assessmentId: number,
  notes?: string
): Promise<{ assessment: Assessment; submissions_transitioned?: number[]; submissions_skipped?: number[] }> {
  return api(`/assessments/${assessmentId}/submit`, { method: "POST", body: JSON.stringify({ notes }) });
}

/** APPROVE is terminal in routing v2 — there is no finalize step after it. */
export function reviewAssessment(
  assessmentId: number,
  action: "APPROVE" | "REQUEST_REVISION",
  notes?: string
): Promise<{ assessment: Assessment; state: AssessmentState }> {
  return api(`/assessments/${assessmentId}/review`, {
    method: "POST",
    body: JSON.stringify({ action, notes }),
  });
}
