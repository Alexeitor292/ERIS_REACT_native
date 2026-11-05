import type { Delegation, DelegationStatus } from "../../api/delegations";

const STATUS: Record<DelegationStatus, string> = {
  SCHEDULED: "Scheduled",
  ACTIVE: "Active now",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};

export const statusLabel = (status: DelegationStatus) => STATUS[status] ?? status;

/** A calendar date as the server sends it, never shifted by the browser's time zone. */
export function dayLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function periodLabel(item: Pick<Delegation, "starts_on" | "ends_on">): string {
  return item.starts_on === item.ends_on ? dayLabel(item.starts_on) : `${dayLabel(item.starts_on)} to ${dayLabel(item.ends_on)}`;
}

export const isOpen = (item: Pick<Delegation, "status">) => item.status === "SCHEDULED" || item.status === "ACTIVE";

/** Why the form cannot be sent yet, or null. The server checks all of it again. */
export function formProblem(form: { delegateId: number | null; startsOn: string; endsOn: string }, today: string): string | null {
  if (form.delegateId == null) return "Choose who will act for you.";
  if (!form.startsOn || !form.endsOn) return "Choose the first and last day.";
  if (form.endsOn < form.startsOn) return "The last day cannot be before the first day.";
  if (form.endsOn < today) return "The last day has already passed.";
  return null;
}

/** What a write under a delegation did, in words, from its method and path. */
export function actionLabel(method: string, path: string): string {
  const review = path.match(/^\/assessments\/(\d+)\/review/);
  if (review) return `Reviewed assessment #${review[1]}`;
  const assessment = path.match(/^\/assessments\/(\d+)/);
  if (assessment) return `Changed assessment #${assessment[1]}`;
  if (path.startsWith("/assessments/move")) return "Moved assessments";
  const share = path.match(/^\/shares\/(\d+)/);
  if (share) return `Decided share #${share[1]}`;
  const form = path.match(/^\/submissions\/(\d+)/);
  if (form) return `Changed form #${form[1]}`;
  const incident = path.match(/^\/incidents\/(\d+)/);
  if (incident) return `Changed report #${incident[1]}`;
  return `${method} ${path}`;
}
