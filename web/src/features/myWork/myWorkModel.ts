import type { WorkItem as MaintenanceItem } from "../../api/maintenanceWorkflows";

/**
 * Which side of the work an item belongs to. Maintenance: field reports in
 * intake triage and reports moving through a district's maintenance workflow.
 * Geotechnical: assessments and shares of technical forms.
 */
export type WorkArea = "geotech" | "maintenance";
export type WorkFilter = "both" | WorkArea;
export type WorkKind = "triage" | "maintenance" | "share" | "assessment";

export const WORK_FILTERS: Array<{ id: WorkFilter; label: string }> = [
  { id: "both", label: "Both" },
  { id: "geotech", label: "Geotechnical" },
  { id: "maintenance", label: "Maintenance" },
];

export function workArea(kind: WorkKind): WorkArea {
  return kind === "triage" || kind === "maintenance" ? "maintenance" : "geotech";
}

/** Only administrators choose; everyone else sees what their duties put in front of them. */
export function filterWork<T extends { kind: WorkKind }>(items: T[], filter: WorkFilter, admin: boolean): T[] {
  if (!admin || filter === "both") return items;
  return items.filter((item) => workArea(item.kind) === filter);
}

export function parseWorkFilter(value: string | null | undefined): WorkFilter {
  return value === "geotech" || value === "maintenance" ? value : "both";
}

/** Where a maintenance report stands, in a few words. */
export function maintenanceStatus(item: Pick<MaintenanceItem, "outcome" | "waiting_reporter" | "step_name">): string {
  if (item.outcome) return item.outcome === "GEOTECH" ? "Sent to GeoTech" : "Maintenance handles it";
  if (item.waiting_reporter) return "Waiting on reporter";
  return item.step_name;
}

/**
 * The maintenance reports My Work lists: those waiting on this person, plus,
 * when asked for, the others they can read. A report opened by a link is
 * always listed.
 */
export function maintenanceInView<T extends Pick<MaintenanceItem, "id" | "my_turn">>(items: T[], includeOthers: boolean, opened: number | null): T[] {
  return items.filter((item) => item.my_turn || includeOthers || item.id === opened);
}
