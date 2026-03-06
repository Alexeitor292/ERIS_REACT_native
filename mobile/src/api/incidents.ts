import { apiFetch } from "./client";

export type IncidentStatus = "NEW" | "IN_PROGRESS" | "RESOLVED";
export type IncidentStage =
  | "COORDINATOR_REVIEW"
  | "OFFICE_CHIEF_REVIEW"
  | "BRANCH_CHIEF_REVIEW"
  | "ENGINEER_ASSIGNED"
  | "RESOLVED";

export type Incident = {
  id: number;
  title: string | null;
  incident_type: string | null;
  description: string | null;
  location_id: number | null;
  location_match_status: string | null;
  location_reviewed_by_user_id: number | null;
  location_reviewed_at: string | null;
  location_match_metadata: unknown | null;
  first_observed_at: string;
  first_occurred_at: string | null;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  office_code: string | null;
  current_stage: IncidentStage;
  status: IncidentStatus;
  reporter_user_id: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_user_id: number | null;
  resolution_comment: string | null;
  linked_submission_id: number | null;
  assignment: {
    assignment_id: number;
    assignee_user_id: number;
    assigned_by_user_id: number;
    assignment_mode: "CLAIM" | "ASSIGN";
    assignment_stage: "COORDINATOR" | "OFFICE_CHIEF" | "BRANCH_CHIEF" | "ENGINEER";
    assigned_at: string;
    assignee_email: string;
    assignee_name: string;
  } | null;
};

export type IncidentCreatePayload = {
  title?: string | null;
  incident_type?: string | null;
  description?: string | null;
  first_observed_at: string;
  first_occurred_at?: string | null;
  latitude: number;
  longitude: number;
  district: string;
  county: string;
  route: string;
  post_mile: string;
};

export type IncidentLocationCandidate = {
  id: number;
  display_name: string | null;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  post_mile_norm: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
  match_score: number;
  coordinate_distance: number;
};

export type IncidentLocationLinkPayload = {
  mode: "EXISTING" | "CREATE_NEW";
  location_id?: number | null;
  comment?: string | null;
};

export async function listIncidents(
  token: string,
  opts: { status?: IncidentStatus; unclaimedOnly?: boolean; limit?: number; scope?: "mobile" | "all" } = {}
) {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.unclaimedOnly) q.set("unclaimed_only", "true");
  if (opts.limit) q.set("limit", String(opts.limit));
  q.set("scope", opts.scope ?? "mobile");
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return apiFetch<{ items: Incident[] }>(`/incidents${suffix}`, { token });
}

export async function missionCenterFeed(token: string) {
  return apiFetch<{ items: Incident[] }>("/mission-center/incidents?scope=mobile", { token });
}

export async function createIncident(token: string, payload: IncidentCreatePayload) {
  return apiFetch<{ incident: Incident }>("/incidents", {
    method: "POST",
    token,
    body: payload,
  });
}

export async function updateIncident(token: string, incidentId: number, payload: IncidentCreatePayload) {
  return apiFetch<{ incident: Incident }>(`/incidents/${incidentId}`, {
    method: "PATCH",
    token,
    body: payload,
  });
}

export async function getIncidentLocationCandidates(token: string, incidentId: number, limit = 8) {
  return apiFetch<{ incident_id: number; location_id: number | null; location_match_status: string | null; items: IncidentLocationCandidate[] }>(
    `/incidents/${incidentId}/location-candidates?limit=${limit}`,
    { token }
  );
}

export async function linkIncidentLocation(
  token: string,
  incidentId: number,
  payload: IncidentLocationLinkPayload
) {
  return apiFetch<{ incident_id: number; location_id: number; location_match_status: string }>(
    `/incidents/${incidentId}/location-link`,
    {
      method: "POST",
      token,
      body: payload,
    }
  );
}

export async function claimIncident(token: string, incidentId: number) {
  return apiFetch<{ incident_id: number; linked_submission_id: number }>(`/incidents/${incidentId}/claim`, {
    method: "POST",
    token,
  });
}

export async function assignIncident(token: string, incidentId: number, assigneeUserId: number) {
  return apiFetch<{ incident_id: number; linked_submission_id: number }>(`/incidents/${incidentId}/assign`, {
    method: "POST",
    token,
    body: { assignee_user_id: assigneeUserId },
  });
}

export async function forwardIncidentByCoordinator(token: string, incidentId: number, comment?: string | null) {
  return apiFetch<{ incident_id: number; current_stage: IncidentStage; office_code: string | null }>(
    `/incidents/${incidentId}/coordinator/forward`,
    {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }
  );
}

export async function requestIncidentRevisionByCoordinator(
  token: string,
  incidentId: number,
  comment?: string | null,
  revisionFields: string[] = []
) {
  return apiFetch<{ incident_id: number; location_match_status: string }>(
    `/incidents/${incidentId}/coordinator/request-revision`,
    {
      method: "POST",
      token,
      body: { comment: comment ?? null, revision_fields: revisionFields },
    }
  );
}

export async function assignIncidentToBranchChief(
  token: string,
  incidentId: number,
  branchChiefUserId: number
) {
  return apiFetch<{ incident_id: number; current_stage: IncidentStage }>(
    `/incidents/${incidentId}/office-chief/assign-branch`,
    {
      method: "POST",
      token,
      body: { branch_chief_user_id: branchChiefUserId },
    }
  );
}

export async function assignIncidentToEngineer(
  token: string,
  incidentId: number,
  engineerUserId: number
) {
  return apiFetch<{ incident_id: number; linked_submission_id: number }>(
    `/incidents/${incidentId}/branch-chief/assign-engineer`,
    {
      method: "POST",
      token,
      body: { engineer_user_id: engineerUserId },
    }
  );
}

export async function unassignIncident(token: string, incidentId: number) {
  return apiFetch<{ incident_id: number; status: IncidentStatus }>(`/incidents/${incidentId}/unassign`, {
    method: "POST",
    token,
  });
}

export async function resolveIncident(token: string, incidentId: number, comment?: string | null) {
  return apiFetch<{ incident_id: number; status: IncidentStatus }>(`/incidents/${incidentId}/resolve`, {
    method: "POST",
    token,
    body: { comment: comment ?? null },
  });
}
