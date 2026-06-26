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

export type TriageDisposition =
  | "ASSESSMENT_REQUIRED"
  | "NO_ASSESSMENT_REQUIRED"
  | "NEEDS_REPORTER_INFORMATION"
  | "DUPLICATE_OR_LINKED";

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

export type AssessmentQueue = "office_chief" | "branch_chief" | "engineer" | "reviewer";

export function listAssessments(params: {
  state?: AssessmentState;
  office_code?: string;
  queue?: AssessmentQueue;
} = {}): Promise<{ items: Assessment[] }> {
  const q = new URLSearchParams();
  if (params.state) q.set("state", params.state);
  if (params.office_code) q.set("office_code", params.office_code);
  if (params.queue) q.set("queue", params.queue);
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

export function addAssignment(
  assessmentId: number,
  body: { user_id: number; assignment_role: "REVIEWER" | "APPROVER" | "CONSULTED"; notes?: string }
): Promise<{ assessment_id: number; assignments: AssessmentAssignment[] }> {
  return api(`/assessments/${assessmentId}/assignments`, { method: "POST", body: JSON.stringify(body) });
}

export function removeAssignment(
  assessmentId: number,
  assignmentId: number
): Promise<{ assessment_id: number; assignments: AssessmentAssignment[] }> {
  return api(`/assessments/${assessmentId}/assignments/${assignmentId}`, { method: "DELETE" });
}

export function submitAssessment(assessmentId: number, notes?: string): Promise<{ assessment: Assessment }> {
  return api(`/assessments/${assessmentId}/submit`, { method: "POST", body: JSON.stringify({ notes }) });
}

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

export function finalizeAssessment(assessmentId: number, notes?: string): Promise<{ assessment: Assessment }> {
  return api(`/assessments/${assessmentId}/finalize`, { method: "POST", body: JSON.stringify({ notes }) });
}
