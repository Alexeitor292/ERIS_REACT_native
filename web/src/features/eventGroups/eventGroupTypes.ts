export type EventGroupStatus = "OPEN" | "CLOSED" | "ARCHIVED";

export type EventGroupIncidentSummary = {
  id: number;
  event_group_id: number | null;
  incident_key: string | null;
  is_permanent: boolean;
  approved_at: string | null;
  approved_by_user_id: number | null;
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

export type EventGroupSummary = {
  id: number;
  event_group_key: string;
  title: string;
  description: string | null;
  status: EventGroupStatus;
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

export type EventGroupEvent = {
  id: number;
  event_group_id: number;
  incident_id: number | null;
  actor_user_id: number | null;
  actor_name: string | null;
  actor_email: string | null;
  event_type: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type EventGroupDetailResponse = {
  event_group: EventGroupSummary;
  incidents: EventGroupIncidentSummary[];
  events: EventGroupEvent[];
};

export function eventGroupLocationLabel(group: Pick<EventGroupSummary, "district" | "county" | "route" | "post_mile">): string {
  const parts = [
    group.district ? `D${group.district}` : null,
    group.county,
    group.route ? `R${group.route}` : null,
    group.post_mile ? `PM ${group.post_mile}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Location not recorded";
}

export function eventGroupStatusLabel(status: EventGroupStatus): string {
  if (status === "CLOSED") return "Closed";
  if (status === "ARCHIVED") return "Archived";
  return "Open";
}
