/** What the bell's badge says: nothing at zero, "9+" past nine. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. */
export function whenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: at.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Where a notice leads inside the web app, or null when it leads nowhere. */
export function internalLink(link: string | null): string | null {
  if (!link) return null;
  return link.startsWith("/") && !link.startsWith("//") ? link : null;
}

/** What a step somebody took is called in a notice: assessment events, then triage decisions. */
const DONE_ACTIONS: Record<string, string> = {
  OFFICE_DELEGATED: "handed it to a branch chief",
  SENIOR_ENGINEER_ASSIGNED: "assigned a Senior Specialist",
  ENGINEER_ASSIGNED: "assigned a Staff member",
  SUBMITTED: "submitted it for review",
  APPROVED: "approved it",
  REVISION_REQUESTED: "sent it back for revision",
  ASSESSMENT_REQUIRED: "sent it for a GeoTech assessment",
  NO_ASSESSMENT_REQUIRED: "closed it: no assessment needed",
  NEEDS_REPORTER_INFORMATION: "asked the reporter for more",
  DUPLICATE_OR_LINKED: "closed it as a duplicate",
};

export type DoneStepLike = { at: string | null; by: string | null; by_you: boolean; action: string | null };

/** "You handed it to a branch chief · 5 min ago": a step somebody already took. */
export function doneText(done: DoneStepLike, now: Date = new Date()): string {
  const who = done.by_you ? "You" : done.by ?? "Someone";
  const what = done.action ? DONE_ACTIONS[done.action] ?? "took this step" : null;
  const when = whenLabel(done.at, now);
  return [what ? `${who} ${what}` : "Already handled", when].filter(Boolean).join(" · ");
}
