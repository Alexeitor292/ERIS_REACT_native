/**
 * Plain-language labels for the dedicated incident page.
 *
 * Every code the backend stores (stage, status, disposition, revision field) is
 * turned into words here and nowhere else, so the page never prints a raw enum.
 * Dependency-free: `node --test` runs this file directly.
 */

export type IncidentStageCode = "COORDINATOR_REVIEW" | "OFFICE_CHIEF_REVIEW" | "BRANCH_CHIEF_REVIEW" | "ENGINEER_ASSIGNED" | "RESOLVED" | string;

export type DetailIncident = {
  current_stage: IncidentStageCode;
  status: string;
  incident_key?: string | null;
  location_match_status?: string | null;
  location_match_metadata?: Record<string, unknown> | null;
  triage_disposition?: string | null;
};

/**
 * Only "Assessment required" enters the incident record. The other decisions
 * keep the report out: closed at triage for good, or held as a temporary field
 * report while the reporter answers.
 */
const DISPOSITION_LABELS: Record<string, { label: string; meaning: string }> = {
  ASSESSMENT_REQUIRED: {
    label: "Sent to GeoTech for assessment",
    meaning: "The coordinator accepted the report into ERIS and opened a GeoTech assessment.",
  },
  NO_ASSESSMENT_REQUIRED: {
    label: "Closed — no assessment needed",
    meaning: "The coordinator decided no geotechnical assessment is required. The report was closed and did not enter ERIS.",
  },
  NEEDS_REPORTER_INFORMATION: {
    label: "Sent back to the reporter",
    meaning: "The coordinator asked the reporter for more information. It stays a field report until the coordinator decides.",
  },
  DUPLICATE_OR_LINKED: {
    label: "Closed — duplicate of another report",
    meaning: "The coordinator found it repeats another report. It was closed and did not enter ERIS.",
  },
};

const CLOSED_AT_TRIAGE = new Set(["NO_ASSESSMENT_REQUIRED", "DUPLICATE_OR_LINKED"]);

/** Closed by the coordinator's decision, so never part of the incident record. */
export function isClosedAtTriage(incident: DetailIncident): boolean {
  const closed = String(incident.status || "").toUpperCase() === "RESOLVED" || String(incident.current_stage || "").toUpperCase() === "RESOLVED";
  return closed && CLOSED_AT_TRIAGE.has(String(incident.triage_disposition || "").toUpperCase());
}

/**
 * Where a report stands against the incident record:
 *   RECORD           — sent for assessment, so in ERIS: numbered and grouped;
 *   FIELD_REPORT     — awaiting the coordinator, or back with its reporter;
 *   CLOSED_AT_TRIAGE — closed by the decision, kept but never entered.
 */
export type RecordStanding = "RECORD" | "FIELD_REPORT" | "CLOSED_AT_TRIAGE";

export function recordStanding(incident: DetailIncident): RecordStanding {
  if (isClosedAtTriage(incident)) return "CLOSED_AT_TRIAGE";
  if (String(incident.current_stage || "").toUpperCase() === "COORDINATOR_REVIEW" && !incident.incident_key) return "FIELD_REPORT";
  return "RECORD";
}

export function dispositionLabel(code: string | null | undefined): string {
  if (!code) return "Not decided yet";
  return DISPOSITION_LABELS[code]?.label ?? humanize(code);
}

export function dispositionMeaning(code: string | null | undefined): string | null {
  if (!code) return null;
  return DISPOSITION_LABELS[code]?.meaning ?? null;
}

/**
 * Where the report is in the workflow, as one label. Derived from stage, status
 * and the revision marker together — status alone is why an accepted report
 * used to read "New" in red.
 */
export function workflowPositionLabel(incident: DetailIncident): string {
  const stage = String(incident.current_stage || "").toUpperCase();
  const status = String(incident.status || "").toUpperCase();
  if (status === "RESOLVED" || stage === "RESOLVED") {
    if (incident.triage_disposition === "NO_ASSESSMENT_REQUIRED") return "Closed at triage — no assessment needed";
    if (incident.triage_disposition === "DUPLICATE_OR_LINKED") return "Closed at triage — duplicate";
    return "Resolved";
  }
  if (stage === "COORDINATOR_REVIEW") {
    return isWaitingOnReporter(incident) ? "Waiting on the reporter" : "Waiting for coordinator review";
  }
  if (stage === "OFFICE_CHIEF_REVIEW") return "With the GeoTech office — awaiting routing";
  if (stage === "BRANCH_CHIEF_REVIEW") return "With a branch chief — awaiting Staff assignment";
  if (stage === "ENGINEER_ASSIGNED") return "Assessment in progress";
  return humanize(stage || status);
}

export type Tone = "neutral" | "active" | "attention" | "done";

export function workflowPositionTone(incident: DetailIncident): Tone {
  const stage = String(incident.current_stage || "").toUpperCase();
  const status = String(incident.status || "").toUpperCase();
  if (status === "RESOLVED" || stage === "RESOLVED") return "done";
  if (stage === "COORDINATOR_REVIEW") return isWaitingOnReporter(incident) ? "attention" : "active";
  return "active";
}

export function isWaitingOnReporter(incident: DetailIncident): boolean {
  return String(incident.location_match_status || "").toUpperCase() === "NEEDS_REVISION";
}

/** Awaiting the coordinator's first decision — the only state in which triage is offered. */
export function isAwaitingTriage(incident: DetailIncident): boolean {
  return String(incident.current_stage || "").toUpperCase() === "COORDINATOR_REVIEW"
    && !incident.incident_key
    && !isWaitingOnReporter(incident)
    && String(incident.status || "").toUpperCase() !== "RESOLVED";
}

/** The fields a reporter can be asked to correct — the server's REVISION_FIELDS_ALLOWED. */
export const REVISION_FIELD_LABELS: Record<string, string> = {
  district: "District",
  county: "County",
  route: "Route",
  post_mile: "Post mile",
  latitude: "Latitude",
  longitude: "Longitude",
  first_observed_at: "When it was first seen",
  first_occurred_at: "When it occurred",
  description: "Description",
};

/** The same fields as choices for the coordinator, in the order the reporter filled them in. */
export const REVISION_FIELD_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  "description",
  "first_observed_at",
  "first_occurred_at",
  "district",
  "county",
  "route",
  "post_mile",
  "latitude",
  "longitude",
].map((code) => ({ code, label: REVISION_FIELD_LABELS[code] }));

export type RevisionRequest = { fields: string[]; comment: string | null };

/** What the coordinator asked the reporter to fix, or null when nothing is pending. */
export function revisionRequest(incident: DetailIncident): RevisionRequest | null {
  if (!isWaitingOnReporter(incident)) return null;
  const metadata = incident.location_match_metadata ?? {};
  const rawFields = Array.isArray((metadata as Record<string, unknown>).revision_fields)
    ? ((metadata as Record<string, unknown>).revision_fields as unknown[])
    : [];
  const fields = rawFields
    .map((field) => String(field ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((field) => REVISION_FIELD_LABELS[field] ?? humanize(field));
  const rawComment = (metadata as Record<string, unknown>).comment;
  const comment = typeof rawComment === "string" && rawComment.trim() ? rawComment.trim() : null;
  return { fields, comment };
}

/**
 * The report's permanent identity, or the plain statement that it has none. A
 * report closed at triage before this rule took effect may still carry a
 * number in the database; it never entered the record, so it is not shown.
 */
export function incidentNumberLabel(incident: DetailIncident, id: number): string {
  if (isClosedAtTriage(incident)) return `Field report #${id} — closed at triage, not entered into ERIS`;
  return incident.incident_key ? `ERIS no. ${incident.incident_key}` : `Field report #${id} — not yet accepted, no ERIS number`;
}

function humanize(code: string): string {
  return code
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}
