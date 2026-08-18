import { apiFetch } from "./client";

export type ProjectIncidentSummary = {
  id: number;
  project_id: number | null;
  title: string | null;
  status: string;
  current_stage: string;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
};

export type ProjectSummary = {
  id: number;
  title: string;
  description: string | null;
  status: "OPEN" | "CLOSED" | "ARCHIVED";
  centroid_latitude: number;
  centroid_longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  incident_count: number;
  open_incident_count: number;
};

export type NearbyProject = ProjectSummary & {
  nearest_distance_m: number;
  incidents: ProjectIncidentSummary[];
};

export type IncidentProjectContext = {
  incident: ProjectIncidentSummary;
  project: ProjectSummary | null;
  requires_project_association: boolean;
  can_change_association: boolean;
};

export async function getIncidentProjectContext(token: string, incidentId: number) {
  return apiFetch<IncidentProjectContext>(`/incidents/${incidentId}/project-context`, { token });
}

export async function getNearbyProjects(
  token: string,
  incidentId: number,
  radiusMiles: number,
) {
  const radiusMeters = Math.round(radiusMiles * 1609.344);
  return apiFetch<{ incident: ProjectIncidentSummary; radius_m: number; items: NearbyProject[] }>(
    `/incidents/${incidentId}/nearby-projects?radius_m=${radiusMeters}&limit=50`,
    { token },
  );
}

export async function associateIncidentWithProject(
  token: string,
  incidentId: number,
  payload:
    | { mode: "EXISTING"; project_id: number; notes?: string | null }
    | { mode: "CREATE_NEW"; title: string; description?: string | null; notes?: string | null },
) {
  return apiFetch<{ incident_id: number; project: ProjectSummary; created: boolean; changed: boolean }>(
    `/incidents/${incidentId}/project-association`,
    { method: "POST", token, body: payload },
  );
}
