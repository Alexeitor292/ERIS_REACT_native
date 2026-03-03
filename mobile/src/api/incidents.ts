import { apiFetch } from "./client";

export type IncidentStatus = "NEW" | "IN_PROGRESS" | "RESOLVED";

export type Incident = {
  id: number;
  title: string;
  incident_type: string | null;
  description: string | null;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
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
    assigned_at: string;
    assignee_email: string;
    assignee_name: string;
  } | null;
};

export type IncidentCreatePayload = {
  title: string;
  incident_type?: string | null;
  description?: string | null;
  latitude: number;
  longitude: number;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
};

export async function listIncidents(
  token: string,
  opts: { status?: IncidentStatus; unclaimedOnly?: boolean; limit?: number } = {}
) {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.unclaimedOnly) q.set("unclaimed_only", "true");
  if (opts.limit) q.set("limit", String(opts.limit));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return apiFetch<{ items: Incident[] }>(`/incidents${suffix}`, { token });
}

export async function missionCenterFeed(token: string) {
  return apiFetch<{ items: Incident[] }>("/mission-center/incidents", { token });
}

export async function createIncident(token: string, payload: IncidentCreatePayload) {
  return apiFetch<{ incident: Incident }>("/incidents", {
    method: "POST",
    token,
    body: payload,
  });
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

