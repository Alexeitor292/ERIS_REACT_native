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

export type AssessmentQueue = "office_chief" | "branch_chief" | "engineer" | "reviewer";

export type Assessment = {
  id: number;
  assessment_uuid: string;
  incident_id: number;
  submission_id: number | null;
  district: string | null;
  office_code: string | null;
  office_override_reason: string | null;
  branch_chief_user_id: number | null;
  assigned_engineer_user_id: number | null;
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
  assignment_role: "ENGINEER" | "REVIEWER" | "APPROVER" | "CONSULTED";
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

export type RoutingUserOption = {
  id: number;
  email: string;
  full_name: string;
  metadata?: Record<string, unknown>;
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

export function getAssessmentBranchOptions(token: string, assessmentId: number) {
  return apiFetch<{ assessment_id: number; office_code: string | null; items: RoutingUserOption[] }>(
    `/assessments/${assessmentId}/branch-options`,
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
