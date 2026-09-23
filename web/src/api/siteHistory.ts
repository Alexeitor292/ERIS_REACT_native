import { api } from "./client";
import type { SiteRelation } from "../features/submissions/memoContentModel";

export type IncidentTypeRef = { code: string; label: string };

export type RecordEvent = {
  incident_id: number;
  title: string | null;
  observed_at: string | null;
  distance_m: number | null;
  same_location: boolean;
  types: IncidentTypeRef[];
  relation: SiteRelation;
  stage: string | null;
  status: string | null;
  event_group: { id: number; title: string | null } | null;
  assessment: { id: number; state: string } | null;
};

export type MaintenanceRecord = {
  incident_id: number;
  title: string | null;
  observed_at: string | null;
  distance_m: number | null;
  same_location: boolean;
  description: string | null;
  reported_by: string | null;
  outcome: string | null;
  decided_at: string | null;
  decided_by: string | null;
  coordinator_notes: string | null;
};

export type SiteHistory = {
  anchor: { latitude: number | null; longitude: number | null; location_id: number | null; radius_m: number; source: string } | null;
  current_types: IncidentTypeRef[];
  record_of_events: RecordEvent[];
  maintenance_history: MaintenanceRecord[];
};

export function getSiteHistory(submissionId: number) {
  return api<SiteHistory>(`/submissions/${submissionId}/site-history`);
}
