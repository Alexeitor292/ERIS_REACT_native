import { apiFetch } from "./client";

// Compatibility exports keep existing mobile imports stable while the domain and
// wire contract are Event Group based. These Project-prefixed aliases can be
// removed after the Incident screen has completed its component rename.
export type ProjectIncidentSummary = {
  id: number;
  project_id: number | null;
  event_group_id?: number | null;
  incident_key?: string | null;
  is_permanent?: boolean;
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

type WireIncident = Omit<ProjectIncidentSummary, "project_id"> & { event_group_id: number | null };
type WireEventGroup = ProjectSummary & { event_group_key: string };

function incidentCompat(incident: WireIncident): ProjectIncidentSummary {
  return { ...incident, project_id: incident.event_group_id };
}

function groupCompat(group: WireEventGroup): ProjectSummary {
  return group;
}

export async function getIncidentProjectContext(token: string, incidentId: number) {
  const wire = await apiFetch<{
    incident: WireIncident;
    event_group: WireEventGroup | null;
    requires_event_group_decision: boolean;
    can_change_association: boolean;
  }>(`/incidents/${incidentId}/event-group-context`, { token });
  return {
    incident: incidentCompat(wire.incident),
    project: wire.event_group ? groupCompat(wire.event_group) : null,
    requires_project_association: wire.requires_event_group_decision,
    can_change_association: wire.can_change_association,
  } satisfies IncidentProjectContext;
}

export async function getNearbyProjects(token: string, incidentId: number, radiusMiles: number) {
  const radiusMeters = Math.round(radiusMiles * 1609.344);
  const wire = await apiFetch<{ incident: WireIncident; radius_m: number; items: Array<WireEventGroup & { nearest_distance_m: number; incidents: WireIncident[] }> }>(
    `/incidents/${incidentId}/nearby-event-groups?radius_m=${radiusMeters}&limit=50`,
    { token },
  );
  return {
    incident: incidentCompat(wire.incident),
    radius_m: wire.radius_m,
    items: wire.items.map((group) => ({
      ...groupCompat(group),
      nearest_distance_m: group.nearest_distance_m,
      incidents: group.incidents.map(incidentCompat),
    })),
  };
}

export async function associateIncidentWithProject(
  token: string,
  incidentId: number,
  payload:
    | { mode: "EXISTING"; project_id: number; notes?: string | null }
    | { mode: "CREATE_NEW"; title: string; description?: string | null; notes?: string | null },
) {
  const body = payload.mode === "EXISTING"
    ? { mode: "EXISTING" as const, event_group_id: payload.project_id, notes: payload.notes ?? null }
    : payload;
  const wire = await apiFetch<{ incident_id: number; event_group: WireEventGroup; created: boolean; changed: boolean }>(
    `/incidents/${incidentId}/event-group-association`,
    { method: "POST", token, body },
  );
  return {
    incident_id: wire.incident_id,
    project: groupCompat(wire.event_group),
    created: wire.created,
    changed: wire.changed,
  };
}
