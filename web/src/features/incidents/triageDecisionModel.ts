/**
 * The coordinator's triage decision, as data: what may be chosen, what each
 * choice still needs before it can be recorded, and the exact request it sends.
 *
 * An Incident Group is asked for only when the report needs an assessment — the
 * one outcome that becomes GeoTech work at a site. Closing a report, or sending
 * it back to its reporter, never asks where it belongs. The server enforces the
 * same rule (POST /incidents/{id}/triage refuses a group with any other
 * decision), and saves the group and the decision in one transaction.
 *
 * Dependency-free: `node --test` runs this file directly.
 */

export type TriageDispositionCode =
  | "ASSESSMENT_REQUIRED"
  | "NO_ASSESSMENT_REQUIRED"
  | "NEEDS_REPORTER_INFORMATION"
  | "DUPLICATE_OR_LINKED";

export type EventGroupChoice =
  | { mode: "EXISTING"; eventGroupId: number }
  | { mode: "CREATE_NEW"; title: string; description: string };

export type TriageDraft = {
  incidentId: number;
  /** Null until the coordinator picks one; nothing is picked for them. */
  disposition: TriageDispositionCode | null;
  notes: string;
  /** Assessment required only. */
  eventGroup: EventGroupChoice | null;
  /** Needs reporter information only. */
  revisionFields: string[];
  /** Duplicate or linked only. */
  duplicateOfIncidentId: number | null;
};

export function newTriageDraft(incidentId: number): TriageDraft {
  return { incidentId, disposition: null, notes: "", eventGroup: null, revisionFields: [], duplicateOfIncidentId: null };
}

export const TRIAGE_OPTIONS: ReadonlyArray<{ value: TriageDispositionCode; label: string; description: string }> = [
  {
    value: "ASSESSMENT_REQUIRED",
    label: "Assessment required",
    description: "Accept the report into ERIS and open a GeoTech assessment. You also say which Incident Group it belongs to.",
  },
  {
    value: "NO_ASSESSMENT_REQUIRED",
    label: "No assessment required",
    description: "Close the report. It does not enter ERIS and no geotechnical work follows.",
  },
  {
    value: "NEEDS_REPORTER_INFORMATION",
    label: "Needs more from the reporter",
    description: "Send it back with what to correct. It stays a field report and comes back to you once they update it.",
  },
  {
    value: "DUPLICATE_OR_LINKED",
    label: "Duplicate of another report",
    description: "Close it and link it to the report it repeats. It does not enter ERIS.",
  },
];

export function needsEventGroup(disposition: TriageDispositionCode | null): boolean {
  return disposition === "ASSESSMENT_REQUIRED";
}

/**
 * Why the decision cannot be recorded yet, in words for the footer, or null
 * when it can. The server accepts some of these empty; the dialog does not,
 * because each one would leave a decision nobody can act on.
 */
export function triageBlocker(draft: TriageDraft): string | null {
  switch (draft.disposition) {
    case null:
      return "Choose what happens to this report.";
    case "ASSESSMENT_REQUIRED":
      return draft.eventGroup ? null : "Choose its Incident Group, or start a new one.";
    case "NEEDS_REPORTER_INFORMATION":
      return draft.revisionFields.length || draft.notes.trim() ? null : "Say what the reporter should correct.";
    case "DUPLICATE_OR_LINKED":
      return draft.duplicateOfIncidentId ? null : "Choose the report it repeats.";
    default:
      return null;
  }
}

export type TriageRequestBody = {
  disposition: TriageDispositionCode;
  notes?: string;
  revision_fields?: string[];
  target_incident_id?: number;
  event_group?: { mode: "EXISTING"; event_group_id: number } | { mode: "CREATE_NEW"; title?: string; description?: string };
};

/** The request for a complete draft — only the fields its decision uses — or null. */
export function triageRequestBody(draft: TriageDraft): TriageRequestBody | null {
  if (!draft.disposition || triageBlocker(draft)) return null;
  const body: TriageRequestBody = { disposition: draft.disposition };
  const notes = draft.notes.trim();
  if (notes) body.notes = notes;
  if (draft.disposition === "ASSESSMENT_REQUIRED" && draft.eventGroup) {
    if (draft.eventGroup.mode === "EXISTING") {
      body.event_group = { mode: "EXISTING", event_group_id: draft.eventGroup.eventGroupId };
    } else {
      const title = draft.eventGroup.title.trim();
      const description = draft.eventGroup.description.trim();
      body.event_group = { mode: "CREATE_NEW", ...(title ? { title } : {}), ...(description ? { description } : {}) };
    }
  }
  if (draft.disposition === "NEEDS_REPORTER_INFORMATION" && draft.revisionFields.length) {
    body.revision_fields = [...draft.revisionFields];
  }
  if (draft.disposition === "DUPLICATE_OR_LINKED" && draft.duplicateOfIncidentId) {
    body.target_incident_id = draft.duplicateOfIncidentId;
  }
  return body;
}

/** The confirm button says what it does. */
export function confirmLabel(disposition: TriageDispositionCode | null): string {
  switch (disposition) {
    case "ASSESSMENT_REQUIRED": return "Accept and open assessment";
    case "NO_ASSESSMENT_REQUIRED": return "Close — no assessment";
    case "NEEDS_REPORTER_INFORMATION": return "Send back to the reporter";
    case "DUPLICATE_OR_LINKED": return "Close as duplicate";
    default: return "Record decision";
  }
}

/** What the coordinator reads once the decision is saved. */
export function triageOutcomeMessage(draft: TriageDraft, result: { assessment?: { id: number } } | null | undefined): string {
  if (result?.assessment) {
    return `Report #${draft.incidentId} accepted. Assessment #${result.assessment.id} is open and waiting for the office chief to route it.`;
  }
  switch (draft.disposition) {
    case "NO_ASSESSMENT_REQUIRED": return `Report #${draft.incidentId} closed — no assessment needed.`;
    case "NEEDS_REPORTER_INFORMATION": return `Report #${draft.incidentId} sent back to the reporter.`;
    case "DUPLICATE_OR_LINKED": return `Report #${draft.incidentId} closed as a duplicate of report #${draft.duplicateOfIncidentId}.`;
    default: return `Decision recorded for report #${draft.incidentId}.`;
  }
}

export type NearbyReport = { id: number; title: string | null; latitude: number; longitude: number };
export type DuplicateCandidate<T extends NearbyReport = NearbyReport> = T & { distanceM: number };

export const DUPLICATE_SEARCH_RADIUS_M = 8047; // 5 miles

/** Other reports near this one, nearest first — the only plausible originals. */
export function duplicateCandidates<T extends NearbyReport>(
  pin: { id: number; latitude: number; longitude: number },
  reports: T[],
  { radiusM = DUPLICATE_SEARCH_RADIUS_M, limit = 8 }: { radiusM?: number; limit?: number } = {},
): DuplicateCandidate<T>[] {
  return reports
    .filter((report) => report.id !== pin.id && Number.isFinite(report.latitude) && Number.isFinite(report.longitude))
    .map((report) => ({ ...report, distanceM: haversineMetres(pin, report) }))
    .filter((report) => report.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM || b.id - a.id)
    .slice(0, limit);
}

/** How far a candidate is from this report, in words. */
export function candidateDistanceLabel(metres: number): string {
  if (!Number.isFinite(metres)) return "";
  if (metres < 10) return "At the same spot";
  if (metres < 1000) return `${Math.round(metres)} m away`;
  return `${(metres / 1609.344).toFixed(1)} mi away`;
}

function haversineMetres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
