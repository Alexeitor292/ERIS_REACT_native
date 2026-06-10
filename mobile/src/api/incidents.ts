import { apiFetch } from "./client";
import { getApiBaseCandidates, getApiBaseUrl } from "./baseUrl";
import { prepareUploadFile } from "../utils/uploadFile";

export type IncidentStatus = "NEW" | "IN_PROGRESS" | "RESOLVED";
export type IncidentStage =
  | "COORDINATOR_REVIEW"
  | "OFFICE_CHIEF_REVIEW"
  | "BRANCH_CHIEF_REVIEW"
  | "ENGINEER_ASSIGNED"
  | "RESOLVED";

export type RoadInventoryIncidentContext = {
  dataset_version_id: number;
  segment_id: number;
  match_method: string | null;
  checked_at: string | null;
  snapshot: Record<string, unknown> | null;
};

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
  road_inventory_context: RoadInventoryIncidentContext | null;
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
  road_inventory_context?: {
    dataset_version_id: number;
    segment_id: number;
    match_method?: string | null;
    snapshot?: Record<string, unknown> | null;
  } | null;
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

export type IncidentLocationTimeline = {
  location: {
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
  };
  incident_count: number;
  submission_count: number;
  incidents: {
    id: number;
    status: IncidentStatus;
    current_stage: IncidentStage;
    description: string | null;
    first_observed_at: string | null;
    first_occurred_at: string | null;
    created_at: string;
    updated_at: string;
    linked_submission_id: number | null;
  }[];
  submissions: {
    id: number;
    status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
    title: string | null;
    created_at: string;
    updated_at: string;
    submitted_at: string | null;
    reviewed_at: string | null;
    date_incident_reported: string | null;
    report_date: string | null;
  }[];
};

export type RoutingUserOption = {
  id: number;
  email: string;
  full_name: string;
  metadata?: {
    district?: string | null;
    office_code?: string | null;
    office_location?: string | null;
  } | null;
};

export type IncidentLocationLinkPayload = {
  mode: "EXISTING" | "CREATE_NEW";
  location_id?: number | null;
  comment?: string | null;
};

export type IncidentAttachmentKind = "PHOTO" | "VIDEO" | "DOC" | "SKETCH";

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

export async function uploadIncidentAttachment(
  token: string,
  incidentId: number | string,
  file: { uri: string; name: string; type: string },
  opts?: { kind?: IncidentAttachmentKind }
) {
  const preparedFile = await prepareUploadFile(file);
  const params = new URLSearchParams();
  if (opts?.kind) params.set("kind", opts.kind);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const baseCandidates = [getApiBaseUrl(), ...getApiBaseCandidates()]
    .map((u) => u.replace(/\/+$/, ""))
    .filter((u, idx, arr) => arr.indexOf(u) === idx);

  let lastError = "Network request failed";
  for (const base of baseCandidates) {
    const formData = new FormData();
    formData.append("file", preparedFile as any);
    try {
      const response = await fetch(`${base}/incidents/${incidentId}/attachments${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (response.ok) return response.json();
      lastError = `${response.status} ${await response.text().catch(() => "")}`;
    } catch (err: any) {
      lastError = String(err?.message ?? err);
    }
  }
  throw new Error(`Could not reach incident upload endpoint. Last error: ${lastError}.`);
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

export async function getIncidentLocationTimeline(token: string, locationId: number, limit = 20) {
  return apiFetch<IncidentLocationTimeline>(`/incident-locations/${locationId}/timeline?limit=${limit}`, {
    token,
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

export async function forwardIncidentByCoordinator(token: string, incidentId: number, comment?: string | null) {
  return apiFetch<{ incident_id: number; current_stage: IncidentStage; office_code: string | null; linked_submission_id: number | null }>(
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

export async function getOfficeChiefBranchOptions(token: string, incidentId: number) {
  return apiFetch<{ incident_id: number; office_code: string | null; items: RoutingUserOption[] }>(
    `/incidents/${incidentId}/office-chief/branch-options`,
    { token }
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
