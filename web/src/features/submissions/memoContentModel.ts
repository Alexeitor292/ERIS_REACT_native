// Dependency-free so it runs under `node --test`. Decides what a memo editor
// starts from, and labels for the site-history views.

/** The four memos edited as formatted documents; each has a plain-text mirror. */
export const RICH_MEMO_KEYS = [
  "observations_notes",
  "geotechnical_assessment_notes",
  "recommendations_notes",
  "sketchpad_notes",
] as const;
export type RichMemoKey = (typeof RICH_MEMO_KEYS)[number];

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as a document: blank lines split paragraphs, single newlines stay line breaks. */
export function plainTextToMemoHtml(text: string | null | undefined): string {
  const source = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  return source
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/**
 * The words of a memo, ignoring layout: list bullets and numbers, punctuation,
 * spacing and case. Two versions with the same signature say the same thing.
 */
export function memoSignature(text: string | null | undefined): string {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[•\-*]|\d+\.)\s+/, ""))
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * What the editor opens with. The formatted version wins while it still says
 * what the plain mirror says; if the mirror was edited elsewhere since (the
 * mobile app edits plain text), start from the mirror instead.
 */
export function chooseMemoContent(html: string | null | undefined, plain: string | null | undefined, htmlText: string): string {
  if (html && memoSignature(htmlText) === memoSignature(plain)) return html;
  if (plain && plain.trim()) return plainTextToMemoHtml(plain);
  return html ?? "";
}

export type SiteRelation = "SAME_TYPE" | "DIFFERENT_TYPE" | "UNCLASSIFIED";

export const RELATION_LABELS: Record<SiteRelation, string> = {
  SAME_TYPE: "Recurrence",
  DIFFERENT_TYPE: "Different type",
  UNCLASSIFIED: "Not classified yet",
};

export const OUTCOME_LABELS: Record<string, string> = {
  ASSESSMENT_REQUIRED: "Sent for assessment",
  NO_ASSESSMENT_REQUIRED: "No assessment needed",
  DUPLICATE_OR_LINKED: "Duplicate of another report",
  NEEDS_REPORTER_INFORMATION: "Sent back to the reporter",
  PENDING_TRIAGE: "Awaiting triage",
};

const STATE_LABELS: Record<string, string> = {
  PENDING_OFFICE_DELEGATION: "Awaiting office routing",
  PENDING_ENGINEER_ASSIGNMENT: "Awaiting assignment",
  DRAFT: "Assessment in progress",
  SUBMITTED: "Assessment in review",
  REVISION_REQUESTED: "Revision requested",
  APPROVED: "Assessment approved",
  FINALIZED: "Assessment finalized",
};

/** Where an earlier incident stands, in words. */
export function recordStandingLabel(stage: string | null, assessmentState: string | null): string {
  if (stage === "RESOLVED") return "Resolved";
  if (assessmentState && STATE_LABELS[assessmentState]) return STATE_LABELS[assessmentState];
  return "In the record";
}

/** "Same location", "12 m away", "1.2 km away". */
export function distanceLabel(distanceM: number | null, sameLocation: boolean): string {
  if (sameLocation) return "Same location";
  if (distanceM == null) return "Nearby";
  if (distanceM < 1) return "Same spot";
  return distanceM < 1000 ? `${Math.round(distanceM)} m away` : `${(distanceM / 1000).toFixed(1)} km away`;
}

/**
 * Summary counts for the Record of incidents header. Recurrences count only
 * incidents in the record; reports that never entered it are counted apart.
 */
export function summarizeRecord(items: ReadonlyArray<{ relation: SiteRelation; in_record?: boolean }>) {
  const inRecord = items.filter((item) => item.in_record !== false);
  return {
    total: items.length,
    recurrences: inRecord.filter((item) => item.relation === "SAME_TYPE").length,
    differentType: inRecord.filter((item) => item.relation === "DIFFERENT_TYPE").length,
    unclassified: inRecord.filter((item) => item.relation === "UNCLASSIFIED").length,
    outsideRecord: items.length - inRecord.length,
  };
}

type MaintenanceSide = {
  triage: { notes: string | null } | null;
  immediate_actions: readonly unknown[];
  follow_up_actions: readonly unknown[];
  notes: readonly unknown[];
  also_reported: readonly unknown[];
};

/** Whether maintenance did or wrote anything beyond the report itself. */
export function hasMaintenanceRecord(side: MaintenanceSide): boolean {
  return Boolean(
    side.triage?.notes ||
      side.immediate_actions.length ||
      side.follow_up_actions.length ||
      side.notes.length ||
      side.also_reported.length,
  );
}
