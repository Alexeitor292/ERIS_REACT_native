export type ProjectStatus = "OPEN" | "CLOSED" | "ARCHIVED";

export type ProjectIncidentSummary = {
  id: number;
  project_id: number | null;
  title: string | null;
  incident_type: string | null;
  status: string;
  current_stage: string;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  first_observed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ProjectSummary = {
  id: number;
  project_uuid: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  anchor_location_id: number | null;
  anchor_latitude: number;
  anchor_longitude: number;
  centroid_latitude: number;
  centroid_longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  created_from_incident_id: number | null;
  created_by_user_id: number;
  source: string;
  incident_count: number;
  open_incident_count: number;
  latest_incident_activity_at: string | null;
  closed_at: string | null;
  closed_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type ProjectEvent = {
  id: number;
  project_id: number;
  incident_id: number | null;
  actor_user_id: number | null;
  actor_name: string | null;
  actor_email: string | null;
  event_type: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type ProjectDetailResponse = {
  project: ProjectSummary;
  incidents: ProjectIncidentSummary[];
  events: ProjectEvent[];
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

export type NearbyProjectsResponse = {
  incident: ProjectIncidentSummary;
  radius_m: number;
  items: NearbyProject[];
};

export type ProjectAssociationResponse = {
  incident_id: number;
  project: ProjectSummary;
  created: boolean;
  changed: boolean;
};

export function milesFromMeters(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 160.9344) return `${Math.round(meters * 3.28084)} ft away`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi away`;
}

export function projectLocationLabel(project: Pick<ProjectSummary, "district" | "county" | "route" | "post_mile">): string {
  const parts = [
    project.district ? `D${project.district}` : null,
    project.county,
    project.route ? `R${project.route}` : null,
    project.post_mile ? `PM ${project.post_mile}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Location not recorded";
}

export function projectStatusLabel(status: ProjectStatus): string {
  if (status === "CLOSED") return "Closed";
  if (status === "ARCHIVED") return "Archived";
  return "Open";
}
