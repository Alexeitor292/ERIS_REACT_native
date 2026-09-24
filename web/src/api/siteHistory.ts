import { api } from "./client";
import type { SiteRelation } from "../features/submissions/memoContentModel";

export type IncidentTypeRef = { code: string; label: string };
export type ActionRef = { code: string; label: string };

/** A later report closed as a duplicate of the incident it is listed under. */
export type AlsoReported = {
  incident_id: number;
  observed_at: string | null;
  reported_by: string | null;
  description: string | null;
  coordinator_notes: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

/** What maintenance reported, decided, did and wrote about one incident. */
export type MaintenanceSide = {
  report: { description: string | null; reported_by: string | null; reported_at: string | null };
  triage: { disposition: string | null; notes: string | null; decided_by: string | null; decided_at: string | null } | null;
  immediate_actions: ActionRef[];
  follow_up_actions: ActionRef[];
  notes: { text: string | null; by: string | null; at: string | null }[];
  also_reported: AlsoReported[];
};

export type SiteIncident = {
  incident_id: number;
  title: string | null;
  observed_at: string | null;
  distance_m: number | null;
  same_location: boolean;
  /** False for reports that never entered the incident record (closed at triage, awaiting triage). */
  in_record: boolean;
  types: IncidentTypeRef[];
  relation: SiteRelation;
  stage: string | null;
  status: string | null;
  /** Outside the record only: how triage left it. */
  outcome: string | null;
  duplicate_of_incident_id: number | null;
  event_group: { id: number; title: string | null } | null;
  assessment: { id: number; state: string } | null;
  maintenance: MaintenanceSide;
};

export type SiteHistory = {
  anchor: { latitude: number | null; longitude: number | null; location_id: number | null; radius_m: number; source: string } | null;
  current_types: IncidentTypeRef[];
  incidents: SiteIncident[];
};

export function getSiteHistory(submissionId: number) {
  return api<SiteHistory>(`/submissions/${submissionId}/site-history`);
}
